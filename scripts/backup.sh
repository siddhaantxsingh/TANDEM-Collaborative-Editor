#!/bin/sh
# Consistent logical backup of the Tandem database (custom format, compressed).
#   DATABASE_URL=postgres://... scripts/backup.sh [output-file]
# pg_dump takes a snapshot, so the backup is consistent even while users edit.
# Acknowledged edits are in the database; edits still unacknowledged at
# backup time are on clients and will be written after the backup.
set -eu
out=${1:-tandem-$(date -u +%Y%m%dT%H%M%SZ).dump}
pg_dump --format=custom --no-owner --dbname="$DATABASE_URL" --file="$out"
echo "backup written to $out ($(wc -c < "$out") bytes)"
