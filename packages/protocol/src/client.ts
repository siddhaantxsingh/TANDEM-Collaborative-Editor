// Client sync engine, shared by the browser UI, the load tester and the
// tests. One TandemConnection multiplexes any number of documents over a
// single WebSocket and keeps them synchronized across disconnects:
//
//  * Local edits are sent as Update messages with an increasing sequence
//    number and stay "unsaved" until the server acknowledges them (the
//    server acks only after writing to PostgreSQL).
//  * While offline, edits accumulate in the Y.Doc (and, in the browser, in
//    IndexedDB). On reconnect the Sync1/Sync2 handshake exchanges exactly
//    what each side is missing, so nothing is lost and nothing is sent twice
//    in a way that matters (Yjs updates are idempotent).
//  * Recovery without a disconnect: an update not acknowledged within
//    ackTimeoutMs makes the client reconnect (the handshake resends it);
//    every resyncIntervalMs each document asks the server for anything it
//    is missing (anti-entropy against a lost frame).
//  * Outgoing frames are paced to the limits the server announces in
//    Welcome, so a large upload (offline edits) is not cut off by the
//    server's rate limiter; messages larger than one frame are fragmented.
import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";

import { canEdit, decode, encodeFrames, ErrorCode, LIMITS, type Message, MsgType, Reassembler, Role } from "./index.js";

export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  bufferedAmount?: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type ConnectionStatus = "connecting" | "online" | "offline" | "outdated";

export interface ConnectionOptions {
  url: string;
  createSocket: (url: string) => WebSocketLike;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  pingIntervalMs?: number;
  ackTimeoutMs?: number; // reconnect if an update is not acknowledged in time
  resyncIntervalMs?: number; // periodic Sync1 per document (0 = off)
  awarenessThrottleMs?: number; // minimum interval between presence messages
  sessionId?: string;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

const OPEN = 1;
const ORIGIN = Symbol("tandem-remote");

/**
 * Y.applyUpdate, plus one retry of structs Yjs is still holding as pending.
 *
 * Yjs 13.6 can leave structs pending although every dependency has arrived
 * when causally dependent updates are applied out of order: the stash
 * records "missing client c, clock k" where (c, k) is itself inside the
 * stash, and the retry condition only fires when client c's state advances
 * from outside. Re-applying the stash (Yjs keeps it in update format V2)
 * lets Yjs resolve the dependencies inside it. Nothing is lost without this
 * (pending structs are included in encodeStateAsUpdate), but the replica
 * stays incomplete until another copy arrives. Minimal counterexample and
 * test: packages/protocol/test/crdt.test.ts, docs/CORRECTNESS.md.
 */
export function applyUpdateHealing(doc: Y.Doc, update: Uint8Array, origin?: unknown): void {
  Y.applyUpdate(doc, update, origin);
  const pending = (doc.store as unknown as { pendingStructs: { update: Uint8Array } | null }).pendingStructs;
  if (pending) Y.applyUpdateV2(doc, pending.update, origin);
}

function randomSessionId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[b & 63];
  return s;
}

export class DocHandle {
  role: Role | undefined;
  joined = false;
  synced = false; // received the server's state at least once this session
  closed = false;
  /** Set when the server refused one of our changes (it stays local only). */
  rejected: { code: ErrorCode; message: string } | undefined;
  private seq = 0;
  private unacked = new Map<number, number>(); // seq -> time sent
  private dirtyOffline = false; // local edits made while not joined
  private syncAckSince = 0; // time our Sync2 was sent, 0 = acknowledged
  private listeners = new Map<keyof DocEvents, ((...a: never[]) => void)[]>();
  private awarenessTimer: ReturnType<typeof setTimeout> | undefined;
  private awarenessLast = 0;

  constructor(
    readonly conn: TandemConnection,
    readonly ch: number,
    readonly docId: string,
    readonly doc: Y.Doc,
    readonly awareness: awarenessProtocol.Awareness | undefined,
  ) {}

  on<K extends keyof DocEvents>(ev: K, fn: DocEvents[K]) {
    const list = this.listeners.get(ev) ?? [];
    list.push(fn as (...a: never[]) => void);
    this.listeners.set(ev, list);
  }
  emit<K extends keyof DocEvents>(ev: K, ...args: Parameters<DocEvents[K]>) {
    for (const fn of this.listeners.get(ev) ?? []) (fn as (...a: unknown[]) => void)(...args);
  }

  /** Number of local changes not yet confirmed as stored by the server. */
  get unsaved(): number {
    return this.unacked.size + (this.dirtyOffline ? 1 : 0) + (this.syncAckSince ? 1 : 0);
  }

  get canEdit(): boolean {
    return this.role !== undefined && canEdit(this.role);
  }

  /** Age in ms of the oldest unacknowledged change (0 = none). */
  oldestUnackedMs(now: number): number {
    let oldest = this.syncAckSince || Infinity;
    for (const t of this.unacked.values()) oldest = Math.min(oldest, t);
    return oldest === Infinity ? 0 : now - oldest;
  }

  /** Mark local state as possibly unknown to the server (e.g. restored from
   *  IndexedDB): it is sent with the next handshake. */
  markDirty() {
    this.dirtyOffline = true;
    this.emit("saved", this.unsaved);
  }

  // ---- called by the connection
  localUpdate(update: Uint8Array) {
    if (this.role !== undefined && !canEdit(this.role)) return; // viewers never send edits
    if (!this.joined || !this.conn.isOpen) {
      this.dirtyOffline = true;
      this.emit("saved", this.unsaved);
      return;
    }
    const seq = ++this.seq;
    this.unacked.set(seq, Date.now());
    this.conn.send({ type: MsgType.Update, ch: this.ch, seq, update });
    this.emit("saved", this.unsaved);
  }

  // Presence is sent at most once per throttle interval (the last state wins).
  localAwareness() {
    if (!this.awareness || !this.joined) return;
    const wait = this.awarenessLast + this.conn.awarenessThrottleMs - Date.now();
    if (wait > 0) {
      this.awarenessTimer ??= setTimeout(() => {
        this.awarenessTimer = undefined;
        this.localAwareness();
      }, wait);
      return;
    }
    this.awarenessLast = Date.now();
    this.conn.send({ type: MsgType.Awareness, ch: this.ch, payload: awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]) });
  }

  onDisconnected() {
    this.joined = false;
    // Unacknowledged updates may or may not have arrived; the next sync
    // handshake resends whatever the server lacks.
    if (this.unacked.size > 0 || this.syncAckSince) this.dirtyOffline = true;
    this.unacked.clear();
    this.syncAckSince = 0;
    if (this.awareness) {
      const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
      awarenessProtocol.removeAwarenessStates(this.awareness, others, ORIGIN);
    }
    this.emit("saved", this.unsaved);
  }

  dispose() {
    if (this.awarenessTimer) clearTimeout(this.awarenessTimer);
  }

  handle(m: Message) {
    switch (m.type) {
      case MsgType.Joined:
        this.role = m.role;
        this.joined = true;
        this.conn.send({ type: MsgType.Sync1, ch: this.ch, stateVector: Y.encodeStateVector(this.doc) });
        if (this.awareness?.getLocalState()) {
          this.awarenessLast = 0;
          this.localAwareness();
        }
        this.emit("role", m.role);
        break;
      case MsgType.Sync1: {
        // The server tells us what it has; send what it lacks.
        if (!canEdit(this.role ?? Role.Viewer)) break;
        const diff = Y.encodeStateAsUpdate(this.doc, m.stateVector);
        this.syncAckSince = Date.now();
        this.dirtyOffline = false;
        this.conn.send({ type: MsgType.Sync2, ch: this.ch, update: diff });
        this.emit("saved", this.unsaved);
        break;
      }
      case MsgType.Sync2:
        applyUpdateHealing(this.doc, m.update, ORIGIN);
        if (!this.synced) {
          this.synced = true;
          this.emit("synced");
        }
        if (this.unsaved === 0) this.emit("confirmed", Y.encodeStateVector(this.doc));
        break;
      case MsgType.Update:
        applyUpdateHealing(this.doc, m.update, ORIGIN);
        if (this.unsaved === 0) this.emit("confirmed", Y.encodeStateVector(this.doc));
        break;
      case MsgType.Ack: {
        const sent = m.seq === 0 ? this.syncAckSince : this.unacked.get(m.seq);
        if (sent) this.emit("ack", Date.now() - sent);
        if (m.seq === 0) this.syncAckSince = 0;
        else this.unacked.delete(m.seq);
        this.emit("saved", this.unsaved);
        if (this.unsaved === 0) this.emit("confirmed", Y.encodeStateVector(this.doc));
        break;
      }
      case MsgType.Awareness:
        if (this.awareness) awarenessProtocol.applyAwarenessUpdate(this.awareness, m.payload, ORIGIN);
        break;
      case MsgType.RoleChanged:
        this.role = m.role;
        this.emit("role", m.role);
        break;
      case MsgType.Error:
        if (m.code === ErrorCode.NotFound || (m.code === ErrorCode.Forbidden && /removed/.test(m.message))) this.closed = true;
        // A refused change: stop waiting for its Ack (it will not come) and
        // remember that local state contains something the server rejected.
        if (m.code === ErrorCode.Forbidden || m.code === ErrorCode.TooLarge || m.code === ErrorCode.BadMessage) {
          if (m.ref > 0 && this.unacked.delete(m.ref)) this.rejected = { code: m.code, message: m.message };
          else if (m.ref === 0 && this.syncAckSince) {
            this.syncAckSince = 0;
            this.rejected = { code: m.code, message: m.message };
          }
          this.emit("saved", this.unsaved);
        }
        this.emit("error", m.code, m.message);
        break;
      default:
        break;
    }
  }
}

export interface DocEvents {
  synced: () => void;
  saved: (unsaved: number) => void;
  /** Everything in the local replica is stored on the server (after an Ack,
   *  or after applying a server update with nothing unsaved). */
  confirmed: (stateVector: Uint8Array) => void;
  role: (role: Role) => void;
  error: (code: ErrorCode, message: string) => void;
  /** An Ack arrived; argument: ms since the change was sent. */
  ack: (latencyMs: number) => void;
}

// Client-side token bucket mirroring the server's limits.
class Pacer {
  private tokens: number;
  private last = Date.now();
  constructor(public rate: number, public capacity: number) {
    this.tokens = capacity;
  }
  /** ms to wait until n tokens are available (0 = available now). */
  wait(n: number): number {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    const need = Math.min(n, this.capacity);
    return this.tokens >= need ? 0 : Math.ceil(((need - this.tokens) / this.rate) * 1000);
  }
  consume(n: number) {
    this.tokens -= Math.min(n, this.capacity);
  }
}

export class TandemConnection {
  status: ConnectionStatus = "offline";
  readonly sessionId: string;
  connectionId = "";
  private ws: WebSocketLike | undefined;
  private docs = new Map<number, DocHandle>();
  private nextCh = 1;
  private backoff: number;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private lastResync = Date.now();
  private lastPong = Date.now();
  private stopped = false;
  private statusListeners: ((s: ConnectionStatus, detail?: string) => void)[] = [];
  private cleanups = new Map<number, () => void>();
  private outbox: Uint8Array[] = [];
  private pumpTimer: ReturnType<typeof setTimeout> | undefined;
  private msgPacer = new Pacer(150, 300);
  private bytePacer = new Pacer(768 * 1024, 3 * 1024 * 1024);
  private reassembler = new Reassembler(LIMITS.maxClientMessageBytes);
  private nextFragmentId = 1;
  readonly awarenessThrottleMs: number;
  lastCloseCode = 0;

  constructor(private readonly opts: ConnectionOptions) {
    this.backoff = opts.minBackoffMs ?? 250;
    this.sessionId = opts.sessionId ?? randomSessionId();
    this.awarenessThrottleMs = opts.awarenessThrottleMs ?? 50;
    this.connect();
  }

  get isOpen(): boolean {
    return this.ws?.readyState === OPEN;
  }

  onStatus(fn: (s: ConnectionStatus, detail?: string) => void) {
    this.statusListeners.push(fn);
  }

  private setStatus(s: ConnectionStatus, detail?: string) {
    this.status = s;
    for (const fn of this.statusListeners) fn(s, detail);
  }

  /**
   * restoredOrigin: transaction origin of updates restored from local
   * storage (IndexedDB). They are not marked as unsaved while offline (the
   * caller decides, by comparing with the last confirmed snapshot, whether
   * they contain anything the server lacks); while joined they are sent.
   */
  open(docId: string, doc: Y.Doc, awareness?: awarenessProtocol.Awareness, opts: { restoredOrigin?: unknown } = {}): DocHandle {
    const ch = this.nextCh++;
    const h = new DocHandle(this, ch, docId, doc, awareness);
    this.docs.set(ch, h);
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === ORIGIN) return;
      if (opts.restoredOrigin !== undefined && origin === opts.restoredOrigin && !h.joined) return;
      h.localUpdate(update);
    };
    doc.on("update", onUpdate);
    const onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === ORIGIN || !h.joined) return;
      if (added.concat(updated, removed).includes(doc.clientID)) h.localAwareness();
    };
    awareness?.on("update", onAwareness);
    this.cleanups.set(ch, () => {
      doc.off("update", onUpdate);
      awareness?.off("update", onAwareness);
      h.dispose();
    });
    if (this.isOpen) this.send({ type: MsgType.Join, ch, docId });
    return h;
  }

  close(h: DocHandle) {
    this.cleanups.get(h.ch)?.();
    this.cleanups.delete(h.ch);
    this.docs.delete(h.ch);
    h.closed = true;
    if (this.isOpen) this.send({ type: MsgType.Leave, ch: h.ch });
  }

  /** Queue a message; frames go out paced to the server's announced limits. */
  send(m: Message) {
    if (!this.ws || this.ws.readyState !== OPEN) return;
    for (const f of encodeFrames(m, () => this.nextFragmentId++)) this.outbox.push(f);
    this.pump();
  }

  private pump = () => {
    this.pumpTimer = undefined;
    while (this.outbox.length > 0) {
      const ws = this.ws;
      if (!ws || ws.readyState !== OPEN) {
        this.outbox = [];
        return;
      }
      const f = this.outbox[0]!;
      const wait = Math.max(this.msgPacer.wait(1), this.bytePacer.wait(f.length));
      if (wait > 0) {
        this.pumpTimer = setTimeout(this.pump, wait);
        return;
      }
      this.msgPacer.consume(1);
      this.bytePacer.consume(f.length);
      this.outbox.shift();
      ws.send(f);
    }
  };

  private connect() {
    if (this.stopped) return;
    this.setStatus("connecting");
    const ws = this.opts.createSocket(this.opts.url);
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.lastPong = Date.now();
      this.outbox = [];
      this.send({ type: MsgType.Hello, sessionId: this.sessionId, resume: this.attempt++ });
      this.setStatus("online");
      for (const h of this.docs.values()) this.send({ type: MsgType.Join, ch: h.ch, docId: h.docId });
      const interval = this.opts.pingIntervalMs ?? 20_000;
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastPong > interval * 2.5) {
          this.opts.log?.("ping timeout; reconnecting");
          ws.close(4002, "ping timeout");
          this.onClosed(ws, 4002, "ping timeout");
          return;
        }
        this.send({ type: MsgType.Ping, nonce: Date.now() % 1e9 });
      }, interval);
      this.watchdog = setInterval(() => this.checkHealth(ws), 1000);
    };
    ws.onmessage = (ev) => {
      const data = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : ev.data instanceof Uint8Array ? ev.data : undefined;
      if (!data) return;
      let m: Message;
      try {
        m = decode(data);
        if (m.type === MsgType.Fragment) {
          const whole = this.reassembler.add(m);
          if (!whole) return;
          m = whole;
        }
      } catch (err) {
        // A frame we cannot read leaves our replica possibly incomplete:
        // reconnect so that the handshake repairs it.
        this.opts.log?.("bad message from server; reconnecting", { err: (err as Error).message });
        this.reassembler = new Reassembler(LIMITS.maxClientMessageBytes);
        this.dropConnection();
        return;
      }
      this.lastPong = Date.now();
      switch (m.type) {
        case MsgType.Ping:
          this.send({ type: MsgType.Pong, nonce: m.nonce });
          return;
        case MsgType.Pong:
          return;
        case MsgType.Welcome:
          this.connectionId = m.connectionId;
          // Stay at 80% of what the server enforces.
          this.msgPacer.rate = Math.max(1, m.msgRatePerSec * 0.8);
          this.msgPacer.capacity = Math.max(1, m.msgRatePerSec * 0.8);
          this.bytePacer.rate = Math.max(1024, m.byteRatePerSec * 0.8);
          this.bytePacer.capacity = Math.max(LIMITS.maxFrameBytes * 1.1, m.byteBurst * 0.8);
          return;
        case MsgType.Joined:
          this.backoff = this.opts.minBackoffMs ?? 250;
          break;
        case MsgType.Error:
          if (m.ch === 0) {
            this.opts.log?.("connection error", { code: m.code, message: m.message });
            if (m.code === ErrorCode.UnsupportedVersion) {
              // This build cannot talk to the server: stop and ask for a reload.
              this.stopped = true;
              this.setStatus("outdated", m.message);
            }
            return;
          }
          break;
        default:
          break;
      }
      if ("ch" in m && m.ch !== 0) this.docs.get(m.ch)?.handle(m);
    };
    ws.onclose = (ev) => this.onClosed(ws, ev.code, ev.reason);
    ws.onerror = () => {
      /* followed by close */
    };
  }

  // Once per second while connected: reconnect if a change has waited too
  // long for its Ack; periodically ask for anything we are missing.
  private checkHealth(ws: WebSocketLike) {
    if (ws !== this.ws || ws.readyState !== OPEN) return;
    const now = Date.now();
    const ackTimeout = this.opts.ackTimeoutMs ?? 30_000;
    // Large uploads are paced: do not count time spent in our own outbox.
    if (this.outbox.length === 0) {
      for (const h of this.docs.values()) {
        if (h.joined && h.oldestUnackedMs(now) > ackTimeout) {
          this.opts.log?.("acknowledgement timeout; reconnecting", { docId: h.docId });
          this.dropConnection();
          return;
        }
      }
    }
    const resync = this.opts.resyncIntervalMs ?? 60_000;
    if (resync > 0 && now - this.lastResync >= resync) {
      this.lastResync = now;
      for (const h of this.docs.values()) if (h.joined) this.send({ type: MsgType.Sync1, ch: h.ch, stateVector: Y.encodeStateVector(h.doc) });
    }
  }

  private onClosed(ws: WebSocketLike, code: number, reason: string) {
    if (ws !== this.ws) return;
    this.ws = undefined;
    this.lastCloseCode = code;
    this.outbox = [];
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.reassembler = new Reassembler(LIMITS.maxClientMessageBytes);
    for (const h of this.docs.values()) h.onDisconnected();
    if (this.status !== "outdated") this.setStatus("offline", reason);
    if (this.stopped) return;
    if (code === 4001) return; // unauthorized: the UI must log in again
    const delay = this.backoff * (0.5 + Math.random());
    this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs ?? 10_000);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** Drop the socket (simulating a network failure) and reconnect later. */
  dropConnection() {
    const ws = this.ws;
    if (!ws) return;
    ws.close(4100, "client drop");
    this.onClosed(ws, 4100, "client drop");
  }

  /** Reconnect now (e.g. when the browser comes back online). */
  reconnectNow() {
    if (this.ws || this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.connect();
  }

  destroy() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    for (const c of this.cleanups.values()) c();
    this.ws?.close(1000, "bye");
  }
}
