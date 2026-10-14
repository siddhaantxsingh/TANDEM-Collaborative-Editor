#!/usr/bin/env bash
# A private, throw-away PostgreSQL 16 cluster for tools/crash-ack.ts --mode pg,
# so that crashing PostgreSQL does not disturb anything else on the machine.
#   tools/pg-crash-cluster.sh init|kill|start|stop|destroy
# kill = SIGKILL of the postmaster and every backend (a real crash; the next
# start runs WAL crash recovery). Needs root (runs postgres as user postgres).
set -euo pipefail
BIN=${PG_BIN:-/usr/lib/postgresql/16/bin}
DIR=${PG_CRASH_DIR:-/var/lib/postgresql/tandem-crash}
PORT=${PG_CRASH_PORT:-5499}
D=$DIR/data
case "${1:-}" in
  init)
    mkdir -p "$DIR" && chown postgres "$DIR"
    [ -d "$D" ] || su postgres -c "$BIN/initdb -D $D -A trust -U postgres" >/dev/null
    "$0" start
    echo "postgres://postgres@127.0.0.1:$PORT/postgres" ;;
  start)
    # After a kill the postmaster can linger as a zombie (no init reaping in
    # a container); PostgreSQL would take it for a live postmaster. Wait for
    # its backends to exit, then remove the stale lock file.
    if [ -f "$D/postmaster.pid" ]; then
      PM=$(head -1 "$D/postmaster.pid")
      st=$(ps -o stat= -p "$PM" 2>/dev/null || true)
      if [ -z "$st" ] || [[ $st == Z* ]]; then
        for _ in $(seq 100); do pgrep -u postgres -P "$PM" >/dev/null || break; sleep 0.1; done
        rm -f "$D/postmaster.pid"
      fi
    fi
    su postgres -c "$BIN/pg_ctl -D $D -o '-p $PORT -c unix_socket_directories=' -l $DIR/pg.log -w start" >/dev/null ;;
  kill)
    PM=$(head -1 "$D/postmaster.pid")
    kill -9 $(pgrep -P "$PM") "$PM" ;;
  stop)
    su postgres -c "$BIN/pg_ctl -D $D -m fast stop" >/dev/null ;;
  destroy)
    "$0" stop || true
    rm -rf "$DIR" ;;
  *) echo "usage: $0 init|start|kill|stop|destroy" >&2; exit 2 ;;
esac
