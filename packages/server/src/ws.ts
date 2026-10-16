// WebSocket endpoint: authentication at upgrade, the Hello/Welcome
// handshake, per-connection rate limits, bounded inbound and outbound queues
// (backpressure), fragmentation, heartbeats, and dispatch of protocol
// messages to the rooms.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";

import { decode, encodeFrames, encodeVersion1Error, ErrorCode, LIMITS, type Message, MsgType, ProtocolError, Reassembler } from "@tandem/protocol";
import { WebSocket, WebSocketServer } from "ws";

import { parseCookies, SESSION_COOKIE, sessionForSocket, type SessionUser } from "./auth.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { Logger } from "./logger.js";
import type { Metrics } from "./metrics.js";
import { TokenBucket } from "./ratelimit.js";
import type { Peer, RoomManager } from "./rooms.js";

// WebSocket close codes used by the server (4000-4999 are application codes).
export const CloseCode = {
  ProtocolError: 4000,
  Unauthorized: 4001,
  RateLimited: 4008,
  Backpressure: 4009,
  Superseded: 4010,
  HandshakeTimeout: 4011,
  ServerShutdown: 1001,
  TryAgainLater: 1013,
} as const;

// Frames are written to the socket while its buffer is below this; the rest
// waits in the connection's own (bounded) queue.
const HIGH_WATER = 256 * 1024;

export function originAllowed(origin: string | undefined, host: string | undefined, allowed: string[]): boolean {
  if (!origin) return false; // browsers always send Origin on WebSocket upgrades
  if (allowed.includes(origin)) return true;
  if (allowed.length > 0) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// Largest reassembled message accepted from a client: a whole document
// (offline edits of a new document) plus room for encoding overhead.
export const maxClientMessageBytes = (cfg: Config) => cfg.maxDocumentBytes + LIMITS.maxFrameBytes;

// Bytes queued for sending, and bytes of partially received fragmented
// messages, on all connections together.
class SendBudget {
  queued = 0;
  reassembling = 0;
  constructor(readonly limit: number, readonly reassemblyLimit: number) {}
}

class Connection implements Peer {
  readonly id = randomUUID();
  alive = true;
  closed = false;
  hello = false;
  sessionKey: string | undefined;
  private msgBucket: TokenBucket;
  private byteBucket: TokenBucket;
  private opBucket: TokenBucket;
  readonly reassembler: Reassembler;
  // Messages are handled strictly in order per connection (a Join must be
  // complete before the Sync1 that follows it is processed).
  chain: Promise<void> = Promise.resolve();
  inMessages = 0;
  inBytes = 0;
  private out: Uint8Array[] = [];
  private outBytes = 0;
  private nextFragmentId = 1;

  expiryTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly ws: WebSocket,
    readonly user: SessionUser,
    readonly tokenHash: string, // hex; identifies the session in revocation events
    private readonly cfg: Config,
    private readonly metrics: Metrics,
    private readonly budget: SendBudget,
    readonly log: Logger,
  ) {
    this.msgBucket = new TokenBucket(cfg.msgRatePerSec, cfg.msgBurst);
    this.byteBucket = new TokenBucket(cfg.byteRatePerSec, cfg.byteBurst);
    this.opBucket = new TokenBucket(cfg.opRatePerSec, cfg.opBurst);
    this.reassembler = new Reassembler(maxClientMessageBytes(cfg));
  }

  get queuedBytes(): number {
    return this.outBytes + this.ws.bufferedAmount;
  }

  send(msg: Message): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    const frames = encodeFrames(msg, () => this.nextFragmentId++);
    const size = frames.reduce((n, f) => n + f.length, 0);
    // Backpressure: a client that does not read fast enough is disconnected
    // rather than buffered without bound. Its replica is intact; on
    // reconnect the state-vector handshake brings it up to date.
    if (this.queuedBytes + size > this.cfg.sendBufferLimit) {
      this.metrics.backpressureDrops.inc({ reason: "slow_consumer" });
      this.log.warn("send queue full; disconnecting slow client", { conn: this.id, queued: this.queuedBytes });
      return this.close(CloseCode.Backpressure, "send buffer full");
    }
    if (this.budget.queued + size > this.budget.limit) {
      this.metrics.backpressureDrops.inc({ reason: "server_budget" });
      this.log.warn("server send budget exhausted; disconnecting", { conn: this.id, queued: this.budget.queued });
      return this.close(CloseCode.TryAgainLater, "server overloaded");
    }
    this.metrics.messagesOut.inc({ type: MsgType[msg.type] ?? "unknown" });
    for (const f of frames) this.out.push(f);
    this.outBytes += size;
    this.budget.queued += size;
    this.pump();
  }

  private pump = () => {
    while (this.out.length > 0 && !this.closed && this.ws.readyState === WebSocket.OPEN && this.ws.bufferedAmount < HIGH_WATER) {
      const f = this.out.shift()!;
      this.outBytes -= f.length;
      this.budget.queued -= f.length;
      // The callback runs once the frame was handed to the OS: keep draining.
      this.ws.send(f, this.out.length > 0 ? () => this.pump() : undefined);
    }
  };

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.releaseQueue();
    this.ws.close(code, reason);
    // Make sure the socket goes away even if the peer never answers.
    setTimeout(() => this.ws.terminate(), 5_000).unref();
  }

  releaseQueue() {
    this.budget.queued -= this.outBytes;
    this.outBytes = 0;
    this.out = [];
    this.budget.reassembling -= this.reassemblyCharged;
    this.reassemblyCharged = 0;
  }

  // Bytes of this connection's partial fragmented message counted against
  // the server-wide budget; false if the budget is exceeded.
  reassemblyCharged = 0;
  chargeReassembly(): boolean {
    const now = this.reassembler.bufferedBytes;
    this.budget.reassembling += now - this.reassemblyCharged;
    this.reassemblyCharged = now;
    return this.budget.reassembling <= this.budget.reassemblyLimit;
  }

  admit(bytes: number): boolean {
    return this.msgBucket.take(1) && this.byteBucket.take(bytes);
  }

  admitOperation(): boolean {
    return this.opBucket.take(1);
  }
}

export class WsEndpoint {
  private wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxFrameBytes + 64, perMessageDeflate: false });
  private conns = new Set<Connection>();
  private sessions = new Map<string, Connection>(); // user id + session id -> connection
  private heartbeat: NodeJS.Timeout;
  private revalidateTimer: NodeJS.Timeout | undefined;
  private revalidating = false;
  private budget: SendBudget;

  constructor(
    private readonly db: Db,
    private readonly rooms: RoomManager,
    private readonly cfg: Config,
    private readonly log: Logger,
    private readonly metrics: Metrics,
  ) {
    this.budget = new SendBudget(cfg.globalSendBudget, cfg.globalReassemblyBudget);
    metrics.activeConnections.set(() => this.conns.size);
    metrics.activeUsers.set(() => new Set([...this.conns].map((c) => c.user.id)).size);
    metrics.sendQueueBytes.set(() => this.budget.queued);
    metrics.reassemblyBytes.set(() => this.budget.reassembling);
    metrics.inboundQueueBytes.set(() => [...this.conns].reduce((n, c) => n + c.inBytes, 0));
    this.heartbeat = setInterval(() => {
      for (const c of this.conns) {
        if (!c.alive) {
          c.log.info("heartbeat timeout", { conn: c.id });
          this.metrics.staleConnections.inc({ reason: "heartbeat_timeout" });
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        c.ws.ping();
      }
    }, cfg.heartbeatMs);
    this.heartbeat.unref();
    if (cfg.sessionRevalidateMs > 0) {
      this.revalidateTimer = setInterval(() => void this.revalidate(), cfg.sessionRevalidateMs);
      this.revalidateTimer.unref();
    }
  }

  // A socket is authenticated once, at the upgrade. Periodically check that
  // its session still exists and has not expired (it may have been revoked
  // on another node whose bus message was lost, or deleted by an
  // administrator), then let the rooms re-check membership and roles.
  // Only connections that existed before the query are judged by it, so a
  // connection opened meanwhile is never closed on a stale answer. A
  // database error leaves connections open (fail-open; edits cannot be
  // acknowledged while the database is down anyway) and is retried next time.
  async revalidate(): Promise<void> {
    if (this.revalidating || this.shuttingDown) return;
    this.revalidating = true;
    try {
      const snapshot = [...this.conns].filter((c) => !c.closed);
      const hashes = [...new Set(snapshot.map((c) => c.tokenHash))];
      const valid = new Set<string>();
      for (let i = 0; i < hashes.length; i += 1000) {
        const r = await this.db.query(
          "SELECT encode(token_hash, 'hex') AS h FROM sessions WHERE token_hash IN (SELECT decode(x, 'hex') FROM unnest($1::text[]) AS x) AND expires_at > now()",
          [hashes.slice(i, i + 1000)],
        );
        for (const row of r.rows) valid.add(row.h as string);
      }
      for (const c of snapshot) {
        if (c.closed || valid.has(c.tokenHash)) continue;
        this.metrics.sessionsClosed.inc({ reason: "revalidation" });
        c.log.info("session no longer valid; closing", { conn: c.id });
        c.close(CloseCode.Unauthorized, "session ended");
      }
      await this.rooms.revalidateMembers();
    } catch (err) {
      this.metrics.errors.inc({ component: "revalidation" });
      this.log.warn("revalidation of live connections failed; will retry", { err: (err as Error).message });
    } finally {
      this.revalidating = false;
    }
  }

  get connectionCount() {
    return this.conns.size;
  }

  async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const reject = (status: number, reason: string) => {
      this.metrics.wsRejected.inc({ reason });
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") return reject(404, "Not Found");
    if (this.shuttingDown) return reject(503, "Service Unavailable");
    if (!originAllowed(req.headers.origin, req.headers.host, this.cfg.allowedOrigins)) return reject(403, "Forbidden");
    if (this.conns.size >= this.cfg.maxConnections) return reject(503, "Service Unavailable");
    let session: Awaited<ReturnType<typeof sessionForSocket>>;
    try {
      session = await sessionForSocket(this.db, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    } catch (err) {
      this.log.error("session lookup failed", { err: (err as Error).message });
      return reject(503, "Service Unavailable");
    }
    if (!session) return reject(401, "Unauthorized");
    const s = session;
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, s.user, s.tokenHash, s.expiresAt));
  }

  private accept(ws: WebSocket, user: SessionUser, tokenHash: string, expiresAt: Date) {
    const log = this.log.child({ user: user.id });
    const conn = new Connection(ws, user, tokenHash, this.cfg, this.metrics, this.budget, log);
    this.conns.add(conn);
    // Close exactly when the session expires (timers are limited to ~24.8
    // days; longer sessions are caught by the periodic revalidation).
    const ttl = expiresAt.getTime() - Date.now();
    if (ttl < 2 ** 31 - 1) {
      conn.expiryTimer = setTimeout(() => {
        this.metrics.sessionsClosed.inc({ reason: "expiry" });
        conn.close(CloseCode.Unauthorized, "session expired");
      }, Math.max(0, ttl));
      conn.expiryTimer.unref();
    }
    this.metrics.wsConnections.inc();
    log.info("connected", { conn: conn.id });
    // The client must say Hello first; a socket that never does is closed.
    const handshake = setTimeout(() => {
      if (conn.hello) return;
      this.metrics.staleConnections.inc({ reason: "handshake_timeout" });
      conn.close(CloseCode.HandshakeTimeout, "no Hello received");
    }, this.cfg.handshakeTimeoutMs);
    handshake.unref();
    ws.on("pong", () => (conn.alive = true));
    ws.on("message", (data, isBinary) => {
      conn.alive = true;
      if (conn.closed) return;
      if (!isBinary) return conn.close(CloseCode.ProtocolError, "binary frames only");
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (!conn.admit(buf.length)) {
        this.metrics.rateLimited.inc({ kind: "messages" });
        conn.send({ type: MsgType.Error, ch: 0, code: ErrorCode.RateLimited, ref: 0, message: "rate limit exceeded" });
        return conn.close(CloseCode.RateLimited, "rate limit exceeded");
      }
      // Inbound queue bounded in messages and in bytes (messages wait while
      // an earlier one is handled, e.g. a Join loading from the database).
      if (conn.inMessages >= this.cfg.inboundQueueMessages || conn.inBytes + buf.length > this.cfg.inboundQueueBytes) {
        this.metrics.backpressureDrops.inc({ reason: "inbound_queue" });
        return conn.close(CloseCode.TryAgainLater, "too many pending messages");
      }
      const frame = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      conn.inMessages++;
      conn.inBytes += frame.length;
      conn.chain = conn.chain
        .then(() => this.dispatch(conn, frame))
        .catch((err) => log.error("message handling failed", { conn: conn.id, err: (err as Error).message }))
        .finally(() => {
          conn.inMessages--;
          conn.inBytes -= frame.length;
        });
    });
    ws.on("close", () => {
      clearTimeout(handshake);
      if (conn.expiryTimer) clearTimeout(conn.expiryTimer);
      conn.closed = true;
      conn.releaseQueue();
      this.conns.delete(conn);
      if (conn.sessionKey && this.sessions.get(conn.sessionKey) === conn) this.sessions.delete(conn.sessionKey);
      this.rooms.peerClosed(conn);
      log.info("disconnected", { conn: conn.id });
    });
    ws.on("error", (err) => log.warn("socket error", { conn: conn.id, err: err.message }));
  }

  private protocolError(conn: Connection, code: ErrorCode, message: string) {
    conn.send({ type: MsgType.Error, ch: 0, code, ref: 0, message });
    conn.close(CloseCode.ProtocolError, "protocol error");
  }

  private async dispatch(conn: Connection, frame: Uint8Array) {
    if (conn.closed) return;
    let m: Message;
    try {
      m = decode(frame);
      if (m.type === MsgType.Fragment) {
        const whole = conn.reassembler.add(m);
        if (!conn.chargeReassembly()) {
          this.metrics.backpressureDrops.inc({ reason: "reassembly_budget" });
          return conn.close(CloseCode.TryAgainLater, "server overloaded");
        }
        if (!whole) return;
        m = whole;
      }
    } catch (err) {
      const e = err instanceof ProtocolError ? err : new ProtocolError("bad message");
      this.metrics.protocolErrors.inc({ reason: e.version !== undefined ? "version" : "malformed" });
      if (e.version === 1) {
        // An older client build (a tab left open during a deployment):
        // answer in its own format so that it can tell the user to reload.
        if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(encodeVersion1Error(ErrorCode.UnsupportedVersion, "the app was updated; reload the page"));
        return conn.close(CloseCode.ProtocolError, "unsupported protocol version");
      }
      if (e.version !== undefined) return this.protocolError(conn, ErrorCode.UnsupportedVersion, e.message);
      return this.protocolError(conn, ErrorCode.BadMessage, e.message);
    }
    this.metrics.messagesIn.inc({ type: MsgType[m.type] ?? "unknown" });
    if (!conn.hello) {
      if (m.type !== MsgType.Hello) return this.protocolError(conn, ErrorCode.BadMessage, "expected Hello as the first message");
      return this.hello(conn, m);
    }
    if ((m.type === MsgType.Update || m.type === MsgType.Sync2) && !conn.admitOperation()) {
      this.metrics.rateLimited.inc({ kind: "operations" });
      conn.send({ type: MsgType.Error, ch: 0, code: ErrorCode.RateLimited, ref: 0, message: "operation rate limit exceeded" });
      return conn.close(CloseCode.RateLimited, "operation rate limit exceeded");
    }
    switch (m.type) {
      case MsgType.Join:
        return this.rooms.join(conn, m.ch, m.docId);
      case MsgType.Leave:
        return this.rooms.leave(conn, m.ch);
      case MsgType.Sync1:
        return this.rooms.sync1(conn, m.ch, m.stateVector);
      case MsgType.Sync2:
        return this.rooms.update(conn, m.ch, m.update, null);
      case MsgType.Update:
        return this.rooms.update(conn, m.ch, m.update, m.seq);
      case MsgType.Awareness:
        return this.rooms.awareness(conn, m.ch, m.payload);
      case MsgType.Ping:
        return conn.send({ type: MsgType.Pong, nonce: m.nonce });
      case MsgType.Pong:
        return;
      default:
        // A second Hello, or a server-to-client message type.
        return this.protocolError(conn, ErrorCode.BadMessage, "unexpected message type");
    }
  }

  private hello(conn: Connection, m: Extract<Message, { type: MsgType.Hello }>) {
    conn.hello = true;
    if (m.resume > 0) this.metrics.reconnects.inc();
    // One live connection per client instance: a reconnect replaces a socket
    // that is still registered (half-open after a network change).
    const key = `${conn.user.id}:${m.sessionId}`;
    const old = this.sessions.get(key);
    if (old && old !== conn) {
      this.metrics.staleConnections.inc({ reason: "superseded" });
      old.close(CloseCode.Superseded, "superseded by a newer connection");
    }
    this.sessions.set(key, conn);
    conn.sessionKey = key;
    conn.send({
      type: MsgType.Welcome,
      connectionId: conn.id,
      heartbeatMs: this.cfg.heartbeatMs,
      maxMessageBytes: maxClientMessageBytes(this.cfg),
      msgRatePerSec: this.cfg.msgRatePerSec,
      byteRatePerSec: this.cfg.byteRatePerSec,
      byteBurst: this.cfg.byteBurst,
    });
  }

  // Close every connection (graceful shutdown); clients reconnect elsewhere.
  // New upgrades are refused from now on.
  closeAll() {
    this.shuttingDown = true;
    clearInterval(this.heartbeat);
    if (this.revalidateTimer) clearInterval(this.revalidateTimer);
    for (const c of this.conns) c.close(CloseCode.ServerShutdown, "server shutting down");
  }

  terminateAll() {
    for (const c of this.conns) c.ws.terminate();
  }

  private shuttingDown = false;

  // Close the connections of one session (logout).
  closeSession(tokenHashHex: string, reason: string) {
    for (const c of this.conns)
      if (c.tokenHash === tokenHashHex && !c.closed) {
        this.metrics.sessionsClosed.inc({ reason });
        c.close(CloseCode.Unauthorized, "session ended");
      }
  }

  // Close all connections of one user (log out everywhere).
  closeUser(userId: string, reason: string) {
    for (const c of this.conns)
      if (c.user.id === userId && !c.closed) {
        this.metrics.sessionsClosed.inc({ reason });
        c.close(CloseCode.Unauthorized, "session ended");
      }
  }
}
