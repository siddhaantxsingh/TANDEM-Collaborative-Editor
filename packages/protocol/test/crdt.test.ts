// Properties of the collaboration algorithm (Yjs / YATA) that Tandem relies
// on, checked directly on Yjs documents with random operation sequences and
// random delivery schedules (no server). docs/CORRECTNESS.md cites these.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { applyUpdateHealing } from "../src/client.js";

type Op = { replica: number; kind: "insert" | "delete"; pos: number; len: number; marker: boolean };

const opArb = (n: number): fc.Arbitrary<Op> =>
  fc.record({
    replica: fc.nat(n - 1),
    kind: fc.constantFrom("insert" as const, "insert" as const, "delete" as const),
    pos: fc.nat(),
    len: fc.integer({ min: 1, max: 4 }),
    marker: fc.boolean(),
  });

// Delivery schedule: for each update, the order key and whether it is
// delivered twice. Undelivered updates are recovered at the end through the
// state-vector handshake (what Sync1/Sync2 does).
interface Run {
  n: number;
  ops: Op[];
  order: number[];
  dupes: boolean[];
  lost: boolean[];
}

const runArb: fc.Arbitrary<Run> = fc.integer({ min: 2, max: 10 }).chain((n) =>
  fc.array(opArb(n), { minLength: 1, maxLength: 80 }).chain((ops) =>
    fc.record({
      n: fc.constant(n),
      ops: fc.constant(ops),
      order: fc.array(fc.nat(), { minLength: ops.length * n, maxLength: ops.length * n }),
      dupes: fc.array(fc.boolean(), { minLength: ops.length * n, maxLength: ops.length * n }),
      lost: fc.array(fc.integer({ min: 0, max: 9 }).map((x) => x === 0), { minLength: ops.length * n, maxLength: ops.length * n }),
    }),
  ),
);

// Markers: unique strings that are never targeted by deletions.
function boundaries(s: string): number[] {
  const out = [0];
  for (let i = 0; i < s.length; i++) if (s[i] === ">" || s[i] === ".") out.push(i + 1);
  return out;
}

function simulate(run: Run) {
  const docs = Array.from({ length: run.n }, (_, i) => {
    const d = new Y.Doc();
    d.clientID = i + 1; // deterministic ids
    return d;
  });
  const markers: string[] = [];
  const inFlight: { to: number; update: Uint8Array; key: number; dup: boolean; lost: boolean }[] = [];
  let u = 0;
  run.ops.forEach((op, k) => {
    const d = docs[op.replica]!;
    const t = d.getText("t");
    const capture: Uint8Array[] = [];
    const h = (upd: Uint8Array) => capture.push(upd);
    d.on("update", h);
    const s = t.toString();
    if (op.kind === "insert") {
      const b = boundaries(s);
      const at = b[op.pos % b.length]!;
      if (op.marker) {
        const m = `<${k}>`;
        markers.push(m);
        t.insert(at, m);
      } else t.insert(at, ".".repeat(op.len));
    } else {
      // delete filler characters only (single '.'), never markers
      const dots = [...s].flatMap((c, i) => (c === "." ? [i] : []));
      if (dots.length) t.delete(dots[op.pos % dots.length]!, 1);
    }
    d.off("update", h);
    for (const upd of capture)
      for (let to = 0; to < run.n; to++)
        if (to !== op.replica) {
          inFlight.push({ to, update: upd, key: run.order[u % run.order.length]!, dup: run.dupes[u % run.dupes.length]!, lost: run.lost[u % run.lost.length]! });
          u++;
        }
  });
  // Deliver in an arbitrary order, some twice, some never.
  inFlight.sort((a, b) => a.key - b.key);
  for (const m of inFlight) {
    if (m.lost) continue;
    Y.applyUpdate(docs[m.to]!, m.update);
    if (m.dup) Y.applyUpdate(docs[m.to]!, m.update);
  }
  // Anti-entropy: pairwise state-vector exchange until quiescent.
  for (let round = 0; round < 2; round++)
    for (const a of docs) for (const b of docs) if (a !== b) Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  return { docs, markers };
}

describe("Yjs convergence properties (random operations, random delivery)", () => {
  it("all replicas converge; every marker present exactly once; no pending structs left", () => {
    fc.assert(
      fc.property(runArb, (run) => {
        const { docs, markers } = simulate(run);
        const texts = docs.map((d) => d.getText("t").toString());
        expect(new Set(texts).size).toBe(1);
        for (const m of markers) expect(texts[0]!.split(m).length - 1).toBe(1);
        for (const d of docs) {
          expect(d.store.pendingStructs).toBeNull();
          expect(d.store.pendingDs).toBeNull();
          expect(Y.encodeStateVector(d)).toEqual(Y.encodeStateVector(docs[0]!));
        }
      }),
      { numRuns: 300 },
    );
  });

  it("applying an update twice equals applying it once (idempotence)", () => {
    fc.assert(
      fc.property(runArb, (run) => {
        const { docs } = simulate(run);
        const full = Y.encodeStateAsUpdate(docs[0]!);
        const once = new Y.Doc();
        Y.applyUpdate(once, full);
        const twice = new Y.Doc();
        Y.applyUpdate(twice, full);
        Y.applyUpdate(twice, full);
        expect(twice.getText("t").toString()).toBe(once.getText("t").toString());
        expect(Y.encodeStateAsUpdate(twice)).toEqual(Y.encodeStateAsUpdate(once));
      }),
      { numRuns: 200 },
    );
  });

  it("the order of applying a set of updates does not matter (commutativity), including out-of-causal-order delivery, with applyUpdateHealing", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.nat(2), fc.nat(), fc.boolean()), { minLength: 2, maxLength: 40 }), fc.array(fc.nat()), (ops, perm) => {
        const docs = [0, 1, 2].map((i) => {
          const d = new Y.Doc();
          d.clientID = 100 + i;
          return d;
        });
        const updates: Uint8Array[] = [];
        for (const [r, pos, del] of ops) {
          const d = docs[r]!;
          // each replica sees everything so far (causally dependent chain)
          for (const upd of updates) Y.applyUpdate(d, upd);
          const t = d.getText("t");
          const sv = Y.encodeStateVector(d);
          if (del && t.length > 0) t.delete(pos % t.length, 1);
          else t.insert(pos % (t.length + 1), "x");
          updates.push(Y.encodeStateAsUpdate(d, sv));
        }
        const inOrder = new Y.Doc();
        for (const upd of updates) Y.applyUpdate(inOrder, upd);
        const shuffled = updates.map((upd, i) => ({ upd, k: perm[i % Math.max(1, perm.length)] ?? i })).sort((a, b) => a.k - b.k);
        const other = new Y.Doc();
        for (const { upd } of shuffled) applyUpdateHealing(other, upd);
        expect(other.getText("t").toString()).toBe(inOrder.getText("t").toString());
        expect(other.store.pendingStructs).toBeNull();
      }),
      { numRuns: 300 },
    );
  });

  it("characterization: plain Y.applyUpdate (Yjs 13.6) can leave structs pending although all dependencies arrived", () => {
    // Minimal counterexample found by the property above. Replica 0 inserts
    // three times, replica 1 once (after seeing those), replica 0 twice more;
    // the updates arrive in the order 1, 3, 5, 0, 2, 4.
    const make = () => {
      const docs = [0, 1].map((i) => {
        const d = new Y.Doc();
        d.clientID = 100 + i;
        return d;
      });
      const updates: Uint8Array[] = [];
      for (const r of [0, 0, 0, 1, 0, 0]) {
        const d = docs[r]!;
        for (const u of updates) Y.applyUpdate(d, u);
        const sv = Y.encodeStateVector(d);
        d.getText("t").insert(0, "x");
        updates.push(Y.encodeStateAsUpdate(d, sv));
      }
      return updates;
    };
    const updates = make();
    const raw = new Y.Doc();
    for (const i of [1, 3, 5, 0, 2, 4]) Y.applyUpdate(raw, updates[i]!);
    expect(raw.getText("t").toString()).toBe("xxx"); // three items stuck as pending
    expect(raw.store.pendingStructs).not.toBeNull();
    // Nothing is lost: the stuck items are part of the encoded state.
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, Y.encodeStateAsUpdate(raw));
    expect(fresh.getText("t").toString()).toBe("xxxxxx");
    // The healing apply used by Tandem integrates them immediately.
    const healed = new Y.Doc();
    for (const i of [1, 3, 5, 0, 2, 4]) applyUpdateHealing(healed, updates[i]!);
    expect(healed.getText("t").toString()).toBe("xxxxxx");
    expect(healed.store.pendingStructs).toBeNull();
  });

  it("deleted text is never resurrected by a late or duplicated insert update", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getText("t").insert(0, "hello");
    const ins = Y.encodeStateAsUpdate(a);
    Y.applyUpdate(b, ins);
    b.getText("t").delete(0, 5);
    const del = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
    // a receives the delete, then the original insert again (duplicate/late).
    Y.applyUpdate(a, del);
    Y.applyUpdate(a, ins);
    Y.applyUpdate(b, ins);
    expect(a.getText("t").toString()).toBe("");
    expect(b.getText("t").toString()).toBe("");
    // A replica that gets the delete before the insert also ends empty.
    const c = new Y.Doc();
    Y.applyUpdate(c, del);
    expect(c.store.pendingDs).not.toBeNull(); // delete held until the insert arrives
    Y.applyUpdate(c, ins);
    expect(c.getText("t").toString()).toBe("");
  });

  it("a merged snapshot (compaction) is equivalent to replaying the log", () => {
    fc.assert(
      fc.property(runArb, (run) => {
        const d = new Y.Doc();
        const log: Uint8Array[] = [];
        d.on("update", (u: Uint8Array) => log.push(u));
        const { docs } = simulate(run);
        Y.applyUpdate(d, Y.encodeStateAsUpdate(docs[0]!));
        for (const other of docs.slice(1)) Y.applyUpdate(d, Y.encodeStateAsUpdate(other));
        const replay = new Y.Doc();
        for (const u of log) Y.applyUpdate(replay, u);
        const snap = new Y.Doc();
        Y.applyUpdate(snap, Y.mergeUpdates(log));
        expect(snap.getText("t").toString()).toBe(replay.getText("t").toString());
        expect(Y.encodeStateVector(snap)).toEqual(Y.encodeStateVector(replay));
      }),
      { numRuns: 150 },
    );
  });
});
