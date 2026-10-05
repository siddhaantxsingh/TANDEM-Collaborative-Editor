# Hardening audit (phase 1 of the final pass)

Date: 2026-10-05. Written before any change of this pass, from reading every
source file and from probe tests run against the server
(`packages/server/test/probe*.test.ts`, temporary; each confirmed defect
became a regression test). Starting point: commit `ed628fa`; 35/35 tests
passing (`npx vitest run`).

## 1. What exists

| Area | Implementation | Assessment |
| --- | --- | --- |
| Collaboration algorithm | Yjs (YATA sequence CRDT) via `yjs` 13.x; one `Y.Text("content")` per document | a real CRDT (see §3) |
| Protocol | binary, version byte 1, 12 message types (`packages/protocol`), strict decoder, fuzzed | no handshake/negotiation message, no fragmentation, errors not correlated to the failing request |
| Sync | state-vector handshake (Sync1/Sync2) per channel; incremental Update with client `seq`; Ack after PostgreSQL commit | correct design; defects P1, P2, P5 below |
| Client engine | `TandemConnection` (shared by browser, tests, load tester): multiplexing, backoff with jitter, app-level ping | no ack timeout, no periodic anti-entropy |
| Offline | y-indexeddb replica per document in the browser | unsynced state not tracked across reloads; the app cannot boot without the server (no app-shell cache; `/api/me` failure → login page) |
| Persistence | `doc_snapshots` + append-only `doc_updates`, compaction under advisory lock (race fixed earlier), load = snapshot + all log rows | sound; no audit log; expired sessions never deleted |
| Multi-node | Redis pub/sub per document + SyncRequest/SyncReply on load and after Redis reconnect; durability sweep (memory → DB) | P4: a lost pub/sub message is never repaired while the room stays loaded |
| Presence | y-protocols awareness, identity rewritten server-side, ≤4 ids per member | P3: a reconnecting replica's presence is rejected while its old socket lingers |
| Auth | scrypt, random session tokens stored hashed, httpOnly SameSite=Lax cookie, origin check on WS and state-changing HTTP | client IP = socket address (behind the shipped nginx every user shares one login-rate bucket); `/metrics` public; limits per node only |
| Authorization | OWNER/EDITOR/VIEWER in PostgreSQL, checked per request and at WS join; live role changes over the bus | sound; tested for main paths, no endpoint × role matrix |
| Backpressure | per-connection send-buffer limit (8 MiB), message and byte token buckets, ≤1000 queued inbound messages | inbound queue bounded by count, not bytes; with 5,000 connections the send limits allow ~40 GiB; no separate operation rate |
| Observability | JSON logs, Prometheus `/metrics` (counters/gauges, persist histogram), `/health/live`, `/health/ready` | missing: API latency, compaction duration, DB/Redis latency, ack latency, process CPU/memory/event-loop lag, heartbeat drops, request ids |
| Frontend | React + Monaco + y-monaco, file tree, presence avatars, status bar | presence sent on every cursor move (no throttle); no responsive CSS; status not announced to screen readers |
| Code execution | none ("Run" button disabled by design, ADR-007) | correct: nothing executes user code |
| Tests | 35 vitest tests (unit, integration, two-node, property with fast-check, codec fuzz) + 1 Playwright E2E | no fault-injecting network, no 5/10-client deterministic scenarios, no CRDT-level property tests, no authz matrix |
| Load / chaos | `tools/loadtest.ts` (50–60 clients measured), `tools/chaos.ts` (node kill, Redis/PG restart) | no CPU/memory measurement, no 100–1000 client runs, no reconnect-storm measurement |
| Deployment | multi-stage Dockerfile (non-root), compose with 2 nodes + nginx, CI workflow, backup/restore scripts | compose has a literal DB password; no proxy trust setting |

## 2. Defects confirmed by probes

| # | Defect | Probe result | Severity |
| --- | --- | --- | --- |
| P1 | An Update whose causal dependencies the server lacks is **acknowledged but not stored**: Yjs keeps it as a pending struct (no `update` event), the room sees "nothing new" and acks at once. A crash then loses data the client was told is safe. | `acked: true, rows stored: 0` | high (breaks the ack-after-persist invariant) |
| P2 | Documents larger than 1 MiB can never be opened: the server's `Sync2` exceeds the decoder's 1 MiB frame limit, the client drops it and stays "Connecting…". The document size limit is 8 MiB. | 1.8 MB document, second client never synced | high |
| P3 | Presence of a reconnecting replica is rejected (`Forbidden`) while its previous, half-open socket is still registered (up to two heartbeat intervals, 60 s). | `{"code":3,"message":"invalid presence update"}` | medium |
| P4 | One lost Redis pub/sub message leaves the other node's replica (and its clients) permanently without that edit while the room stays loaded; the durability sweep only writes memory → DB. | a: `"lost?"`, b: `""`, db: `"lost?"` after 4 s | high (divergence) |
| P5 | Offline edits larger than 1 MiB can never be uploaded: the reconnect `Sync2` exceeds `maxPayload`, the server closes with 1009, the client reconnects and repeats forever. Not lost (still local), but never saved. | `unsaved 1, last close 1009` | medium |
| P6 | Behind the shipped nginx, every request has the proxy's address: login/registration limits become global (one attacker locks everyone out). | code (`clientIp` uses `socket.remoteAddress`; nginx sets `X-Forwarded-For`) | medium |
| P7 | `/metrics` is served to anyone (internal counters, document counts). | code | low |
| P8 | Expired sessions are never deleted. | code | low |
| P9 | A client has no recovery from a frame lost without a disconnect (e.g. a misbehaving proxy): no ack timeout, no periodic resync. | code | medium |

## 3. Collaboration algorithm (as implemented)

Yjs implements YATA: every inserted item has a unique id `(clientID,
clock)` and records its left and right origins at insertion time; concurrent
inserts at the same position are ordered deterministically by the origins
and then by client id. Deletions mark items deleted (tombstones, kept in a
delete set of id ranges); with `gc: true` the content of deleted items is
dropped but the structural item stays. A replica's knowledge is a state
vector (highest clock per client), the version vector of this system.
Properties relevant here: applying an update twice is a no-op (idempotent);
updates may arrive in any order (an item whose origins are unknown is held
as *pending* until they arrive); merge is commutative. These are the
properties the tests must demonstrate for this system, not assume.

## 4. Plan (in order)

1. Correctness fixes P1–P5, P9 with regression tests; deterministic and
   randomized convergence tests (2/5/10 clients, fault-injecting socket:
   delay, duplicate, reorder, drop, disconnect, offline), CRDT-level property
   tests.
2. Protocol v2: Hello/Welcome handshake (version negotiation, limits,
   heartbeat), message fragmentation, request-correlated errors, duplicate
   session supersede, handshake timeout.
3. Offline-first browser: confirmed state vector in IndexedDB, app-shell
   service worker, offline boot; Playwright tests for refresh, restart,
   network loss.
4. Backpressure: byte-bounded inbound queue, flow-controlled outbound
   queue, global buffer budget, operation rate limit.
5. Security: trusted proxy setting, protected metrics, session cleanup,
   Redis-shared login limits, authorization matrix test, secrets in compose.
6. Database: audit log, indexes, migration test.
7. Observability: the missing metrics, request ids.
8. Frontend: presence throttling, accessibility, responsive layout.
9. Load tests 1 → 1,000 clients with CPU/memory, multi-node, reconnect
   storm; chaos with network faults; container deployment smoke test.

## 5. Resolution (end of the pass)

| # | Status | Fix | Test |
| --- | --- | --- | --- |
| P1 | fixed | an update that leaves structs pending is stored raw before the Ack | `regressions.test.ts` P1 |
| P2 | fixed | Fragment message (protocol v2): Sync2/Update larger than a frame are split into ≤ 256 KiB parts | P2 (1.8 MB document) |
| P3 | fixed | presence claimed by the same user's new connection moves to it; the old socket is closed (4010) | P3 |
| P4 | fixed | sweep is anti-entropy in both directions (DB → replica, SyncRequest to peers) | P4 |
| P5 | fixed | fragmentation in the client → server direction; server limit = document limit + one frame | P5 (1.2 MB offline edit) |
| P6 | fixed | `TRUST_PROXY` (last `X-Forwarded-For` entry); limits shared through Redis | `security.test.ts` |
| P7 | fixed | `/metrics` needs `METRICS_TOKEN`, else loopback only; nginx returns 404 | `security.test.ts`, deployment smoke test |
| P8 | fixed | periodic deletion of expired sessions | `security.test.ts` |
| P9 | fixed | client ack timeout (reconnect) and periodic resync | `convergence.test.ts` 30 % silent loss; mutation check |

Found later in the pass, also fixed: the Yjs pending-struct quirk
(CORRECTNESS.md), offline boot without a cached `/api/me`, unbounded
shutdown on busy HTTP connections, spurious durability-sweep repairs under
load, and the nginx passive-health-check lockout after a rolling restart
(PERFORMANCE.md). Plan items 1–9 were carried out; for what remains
unproven see docs/FINAL_AUDIT.md "Limitations".
