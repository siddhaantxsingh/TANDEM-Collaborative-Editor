# Requirements matrix (2026-10-14 audit)

Status values: VERIFIED, IMPLEMENTED BUT UNVERIFIED, PARTIAL, FAILED,
BLOCKED, NOT IMPLEMENTED. Evidence paths are under `docs/evidence/2026-10-14/`
unless stated. "Baseline" is the state of commit 1a4d7df.

| # | Requirement | Baseline | Final | Evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | Clean install, build, typecheck | VERIFIED | VERIFIED | `baseline-*.log`, `final-tests.log` | "lint" is only `tsc --noEmit` |
| 2 | Unit/integration suite green | PARTIAL (87/88, flaky) | VERIFIED (100 tests, 14 files) | `final-tests.log` | one CPU-bound test timed out at load avg ~30; fixed (Buffer.equals) and re-run alone: 7/7 |
| 3 | Browser E2E (Playwright, Chromium) | PARTIAL (needs `CHROMIUM_PATH` here) | VERIFIED 3/3 | `final-tests.log` | |
| 4 | CRDT convergence (Yjs/YATA), offline edits merge | VERIFIED (text equality) | VERIFIED | `offline-property.test.ts`, `offline-property.log` | 200/200 runs after fix: same content, state vector, delete set and canonical bytes on all clients, both nodes and PostgreSQL; raw `encodeStateAsUpdate` bytes identical in 200/200 |
| 5 | Ack only after PostgreSQL commit | PARTIAL: defect P10 acked a second pending update without storing it | VERIFIED | `pending-ack-before/after.log`, `crash-ack.log`, `crash-ack-mutation.log` | 12 crash cycles (server kill -9, PostgreSQL kill -9): 3,706 acks, 0 missing; mutation (ack before write) loses 1,376 |
| 6 | Survive PostgreSQL crash | FAILED: lost connection on a checked-out client crashed the node | VERIFIED | `pg-client-error-before/after.log`, `crash-ack.log` | |
| 7 | Multi-node sync via Redis, real processes, node crash/restart | VERIFIED (by the owner's earlier logs) | VERIFIED | `chaos-multinode.log` | 2 runs, 2 node processes, SIGKILL of each node, Redis restart, PostgreSQL SIGKILL: 7,160 and 7,088 inserts, 0 missing or duplicated, DB matches |
| 8 | Logout / revoked / expired session closes live sockets on every node | FAILED (7 of 9 new tests failed) | VERIFIED | `session-revalidation-before/after.log` | |
| 9 | Permission change applied to live sockets even if the bus event is lost | FAILED | VERIFIED | `session.test.ts` | within `SESSION_REVALIDATE_MS` (30 s) |
| 10 | Load test: propagation latency p50/p95/p99 | IMPLEMENTED (owner's 2-vCPU runs) | VERIFIED here, numbers heavily affected by a shared machine | `load.jsonl`, `load-run.log` | see `docs/PERFORMANCE.md` 2026-10-14 section |
| 11 | "Sub-50 ms edit propagation" (resume) | - | PARTIAL | `load.jsonl` | true for p50 on one node (25-44 ms), not for p95/p99 or two nodes on this machine |
| 12 | "50+ simulated editors" (resume) | - | VERIFIED | `load.jsonl` | 50 active editors on 1 and 2 nodes, 3 runs each, all converged; 1,000 connected / 50 active also passed |
| 13 | Operational transformation as an alternate merge strategy (resume) | NOT IMPLEMENTED | NOT IMPLEMENTED | `docs/CORRECTNESS.md`, `docs/adr/001-crdt-yjs.md` | the code uses only Yjs; the resume line should be removed |
| 14 | Docker image builds and runs; compose stack | IMPLEMENTED BUT UNVERIFIED (here) | BLOCKED | - | shared disk 98-100 % full; owner step in `docs/OWNER_ACTIONS.md` |
| 15 | Real deployment | NOT IMPLEMENTED | BLOCKED (owner-only) | `docs/OWNER_ACTIONS.md` | |
| 16 | CI on GitHub | unknown | IMPLEMENTED BUT UNVERIFIED | `.github/workflows/ci.yml` | see final report for run status |
