# Deployment, operations, backups

## Configuration (environment variables)

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://postgres@127.0.0.1:5432/tandem` | migrations run automatically at start (advisory-locked) |
| `REDIS_URL` | unset | set for multi-node; unset = single node |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | |
| `NODE_ID` | random | appears in logs and in `doc_updates.node_id` |
| `ALLOWED_ORIGINS` | same host | comma-separated, e.g. `https://tandem.example.com` |
| `COOKIE_SECURE` | `false` | **set `true` behind HTTPS** |
| `STATIC_DIR` | unset | built client to serve (the Docker image sets it) |
| `SESSION_TTL_HOURS` | 168 | |
| `COMPACT_EVERY` | 500 | stored updates between compactions |
| `DURABILITY_SWEEP_MS` | 15000 | 0 disables |
| `MAX_CONNECTIONS`, `MAX_CONNECTIONS_PER_DOC` | 5000, 200 | |
| `MAX_DOCUMENT_BYTES` | 8 MiB | |
| `SEND_BUFFER_LIMIT` | 16 MiB | bytes queued to one socket before it is closed (4009); must exceed `MAX_DOCUMENT_BYTES` |
| `GLOBAL_SEND_BUDGET`, `GLOBAL_REASSEMBLY_BUDGET` | 512 MiB, 256 MiB | all sockets together |
| `INBOUND_QUEUE_MESSAGES`, `INBOUND_QUEUE_BYTES` | 1000, 4 MiB | received but not yet handled, per connection |
| `MSG_RATE_PER_SEC`/`MSG_BURST`, `BYTE_RATE_PER_SEC`/`BYTE_BURST` | 200/400, 1 MiB/4 MiB | per connection |
| `OP_RATE_PER_SEC`/`OP_BURST` | 100/300 | document updates per connection |
| `HANDSHAKE_TIMEOUT_MS`, `HEARTBEAT_MS` | 10000, 30000 | |
| `LOGIN_ATTEMPTS_PER_MINUTE`, `REGISTRATIONS_PER_HOUR` | 10, 20 | per client address (and per email for login); shared through Redis when configured |
| `TRUST_PROXY` | `false` | `true` **only** when every request comes through your proxy (the shipped nginx); the last `X-Forwarded-For` entry is then the client address |
| `METRICS_TOKEN` | unset | bearer token for `/metrics`; unset = loopback requests only |
| `SESSION_CLEANUP_MS` | 3600000 | interval of expired-session deletion |
| `SHUTDOWN_GRACE_MS` | 5000 | time open HTTP requests get on shutdown |
| `LOG_LEVEL` | `info` | JSON logs on stdout |

Secrets (`POSTGRES_PASSWORD`, `METRICS_TOKEN`) come from the environment
or an uncommitted `.env` (template: `.env.example`); `docker compose`
refuses to start without them.

## Running

* Single node: `npm ci && npm run build && DATABASE_URL=... STATIC_DIR=packages/client/dist node packages/server/dist/main.js`.
* Docker: `docker build -t tandem .` (multi-stage; runtime image has
  production dependencies only and runs as the unprivileged `node` user,
  with a `HEALTHCHECK`).
* Multi-node: `docker compose up --build` starts PostgreSQL, Redis, two
  nodes and nginx on <http://localhost:8080>. The containers run read-only
  with all capabilities dropped.
* Kubernetes or similar: liveness `GET /health/live`, readiness
  `GET /health/ready` (database and Redis reachable, not shutting down).
  Any number of replicas; no session affinity required.

## Load balancer

`deploy/nginx.conf` proxies `/ws` (WebSocket upgrade, 120 s read timeout)
and the API to all nodes round-robin, adds `X-Forwarded-For` and
`X-Request-Id`, and returns 404 for `/metrics`. Upstreams use
`max_fails=0` with `proxy_next_upstream error timeout`: a node that refuses
connections is skipped within the same request. **Do not** enable passive
failure marking (`max_fails=1`) for WebSocket upstreams: the rolling-restart
test showed it locks clients out for minutes (see
[PERFORMANCE.md](PERFORMANCE.md#deployment-smoke-test)).

## Graceful shutdown

On SIGTERM a node: stops accepting WebSocket upgrades (503) and reports not
ready; closes WebSockets with 1001 (clients reconnect through the load
balancer to another node); closes idle HTTP connections and gives busy ones
`SHUTDOWN_GRACE_MS`, then closes the rest; writes every queued update and
compacts open documents; closes Redis and the database pool. Each step is
logged with its duration (`"shutdown step done"`). A 20 s guard forces exit.
Measured with the container: `docker stop` 106–880 ms, exit code 0,
including under load. Clients keep unacknowledged edits and resend them
after reconnecting.

## Deployment smoke test

After every deployment run, against the public URL:

```
npx tsx tools/smoke.ts --url https://tandem.example.com --phase write --state smoke.json
# ... restart or redeploy ...
npx tsx tools/smoke.ts --url https://tandem.example.com --phase verify --state smoke.json
```

It checks health, the app shell and its headers, that `/metrics` is not
public, cookie flags (and `Secure` on HTTPS), CSRF and cross-origin
WebSocket refusal, request ids, IDOR, and an edit made over the real
protocol through the load balancer and acknowledged; `verify` checks that
the session and the document survived. `tools/deploy-smoke.sh` runs the
whole sequence locally against the production image (two containers +
nginx), including a rolling restart under load and a backup/restore; its
recorded output is `docs/results/deploy-smoke-2026-10-05.log`.

What has **not** been done: a deployment to a real hosting environment
with TLS, DNS, a managed database and separate hosts. The image was built
from a locally assembled stand-in for `node:22-bookworm-slim` (Node 22.22
and glibc 2.39 libraries only, no Debian userland) because Docker
Hub is not reachable from the build environment; the CI workflow builds
from the official image but has not been run on GitHub.

## Observability

* Logs: one JSON object per line with `time`, `level`, `msg`, `node`, and
  context (`requestId` for HTTP, `conn`, `docId`, `user`). Every HTTP
  response carries `X-Request-Id` (a valid incoming one is kept, so nginx's
  `$request_id` correlates both logs); 500 responses include it in the body.
* Metrics at `GET /metrics` (Prometheus text; bearer token): connections,
  active users and documents; messages in/out by type; histograms for
  persistence, **ack latency**, HTTP latency by route, database query,
  Redis, compaction and sweep duration; queue bytes (send, inbound,
  reassembly); counters for rate limiting, backpressure disconnects, stale
  connections (heartbeat/handshake timeout, superseded), protocol errors,
  reconnects, persist failures, pending (dependency-waiting) updates,
  anti-entropy and durability repairs, expired sessions; process CPU,
  RSS, heap and event-loop lag p99.

Suggested alerts: readiness failing; `tandem_pending_persist_updates` > 1000
for 1 min; `tandem_persist_failures_total` increasing;
`tandem_durability_sweep_repairs_total` or
`tandem_anti_entropy_repairs_total` increasing (a node lost unwritten
updates or a pub/sub message was lost; the sweep fixed it); p99
`tandem_ack_latency_seconds` > 1 s; event-loop lag p99 > 200 ms.

## Backups and restore

* `scripts/backup.sh` runs `pg_dump --format=custom` (a consistent snapshot
  while users keep editing). Schedule it (e.g. hourly) and keep copies off
  the database host; for point-in-time recovery use PostgreSQL WAL archiving
  (managed services provide this).
* `scripts/restore.sh backup.dump` restores into an empty database and
  decodes every document to prove the backup is usable.
* Drills performed on 2026-10-05: (1) backup of a load-test database
  (9 documents, 145 KB dump), restored, every document's text identical to
  the source (9/9); (2) in the deployment smoke test, 31 documents backed up
  while the containers ran, restored, 31/31 decode.
* What a restore loses: edits acknowledged after the backup. Clients that
  still hold newer replicas re-upload them on their next connection (the
  CRDT merge makes that safe), so recent work of connected users is often
  recovered automatically.

## Scaling notes

Measured capacity is in [PERFORMANCE.md](PERFORMANCE.md). Each open
document costs one in-memory replica per node that has clients for it;
documents are unloaded 30 s after their last client leaves. The write load
is one INSERT per batch per document; PostgreSQL is the shared bottleneck,
so batch size and compaction frequency are the main levers.
