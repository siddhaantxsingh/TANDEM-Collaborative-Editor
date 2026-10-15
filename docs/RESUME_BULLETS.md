# Resume bullets — Tandem (pick 2–4)

- Built **Tandem**, a real-time collaborative code editor (TypeScript, React, Monaco, Node.js, PostgreSQL, Redis) using the Yjs CRDT for conflict-free merging, offline editing via IndexedDB, and live presence/cursors.
- Designed an explicit, versioned binary WebSocket protocol with per-edit acknowledgements sent only after PostgreSQL commit, so "saved" is truthful and no edit is silently lost; fuzzed the decoder with 40,000 random/mutated frames.
- Implemented server-enforced OWNER/EDITOR/VIEWER authorization pushed live to connected clients across nodes, scrypt password hashing, hashed session tokens, CSRF/WebSocket-origin checks, rate limiting and backpressure.
- Scaled horizontally with Redis pub/sub and a durability sweep; verified with property-based convergence tests, a 3-browser Playwright test, load tests (60 clients, p50 57 ms across nodes) and a chaos test (node SIGKILL, Redis and Postgres restarts) with 0 of 3,424 edits lost.
- Found and fixed a lost-update race in log compaction caused by PostgreSQL sequence values committing out of order, with a deterministic two-transaction regression test.

## Corrections from the 2026-10-14 audit

* Do not claim operational transformation: the code uses only Yjs (CRDT).
* "Sub-50 ms edit propagation" holds only for the median on one node
  (p50 25-44 ms, 50 editors, shared 4-vCPU machine); p99 was 0.3-0.5 s on
  one node and 0.5-1.4 s on two nodes there. Quote the median and the setup.
* "50+ simulated editors" is supported (50 active editors on 1 and 2 nodes;
  1,000 connected with 50 active).
* New, evidence-backed bullet: "Found and fixed an acknowledged-but-unstored
  edit in the server's handling of out-of-order CRDT updates with a
  fast-check property test across two nodes and offline clients; verified
  ack-after-commit with kill -9 of the server and of PostgreSQL (3,706 acks,
  0 lost)."
