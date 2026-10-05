// PostgreSQL access: connection pool and forward-only migrations.
import pg from "pg";

export type Db = pg.Pool;

export const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: "initial schema",
    sql: `
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  token_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('OWNER', 'EDITOR', 'VIEWER')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships(user_id);
CREATE TABLE documents (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, path)
);
-- Compacted document state: a Yjs update containing every log row deleted
-- by compaction. last_seq (highest merged seq) is informational only.
CREATE TABLE doc_snapshots (
  doc_id text PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  state bytea NOT NULL,
  last_seq bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Append-only operation log since the snapshot.
CREATE TABLE doc_updates (
  seq bigserial PRIMARY KEY,
  doc_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  update bytea NOT NULL,
  user_id uuid,
  node_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX doc_updates_doc_seq_idx ON doc_updates(doc_id, seq);
`,
  },
  {
    id: 2,
    name: "audit log, session expiry index",
    sql: `
-- Who did what, for workspace owners and incident analysis. No foreign key
-- to workspaces: entries outlive deleted workspaces and documents.
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  workspace_id uuid,
  target text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id text,
  ip text
);
CREATE INDEX audit_log_workspace_idx ON audit_log(workspace_id, at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log(actor_id, at DESC);
-- Periodic deletion of expired sessions.
CREATE INDEX sessions_expires_idx ON sessions(expires_at);
`,
  },
];

export function createDb(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 20, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
}

export async function migrate(db: Db): Promise<number[]> {
  const client = await db.connect();
  const applied: number[] = [];
  try {
    // One migrator at a time across nodes.
    await client.query("SELECT pg_advisory_lock(424242)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id int PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set((await client.query("SELECT id FROM schema_migrations")).rows.map((r) => r.id as number));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (id, name) VALUES ($1, $2)", [m.id, m.name]);
        await client.query("COMMIT");
        applied.push(m.id);
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(424242)").catch(() => {});
    client.release();
  }
  return applied;
}
