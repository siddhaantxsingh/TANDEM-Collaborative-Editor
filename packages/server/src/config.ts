// Configuration from environment variables (12-factor). Every value has a
// safe default for local development; production settings are documented in
// docs/DEPLOYMENT.md.
import { randomUUID } from "node:crypto";

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  redisUrl: string | undefined; // unset = single-node mode
  nodeId: string;
  allowedOrigins: string[]; // empty = same host only
  cookieSecure: boolean;
  sessionTtlHours: number;
  staticDir: string | undefined; // built client to serve, if any
  logLevel: "debug" | "info" | "warn" | "error";
  compactEvery: number; // compact a document after this many stored updates
  roomIdleMs: number; // unload a document this long after its last client left
  maxConnections: number;
  maxConnectionsPerDoc: number;
  maxDocumentBytes: number; // encoded size limit of one document
  sendBufferLimit: number; // bytes queued to one socket before it is dropped (> maxDocumentBytes)
  globalSendBudget: number; // bytes queued on all sockets together before new sends are refused
  globalReassemblyBudget: number; // bytes of partially received large messages on all sockets
  inboundQueueMessages: number; // messages received but not yet handled, per connection
  inboundQueueBytes: number; // bytes of such messages, per connection
  opRatePerSec: number; // document updates (Update, Sync2) per connection
  opBurst: number;
  handshakeTimeoutMs: number; // time a new socket has to send Hello
  shutdownGraceMs: number; // time open connections get to finish on shutdown
  trustProxy: boolean; // take the client address from X-Forwarded-For (behind a proxy only)
  metricsToken: string | undefined; // bearer token for /metrics; unset = local requests only
  sessionCleanupMs: number; // interval of expired-session deletion (0 = off)
  msgRatePerSec: number;
  msgBurst: number;
  byteRatePerSec: number;
  byteBurst: number;
  loginAttemptsPerMinute: number;
  registrationsPerHour: number;
  heartbeatMs: number;
  durabilitySweepMs: number; // 0 = off
}

function int(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`invalid integer in ${name}: ${v}`);
  return n;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = process.env;
  const level = (env.LOG_LEVEL ?? "info") as Config["logLevel"];
  if (!["debug", "info", "warn", "error"].includes(level)) throw new Error(`invalid LOG_LEVEL ${level}`);
  return {
    port: int("PORT", 8080),
    host: env.HOST ?? "0.0.0.0",
    databaseUrl: env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/tandem",
    redisUrl: env.REDIS_URL || undefined,
    nodeId: env.NODE_ID ?? randomUUID().slice(0, 8),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    cookieSecure: env.COOKIE_SECURE === "true",
    sessionTtlHours: int("SESSION_TTL_HOURS", 24 * 7),
    staticDir: env.STATIC_DIR || undefined,
    logLevel: level,
    compactEvery: int("COMPACT_EVERY", 500),
    roomIdleMs: int("ROOM_IDLE_MS", 30_000),
    maxConnections: int("MAX_CONNECTIONS", 5_000),
    maxConnectionsPerDoc: int("MAX_CONNECTIONS_PER_DOC", 200),
    maxDocumentBytes: int("MAX_DOCUMENT_BYTES", 8 * 1024 * 1024),
    sendBufferLimit: int("SEND_BUFFER_LIMIT", 16 * 1024 * 1024),
    globalSendBudget: int("GLOBAL_SEND_BUDGET", 512 * 1024 * 1024),
    globalReassemblyBudget: int("GLOBAL_REASSEMBLY_BUDGET", 256 * 1024 * 1024),
    inboundQueueMessages: int("INBOUND_QUEUE_MESSAGES", 1000),
    inboundQueueBytes: int("INBOUND_QUEUE_BYTES", 4 * 1024 * 1024),
    opRatePerSec: int("OP_RATE_PER_SEC", 100),
    opBurst: int("OP_BURST", 300),
    handshakeTimeoutMs: int("HANDSHAKE_TIMEOUT_MS", 10_000),
    shutdownGraceMs: int("SHUTDOWN_GRACE_MS", 5_000),
    trustProxy: env.TRUST_PROXY === "true",
    metricsToken: env.METRICS_TOKEN || undefined,
    sessionCleanupMs: int("SESSION_CLEANUP_MS", 3_600_000),
    msgRatePerSec: int("MSG_RATE_PER_SEC", 200),
    msgBurst: int("MSG_BURST", 400),
    byteRatePerSec: int("BYTE_RATE_PER_SEC", 1024 * 1024),
    byteBurst: int("BYTE_BURST", 4 * 1024 * 1024),
    loginAttemptsPerMinute: int("LOGIN_ATTEMPTS_PER_MINUTE", 10),
    registrationsPerHour: int("REGISTRATIONS_PER_HOUR", 20),
    heartbeatMs: int("HEARTBEAT_MS", 30_000),
    durabilitySweepMs: int("DURABILITY_SWEEP_MS", 15_000),
    ...overrides,
  };
}
