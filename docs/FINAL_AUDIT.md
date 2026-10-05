# Final report — Tandem 0.2 (production-hardening pass)

Date: 2026-10-05. Scope: the hardening pass that started from commit
`ed628fa` (audit: [HARDENING_AUDIT.md](HARDENING_AUDIT.md)). Every result
below was produced in this pass on one 2-vCPU VM and is recorded in
`docs/results/` or reproducible with the commands in
[TESTING.md](TESTING.md). Anything not run is marked **NOT RUN**.

## 1. Verification status

| Check | Status | Evidence |
| --- | --- | --- |
| Build, strict typecheck (protocol, server, client, tools) | PASS | `npm run build`, `npm run typecheck` |
| Unit / integration / property / fuzz / fault-injection tests | PASS — 88/88 | `npx vitest run` |
| Browser E2E incl. offline reload and offline browser restart | PASS — 3/3 | `npx playwright test` |
| CRDT property tests (convergence, idempotence, commutativity, no resurrection, compaction) | PASS | `crdt.test.ts` |
| Convergence under delay / duplication / reordering / loss / kills / offline, 2–10 clients, two nodes | PASS — 20 scenarios | `convergence.test.ts` |
| Mutation checks (tests catch the defects they target) | PASS — 3 mutations detected | TESTING.md |
| Load matrix 1, 5, 10, 25, 50, 100, 500, 1,000 clients (1 node), 100/500/1,000 (2 nodes + Redis), 1,000 connected / 100 editing | PASS (all converged, all saved, DB matches) | `docs/results/load-2026-10-05.jsonl` |
| Reconnect storm in every load row (up to 1,000 simultaneous reconnects with offline edits) | PASS | same |
| Chaos: partition (half-open), latency, reconnect storm, SIGKILL ×2, Redis restart, PostgreSQL outage | PASS — 2 runs, 0 lost/duplicated of 11,800 inserts | `docs/results/chaos-v2-2026-10-05.log` |
| Production image: build, non-root, read-only root fs, no capabilities | PASS (stand-in base image, see §8) | `docs/results/deploy-smoke-2026-10-05.log` |
| Deployment smoke test through nginx (19 checks) | PASS | same |
| Rolling restart of both nodes under load | PASS after fixing `deploy/nginx.conf` (first attempt FAILED) | same; PERFORMANCE.md |
| Backup + restore (while running) | PASS — 31/31 documents | same |
| CI job steps (build, typecheck, tests, E2E, smoke + load, chaos) run locally | PASS | |
| Everything above repeated from a clean `git clone` (vitest, E2E, chaos, image build, deployment smoke incl. rolling restart and backup/restore) | PASS | `deploy-smoke-2026-10-05.log` (second run) |
| `npm audit` | 0 vulnerabilities | |
| GitHub Actions on GitHub | **NOT RUN** | no remote repository or runner here |
| Image built from the official `node:22-bookworm-slim` | **NOT RUN** | Docker Hub blocked here |
| Deployment to real hosting (TLS, DNS, managed DB, separate hosts), real user traffic | **NOT RUN** | |
| Horizontal throughput scaling (more nodes → more capacity) | **NOT DEMONSTRATED** | all processes shared 2 vCPUs |
| External penetration test | **NOT RUN** | |

## 2. Architecture

Browser (React, Monaco, y-monaco, Y.Doc replica in IndexedDB, service
worker app shell) ⇄ binary WebSocket protocol v2 ⇄ any number of stateless
Node.js nodes (HTTP API, WebSocket endpoint with flow control and limits,
one in-memory Y.Doc per open document, persist queue) ⇄ PostgreSQL
(snapshots + append-only update log, compaction under an advisory lock,
audit log) with Redis pub/sub between nodes (updates, presence, sync
requests, role changes) and Redis-backed login limits. Details:
[ARCHITECTURE.md](ARCHITECTURE.md), [PROTOCOL.md](PROTOCOL.md).

## 3. Algorithm

Yjs 13.6 (YATA sequence CRDT); no OT, no last-write-wins in document
content. State-vector handshake on every (re)join; incremental updates with
client sequence numbers; Ack only after the PostgreSQL commit. This pass
found and works around a Yjs liveness quirk (items left pending although all
dependencies arrived; 0.78 % of random out-of-order deliveries) with a
healing apply used everywhere. [CORRECTNESS.md](CORRECTNESS.md).

## 4. Demonstrated guarantees

| Invariant | Demonstrated by |
| --- | --- |
| I1 concurrent operations converge | CRDT property (300 runs, 2–10 replicas); 12 randomized + 8 deterministic real-client scenarios; every load and chaos run |
| I2 duplicates idempotent | property (200 runs); "every frame duplicated" scenario |
| I3 out-of-order safe | commutativity property; characterization of the Yjs quirk + fix; "every Update held back" scenario; P1 regression (dependent update stored before ack) |
| I4 lost operations recovered | 30 % silent-loss scenario (ack timeout + periodic resync); P4 (pub/sub loss repaired by anti-entropy); mutation check |
| I5 reconnection restores state | stale-replica test; kill/offline profile; reconnect storms of 1,000 clients; node kills in chaos and rolling restart |
| I6 offline edits merged without silent loss | 10 clients offline at the same position; E2E reload and browser restart while offline; storm edits made while disconnected present in every load row |
| I7 presence cannot corrupt documents | presence garbage/spoofing/flood scenario; P3 |
| Ack means durable | ack-after-commit tests; PostgreSQL outage in chaos (acks withheld, then all written) |

These are test results, not proofs; the server has no formal model.

## 5. Load results (summary of [PERFORMANCE.md](PERFORMANCE.md))

* One node, up to 100 fully active clients (≈ 200 edits/s): propagation p99
  ≤ 96 ms, durable-ack p99 ≤ 118 ms, server CPU ≤ 20 %, RSS ≤ 119 MiB.
* 1,000 connected clients with 100 editing: propagation p99 28 ms, ack p99
  62 ms, RSS 124 MiB.
* 500 and 1,000 fully active clients: correct (no loss, converged) but the
  shared 2-vCPU machine was saturated — the generator reached only
  767–1,095 edits/s of the 1,000–2,000 targeted and latency rose to seconds.
  These rows are not a capacity measurement of the server.
* Reconnect storm of 1,000 clients: all re-joined ≤ 3.0 s, all offline edits
  saved and converged ≤ 3.3 s.
* Two nodes: correct at 100/500/1,000 clients; no throughput gain measurable
  on shared cores.

## 6. Failure results

Chaos (2 runs, 8 clients, 2 nodes): after an 8 s half-open partition
clients recovered in ≈ 0.3 s; after a node SIGKILL + restart in 0.06–1.2 s;
Redis restart ≈ 20 ms; during a 4 s PostgreSQL outage edits kept
propagating, acks were withheld and all were committed 215 ms after the
database returned. 0 missing or duplicated words, database identical.
Rolling restart of both containers under 100-client load through nginx:
converged, all saved. Graceful stop: 106–880 ms, exit 0.

Bugs found by these runs and fixed in this pass: spurious durability-sweep
repairs under load (race); nginx passive health checks locking WebSocket
clients out after a rolling restart.

## 7. Security

Server-side OWNER/EDITOR/VIEWER on every HTTP endpoint and WebSocket join
and update; authorization matrix test (endpoint × role × own/foreign ids)
covers IDOR, privilege escalation and enumeration (NotFound for
inaccessible resources). Origin checks (CSRF, cross-site WebSocket), scrypt,
hashed session tokens, session cleanup, Redis-shared login limits,
`TRUST_PROXY`, protected `/metrics`, audit log, strict CSP, per-connection
rate/size/queue limits with global budgets. **Code execution: disabled** —
no isolation that could guarantee safety is available in this deployment
(ADR-007); nothing executes user code. Details and known gaps:
[SECURITY.md](SECURITY.md).

## 8. Deployment

Multi-stage Dockerfile (non-root, health check), compose with PostgreSQL,
Redis, two nodes, nginx; secrets only from `.env`; forward-only
transactional migrations (tested upgrading a version-1 database);
bounded graceful shutdown; backup/restore scripts with a verification step;
CI workflow; post-deployment smoke test (`tools/smoke.ts`). The deployment
smoke test ran the production image on one machine (containers + nginx +
host PostgreSQL/Redis). The image's base was a locally assembled stand-in
for `node:22-bookworm-slim` (Node 22.22 with the host's glibc 2.39
libraries, no OS userland — not Debian) because Docker Hub is blocked here;
the official base adds a Debian userland and must be re-tested. [DEPLOYMENT.md](DEPLOYMENT.md).

## 9. Limitations

1. Not deployed to real infrastructure or real users; GitHub Actions not run.
2. Horizontal scalability not demonstrated: all load runs shared 2 vCPUs
   with the generator; capacity on dedicated hardware is unknown.
3. Above ~100 fully active clients per this machine, latency is
   seconds-level (machine saturation).
4. Correctness rests on tests (property, fault injection, chaos), not on a
   formal model; Yjs is a dependency whose quirk this pass had to work
   around — a Yjs upgrade must re-run `crdt.test.ts` and `pending-check`.
5. Presence and per-connection rate limits are per connection; one user can
   open several connections (bounded by per-document and server caps).
6. No email verification, password reset, MFA, or end-to-end encryption; no
   external penetration test.
7. No code execution feature (by design until a sandbox service exists).
8. Character-level merge only: no semantic conflict detection.
9. A restore loses edits acknowledged after the backup unless a client that
   still holds them reconnects.
