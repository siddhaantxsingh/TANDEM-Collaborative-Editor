// Crash test for the durability invariant "ACK means PostgreSQL commit".
//
// Raw protocol clients (no reconnect, no resend) stream small unique inserts
// into one document as fast as the server's operation limit allows and
// record which ones the server acknowledged. In each cycle one fault hits
// while writes are in flight:
//   * server: the server process is killed with SIGKILL (kill -9);
//   * pg:     PostgreSQL is crashed (SIGKILL of the postmaster and all
//             backends; WAL crash recovery on start) while writes are in
//             flight; after 0.5 s the server is SIGKILLed while PostgreSQL
//             is still down, then PostgreSQL is started again;
//   * pg-recover: PostgreSQL is crashed, restarted after 0.5 s while the
//             server keeps running (it must retry and acknowledge only what
//             it then commits), writes continue for 1 s, then the server is
//             SIGKILLed.
// Because the clients never resend, every acknowledged insert must have
// been committed before the Ack was sent. After each cycle the document is
// read back from PostgreSQL directly and every acknowledged token must be
// present exactly once. Unacknowledged tokens may or may not be present.
//
// Usage: npx tsx tools/crash-ack.ts [--cycles 10] [--clients 6] [--mode server|pg|pg-recover|all]
//        For the pg modes use a private cluster (tools/pg-crash-cluster.sh):
//        TEST_DATABASE_ADMIN_URL=postgres://postgres@127.0.0.1:5499/postgres
//        PG_KILL / PG_START override the crash and start commands.
//        Exit code 0 = pass.
// Prints one JSON summary line at the end.
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

import { decode, encode, type Message, MsgType } from "@tandem/protocol";
import pg from "pg";
import { WebSocket } from "ws";
import * as Y from "yjs";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const CYCLES = Number(args.get("cycles") ?? 10);
const CLIENTS = Number(args.get("clients") ?? 6);
const MODE = args.get("mode") ?? "server";
const ADMIN = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
const PG_KILL = process.env.PG_KILL ?? "tools/pg-crash-cluster.sh kill";
const PG_START = process.env.PG_START ?? "tools/pg-crash-cluster.sh start";
const MODES = ["server", "pg", "pg-recover"];
const PORT = 19300 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 23)}] ${m}`);

async function withClient<T>(url: string, f: (c: pg.Client) => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    const c = new pg.Client({ connectionString: url });
    try {
      await c.connect();
      try {
        return await f(c);
      } finally {
        await c.end();
      }
    } catch (e) {
      if (i >= 100) throw e;
      await sleep(200);
    }
  }
}

// The document's text exactly as stored (snapshot + every log row).
async function storedText(dbUrl: string, docId: string): Promise<string> {
  return withClient(dbUrl, async (c) => {
    const snap = await c.query("SELECT state FROM doc_snapshots WHERE doc_id = $1", [docId]);
    const rows = await c.query("SELECT update FROM doc_updates WHERE doc_id = $1 ORDER BY seq", [docId]);
    const d = new Y.Doc();
    for (const r of [...snap.rows.map((x) => x.state), ...rows.rows.map((x) => x.update)]) Y.applyUpdate(d, new Uint8Array(r as Buffer));
    return d.getText("content").toString();
  });
}

let server: ChildProcess | undefined;
function startServer(dbUrl: string) {
  server = spawn("node", ["packages/server/dist/main.js"], {
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATABASE_URL: dbUrl, REDIS_URL: "", LOG_LEVEL: "error", REGISTRATIONS_PER_HOUR: "10000", OP_RATE_PER_SEC: "200", OP_BURST: "400" },
    stdio: ["ignore", "inherit", "inherit"],
  });
}
async function ready() {
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(BASE + "/health/ready")).ok) return;
    } catch {
      /* starting */
    }
    await sleep(100);
  }
  throw new Error("server did not become ready");
}
function kill9() {
  const p = server;
  if (!p?.pid) return Promise.resolve();
  return new Promise<void>((resolve) => {
    p.once("exit", () => resolve());
    process.kill(p.pid!, "SIGKILL");
  });
}

// One raw client: its own Y.Doc, one Update per insert, never resends.
class Writer {
  doc = new Y.Doc();
  ws: WebSocket;
  seq = 0;
  sent = new Map<number, string>(); // seq -> token
  acked: string[] = [];
  joined = false;
  open = true;
  constructor(cookie: string, docId: string, readonly name: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { Cookie: cookie, Origin: BASE } });
    this.ws.on("open", () => {
      this.send({ type: MsgType.Hello, sessionId: `${name}-${randomBytes(4).toString("hex")}`, resume: 0 });
      this.send({ type: MsgType.Join, ch: 1, docId });
    });
    this.ws.on("message", (d: Buffer) => {
      let m: Message;
      try {
        m = decode(new Uint8Array(d));
      } catch {
        return;
      }
      if (m.type === MsgType.Joined) this.joined = true;
      if (m.type === MsgType.Ack && m.seq > 0) {
        const t = this.sent.get(m.seq);
        if (t) this.acked.push(t);
      }
    });
    this.ws.on("close", () => (this.open = false));
    this.ws.on("error", () => {});
  }
  send(m: Message) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encode(m));
  }
  // Insert a unique token at the end of this client's own replica (other
  // clients' updates are not applied: tokens never interleave inside each
  // other, and each update depends only on this client's earlier ones).
  write(cycle: number) {
    if (!this.joined || !this.open) return;
    const seq = ++this.seq;
    const token = `<${this.name}.${cycle}.${seq}>`;
    let update: Uint8Array | undefined;
    const h = (u: Uint8Array) => (update = u);
    this.doc.on("update", h);
    const t = this.doc.getText("content");
    t.insert(t.length, token);
    this.doc.off("update", h);
    this.sent.set(seq, token);
    this.send({ type: MsgType.Update, ch: 1, seq, update: update! });
  }
}

async function main() {
  const dbName = "tandem_crash_" + randomBytes(3).toString("hex");
  await withClient(ADMIN, (c) => c.query(`CREATE DATABASE ${dbName}`));
  const u = new URL(ADMIN);
  u.pathname = "/" + dbName;
  const dbUrl = u.toString();
  startServer(dbUrl);
  await ready();
  const req = async (method: string, path: string, body: unknown, cookie = "") => {
    const r = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", Origin: BASE, Cookie: cookie }, body: JSON.stringify(body) });
    return { json: (await r.json()) as any, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? cookie };
  };
  const reg = await req("POST", "/api/auth/register", { email: `crash_${randomBytes(3).toString("hex")}@x.io`, password: "crash crash crash", name: "crash" });
  const cookie = reg.cookie;
  const ws = await req("POST", "/api/workspaces", { name: "crash" }, cookie);
  const docId = (await req("POST", `/api/workspaces/${ws.json.workspace.id}/documents`, { path: "crash.txt" }, cookie)).json.document.id as string;

  const allAcked: string[] = [];
  let totalSent = 0;
  let unackedPresent = 0;
  const failures: string[] = [];
  const cycles: unknown[] = [];
  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    const mode = MODE === "all" ? MODES[(cycle - 1) % MODES.length]! : MODE;
    const writers = Array.from({ length: CLIENTS }, (_, i) => new Writer(cookie, docId, `w${i}`));
    for (let i = 0; i < 100 && !writers.every((w) => w.joined); i++) await sleep(50);
    // ~100 inserts/s per client, until the fault.
    const timer = setInterval(() => writers.forEach((w) => w.write(cycle)), 10);
    const faultAfter = 300 + Math.floor(Math.random() * 1200);
    await sleep(faultAfter);
    if (mode === "server") {
      await kill9();
    } else if (mode === "pg") {
      execSync(PG_KILL, { stdio: "ignore" });
      await sleep(500); // writes keep arriving; acks must be withheld
      await kill9(); // the server dies with unpersisted, unacknowledged edits
      execSync(PG_START, { stdio: "ignore" });
    } else if (mode === "pg-recover") {
      execSync(PG_KILL, { stdio: "ignore" });
      await sleep(500);
      execSync(PG_START, { stdio: "ignore" }); // crash recovery; the server retries
      await sleep(1000);
      await kill9();
    } else throw new Error(`unknown mode ${mode}`);
    clearInterval(timer);
    for (const w of writers) w.ws.terminate();
    const sent = writers.reduce((n, w) => n + w.seq, 0);
    const acked = writers.flatMap((w) => w.acked);
    totalSent += sent;
    allAcked.push(...acked);
    // Read back from PostgreSQL directly.
    const text = await storedText(dbUrl, docId);
    const missing = allAcked.filter((t) => text.split(t).length - 1 !== 1);
    const ackedSet = new Set(acked);
    const unackedHere = writers.flatMap((w) => [...w.sent.values()]).filter((t) => !ackedSet.has(t));
    const present = unackedHere.filter((t) => text.includes(t)).length;
    unackedPresent += present;
    cycles.push({ cycle, mode, faultAfterMs: faultAfter, sent, acked: acked.length, unacked: unackedHere.length, unackedButStored: present, missingAcked: missing.length });
    log(`cycle ${cycle} (${mode}): sent ${sent}, acked ${acked.length}, unacked ${unackedHere.length} (stored anyway: ${present}), acked missing from DB: ${missing.length}`);
    if (missing.length) failures.push(`cycle ${cycle}: ${missing.length} acknowledged inserts missing, e.g. ${missing.slice(0, 3).join(" ")}`);
    startServer(dbUrl);
    await ready();
  }
  await kill9();
  await withClient(ADMIN, (c) => c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)).catch(() => {});
  const summary = { pass: failures.length === 0, mode: MODE, cycles: CYCLES, clients: CLIENTS, sent: totalSent, acked: allAcked.length, unackedButStored: unackedPresent, failures, perCycle: cycles };
  console.log(JSON.stringify(summary));
  process.exit(summary.pass ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await kill9().catch(() => {});
  process.exit(2);
});
