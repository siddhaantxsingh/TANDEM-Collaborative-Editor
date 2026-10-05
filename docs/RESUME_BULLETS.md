# Resume bullets — Tandem (pick 2–4)

- Built **Tandem**, a real-time collaborative code editor (TypeScript, React, Monaco, Node.js, PostgreSQL, Redis) using the Yjs CRDT for conflict-free merging, offline editing via IndexedDB, and live presence/cursors.
- Designed an explicit, versioned binary WebSocket protocol with per-edit acknowledgements sent only after PostgreSQL commit, so "saved" is truthful and no edit is silently lost; fuzzed the decoder with 40,000 random/mutated frames.
- Implemented server-enforced OWNER/EDITOR/VIEWER authorization pushed live to connected clients across nodes, scrypt password hashing, hashed session tokens, CSRF/WebSocket-origin checks, rate limiting and backpressure.
- Scaled horizontally with Redis pub/sub and a durability sweep; verified with property-based convergence tests, a 3-browser Playwright test, load tests (60 clients, p50 57 ms across nodes) and a chaos test (node SIGKILL, Redis and Postgres restarts) with 0 of 3,424 edits lost.
- Found and fixed a lost-update race in log compaction caused by PostgreSQL sequence values committing out of order, with a deterministic two-transaction regression test.
