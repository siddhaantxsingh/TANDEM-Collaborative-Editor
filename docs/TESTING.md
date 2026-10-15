# Testing

```
npm ci && npm run build
npx vitest run                     # 88 tests (needs PostgreSQL + Redis; TEST_DATABASE_ADMIN_URL, TEST_REDIS_URL)
CHROMIUM_PATH=... npx playwright test        # browser end-to-end
tools/loadmatrix.sh                # load: 1 … 1,000 clients, 1 and 2 nodes (see PERFORMANCE.md)
PG_STOP=... PG_START=... REDIS_RESTART=... npx tsx tools/chaos.ts
IMAGE=tandem:latest tools/deploy-smoke.sh    # production image + nginx: smoke, rolling restart, backup/restore
npx tsx tools/smoke.ts --url https://… --phase write|verify   # after a real deployment
npx tsx tools/pending-check.ts     # how often the Yjs pending-struct quirk occurs (CORRECTNESS.md)
```

Integration tests create a fresh database per test file and start real
servers on random ports; nothing is mocked. Randomized tests are seeded and
print the seed in the test name.

## Suites

| File | Tests | What it demonstrates |
| --- | ---: | --- |
| `protocol/test/codec.test.ts` | 7 | every message round-trips (random cases); 20,000 random byte strings and 20,000 mutated frames only ever raise `ProtocolError` (fuzz); truncation, trailing bytes, other versions, invalid ids, oversized fields rejected; fragmentation and exact reassembly; oversized, interleaved, reordered and non-document fragment streams refused; version-1 error for outdated clients |
| `protocol/test/crdt.test.ts` | 6 | CRDT properties on Yjs directly: convergence under random delivery, duplication and loss (300 runs, 2–10 replicas); idempotence; commutativity with out-of-causal-order delivery; the Yjs pending-struct characterization and its fix; no resurrection of deleted text; compaction ≡ log replay |
| `server/test/convergence.test.ts` | 20 | invariants I1–I7 with real clients and servers over a fault-injecting socket: 12 randomized cases (2/5/10 clients × clean / delay+duplicate+reorder / 30 % loss / socket kills+offline, two nodes) and 8 deterministic scenarios (same character, same line, overlapping selections, all frames duplicated, all reordered, 30 % silent loss, 300 ms delay, presence garbage) |
| `server/test/regressions.test.ts` | 12 | audit defects P1–P5 (dependent update stored before ack; 1.8 MB document opens; 1.2 MB offline edit uploads; reconnecting presence; edit lost on pub/sub repaired) and protocol v2 rules (Hello required, handshake timeout, v1 client told to reload in its own format, session supersede, error refers to the request, operation rate limit, inbound byte bound) |
| `server/test/security.test.ts` | 11 | authorization matrix (every endpoint × owner/editor/viewer/non-member/anonymous × own/foreign ids), WebSocket join refusal, audit log, `TRUST_PROXY`, login limit across nodes via Redis, metrics token, request ids, session cleanup, security headers, migration of a version-1 database |
| `server/test/sync.test.ts` | 5 | two editors converge with ack-after-persist; offline edits on both sides merge; restart + compaction; stale replica catches up; presence identity cannot be spoofed |
| `server/test/auth.test.ts` | 12 | hashing, register/login/logout, validation, login rate limit, CSRF and cross-site WebSocket refusal, viewer cannot write via a raw socket, live role change/removal, last owner protected, path traversal, deletion disconnects clients |
| `server/test/multinode.test.ts` | 5 | cross-node edits/presence/role changes, failover keeps edits, durability sweep, sweep not fooled by an edit that arrives during its database read |
| `server/test/limits.test.ts` | 7 | malformed frames, malformed Yjs updates, flooding, document size limit, backpressure disconnect, health/metrics, readiness without database |
| `server/test/property.test.ts` | 2 | fast-check scenarios of 2–4 clients on two nodes with random edits, pauses and disconnects: replicas and database identical, every insert exactly once |
| `server/test/session.test.ts` (2026-10-14) | 9 | logout closes that session's sockets on every node and only that session; log out everywhere; expiry; admin revocation; membership/role/document changes without bus events reach live sockets |
| `server/test/offline-property.test.ts` (2026-10-14) | 1 | fast-check: 2-5 clients over 2 nodes, offline periods, duplicate/reorder/delay; identical content, state vector, delete set and canonical bytes everywhere incl. PostgreSQL (30 runs by default, `OFFLINE_PROP_RUNS`) |
| `server/test/db-resilience.test.ts` (2026-10-14) | 1 | killed backend of a checked-out pool client does not crash the node |
| `tools/crash-ack.ts` (2026-10-14) | - | kill -9 of the server / PostgreSQL during writes; every acknowledged insert stored (`tools/pg-crash-cluster.sh` for a private cluster) |
| `server/test/compaction.test.ts` | 1 | an update committing after compaction merged a higher sequence number is not lost |
| `e2e/editor.spec.ts` (Playwright) | 1 | three browsers: live typing, presence, offline then merged, viewer read-only, Run disabled |
| `e2e/offline.spec.ts` (Playwright) | 2 | reload while offline keeps edits and syncs them later; browser restart while offline (persistent profile) boots from the service worker and IndexedDB, then syncs |

## Recorded results (2026-10-05, final state)

| Check | Result |
| --- | --- |
| `npm run build`, `npm run typecheck` (protocol, server, client) and tools typecheck | PASS |
| `npx vitest run` | 11 files, **88/88 passed** (96 s) |
| Playwright | **3/3 passed** (18 s) |
| E2E repeated 3 × 3 during development (after fixing two test races) | all passed |
| CRDT property tests | 300 / 200 / 300 / 150 runs per property, all passed |
| `tools/pending-check.ts` | plain apply left pending structs in 390 of 50,000 and 116 of 15,000 random cases; healing apply 0 |
| Load matrix, 12 rows (1 → 1,000 clients, 1 and 2 nodes) | all converged, all saved, DB matches — [PERFORMANCE.md](PERFORMANCE.md) |
| Chaos, 2 runs × 7 faults | 0 missing/duplicated of 5,928 and 5,872 inserts |
| Deployment smoke test (image + nginx, rolling restart under load, backup/restore) | PASS after fixing `deploy/nginx.conf` |
| CI job steps run locally (smoke + load against a server started like CI does) | PASS |
| From a clean `git clone` of the final commit: `npm ci`, build, typecheck, vitest (88/88), Playwright (3/3), chaos (CI variant: 4,856 inserts, 0 lost), image build + `tools/deploy-smoke.sh` | PASS |
| `npm audit` (all and production dependencies) | 0 vulnerabilities |
| GitHub Actions on GitHub | **NOT RUN** (no remote repository/runner here) |

## Mutation checks (do the tests detect the defects they target?)

| Mutation | Result |
| --- | --- |
| Client ack timeout and periodic resync disabled | every lossy convergence case fails |
| Durability sweep compares against the live replica (old code) | the new multinode regression test fails |
| Healing re-application removed (plain `Y.applyUpdate`) | the characterization test fails. The commutativity property passed in this run: it found the quirk originally, but the quirk occurs in under 1 % of random cases (`pending-check`), so 300 random runs do not always hit it — the deterministic characterization case is what guards it |

## Bugs found by testing in this pass

| How | Bug | Fix |
| --- | --- | --- |
| Probe tests during the audit | P1–P5, P9 (see HARDENING_AUDIT.md) | fixed with regression tests |
| CRDT property test | Yjs leaves items pending although all dependencies arrived | `applyUpdateHealing` everywhere updates are applied |
| E2E offline boot | app showed the login page offline: `/api/me` never cached | cache it on login/registration |
| Shutdown under E2E | shutdown hung 20 s on HTTP connections with unfinished responses | bounded grace period, then forced close |
| Load test (100+ clients) | spurious durability-sweep repairs (race with in-flight persistence) | compare with the replica as of sweep start |
| Deployment smoke test | nginx passive health checks locked WebSocket clients out for minutes after a rolling restart | `max_fails=0` + `proxy_next_upstream` |
