# Interview notes — Tandem

## Pitch (30 s)
Tandem is a collaborative code editor: Monaco in the browser, Yjs CRDT for
conflict-free merging, my own binary WebSocket protocol with
acknowledgements that mean "committed to PostgreSQL", offline editing via
IndexedDB, server-enforced roles, and multiple nodes coordinated through
Redis. I verified it with property-based convergence tests, a fuzzed
protocol decoder, a Playwright test with three browsers, a load test that
checks convergence, and a chaos test that kills nodes and restarts Redis and
Postgres mid-session without losing any of 3,424 edits.

## Likely questions

**Why a CRDT and not OT?** OT needs a central sequencer and correct transform
functions; offline editing is awkward. A CRDT converges regardless of order
and duplicates, which also makes reconnect and multi-node simple. Cost:
metadata growth, handled by GC and compaction.

**How do you guarantee no edit is lost?** The client counts an edit as unsaved
until an Ack that the server sends only after the INSERT commits. On any
disconnect the state-vector handshake resends what the server lacks. If a
node dies after relaying but before writing, the durability sweep on other
nodes writes it. Chaos test: SIGKILL, Redis restart, Postgres outage — zero
missing or duplicated words.

**Tell me about a bug.** Compaction: I filtered the log with `seq > last_seq`.
bigserial values are assigned before commit, so a transaction with a lower
seq can commit after compaction merged a higher one — that update would never
load again. Fix: load all remaining rows (idempotent) and delete exactly the
rows merged. I wrote a test that reproduces it with two transactions.

**How is authorization enforced?** Never from the client. Role comes from the
database on join, is pushed live on change (also across nodes), and every
update is checked; I test it by sending updates from a raw socket as a
viewer. Non-members get 404 so ids can't be probed. Presence identity is
rewritten by the server.

**Backpressure?** If a socket's buffered bytes exceed a limit, the server
closes it rather than buffering; the client reconnects and resyncs by state
vector, so it's a performance event, not data loss.

**Why no "run code"?** Running untrusted code needs real isolation (micro-VMs,
no network, resource limits). Doing it in the app server would be RCE by
design, so it's disabled and documented.

**Scaling?** Stateless nodes with in-memory replicas of open documents,
Redis fan-out, Postgres as the durable store. Measured on a 2-vCPU VM: 221
edits/s with 50 clients, p50 24 ms; two nodes p50 57 ms (extra hop, shared
cores). Next: sticky routing by document to avoid N-way fan-out.

## Numbers
35 automated tests + E2E; 765 random property scenarios passed; chaos run
3,424 inserts, 0 lost; load tests 50/60 clients converged with DB match.
