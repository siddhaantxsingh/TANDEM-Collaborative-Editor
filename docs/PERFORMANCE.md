# Performance, load and failure testing

Every number on this page comes from a run recorded in `docs/results/`.
Nothing is extrapolated.

## Test machine and its limits

One cloud VM: **2 vCPUs** (Intel Xeon @ 2.10 GHz), 7.8 GiB RAM, Node 22.22,
PostgreSQL 16.15, Redis 7.0.15. The server node(s), PostgreSQL, Redis **and
the load generator** all ran on these two cores. Consequences:

* Above ~100 fully active clients the machine is CPU-saturated, and the
  load generator (each simulated client is a full Yjs replica that applies
  every peer's edits) uses more CPU than the server. Latencies in those rows
  measure the saturated machine, not the server alone.
* The two-node runs show that the multi-node path (Redis relay,
  anti-entropy, shared database) stays **correct** under load. They do
  **not** show throughput scaling with more nodes: two nodes on the same two
  cores cannot do more work than one. Horizontal scalability is therefore
  **not demonstrated**.

## Method

`tools/loadtest.ts` drives N headless clients that use the same sync engine
as the browser, over real WebSockets, in 1–2 generator processes. Each
client edits at 2 edits/s (random inserts of a tagged token, some deletes);
documents have 10 clients each (`clients / 10` documents). Each run: 30 s of
editing, then a wait until every client has zero unsaved edits and all
replicas of a document are identical, then a **reconnect storm** (every
client drops its socket at the same instant and makes one edit while
disconnected), then a comparison of every document with the database.

* **propagation** = edit made → observed by another client (all receivers).
* **ack** = update sent → server's Ack, which is sent only after the
  PostgreSQL commit (i.e. durability latency).
* **server CPU / RSS / event-loop lag** come from deltas of the server's own
  `/metrics` (`process.cpuUsage`, RSS, `monitorEventLoopDelay` p99),
  sampled every second; **generator CPU** is the load tool's own usage.
* Runner: `tools/loadmatrix.sh` starts a fresh server and database per row.

Raw data: `docs/results/load-2026-10-05.jsonl` (one JSON object per row).

## Results (2026-10-05)

Every row passed every check: 0 failed connections, all edits acknowledged,
all replicas converged, database identical to the clients, all offline
storm edits present, 0 backpressure disconnects, 0 rate-limit hits, 0
server errors, 0 repair writes.

| Nodes | Clients (editing) | Docs | Edits/s achieved (target) | Propagation p50 / p95 / p99 ms | Ack p50 / p95 / p99 ms | Server CPU % (per node) | Peak RSS MiB | Server loop lag p99 max ms | Msgs in / out per s | Generator CPU % | Storm: all rejoined / all saved+converged ms |
| ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | --- |
| 1 | 1 | 1 | 2 (2) | – (no peer) | 4 / 8 / 15 | 1.4 | 91 | 42.6 | 2 / 2 | 1.0 | 125 / 125 |
| 1 | 5 | 1 | 10 (10) | 2.4 / 4.8 / 8.4 | 4 / 8 / 12 | 3.0 | 92 | 51.2 | 10 / 49 | 3.6 | 145 / 145 |
| 1 | 10 | 1 | 19 (20) | 3.4 / 6.9 / 11.8 | 5 / 9 / 16 | 5.6 | 93 | 37.7 | 20 / 193 | 10.2 | 147 / 170 |
| 1 | 25 | 3 | 48 (50) | 2.6 / 6.2 / 10.0 | 4 / 10 / 19 | 9.1 | 94 | 46.5 | 49 / 405 | 16.8 | 177 / 182 |
| 1 | 50 | 5 | 97 (100) | 3.0 / 13.0 / 24.9 | 5 / 21 / 36 | 15.2 | 110 | 50.8 | 98 / 965 | 35.4 | 336 / 389 |
| 1 | 100 | 10 | 191 (200) | 5.0 / 40.4 / 95.8 | 9 / 54 / 118 | 19.2 | 119 | 49.9 | 194 / 1,912 | 59.3 | 396 / 463 |
| 1 | 500 | 50 | 797 (1,000) | 168 / 513 / 695 | 238 / 635 / 881 | 37.6 | 155 | 222 | 807 / 7,925 | 122.6 | 1,745 / 1,965 |
| 1 | 1,000 | 100 | 1,095 (2,000) | 508 / 1,349 / 1,870 | 1,028 / 2,360 / 2,982 | 43.3 | 151 | 549 | 1,109 / 10,798 | 130.5 | 2,936 / 3,208 |
| 1 | 1,000 (100) | 100 | 193 (200) | 1.8 / 11.1 / 28.4 | 4 / 18 / 62 | 19.4 | 124 | 52.8 | 225 / 1,957 | 37.7 | 2,375 / 2,416 |
| 2 | 100 | 10 | 192 (200) | 4.8 / 28.1 / 59.4 | 9 / 39 / 78 | 16.5 + 16.5 | 125 / 119 | 59.9 | 195 / 1,920 | 60.4 | 491 / 554 |
| 2 | 500 | 50 | 767 (1,000) | 198 / 522 / 730 | 259 / 657 / 910 | 24.3 + 24.7 | 132 / 132 | 378 | 780 / 7,645 | 115.3 | 1,519 / 1,682 |
| 2 | 1,000 | 100 | 1,090 (2,000) | 546 / 1,404 / 1,806 | 781 / 2,710 / 3,863 | 28.5 + 28.7 | 143 / 137 | 823 | 1,112 / 10,832 | 112.4 | 2,908 / 3,213 |

Reading the table:

* **Up to 100 fully active clients** (≈ 200 edits/s, ≈ 1,900 outgoing
  messages/s) on one node: propagation p99 < 100 ms, durable-ack p99
  < 120 ms, server CPU < 20 %.
* **1,000 connected clients, 100 of them editing**: p99 propagation 28 ms,
  ack 62 ms, 124 MiB RSS. Holding idle connections is cheap; cost follows
  edit volume.
* **500 and 1,000 fully active clients**: the generator could not produce
  the target rate (767–797 of 1,000 and 1,090–1,095 of 2,000 edits/s) and used 1.1–1.3
  of the 2 cores; server event-loop lag rose to 0.2–0.8 s because the
  process was starved of CPU, not because it was busy (server CPU ≤ 43 %).
  Seconds-level latency here is a property of this machine. These rows do
  show that nothing is lost or diverges under overload.
* **Reconnect storm**: 1,000 clients reconnecting at once were all re-joined
  in ≤ 3.0 s and all offline edits were saved and converged in ≤ 3.3 s.
* **Connection setup** (open → first sync, per client, connecting in
  waves of 100): p50 24–410 ms, p99 ≤ 720 ms in all rows.
* **Memory**: peak RSS 91 MiB idle-ish to 155 MiB with 500–1,000 clients.

Not measured: dedicated server hardware, separate load-generator machines,
more than 1,000 clients, more than 2 nodes, documents near the 8 MiB limit
under load, long-duration (soak) runs, cross-region latency.

### A bug found by these runs

The 100-client and 1,000-client runs of a first pass logged "durability
sweep wrote updates missing from the database". Cause: the sweep compared
the database with the *current* replica, so an edit that arrived while the
sweep was reading the database (and was being persisted normally) looked
missing and was written twice. Harmless (CRDT duplicates are no-ops) but a
false alarm and wasted writes. Fixed by comparing against the replica as it
was when the sweep started; regression test in `multinode.test.ts` (fails
on the old code). The recorded runs above are after the fix: 0 repair
writes.

## Failure testing (chaos)

`tools/chaos.ts`: 8 clients (4 behind a fault-injecting TCP proxy in front
of node 1, 4 on node 2) insert uniquely tagged words every 50 ms while
faults are injected one after another. For each fault, measured from the
moment it is healed: **propagation recovery** (every client joined and has
every edit any client made before healing) and **durability recovery** (every
update sent before healing is acknowledged = committed). Afterwards every
inserted word must be present exactly once in every replica and the
database. Log: `docs/results/chaos-v2-2026-10-05.log` (two runs).

| Fault | Run 1 propagation | Run 2 propagation | Run 2 durability |
| --- | ---: | ---: | ---: |
| Network partition of node 1 for 8 s (proxy stops forwarding, sockets stay open: half-open) | 302 ms | 297 ms | 120 ms |
| 200 ms added latency on node 1 for 5 s | 233 ms | 246 ms | 266 ms |
| Reconnect storm (all clients drop at once) | 185 ms | 210 ms | 210 ms |
| SIGKILL node 1, restart after 3 s | 1,234 ms | 92 ms | 63 ms |
| Redis restart | 20 ms | 19 ms | 19 ms |
| PostgreSQL stopped for 4 s | 20 ms | 1 ms | 215 ms |
| SIGKILL node 2, restart after 1.5 s | 691 ms | 942 ms | 921 ms |
| **Total inserts / missing or duplicated / converged / DB matches** | 5,928 / 0 / yes / yes | 5,872 / 0 / yes / yes | |

During the PostgreSQL outage edits kept propagating between clients
(relaying does not wait for the database) while acknowledgements were
withheld; the nodes logged 12 retried writes with exponential backoff, and
everything was acknowledged 215 ms after the database returned. Recovery
times after a node kill vary between runs (92 ms vs 1,234 ms) because they
include the client's randomized reconnect backoff.

Also exercised by the automated suite (deterministic, seeded):
duplicated, dropped (30 %), reordered and delayed (≤ 300 ms) frames,
sockets killed at random, clients offline and back (`convergence.test.ts`,
see [CORRECTNESS.md](CORRECTNESS.md)).

## Deployment smoke test

`tools/deploy-smoke.sh` with the production image (two containers,
read-only root file system, all capabilities dropped, uid 1000) behind nginx
using `deploy/nginx.conf`. Log: `docs/results/deploy-smoke-2026-10-05.log`.

| Step | Result |
| --- | --- |
| 19 smoke checks through nginx (health, app, CSP, frame options, service worker caching, `/metrics` not public, request ids, cookie flags, CSRF and cross-origin WebSocket refusal, IDOR, anonymous refusal, edit acknowledged and stored) | all PASS |
| `/metrics` on a node | 404 without token, 200 with token |
| Client address behind nginx (`TRUST_PROXY`) | recorded as the real client address |
| 200 clients through nginx, 20 s + storm | converged, all saved, DB matches; propagation p99 519 ms (machine shared with Docker and nginx) |
| **Rolling restart of both nodes under load** (100 clients, 30 s; stop node 1, start, stop node 2, start) | converged, all saved, DB matches; `docker stop` 879 ms / 559 ms, exit 0 |
| Restart of both nodes, then verify | session valid, document content intact |
| Backup and restore into a new database | 31 / 31 documents, all decode |

The first rolling-restart attempt **failed**: clients could not reconnect
for about two minutes and the run timed out. Cause: `deploy/nginx.conf`
used `max_fails=1 fail_timeout=5s`. After both nodes had been marked failed,
nginx lets one probe request through per `fail_timeout` and clears the mark
only when that request completes; a WebSocket probe completes only when the
socket closes, so both nodes stayed "down" (5,396 "no live upstreams"
errors while both containers were healthy). Fixed with `max_fails=0` plus
`proxy_next_upstream error timeout` and a 2 s connect timeout: a refused
connect is retried on the other node within the same request. The recorded
run is after the fix: 0 "no live upstreams" errors.

## Earlier baseline (protocol v1)

`docs/results/loadtest-v1-2026-10-05.json` and `chaos-v1-2026-10-05.log`
were recorded before this hardening pass with the previous tools (50 clients
single node, 60 clients on two nodes; node kills, Redis and PostgreSQL
restarts). They are kept for comparison only.
