#!/usr/bin/env bash
# Runs tools/loadtest.ts against a freshly started server (fresh database) for
# each client count, single node, then against two nodes sharing Redis.
# Appends one JSON line per run to $OUT. Requires a built server
# (npm run build), PostgreSQL at $PGURL and, for the multi-node runs, Redis.
#
#   OUT=docs/results/load-$(date +%F).jsonl tools/loadmatrix.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PGURL=${PGURL:-postgres://postgres@127.0.0.1:5432}
REDIS_URL=${REDIS_URL:-redis://127.0.0.1:6379}
OUT=${OUT:-docs/results/load-$(date +%F).jsonl}
SECONDS_PER_RUN=${SECONDS_PER_RUN:-30}
RATE=${RATE:-2}
SINGLE=${SINGLE-"1 5 10 25 50 100 500 1000"}
MULTI=${MULTI-"100 500 1000"}
EXTRA=${EXTRA-"1000:0.1"} # clients:active fraction, single node
P1=${PORT_BASE:-18080}; P2=$((P1 + 1))
RUNDIR=$(mktemp -d)
mkdir -p "$(dirname "$OUT")"

start_node() { # port dbname nodeid [redis]
  PORT=$1 HOST=127.0.0.1 DATABASE_URL="$PGURL/$2" NODE_ID=$3 REDIS_URL=${4:-} LOG_LEVEL=warn REGISTRATIONS_PER_HOUR=10000 \
    MAX_CONNECTIONS=5000 node packages/server/dist/main.js >"$RUNDIR/$3.log" 2>&1 &
  echo $! >"$RUNDIR/$3.pid"
  for _ in $(seq 600); do curl -fs "http://127.0.0.1:$1/health/ready" >/dev/null && return 0; sleep 0.1; done
  echo "node $3 did not start" >&2; cat "$RUNDIR/$3.log" >&2; return 1
}
stop_nodes() {
  for f in "$RUNDIR"/*.pid; do [ -e "$f" ] || continue; kill -TERM "$(cat "$f")" 2>/dev/null || true; done
  for f in "$RUNDIR"/*.pid; do [ -e "$f" ] || continue; while kill -0 "$(cat "$f")" 2>/dev/null; do sleep 0.1; done; rm -f "$f"; done
}
trap stop_nodes EXIT

run() { # label clients urls [active]
  local db="tandem_load_$RANDOM$RANDOM"
  psql "$PGURL/postgres" -qc "CREATE DATABASE $db" >/dev/null
  local i=0 urls=""
  for port in $3; do
    i=$((i + 1))
    start_node "$port" "$db" "n$i" "$([ "$1" = multi ] && echo "$REDIS_URL")"
    urls="${urls:+$urls,}http://127.0.0.1:$port"
  done
  echo "== $1: $2 clients on $urls" >&2
  local code=0
  npx tsx tools/loadtest.ts --urls "$urls" --clients "$2" --seconds "$SECONDS_PER_RUN" --rate "$RATE" --storm 1 --active "${4:-1}" \
    >"$RUNDIR/out.json" || code=$?
  stop_nodes
  if [ -s "$RUNDIR/out.json" ]; then
    node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1]));r.label=process.argv[2];r.exitCode=+process.argv[3];console.log(JSON.stringify(r))' \
      "$RUNDIR/out.json" "$1" "$code" | tee -a "$OUT"
  else
    echo "{\"label\":\"$1\",\"clients\":$2,\"exitCode\":$code,\"error\":\"no result\"}" | tee -a "$OUT"
  fi
  grep -iE '"level":"(error|warn)"' "$RUNDIR"/n*.log | head -5 >&2 || true
  psql "$PGURL/postgres" -qc "DROP DATABASE $db" >/dev/null
}

for n in $SINGLE; do run single "$n" "$P1"; done
for n in $MULTI; do run multi "$n" "$P1 $P2"; done
for x in $EXTRA; do run single-partial "${x%%:*}" "$P1" "${x##*:}"; done
