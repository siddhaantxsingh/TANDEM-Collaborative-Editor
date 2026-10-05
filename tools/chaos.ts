// Chaos test: clients edit continuously while faults are injected:
//   - a network partition (a TCP proxy in front of node 1 stops forwarding in
//     both directions without closing: half-open sockets, heartbeat timeouts)
//   - added latency (the proxy delays every chunk, order preserved)
//   - a reconnect storm (every client drops its socket at once)
//   - SIGKILL of a server node and restart
//   - Redis restart, PostgreSQL stop/start (when the commands are given)
// For each fault it records, from the moment the fault is healed, how long
// until every client is joined again and has every edit made before that
// moment (propagation), and until every update sent before that moment is
// acknowledged, i.e. committed (durability).
// Afterwards every replica must converge, every insert must be present
// exactly once, every edit must be acknowledged and the database must match.
// Prints one JSON object; exit code 0 = pass.
//
// Requires: built server (npm run build), PostgreSQL and Redis reachable.
// PG_STOP / PG_START / REDIS_RESTART are shell commands for the environment
// (steps are skipped when unset).
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";

import { TandemConnection, type WebSocketLike } from "@tandem/protocol/client";
import pg from "pg";
import { WebSocket } from "ws";
import * as Y from "yjs";

const ADMIN = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
const REDIS = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const PG_STOP = process.env.PG_STOP;
const PG_START = process.env.PG_START;
const REDIS_RESTART = process.env.REDIS_RESTART;
const PORTS = [19101, 19102];
const PROXY_PORT = 19100; // in front of PORTS[0]

const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function adminQuery(sql: string) {
  for (let i = 0; i < 50; i++) {
    try {
      const c = new pg.Client({ connectionString: ADMIN });
      await c.connect();
      await c.query(sql);
      await c.end();
      return;
    } catch (e) {
      if (i === 49) throw e;
      await sleep(200);
    }
  }
}

// TCP proxy with a "partitioned" switch (stop reading in both directions:
// bytes wait in kernel buffers, nothing is closed) and an added delay.
class FaultProxy {
  partitioned = false;
  delayMs = 0;
  private pairs = new Set<{ a: net.Socket; b: net.Socket }>();
  private server: net.Server;
  constructor(listen: number, target: number) {
    this.server = net.createServer((a) => {
      const b = net.connect(target, "127.0.0.1");
      const pair = { a, b };
      this.pairs.add(pair);
      const pipe = (from: net.Socket, to: net.Socket) =>
        from.on("data", (chunk) => {
          if (this.delayMs === 0) to.write(chunk);
          else {
            from.pause(); // keep order: one chunk in flight per direction
            setTimeout(() => {
              to.write(chunk);
              if (!this.partitioned) from.resume();
            }, this.delayMs);
          }
        });
      pipe(a, b);
      pipe(b, a);
      if (this.partitioned) (a.pause(), b.pause());
      const end = () => {
        a.destroy();
        b.destroy();
        this.pairs.delete(pair);
      };
      a.on("close", end).on("error", end);
      b.on("close", end).on("error", end);
    });
    this.server.listen(listen, "127.0.0.1");
  }
  partition(on: boolean) {
    this.partitioned = on;
    for (const { a, b } of this.pairs) on ? (a.pause(), b.pause()) : (a.resume(), b.resume());
  }
  close() {
    this.server.close();
    for (const { a, b } of this.pairs) (a.destroy(), b.destroy());
  }
}

async function main() {
  const dbName = "tandem_chaos_" + randomBytes(3).toString("hex");
  await adminQuery(`CREATE DATABASE ${dbName}`);
  const u = new URL(ADMIN);
  u.pathname = "/" + dbName;
  const dbUrl = u.toString();

  const nodes = new Map<number, ChildProcess>();
  const startNode = (port: number) => {
    const p = spawn("node", ["packages/server/dist/main.js"], {
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", NODE_ID: `c${port}`, DATABASE_URL: dbUrl, REDIS_URL: REDIS, LOG_LEVEL: "error", DURABILITY_SWEEP_MS: "3000", HEARTBEAT_MS: "3000", REGISTRATIONS_PER_HOUR: "10000" },
      stdio: ["ignore", "inherit", "inherit"],
    });
    nodes.set(port, p);
  };
  const ready = async (port: number) => {
    for (let i = 0; i < 300; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health/live`)).ok) return;
      } catch {
        /* starting */
      }
      await sleep(100);
    }
    throw new Error(`node ${port} did not start`);
  };
  PORTS.forEach(startNode);
  await Promise.all(PORTS.map(ready));
  const proxy = new FaultProxy(PROXY_PORT, PORTS[0]!);

  const base = `http://127.0.0.1:${PORTS[1]}`;
  const req = async (method: string, path: string, body: unknown, cookie = "") => {
    const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie }, body: JSON.stringify(body) });
    return { json: (await r.json()) as any, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? cookie };
  };
  const reg = await req("POST", "/api/auth/register", { email: `chaos_${randomBytes(3).toString("hex")}@x.io`, password: "chaos chaos chaos", name: "chaos" });
  const cookie = reg.cookie;
  const ws = await req("POST", "/api/workspaces", { name: "chaos" }, cookie);
  const doc = await req("POST", `/api/workspaces/${ws.json.workspace.id}/documents`, { path: "chaos.txt" }, cookie);
  const docId = doc.json.document.id as string;

  const clients = Array.from({ length: 8 }, (_, i) => {
    const port = i % 2 === 0 ? PROXY_PORT : PORTS[1]!;
    const ydoc = new Y.Doc();
    const conn = new TandemConnection({
      url: `ws://127.0.0.1:${port}/ws`,
      createSocket: (url) => new WebSocket(url, { headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}` } }) as unknown as WebSocketLike,
      minBackoffMs: 100,
      maxBackoffMs: 1000,
      pingIntervalMs: 2000,
    });
    return { conn, ydoc, handle: conn.open(docId, ydoc), text: ydoc.getText("content") };
  });
  const words: string[] = [];
  let k = 0;
  let editing = true;
  const editor = setInterval(() => {
    if (!editing) return;
    for (const c of clients) {
      const w = `<${k++}>`;
      words.push(w);
      c.text.insert(Math.random() < 0.5 ? 0 : c.text.length, w); // words never split each other
    }
  }, 50);

  // Each fault: inject, (optionally) hold, heal, then measure the time from
  // healing until every client is joined again and has received every edit
  // that any client had made by the time of healing.
  const events: { fault: string; recoveredMs: number | null; durableMs: number | null }[] = [];
  const allJoined = () => clients.every((c) => c.handle.joined);
  const fault = async (name: string, inject: () => void | Promise<void>, heal: () => void | Promise<void> = () => {}, holdMs = 0) => {
    log(name);
    await inject();
    if (holdMs) await sleep(holdMs);
    await heal();
    const healed = Date.now();
    // Every client's edits up to now must have reached every other client.
    const clocks = clients.map((c) => [c.ydoc.clientID, Y.getState(c.ydoc.store, c.ydoc.clientID)] as const);
    const caughtUp = () => clients.every((c) => clocks.every(([id, clock]) => Y.getState(c.ydoc.store, id) >= clock));
    // ...and every update a client sent before healing is acknowledged
    // (committed to PostgreSQL).
    const durable = () => clients.every((c) => c.handle.joined && c.handle.oldestUnackedMs(Date.now()) < Date.now() - healed);
    let recoveredMs: number | null = null;
    let durableMs: number | null = null;
    while (Date.now() - healed < 60_000 && (recoveredMs === null || durableMs === null)) {
      if (recoveredMs === null && allJoined() && caughtUp()) recoveredMs = Date.now() - healed;
      if (durableMs === null && durable()) durableMs = Date.now() - healed;
      await sleep(20);
    }
    log(`  propagation recovered in ${recoveredMs ?? "TIMEOUT"} ms, acknowledgements in ${durableMs ?? "TIMEOUT"} ms`);
    events.push({ fault: name, recoveredMs, durableMs });
    await sleep(1500);
  };
  await sleep(2000);
  await fault("network partition of node 1 for 8 s (half-open sockets)", () => proxy.partition(true), () => proxy.partition(false), 8000);
  await fault("200 ms added latency on node 1 for 5 s", () => void (proxy.delayMs = 200), () => void (proxy.delayMs = 0), 5000);
  await fault("reconnect storm (all clients drop at once)", () => clients.forEach((c) => c.conn.dropConnection()));
  await fault(`SIGKILL node ${PORTS[0]}, restart after 3 s`, () => void nodes.get(PORTS[0]!)!.kill("SIGKILL"), async () => {
    await sleep(3000);
    startNode(PORTS[0]!);
    await ready(PORTS[0]!);
  });
  if (REDIS_RESTART) await fault("restart Redis", () => void execSync(REDIS_RESTART, { stdio: "inherit" }));
  if (PG_STOP && PG_START)
    await fault("stop PostgreSQL for 4 s", () => void execSync(PG_STOP, { stdio: "inherit" }), () => void execSync(PG_START, { stdio: "inherit" }), 4000);
  await fault(`SIGKILL node ${PORTS[1]}, restart after 1.5 s`, () => void nodes.get(PORTS[1]!)!.kill("SIGKILL"), async () => {
    await sleep(1500);
    startNode(PORTS[1]!);
    await ready(PORTS[1]!);
  });
  editing = false;
  clearInterval(editor);
  log(`stopped editing after ${words.length} inserts; waiting for convergence`);

  const deadline = Date.now() + 90_000;
  const settled = () => clients.every((c) => c.handle.joined && c.handle.unsaved === 0);
  const equal = () => clients.every((c) => c.text.toString() === clients[0]!.text.toString());
  while (!(settled() && equal()) && Date.now() < deadline) await sleep(200);
  const final = clients[0]!.text.toString();
  const missing = words.filter((w) => final.split(w).length - 1 !== 1);
  const stored = await (await fetch(`${base}/api/documents/${docId}/content`, { headers: { Cookie: cookie } })).text();
  const result = {
    events,
    inserts: words.length,
    allSaved: settled(),
    converged: equal(),
    missingOrDuplicated: missing.length,
    databaseMatches: stored === final,
  };
  console.log(JSON.stringify(result, null, 2));
  for (const c of clients) c.conn.destroy();
  proxy.close();
  for (const p of nodes.values()) p.kill("SIGTERM");
  await sleep(1500);
  await adminQuery(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  process.exit(result.allSaved && result.converged && result.missingOrDuplicated === 0 && result.databaseMatches && events.every((e) => e.recoveredMs !== null && e.durableMs !== null) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
