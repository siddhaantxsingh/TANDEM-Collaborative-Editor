// Composition root: builds the server from a Config. Used by main.ts and by
// the integration tests (which start several instances in one process).
import { createServer, type Server } from "node:http";

import { LocalBus, RedisBus, type Bus } from "./bus.js";
import type { Config } from "./config.js";
import { createDb, migrate, type Db } from "./db.js";
import { HttpApi } from "./http.js";
import { createLogger, type Logger } from "./logger.js";
import { Metrics } from "./metrics.js";
import { LocalLimiter, RedisLimiter, type AsyncLimiter } from "./ratelimit.js";
import { RoomManager } from "./rooms.js";
import { WsEndpoint } from "./ws.js";

export interface App {
  server: Server;
  db: Db;
  bus: Bus;
  rooms: RoomManager;
  ws: WsEndpoint;
  metrics: Metrics;
  log: Logger;
  listen(): Promise<number>;
  close(): Promise<void>;
}

export async function createApp(cfg: Config, opts: { log?: Logger } = {}): Promise<App> {
  const metrics = new Metrics();
  const baseLog = opts.log ?? createLogger(cfg.logLevel, { node: cfg.nodeId });
  const log = countingLogger(baseLog, metrics);
  const db = createDb(cfg.databaseUrl);
  db.on("error", (err) => log.error("database pool error", { err: err.message }));
  instrumentDb(db, metrics);
  const applied = await migrate(db);
  if (applied.length) log.info("migrations applied", { applied });
  const bus: Bus = cfg.redisUrl
    ? new RedisBus(cfg.nodeId, cfg.redisUrl, log, (op, s) => metrics.redisLatency.observe(s, { op }))
    : new LocalBus(cfg.nodeId);
  const rooms = new RoomManager(db, bus, cfg, log, metrics);
  if (bus instanceof RedisBus) bus.onReconnect = () => rooms.resyncAll();
  const ws = new WsEndpoint(db, rooms, cfg, log, metrics);
  // Login / registration limits, shared between nodes through Redis.
  const limiter = (name: string, perWindow: number, windowMs: number): AsyncLimiter => {
    const local = new LocalLimiter(perWindow, windowMs);
    if (!(bus instanceof RedisBus)) return local;
    return new RedisLimiter(bus.pub, name, perWindow, windowMs, local, (err) => {
      metrics.errors.inc({ component: "rate_limiter" });
      log.warn("shared rate limiter unavailable; using the local one", { err: err.message });
    });
  };
  const perMin = cfg.loginAttemptsPerMinute;
  const limiters = {
    loginIp: limiter("login-ip", perMin, 60_000),
    loginEmail: limiter("login-email", Math.max(1, Math.floor(perMin / 2)), 60_000),
    registerIp: limiter("register-ip", Math.max(1, cfg.registrationsPerHour), 3_600_000),
  };
  const api = new HttpApi(db, rooms, bus, cfg, log, metrics, limiters, {
    session: (h) => ws.closeSession(h, "logout"),
    user: (userId) => ws.closeUser(userId, "logout_all"),
  });
  // Revocations made through another node (closing twice is harmless).
  bus.onControl((e) => {
    if (e.type === "session-revoked") ws.closeSession(e.tokenHash, "logout");
    else if (e.type === "user-sessions-revoked") ws.closeUser(e.userId, "logout_all");
  });
  // Expired sessions are useless and only grow the table.
  const cleanup = async () => {
    try {
      const r = await db.query("DELETE FROM sessions WHERE expires_at < now()");
      if (r.rowCount) metrics.sessionsExpired.inc({}, r.rowCount);
    } catch (err) {
      log.warn("session cleanup failed", { err: (err as Error).message });
    }
  };
  const cleanupTimer = cfg.sessionCleanupMs > 0 ? setInterval(() => void cleanup(), cfg.sessionCleanupMs) : undefined;
  cleanupTimer?.unref();
  if (cfg.sessionCleanupMs > 0) void cleanup();
  let shuttingDown = false;

  const health = async () => {
    const checks: Record<string, boolean> = { accepting: !shuttingDown };
    try {
      await db.query("SELECT 1");
      checks.database = true;
    } catch {
      checks.database = false;
    }
    checks.bus = await bus.healthy();
    return { ok: Object.values(checks).every(Boolean), checks };
  };

  const server = createServer((req, res) => void api.handle(req, res, health));
  server.on("upgrade", (req, socket, head) => void ws.handleUpgrade(req, socket, head));
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;

  return {
    server,
    db,
    bus,
    rooms,
    ws,
    metrics,
    log,
    listen: () =>
      new Promise((resolve) => {
        server.listen(cfg.port, cfg.host, () => {
          const addr = server.address();
          resolve(typeof addr === "object" && addr ? addr.port : cfg.port);
        });
      }),
    // Graceful shutdown: stop accepting, close sockets (clients reconnect to
    // another node), write every pending update, compact, close pools.
    close: async () => {
      shuttingDown = true;
      if (cleanupTimer) clearInterval(cleanupTimer);
      const t0 = Date.now();
      const step = (name: string) => log.info("shutdown step done", { step: name, ms: Date.now() - t0 });
      ws.closeAll();
      // Stop accepting; idle keep-alive connections are closed now, busy ones
      // get a grace period and are then closed forcibly so that shutdown is
      // bounded (a client reconnecting during shutdown, a stuck request).
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      const grace = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), cfg.shutdownGraceMs).unref());
      if ((await Promise.race([closed, grace])) === "timeout") {
        const open = await new Promise<number>((resolve) => server.getConnections((_e, n) => resolve(n)));
        log.warn("connections still open after the grace period; closing them", { open, websockets: ws.connectionCount });
        ws.terminateAll();
        server.closeAllConnections();
        await closed;
      }
      step("http");
      await rooms.shutdown();
      step("documents flushed");
      await bus.close();
      await db.end();
      step("connections closed");
    },
  };
}

// Count warnings and errors (an alerting signal that needs no log pipeline).
function countingLogger(inner: Logger, metrics: Metrics): Logger {
  return {
    debug: inner.debug,
    info: inner.info,
    warn: (m, f) => {
      metrics.logLines.inc({ level: "warn" });
      inner.warn(m, f);
    },
    error: (m, f) => {
      metrics.logLines.inc({ level: "error" });
      inner.error(m, f);
    },
    child: (fields) => countingLogger(inner.child(fields), metrics),
  };
}

// Time every pool query (transactions on checked-out clients are not
// included; they are the compaction and membership paths, timed elsewhere).
function instrumentDb(db: Db, metrics: Metrics) {
  const query = db.query.bind(db) as (...a: unknown[]) => Promise<unknown>;
  (db as unknown as { query: (...a: unknown[]) => Promise<unknown> }).query = (...args: unknown[]) => {
    const t0 = performance.now();
    const p = query(...args);
    void p.then(
      () => metrics.dbLatency.observe((performance.now() - t0) / 1000),
      () => metrics.errors.inc({ component: "database" }),
    );
    return p;
  };
}
