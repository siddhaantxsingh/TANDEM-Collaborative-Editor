#!/usr/bin/env bash
# Deployment smoke test of the production image on one machine:
#   two app containers (read-only root fs, all capabilities dropped,
#   non-root) + nginx with deploy/nginx.conf + PostgreSQL + Redis.
# Steps: smoke checks through nginx, load through nginx, rolling restart of
# both nodes under load, data survives restarts, backup and restore.
# The containers allow 1000 registrations per hour per address (the test
# registers several users from 127.0.0.1; the limit is shared via Redis).
#
# Requires: docker, nginx, psql/pg_dump/pg_restore, a built image
# ($IMAGE, default tandem:latest), PostgreSQL and Redis on the host network.
#   IMAGE=tandem:final tools/deploy-smoke.sh 2>&1 | tee docs/results/deploy-smoke-$(date +%F).log
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE=${IMAGE:-tandem:latest}
PG=${PG:-postgres://postgres@127.0.0.1:5432}
REDIS_URL=${REDIS_URL:-redis://127.0.0.1:6379}
DB=tandem_deploy_smoke
LB=http://127.0.0.1:18090
WORK=$(mktemp -d)
TOKEN=$(openssl rand -hex 16)
step() { echo; echo "=== $*"; }
cleanup() {
  docker rm -f smoke1 smoke2 >/dev/null 2>&1 || true
  [ -f "$WORK/nginx.pid" ] && nginx -c "$WORK/nginx.conf" -s quit 2>/dev/null || true
  psql "$PG/postgres" -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -qc "DROP DATABASE IF EXISTS ${DB}_restored WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

step "image $IMAGE"
docker image inspect "$IMAGE" --format 'size {{.Size}} bytes, user {{.Config.User}}'
psql "$PG/postgres" -qc "CREATE DATABASE $DB"

start() { # n (replaces a stopped container of the same name)
  docker rm -f "smoke$1" >/dev/null 2>&1 || true
  docker run -d --name "smoke$1" --network host --read-only --cap-drop ALL --security-opt no-new-privileges \
    -e PORT="1809$1" -e HOST=127.0.0.1 -e DATABASE_URL="$PG/$DB" -e REDIS_URL="$REDIS_URL" -e NODE_ID="app$1" \
    -e TRUST_PROXY=true -e METRICS_TOKEN="$TOKEN" -e ALLOWED_ORIGINS="$LB" -e LOG_LEVEL=info \
    -e REGISTRATIONS_PER_HOUR=1000 "$IMAGE" >/dev/null
}
wait_healthy() { # n
  for _ in $(seq 100); do curl -fs "http://127.0.0.1:1809$1/health/ready" >/dev/null && return 0; sleep 0.2; done
  echo "node $1 not ready" >&2; docker logs "smoke$1" | tail -20 >&2; return 1
}
stop_timed() { # n
  local s e; s=$(date +%s%N); docker stop "smoke$1" >/dev/null; e=$(date +%s%N)
  echo "node $1: docker stop took $(( (e - s) / 1000000 )) ms, exit code $(docker inspect -f '{{.State.ExitCode}}' "smoke$1")"
}

step "start two nodes and nginx"
start 1; start 2; wait_healthy 1; wait_healthy 2
docker exec smoke1 id
sed -e 's/app1:8080/127.0.0.1:18091/; s/app2:8080/127.0.0.1:18092/; s/listen 80;/listen 127.0.0.1:18090;/' deploy/nginx.conf >"$WORK/site.conf"
cat >"$WORK/nginx.conf" <<EOF
worker_processes 1;
pid $WORK/nginx.pid;
error_log $WORK/error.log;
events { worker_connections 4096; }
http {
  access_log off;
  client_body_temp_path $WORK/b; proxy_temp_path $WORK/p; fastcgi_temp_path $WORK/f; uwsgi_temp_path $WORK/u; scgi_temp_path $WORK/s;
  include $WORK/site.conf;
}
EOF
nginx -c "$WORK/nginx.conf"
sleep 0.5

step "smoke checks through nginx"
npx tsx tools/smoke.ts --url "$LB" --phase write --state "$WORK/smoke.json"
echo "metrics on a node: without token $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18091/metrics), with token $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" http://127.0.0.1:18091/metrics)"
echo "client address recorded behind the proxy: $(psql -At "$PG/$DB" -c "SELECT DISTINCT ip FROM audit_log")"

step "load through nginx: 200 clients, 20 s, reconnect storm"
npx tsx tools/loadtest.ts --urls "$LB" --metrics-urls http://127.0.0.1:18091,http://127.0.0.1:18092 --metrics-token "$TOKEN" \
  --clients 200 --seconds 20 --rate 2 --storm 1

step "rolling restart of both nodes under load (100 clients, 30 s)"
npx tsx tools/loadtest.ts --urls "$LB" --metrics-urls none --clients 100 --seconds 30 --rate 2 >"$WORK/rolling.json" &
LOAD=$!
sleep 10; stop_timed 1; sleep 3; start 1; wait_healthy 1
sleep 3; stop_timed 2; sleep 3; start 2; wait_healthy 2
code=0; wait $LOAD || code=$?
cat "$WORK/rolling.json"
echo "load test during rolling restart: exit $code"
[ "$code" = 0 ]

step "data survives a restart of both nodes"
stop_timed 1; stop_timed 2
start 1; start 2; wait_healthy 1; wait_healthy 2
npx tsx tools/smoke.ts --url "$LB" --phase verify --state "$WORK/smoke.json"

step "graceful shutdown log (node 1)"
docker stop smoke1 >/dev/null
docker logs smoke1 2>&1 | grep -E '"shutting down"|shutdown step' || true
start 1; wait_healthy 1

step "backup and restore"
DATABASE_URL="$PG/$DB" scripts/backup.sh "$WORK/backup.dump"
psql "$PG/postgres" -qc "CREATE DATABASE ${DB}_restored"
DATABASE_URL="$PG/${DB}_restored" scripts/restore.sh "$WORK/backup.dump"
src=$(psql -At "$PG/$DB" -c "SELECT count(*) FROM documents")
dst=$(psql -At "$PG/${DB}_restored" -c "SELECT count(*) FROM documents")
echo "documents: source $src, restored $dst"
[ "$src" = "$dst" ]

step "nginx errors"
grep -c "no live upstreams" "$WORK/error.log" | sed 's/^/"no live upstreams" errors: /' || true

echo; echo "DEPLOYMENT SMOKE TEST PASSED"
