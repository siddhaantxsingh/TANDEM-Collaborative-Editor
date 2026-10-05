// Randomized check of out-of-causal-order delivery in Yjs: how often does a
// replica stay incomplete with plain Y.applyUpdate, and with
// applyUpdateHealing (used by Tandem)? See docs/CORRECTNESS.md.
//
// Usage: npx tsx tools/pending-check.ts [cases=50000] [seed=12345]
import * as Y from "yjs";

import { applyUpdateHealing } from "@tandem/protocol/client";

const CASES = Number(process.argv[2] ?? 50_000);
let rng = Number(process.argv[3] ?? 12345);
const rand = () => (rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648;
let plainIncomplete = 0;
let healedIncomplete = 0;
for (let c = 0; c < CASES; c++) {
  const n = 3 + Math.floor(rand() * 4);
  const len = 2 + Math.floor(rand() * 30);
  const docs = Array.from({ length: n }, (_, i) => {
    const d = new Y.Doc();
    d.clientID = 10 + i;
    return d;
  });
  const updates: Uint8Array[] = [];
  for (let k = 0; k < len; k++) {
    const d = docs[Math.floor(rand() * n)]!;
    const seen = Math.floor(rand() * (updates.length + 1)); // a random causal history
    for (let j = 0; j < seen; j++) Y.applyUpdate(d, updates[j]!);
    const sv = Y.encodeStateVector(d);
    const t = d.getText("t");
    if (rand() < 0.3 && t.length > 0) t.delete(Math.floor(rand() * t.length), 1);
    else t.insert(Math.floor(rand() * (t.length + 1)), "x");
    updates.push(Y.encodeStateAsUpdate(d, sv));
  }
  const ref = new Y.Doc();
  for (const u of updates) Y.applyUpdate(ref, u);
  const order = updates.map((_, i) => [rand(), i] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const plain = new Y.Doc();
  const healed = new Y.Doc();
  for (const i of order) {
    Y.applyUpdate(plain, updates[i]!);
    applyUpdateHealing(healed, updates[i]!);
  }
  const want = ref.getText("t").toString();
  if (plain.getText("t").toString() !== want) plainIncomplete++;
  if (healed.getText("t").toString() !== want || healed.store.pendingStructs || healed.store.pendingDs) healedIncomplete++;
}
console.log(JSON.stringify({ yjs: (await import("yjs/package.json", { with: { type: "json" } })).default.version, cases: CASES, plainApplyIncomplete: plainIncomplete, healingApplyIncomplete: healedIncomplete }));
