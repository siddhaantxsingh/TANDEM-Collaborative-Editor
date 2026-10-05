#!/bin/sh
# Restore a backup into an EMPTY database, then verify every document decodes.
#   DATABASE_URL=postgres://.../tandem_restored scripts/restore.sh backup.dump
set -eu
[ $# -eq 1 ] || { echo "usage: restore.sh backup.dump" >&2; exit 2; }
pg_restore --no-owner --exit-on-error --dbname="$DATABASE_URL" "$1"
node --input-type=module -e "
import pg from 'pg'; import * as Y from 'yjs';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const docs = (await db.query('SELECT id FROM documents')).rows;
let bytes = 0;
for (const { id } of docs) {
  const s = await db.query('SELECT state FROM doc_snapshots WHERE doc_id = \$1', [id]);
  const u = await db.query('SELECT update FROM doc_updates WHERE doc_id = \$1 ORDER BY seq', [id]);
  // Merged into one update first, as the server loads documents (applying
  // log rows one by one can leave items pending, see docs/CORRECTNESS.md).
  const parts = [...s.rows.map((r) => r.state), ...u.rows.map((r) => r.update)];
  const d = new Y.Doc();
  if (parts.length) Y.applyUpdate(d, Y.mergeUpdates(parts));
  bytes += d.getText('content').length;
}
console.log('restored', docs.length, 'documents,', bytes, 'characters; all decode');
await db.end();
"
