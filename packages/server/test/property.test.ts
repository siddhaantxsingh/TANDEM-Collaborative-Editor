// Property-based convergence: random concurrent edits from several clients
// on one or two nodes, with random disconnections. At the end every replica
// and the database must contain exactly the same text, and every edit that
// was made must be accounted for (no lost edits).
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { docText } from "../src/store.js";
import { connectClient, createTestDatabase, newUser, REDIS_URL, sleep, startServer, waitFor, workspaceWithDoc, type TestClient, type TestServer } from "./helpers.js";

let db: { url: string; drop: () => Promise<void> };
let n1: TestServer;
let n2: TestServer;

beforeAll(async () => {
  db = await createTestDatabase();
  n1 = await startServer(db.url, { redisUrl: REDIS_URL, nodeId: "p1", compactEvery: 25 });
  n2 = await startServer(db.url, { redisUrl: REDIS_URL, nodeId: "p2", compactEvery: 25 });
});
afterAll(async () => {
  await n1.app.close();
  await n2.app.close();
  await db.drop();
});

type Op =
  | { kind: "insert"; client: number; pos: number; text: string }
  | { kind: "delete"; client: number; pos: number; len: number }
  | { kind: "drop"; client: number }
  | { kind: "pause"; ms: number };

const opArb = (clients: number): fc.Arbitrary<Op> =>
  fc.oneof(
    { weight: 6, arbitrary: fc.record({ kind: fc.constant("insert" as const), client: fc.nat(clients - 1), pos: fc.nat(), text: fc.stringMatching(/^[a-z]{1,4}$/) }) },
    { weight: 3, arbitrary: fc.record({ kind: fc.constant("delete" as const), client: fc.nat(clients - 1), pos: fc.nat(), len: fc.integer({ min: 1, max: 3 }) }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant("drop" as const), client: fc.nat(clients - 1) }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant("pause" as const), ms: fc.integer({ min: 0, max: 30 }) }) },
  );

describe("convergence property", () => {
  it("random concurrent edits with disconnects converge on every replica and in the database", async () => {
    const owner = await newUser(n1.base, "prop");
    let runs = 0;
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 4 }).chain((n) => fc.tuple(fc.constant(n), fc.array(opArb(n), { minLength: 10, maxLength: 60 }))), async ([n, ops]) => {
        runs++;
        const t0 = Date.now();
        const { docId } = await workspaceWithDoc(owner.http, `f${runs}.txt`);
        const clients: TestClient[] = [];
        for (let i = 0; i < n; i++) clients.push(connectClient(i % 2 === 0 ? n1 : n2, owner.http.cookie, docId));
        await waitFor(() => clients.every((c) => c.handle.synced), 10_000, "initial sync");
        const inserted: string[] = [];
        let marker = 0;
        for (const op of ops) {
          const c = clients[(op as { client?: number }).client ?? 0]!;
          if (op.kind === "insert") {
            // Unique marker per insert so each edit can be traced afterwards.
            const t = `${op.text}${marker++}|`;
            c.text.insert(op.pos % (c.text.length + 1), t);
            inserted.push(t);
          } else if (op.kind === "delete" && c.text.length > 0) {
            const pos = op.pos % c.text.length;
            c.text.delete(pos, Math.min(op.len, c.text.length - pos));
          } else if (op.kind === "drop") {
            c.conn.dropConnection();
          } else if (op.kind === "pause") {
            await sleep(op.ms);
          }
        }
        await waitFor(() => clients.every((c) => c.handle.joined && c.handle.unsaved === 0), 20_000, "all saved");
        await waitFor(() => clients.every((c) => c.text.toString() === clients[0]!.text.toString()), 10_000, "replicas equal");
        const final = clients[0]!.text.toString();
        expect(await docText(n1.app.db, docId)).toBe(final);
        // No lost edits: every insert is either present intact or was cut by
        // a delete; Yjs never resurrects or duplicates. Checking that the text
        // only consists of inserted characters (and that the per-insert
        // markers appear at most once) catches duplication and corruption.
        for (const t of inserted) expect(final.split(t).length - 1).toBeLessThanOrEqual(1);
        const allowed = new Set(inserted.join(""));
        for (const ch of final) expect(allowed.has(ch)).toBe(true);
        for (const c of clients) c.destroy();
        if (process.env.PROP_VERBOSE) console.log(`run ${runs}: ${n} clients, ${ops.length} ops, ${Date.now() - t0} ms`);
      }),
      { numRuns: 25 },
    );
  }, 600_000);

  it("without deletes, every insert is present exactly once after random disconnects", async () => {
    const owner = await newUser(n1.base, "prop2");
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(fc.nat(2), fc.boolean()), { minLength: 5, maxLength: 40 }), async (steps) => {
        const { docId } = await workspaceWithDoc(owner.http, `g${Math.random().toString(36).slice(2)}.txt`);
        const clients = [0, 1, 2].map((i) => connectClient(i === 1 ? n2 : n1, owner.http.cookie, docId));
        await waitFor(() => clients.every((c) => c.handle.synced));
        const words: string[] = [];
        steps.forEach(([ci, drop], k) => {
          const c = clients[ci]!;
          if (drop) c.conn.dropConnection();
          const w = `<${k}>`;
          words.push(w);
          // At either end, so words never split each other.
          c.text.insert(k % 2 === 0 ? 0 : c.text.length, w);
        });
        await waitFor(() => clients.every((c) => c.handle.joined && c.handle.unsaved === 0), 20_000, "saved");
        await waitFor(() => clients.every((c) => c.text.toString() === clients[0]!.text.toString()), 10_000, "equal");
        const final = await docText(n2.app.db, docId);
        expect(final).toBe(clients[0]!.text.toString());
        for (const w of words) expect(final.split(w).length - 1).toBe(1);
        for (const c of clients) c.destroy();
      }),
      { numRuns: 20 },
    );
  }, 600_000);
});
