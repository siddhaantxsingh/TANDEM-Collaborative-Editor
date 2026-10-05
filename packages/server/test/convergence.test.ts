// Collaboration invariants under a hostile network (see docs/CORRECTNESS.md):
//   I1 concurrent valid operations converge
//   I2 duplicate operations are idempotent
//   I3 out-of-order operations are handled safely
//   I4 lost operations are recovered
//   I5 reconnection eventually restores the correct state
//   I6 offline edits are merged without silent loss
//   I7 presence failures never corrupt document state
// Every scenario is driven by a seeded PRNG (the seed is in the test name),
// so a failure can be replayed exactly.
import { TandemConnection } from "@tandem/protocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { MsgType } from "@tandem/protocol";

import { docText } from "../src/store.js";
import { FaultyNetwork, type Faults, NO_FAULTS, prng } from "./faultnet.js";
import { createTestDatabase, newUser, rawClient, REDIS_URL, sleep, startServer, waitFor, workspaceWithDoc, type TestServer } from "./helpers.js";

let db: { url: string; drop: () => Promise<void> };
let n1: TestServer;
let n2: TestServer;

beforeAll(async () => {
  db = await createTestDatabase();
  n1 = await startServer(db.url, { redisUrl: REDIS_URL, nodeId: "c1", compactEvery: 40, durabilitySweepMs: 1000 });
  n2 = await startServer(db.url, { redisUrl: REDIS_URL, nodeId: "c2", compactEvery: 40, durabilitySweepMs: 1000 });
});
afterAll(async () => {
  await n1.app.close();
  await n2.app.close();
  await db.drop();
});

interface Replica {
  net: FaultyNetwork;
  conn: TandemConnection;
  doc: Y.Doc;
  text: Y.Text;
  handle: ReturnType<TandemConnection["open"]>;
}

function replica(server: TestServer, cookie: string, docId: string, seed: number, faults: Faults): Replica {
  const net = new FaultyNetwork(prng(seed), faults, { Cookie: cookie, Origin: server.origin });
  const conn = new TandemConnection({
    url: `ws://127.0.0.1:${server.port}/ws`,
    createSocket: net.factory,
    minBackoffMs: 30,
    maxBackoffMs: 300,
    pingIntervalMs: 1000,
    ackTimeoutMs: 1500,
    resyncIntervalMs: 700,
  });
  const doc = new Y.Doc();
  const handle = conn.open(docId, doc, new Awareness(doc));
  return { net, conn, doc, text: doc.getText("content"), handle };
}

// Token boundaries: positions that do not split a marker "<i.k>".
function boundaries(s: string): number[] {
  const out = [0];
  for (let i = 0; i < s.length; i++) if (s[i] === ">" || s[i] === "~" || s[i] === "\n") out.push(i + 1);
  return out;
}

async function settle(rs: Replica[], docId: string, server: TestServer, timeoutMs = 40_000) {
  for (const r of rs) r.net.faults = NO_FAULTS; // faults stop; recovery must still complete
  for (const r of rs) r.net.setOnline(true);
  await waitFor(
    async () => {
      if (!rs.every((r) => r.handle.joined && r.handle.unsaved === 0)) return false;
      const t = rs[0]!.text.toString();
      if (!rs.every((r) => r.text.toString() === t)) return false;
      return (await docText(server.app.db, docId)) === t;
    },
    timeoutMs,
    "convergence",
  );
}

function checkMarkers(text: string, markers: string[]) {
  const missing: string[] = [];
  const duplicated: string[] = [];
  for (const m of markers) {
    const n = text.split(m).length - 1;
    if (n === 0) missing.push(m);
    if (n > 1) duplicated.push(m);
  }
  expect({ missing, duplicated }).toEqual({ missing: [], duplicated: [] });
}

const PROFILES: Record<string, Faults> = {
  clean: NO_FAULTS,
  "delay+duplicate+reorder": { maxDelayMs: 40, duplicate: 0.3, reorder: 0.3, drop: 0, kill: 0 },
  lossy: { maxDelayMs: 10, duplicate: 0, reorder: 0, drop: 0.15, kill: 0 },
  "kills+offline": { maxDelayMs: 10, duplicate: 0.1, reorder: 0.1, drop: 0.05, kill: 0.01 },
};

describe("randomized convergence under network faults", () => {
  const cases: [number, string, number][] = [];
  let seed = 1000;
  for (const clients of [2, 5, 10]) for (const profile of Object.keys(PROFILES)) cases.push([clients, profile, seed++]);

  for (const [clients, profile, s] of cases) {
    it(`${clients} clients, ${profile}, seed ${s}`, async () => {
      const rand = prng(s);
      const owner = await newUser(n1.base, "conv");
      const { docId } = await workspaceWithDoc(owner.http, `conv-${s}.txt`);
      // Half of the clients on each node (cross-node fan-out through Redis).
      const rs = Array.from({ length: clients }, (_, i) => replica(i % 2 ? n2 : n1, owner.http.cookie, docId, s * 100 + i, PROFILES[profile]!));
      await waitFor(() => rs.every((r) => r.handle.synced), 15_000, "initial sync");
      const markers: string[] = [];
      let k = 0;
      const offline = profile === "kills+offline";
      for (let round = 0; round < 30; round++) {
        for (const [i, r] of rs.entries()) {
          if (offline && round === 5 && i % 3 === 0) r.net.setOnline(false); // go offline, keep editing
          if (offline && round === 20 && i % 3 === 0) r.net.setOnline(true);
          const roll = rand();
          const b = boundaries(r.text.toString());
          if (roll < 0.45) {
            const m = `<${i}.${k++}>`;
            markers.push(m);
            r.text.insert(rand() < 0.3 ? 0 : b[Math.floor(rand() * b.length)]!, m); // 30%: same position
          } else if (roll < 0.75) {
            r.text.insert(b[Math.floor(rand() * b.length)]!, "~");
          } else {
            const s2 = r.text.toString();
            const tildes = [...s2].flatMap((c, j) => (c === "~" ? [j] : []));
            if (tildes.length) r.text.delete(tildes[Math.floor(rand() * tildes.length)]!, 1);
          }
        }
        await sleep(rand() * 40);
      }
      const stats = rs.reduce(
        (a, r) => ({ dup: a.dup + r.net.stats.duplicated, re: a.re + r.net.stats.reordered, drop: a.drop + r.net.stats.dropped, kill: a.kill + r.net.stats.killed }),
        { dup: 0, re: 0, drop: 0, kill: 0 },
      );
      await settle(rs, docId, n1);
      const final = rs[0]!.text.toString();
      checkMarkers(final, markers);
      // The faults of the profile really happened.
      const f = PROFILES[profile]!;
      if (f.duplicate > 0) expect(stats.dup).toBeGreaterThan(0);
      if (f.reorder > 0) expect(stats.re).toBeGreaterThan(0);
      if (f.drop > 0) expect(stats.drop).toBeGreaterThan(0);
      for (const r of rs) r.conn.destroy();
    });
  }
});

describe("deterministic scenarios", () => {
  async function setup(n: number, faults: Faults = NO_FAULTS, seed = 1) {
    const owner = await newUser(n1.base, "det");
    const { docId } = await workspaceWithDoc(owner.http, `det-${Math.random().toString(36).slice(2)}.txt`);
    const rs = Array.from({ length: n }, (_, i) => replica(i % 2 ? n2 : n1, owner.http.cookie, docId, seed + i, faults));
    await waitFor(() => rs.every((r) => r.handle.synced), 15_000, "initial sync");
    return { owner, docId, rs };
  }

  it("10 clients insert at the same character position while offline: one deterministic order, nothing lost", async () => {
    const { docId, rs } = await setup(10);
    rs[0]!.text.insert(0, "[]");
    await settle(rs, docId, n1);
    for (const r of rs) r.net.setOnline(false);
    await sleep(100);
    const markers = rs.map((r, i) => {
      const m = `<${i}>`;
      r.text.insert(1, m); // all between "[" and "]"
      return m;
    });
    await settle(rs, docId, n1);
    const t = rs[0]!.text.toString();
    expect(t.startsWith("[") && t.endsWith("]")).toBe(true);
    checkMarkers(t, markers);
    for (const r of rs) r.conn.destroy();
  });

  it("5 clients edit the same line concurrently", async () => {
    const { docId, rs } = await setup(5);
    rs[0]!.text.insert(0, "line one\nline two\nline three\n");
    await settle(rs, docId, n1);
    for (const r of rs) r.net.setOnline(false);
    for (const [i, r] of rs.entries()) {
      const s = r.text.toString();
      r.text.insert(s.indexOf("\nline three"), ` +${i}`); // end of line two
      r.text.insert(s.indexOf("two"), `(${i})`); // middle of line two
    }
    await settle(rs, docId, n1);
    const lines = rs[0]!.text.toString().split("\n");
    expect(lines[0]).toBe("line one");
    expect(lines[2]).toBe("line three");
    for (let i = 0; i < 5; i++) {
      expect(lines[1]!.split(` +${i}`).length - 1).toBe(1);
      expect(lines[1]!.split(`(${i})`).length - 1).toBe(1);
    }
    for (const r of rs) r.conn.destroy();
  });

  it("2 clients replace overlapping selections: both insertions kept, deleted text not resurrected", async () => {
    const { docId, rs } = await setup(2);
    const [a, b] = rs as [Replica, Replica];
    a.text.insert(0, "0123456789");
    await settle(rs, docId, n1);
    a.net.setOnline(false);
    b.net.setOnline(false);
    a.text.delete(2, 5); // "23456" -> "AAA"
    a.text.insert(2, "AAA");
    b.text.delete(4, 5); // "45678" -> "BBB"
    b.text.insert(4, "BBB");
    await settle(rs, docId, n1);
    const t = a.text.toString();
    // Union of the selections (2..8) is deleted; outside text intact; both
    // replacements present exactly once.
    expect(t.startsWith("01")).toBe(true);
    expect(t.endsWith("9")).toBe(true);
    for (const c of "2345678") expect(t.includes(c)).toBe(false);
    expect(t.split("AAA").length - 1).toBe(1);
    expect(t.split("BBB").length - 1).toBe(1);
    expect(t.length).toBe(2 + 3 + 3 + 1);
    for (const r of rs) r.conn.destroy();
  });

  it("every document frame duplicated: content is not doubled (idempotence)", async () => {
    const { docId, rs } = await setup(2, { maxDelayMs: 0, duplicate: 1, reorder: 0, drop: 0, kill: 0 });
    for (let i = 0; i < 20; i++) rs[i % 2]!.text.insert(0, `<${i}>`);
    await settle(rs, docId, n1);
    checkMarkers(rs[0]!.text.toString(), Array.from({ length: 20 }, (_, i) => `<${i}>`));
    expect(rs[0]!.net.stats.duplicated).toBeGreaterThan(0);
    for (const r of rs) r.conn.destroy();
  });

  it("every Update held back behind the next one (out of order): converges, acknowledged updates are stored", async () => {
    const { docId, rs } = await setup(2, { maxDelayMs: 0, duplicate: 0, reorder: 1, drop: 0, kill: 0 });
    for (let i = 0; i < 30; i++) rs[i % 2]!.text.insert(rs[i % 2]!.text.length, `<${i}>`); // each depends on the previous
    await settle(rs, docId, n1);
    checkMarkers(rs[0]!.text.toString(), Array.from({ length: 30 }, (_, i) => `<${i}>`));
    expect(rs[0]!.net.stats.reordered).toBeGreaterThan(0);
    for (const r of rs) r.conn.destroy();
  });

  it("30% of document frames silently lost (no disconnect): recovered by ack timeout and anti-entropy", async () => {
    const { docId, rs } = await setup(3, { maxDelayMs: 0, duplicate: 0, reorder: 0, drop: 0.3, kill: 0 }, 77);
    for (let i = 0; i < 30; i++) {
      rs[i % 3]!.text.insert(0, `<${i}>`);
      await sleep(10);
    }
    await settle(rs, docId, n1);
    checkMarkers(rs[0]!.text.toString(), Array.from({ length: 30 }, (_, i) => `<${i}>`));
    expect(rs.reduce((n, r) => n + r.net.stats.dropped, 0)).toBeGreaterThan(0);
    for (const r of rs) r.conn.destroy();
  });

  it("delayed delivery (up to 300 ms per frame): converges", async () => {
    const { docId, rs } = await setup(5, { maxDelayMs: 300, duplicate: 0, reorder: 0, drop: 0, kill: 0 }, 5);
    for (let i = 0; i < 25; i++) rs[i % 5]!.text.insert(0, `<${i}>`);
    await settle(rs, docId, n1);
    checkMarkers(rs[0]!.text.toString(), Array.from({ length: 25 }, (_, i) => `<${i}>`));
    for (const r of rs) r.conn.destroy();
  });

  it("presence garbage, spoofing and floods never affect the document (I7)", async () => {
    const { owner, docId, rs } = await setup(2);
    const evil = await rawClient(n1, owner.http.cookie);
    evil.send({ type: MsgType.Join, ch: 1, docId });
    await waitFor(() => evil.msgs.some((m) => m.type === MsgType.Joined));
    // Claim the other replicas' awareness ids, send malformed payloads.
    const fake = new Y.Doc();
    const aw = new Awareness(fake);
    aw.setLocalStateField("user", { name: "<script>", color: "red" });
    for (const r of rs) {
      (fake as unknown as { clientID: number }).clientID = r.doc.clientID;
      aw.setLocalStateField("cursor", { x: 1 });
    }
    evil.send({ type: MsgType.Awareness, ch: 1, payload: encodeAwarenessUpdate(aw, [aw.clientID]) });
    evil.send({ type: MsgType.Awareness, ch: 1, payload: new Uint8Array([5, 1, 2, 3]) });
    for (let i = 0; i < 20; i++) rs[i % 2]!.text.insert(0, `<${i}>`);
    await settle(rs, docId, n1);
    checkMarkers(rs[0]!.text.toString(), Array.from({ length: 20 }, (_, i) => `<${i}>`));
    expect(evil.msgs.some((m) => m.type === MsgType.Error)).toBe(true);
    evil.ws.close();
    aw.destroy();
    for (const r of rs) r.conn.destroy();
  });
});
