// Load test: N simulated editors (headless Yjs clients using the real client
// engine over real WebSockets) edit shared documents concurrently. Measures,
// and prints as one JSON object:
//   - connection setup: time from open() to the first completed sync, failures
//   - achieved edit rate
//   - propagation latency (edit created -> observed by another client) and
//     acknowledgement latency (update sent -> server Ack, i.e. committed to
//     PostgreSQL), p50/p95/p99
//   - per node, from /metrics deltas: messages in/out per second, CPU %,
//     peak RSS, worst event-loop lag p99
//   - the load generator's own CPU % and event-loop lag (it shares the machine)
//   - optional reconnect storm (--storm 1): every client drops its socket at the
//     same moment and makes one edit while disconnected; reports the time until
//     all are re-joined, all edits are acknowledged and every replica agrees
//   - final convergence of all replicas and agreement with the database
//
// The clients run in --workers child processes (default: 1 per 250 clients,
// at most the number of CPUs) so that a single generator event loop does not
// become the bottleneck. All clients of one document live in the same worker,
// which measures latency and checks convergence for its documents.
//
// Usage:
//   npx tsx tools/loadtest.ts --urls http://127.0.0.1:8080[,http://...] \
//     --clients 100 [--docs 10] --seconds 30 --rate 2 [--storm 1] [--workers N] [--active 0.1]
//     [--metrics-urls http://node1:8080,...|none] [--metrics-token T]
// Exit code 0 only if every check passed.
import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { availableParallelism } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";

import { TandemConnection, type WebSocketLike } from "@tandem/protocol/client";
import { WebSocket } from "ws";
import * as Y from "yjs";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const urls = (args.get("urls") ?? args.get("url") ?? "http://127.0.0.1:8080").split(",");
const CLIENTS = Number(args.get("clients") ?? 20);
const DOCS = Math.max(1, Number(args.get("docs") ?? Math.ceil(CLIENTS / 10)));
const SECONDS = Number(args.get("seconds") ?? 20);
const RATE = Number(args.get("rate") ?? 2); // edits per second per client
const STORM = args.get("storm") === "1";
const ACTIVE = Number(args.get("active") ?? 1); // fraction of clients that edit; the rest only stay connected and receive
const WORKERS = Math.max(1, Math.min(DOCS, Number(args.get("workers") ?? Math.min(availableParallelism(), Math.ceil(CLIENTS / 250)))));
const CONNECT_CONCURRENCY = Number(args.get("connect-concurrency") ?? 100);
const METRICS_TOKEN = args.get("metrics-token") ?? process.env.METRICS_TOKEN ?? "";
// Where to scrape /metrics (behind a load balancer the nodes are scraped
// directly); "none" skips server measurements.
const METRICS_URLS = (args.get("metrics-urls") ?? urls.join(",")).split(",").filter((u) => u && u !== "none");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- messages between coordinator and workers ------------------------------
type ToWorker =
  | { cmd: "connect"; cookie: string; docIds: string[]; clientIdx: number[] }
  | { cmd: "edit"; seconds: number }
  | { cmd: "settle" }
  | { cmd: "storm" }
  | { cmd: "dbcheck" }
  | { cmd: "exit" };
type FromWorker =
  | { ev: "connected"; failed: number; connectMs: number[] }
  | { ev: "edited"; edits: number; editSeconds: number }
  | { ev: "settled"; saved: boolean; converged: boolean; settleMs: number; propagation: number[]; acks: number[]; cpuSeconds: number; lagP99Ms: number; unsettled: Record<string, number> }
  | { ev: "stormed"; rejoinedMs: number | null; recoveredMs: number | null; offlineEditsPresent: boolean }
  | { ev: "dbchecked"; matches: boolean };

// ============================================================================
// Worker: runs a set of clients
// ============================================================================
async function worker() {
  const send = (m: FromWorker) => process.send!(m);
  const genLag = monitorEventLoopDelay({ resolution: 10 });
  genLag.enable();
  const propagation: number[] = [];
  const acks: number[] = [];
  const connectMs: number[] = [];
  const sentAt = new Map<string, number>();
  let measuring = false;
  let cookie = "";
  let docIds: string[] = [];

  const makeClient = (i: number) => {
    const url = urls[i % urls.length]!;
    const doc = new Y.Doc();
    const docId = docIds[i % DOCS]!;
    const conn = new TandemConnection({
      url: url.replace(/^http/, "ws") + "/ws",
      createSocket: (u) => new WebSocket(u, { headers: { Cookie: cookie, Origin: url } }) as unknown as WebSocketLike,
      minBackoffMs: 100,
      maxBackoffMs: 2000,
    });
    const opened = performance.now();
    const handle = conn.open(docId, doc, undefined);
    let syncs = 0;
    handle.on("synced", () => {
      if (syncs++ === 0) connectMs.push(performance.now() - opened);
    });
    handle.on("ack", (ms) => {
      if (measuring) acks.push(ms);
    });
    const text = doc.getText("content");
    text.observe((ev) => {
      if (ev.transaction.local || !measuring) return;
      for (const d of ev.changes.delta) {
        if (typeof d.insert !== "string") continue;
        for (const m of d.insert.matchAll(/\{(\w+)\}/g)) {
          const t = sentAt.get(m[1]!);
          if (t) propagation.push(performance.now() - t);
        }
      }
    });
    return { i, conn, doc, handle, text, docId };
  };
  type Client = ReturnType<typeof makeClient>;
  const clients: Client[] = [];
  const allSaved = () => clients.every((c) => c.handle.joined && c.handle.unsaved === 0);
  const converged = () => {
    const first = new Map<string, string>();
    for (const c of clients) {
      const s = c.text.toString();
      if (!first.has(c.docId)) first.set(c.docId, s);
      else if (first.get(c.docId) !== s) return false;
    }
    return true;
  };
  let cpu0 = process.cpuUsage();
  let tEdit = 0;
  // Why clients are not settled (empty when all are).
  const diagnose = () => {
    const out: Record<string, number> = {};
    const inc = (k: string) => (out[k] = (out[k] ?? 0) + 1);
    for (const c of clients) {
      if (!c.handle.joined) inc(`notJoined:${c.conn.status}`);
      else if (c.handle.unsaved > 0) inc("unsaved");
      if (c.handle.rejected) inc(`rejected:${c.handle.rejected.code}`);
    }
    return out;
  };

  process.on("message", async (m: ToWorker) => {
    if (m.cmd === "connect") {
      cookie = m.cookie;
      docIds = m.docIds;
      let failed = 0;
      for (let k = 0; k < m.clientIdx.length; k += CONNECT_CONCURRENCY) {
        const batch = m.clientIdx.slice(k, k + CONNECT_CONCURRENCY).map(makeClient);
        clients.push(...batch);
        const t = performance.now();
        while (!batch.every((c) => c.handle.synced) && performance.now() - t < 60_000) await sleep(20);
        failed += batch.filter((c) => !c.handle.synced).length;
      }
      send({ ev: "connected", failed, connectMs });
    } else if (m.cmd === "edit") {
      cpu0 = process.cpuUsage();
      genLag.reset();
      measuring = true;
      tEdit = performance.now();
      let edits = 0;
      const end = Date.now() + m.seconds * 1000;
      // Clients 0..k-1 edit: with k >= DOCS every document has an editor.
      const editors = clients.filter((c) => c.i < Math.round(CLIENTS * ACTIVE));
      const starts = editors.map((c) =>
        setTimeout(
          () => {
            const tick = setInterval(() => {
              if (Date.now() > end) return clearInterval(tick);
              const len = c.text.length;
              if (len > 400 && Math.random() < 0.3) c.text.delete(Math.floor(Math.random() * (len - 10)), 5);
              else {
                const id = randomBytes(4).toString("hex");
                sentAt.set(id, performance.now());
                c.text.insert(Math.floor(Math.random() * (len + 1)), `{${id}}`);
              }
              edits++;
            }, 1000 / RATE);
          },
          Math.random() * (1000 / RATE), // spread clients over the interval
        ),
      );
      await sleep(m.seconds * 1000 + 1000 / RATE);
      starts.forEach(clearTimeout);
      send({ ev: "edited", edits, editSeconds: (performance.now() - tEdit) / 1000 });
    } else if (m.cmd === "settle") {
      const t = performance.now();
      while (!(allSaved() && converged()) && performance.now() - t < 120_000) await sleep(50);
      const settleMs = performance.now() - t;
      measuring = false;
      const cpu = process.cpuUsage(cpu0);
      send({
        ev: "settled",
        saved: allSaved(),
        converged: converged(),
        settleMs,
        propagation,
        acks,
        cpuSeconds: (cpu.user + cpu.system) / 1e6,
        lagP99Ms: genLag.percentile(99) / 1e6,
        unsettled: diagnose(),
      });
    } else if (m.cmd === "storm") {
      const ts = performance.now();
      for (const c of clients) {
        c.conn.dropConnection();
        c.text.insert(0, `<${c.i}>`); // an edit made while disconnected
      }
      let rejoinedMs: number | null = null;
      while (performance.now() - ts < 120_000) {
        if (rejoinedMs === null && clients.every((c) => c.handle.joined)) rejoinedMs = performance.now() - ts;
        if (allSaved() && converged()) break;
        await sleep(20);
      }
      const ok = allSaved() && converged();
      const byDoc = new Map(clients.map((c) => [c.docId, c.text.toString()]));
      send({
        ev: "stormed",
        rejoinedMs,
        recoveredMs: ok ? performance.now() - ts : null,
        offlineEditsPresent: clients.every((c) => byDoc.get(c.docId)!.includes(`<${c.i}>`)),
      });
    } else if (m.cmd === "dbcheck") {
      let matches = true;
      for (const [docId, local] of new Map(clients.map((c) => [c.docId, c.text.toString()]))) {
        const r = await fetch(`${urls[0]}/api/documents/${docId}/content`, { headers: { Cookie: cookie } });
        if ((await r.text()) !== local) matches = false;
      }
      send({ ev: "dbchecked", matches });
    } else if (m.cmd === "exit") {
      clients.forEach((c) => c.conn.destroy());
      setTimeout(() => process.exit(0), 100);
    }
  });
}

// ============================================================================
// Coordinator
// ============================================================================
async function http(base: string, method: string, path: string, body: unknown, cookie = "") {
  const r = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as any, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? cookie };
}

function pct(xs: number[], p: number) {
  if (xs.length === 0) return null;
  const s = Float64Array.from(xs).sort();
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! * 10) / 10;
}
const dist = (xs: number[]) => ({ samples: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: pct(xs, 100) });

type Scrape = Map<string, number>; // metric name -> sum over label sets
async function scrape(base: string): Promise<Scrape> {
  const r = await fetch(base + "/metrics", { headers: METRICS_TOKEN ? { Authorization: `Bearer ${METRICS_TOKEN}` } : {} });
  if (r.status !== 200) throw new Error(`/metrics on ${base}: HTTP ${r.status}`);
  const out: Scrape = new Map();
  for (const line of (await r.text()).split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = /^([a-zA-Z_:][\w:]*)(\{[^}]*\})?\s+(\S+)$/.exec(line);
    if (!m) continue;
    out.set(m[1]!, (out.get(m[1]!) ?? 0) + Number(m[3]));
  }
  return out;
}

class NodeWatch {
  peakRss = 0;
  worstLagP99 = 0;
  first?: Scrape;
  firstAt = 0;
  last?: Scrape;
  lastAt = 0;
  constructor(readonly base: string) {}
  async sample() {
    const s = await scrape(this.base);
    const now = performance.now();
    if (!this.first) {
      this.first = s;
      this.firstAt = now;
    }
    this.last = s;
    this.lastAt = now;
    this.peakRss = Math.max(this.peakRss, s.get("tandem_process_resident_memory_bytes") ?? 0);
    this.worstLagP99 = Math.max(this.worstLagP99, s.get("tandem_event_loop_lag_p99_seconds") ?? 0);
  }
  report() {
    const secs = (this.lastAt - this.firstAt) / 1000;
    const d = (name: string) => (this.last!.get(name) ?? 0) - (this.first!.get(name) ?? 0);
    return {
      url: this.base,
      windowSeconds: Math.round(secs * 10) / 10,
      messagesInPerSec: Math.round(d("tandem_messages_in_total") / secs),
      messagesOutPerSec: Math.round(d("tandem_messages_out_total") / secs),
      cpuPercent: Math.round((d("tandem_process_cpu_seconds") / secs) * 1000) / 10,
      peakRssMiB: Math.round(this.peakRss / 1048576),
      worstEventLoopLagP99Ms: Math.round(this.worstLagP99 * 10000) / 10,
      connections: this.last!.get("tandem_active_connections") ?? null,
      backpressureDisconnects: d("tandem_backpressure_disconnects_total"),
      rateLimited: d("tandem_rate_limited_total"),
      errors: d("tandem_errors_total"),
      sweepRepairs: d("tandem_durability_sweep_repairs_total"),
      antiEntropyRepairs: d("tandem_anti_entropy_repairs_total"),
    };
  }
}

async function coordinator() {
  const base = urls[0]!;
  const email = `load_${randomBytes(4).toString("hex")}@example.com`;
  const reg = await http(base, "POST", "/api/auth/register", { email, password: "load test password", name: "load" });
  if (reg.status !== 201) throw new Error("register failed " + JSON.stringify(reg.json));
  const cookie = reg.cookie;
  const ws = await http(base, "POST", "/api/workspaces", { name: "load" }, cookie);
  const docIds: string[] = [];
  for (let d = 0; d < DOCS; d++) docIds.push((await http(base, "POST", `/api/workspaces/${ws.json.workspace.id}/documents`, { path: `f${d}.txt` }, cookie)).json.document.id);

  // Client i edits document i % DOCS; document d belongs to worker d % WORKERS.
  const workers: ChildProcess[] = Array.from({ length: WORKERS }, () => fork(process.argv[1]!, [...process.argv.slice(2), "--worker", "1"], { execArgv: process.execArgv }));
  const ask = <E extends FromWorker["ev"]>(m: ToWorker, ev: E, only?: ChildProcess[]) =>
    Promise.all(
      (only ?? workers).map(
        (w) =>
          new Promise<Extract<FromWorker, { ev: E }>>((resolve) => {
            const h = (r: FromWorker) => {
              if (r.ev !== ev) return;
              w.off("message", h);
              resolve(r as Extract<FromWorker, { ev: E }>);
            };
            w.on("message", h);
            w.send(m);
          }),
      ),
    );
  const t0 = performance.now();
  const connected = await Promise.all(
    workers.map(async (w, k) => {
      const clientIdx = Array.from({ length: CLIENTS }, (_, i) => i).filter((i) => (i % DOCS) % WORKERS === k);
      return (await ask({ cmd: "connect", cookie, docIds, clientIdx }, "connected", [w]))[0]!;
    }),
  );
  const connectWallMs = performance.now() - t0;
  const failedConnect = connected.reduce((a, c) => a + c.failed, 0);
  console.error(`connected ${CLIENTS - failedConnect}/${CLIENTS} clients (${WORKERS} generator processes) to ${urls.length} node(s), ${DOCS} documents in ${Math.round(connectWallMs)} ms; editing ${SECONDS}s at ${RATE}/s each`);

  const nodes = METRICS_URLS.map((u) => new NodeWatch(u));
  await Promise.all(nodes.map((n) => n.sample()));
  const sampler = setInterval(() => void Promise.all(nodes.map((n) => n.sample())).catch(() => {}), 1000);
  const tEdit = performance.now();
  const edited = await ask({ cmd: "edit", seconds: SECONDS }, "edited");
  const settled = await ask({ cmd: "settle" }, "settled");
  const wall = (performance.now() - tEdit) / 1000;
  await Promise.all(nodes.map((n) => n.sample()));
  clearInterval(sampler);
  const edits = edited.reduce((a, e) => a + e.edits, 0);
  const editSeconds = Math.max(...edited.map((e) => e.editSeconds));

  let storm: Record<string, unknown> | undefined;
  if (STORM) {
    const stormNodes = METRICS_URLS.map((u) => new NodeWatch(u));
    await Promise.all(stormNodes.map((n) => n.sample()));
    const r = await ask({ cmd: "storm" }, "stormed");
    await Promise.all(stormNodes.map((n) => n.sample()));
    const max = (xs: (number | null)[]) => (xs.some((x) => x === null) ? null : Math.round(Math.max(...(xs as number[]))));
    storm = {
      clients: CLIENTS,
      allRejoinedMs: max(r.map((x) => x.rejoinedMs)),
      allSavedAndConvergedMs: max(r.map((x) => x.recoveredMs)),
      offlineEditsPresent: r.every((x) => x.offlineEditsPresent),
      nodes: stormNodes.map((n) => n.report()),
    };
  }
  const databaseMatches = (await ask({ cmd: "dbcheck" }, "dbchecked")).every((r) => r.matches);
  workers.forEach((w) => w.send({ cmd: "exit" } satisfies ToWorker));

  const steady = { saved: settled.every((s) => s.saved), converged: settled.every((s) => s.converged), settleMs: Math.round(Math.max(...settled.map((s) => s.settleMs))) };
  const result = {
    at: new Date().toISOString(),
    nodes: urls.length,
    clients: CLIENTS,
    documents: DOCS,
    seconds: SECONDS,
    ratePerClient: RATE,
    activeFraction: ACTIVE,
    generatorProcesses: WORKERS,
    connect: { failed: failedConnect, wallMs: Math.round(connectWallMs), perClientMs: dist(connected.flatMap((c) => c.connectMs)) },
    edits,
    editsPerSecond: Math.round(edits / editSeconds),
    propagationMs: dist(settled.flatMap((s) => s.propagation)),
    ackMs: dist(settled.flatMap((s) => s.acks)),
    steady: { ...steady, unsettled: Object.assign({}, ...settled.map((s) => s.unsettled)) },
    server: nodes.map((n) => n.report()),
    generator: {
      cpuPercent: Math.round((settled.reduce((a, s) => a + s.cpuSeconds, 0) / wall) * 1000) / 10,
      worstEventLoopLagP99Ms: Math.round(Math.max(...settled.map((s) => s.lagP99Ms)) * 10) / 10,
    },
    storm,
    databaseMatches,
  };
  console.log(JSON.stringify(result));
  const ok = failedConnect === 0 && steady.saved && steady.converged && databaseMatches && (!storm || (storm.allSavedAndConvergedMs !== null && storm.offlineEditsPresent));
  setTimeout(() => process.exit(ok ? 0 : 1), 300);
}

(args.has("worker") ? worker() : coordinator()).catch((e) => {
  console.error(e);
  process.exit(2);
});
