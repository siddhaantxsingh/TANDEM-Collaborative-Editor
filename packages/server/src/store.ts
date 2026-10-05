// Data access: workspaces, memberships, documents and document persistence
// (snapshot + append-only update log, compaction).
import { randomBytes } from "node:crypto";

import { parseRole, Role } from "@tandem/protocol";
import * as Y from "yjs";

import type { Db } from "./db.js";

export interface DocMeta {
  id: string;
  workspaceId: string;
  path: string;
}

export const newDocId = () => randomBytes(12).toString("base64url"); // 16 chars, [A-Za-z0-9_-]

export async function roleIn(db: Db, workspaceId: string, userId: string): Promise<Role | undefined> {
  const r = await db.query("SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userId]);
  return r.rows[0] ? parseRole(r.rows[0].role as string) : undefined;
}

export async function docMeta(db: Db, docId: string): Promise<DocMeta | undefined> {
  const r = await db.query("SELECT id, workspace_id, path FROM documents WHERE id = $1", [docId]);
  const row = r.rows[0];
  return row ? { id: row.id, workspaceId: row.workspace_id, path: row.path } : undefined;
}

export async function roleForDoc(db: Db, docId: string, userId: string): Promise<{ meta: DocMeta; role: Role } | undefined> {
  const r = await db.query(
    "SELECT d.id, d.workspace_id, d.path, m.role FROM documents d JOIN memberships m ON m.workspace_id = d.workspace_id AND m.user_id = $2 WHERE d.id = $1",
    [docId, userId],
  );
  const row = r.rows[0];
  if (!row) return undefined;
  const role = parseRole(row.role);
  return role ? { meta: { id: row.id, workspaceId: row.workspace_id, path: row.path }, role } : undefined;
}

// ------------------------------------------------------------ persistence

export interface LoadedDoc {
  state: Uint8Array; // merged update (snapshot + log)
  logRows: number; // log entries not yet folded into the snapshot
}

// Snapshot plus *every* remaining log row. Rows are not filtered by sequence
// number: a row can commit after a higher-numbered one (bigserial values are
// assigned before commit), so "seq > last_seq" could skip a committed update.
// Applying a row that is already contained in the snapshot is harmless
// because Yjs updates are idempotent.
export async function loadDocState(db: Db, docId: string): Promise<LoadedDoc> {
  const snap = await db.query("SELECT state FROM doc_snapshots WHERE doc_id = $1", [docId]);
  const log = await db.query("SELECT update FROM doc_updates WHERE doc_id = $1 ORDER BY seq", [docId]);
  const parts: Uint8Array[] = [];
  if (snap.rows[0]) parts.push(new Uint8Array(snap.rows[0].state as Buffer));
  for (const row of log.rows) parts.push(new Uint8Array(row.update as Buffer));
  const state = parts.length === 0 ? new Uint8Array([0, 0]) : parts.length === 1 ? parts[0]! : Y.mergeUpdates(parts);
  return { state, logRows: log.rows.length };
}

export async function appendUpdates(db: Db, docId: string, updates: { update: Uint8Array; userId: string | null }[], nodeId: string): Promise<void> {
  if (updates.length === 0) return;
  const values: string[] = [];
  const params: unknown[] = [docId, nodeId];
  updates.forEach((u, i) => {
    values.push(`($1, $${i * 2 + 3}, $${i * 2 + 4}, $2)`);
    params.push(Buffer.from(u.update), u.userId);
  });
  await db.query(`INSERT INTO doc_updates (doc_id, update, user_id, node_id) VALUES ${values.join(", ")}`, params);
}

// Fold the log into the snapshot. Works only from database contents (never
// from in-memory state), so it is correct with several nodes; serialized per
// document by a transaction-scoped advisory lock. Deletes exactly the rows it
// merged (by sequence number), so rows committed concurrently by other
// transactions stay in the log for the next load or compaction.
export async function compactDoc(db: Db, docId: string): Promise<{ merged: number } | undefined> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('doc:' || $1))", [docId]);
    const snap = await client.query("SELECT state FROM doc_snapshots WHERE doc_id = $1", [docId]);
    const log = await client.query("SELECT seq, update FROM doc_updates WHERE doc_id = $1 ORDER BY seq", [docId]);
    if (log.rows.length === 0) {
      await client.query("COMMIT");
      return { merged: 0 };
    }
    const parts: Uint8Array[] = [];
    if (snap.rows[0]) parts.push(new Uint8Array(snap.rows[0].state as Buffer));
    const seqs: string[] = [];
    for (const row of log.rows) {
      parts.push(new Uint8Array(row.update as Buffer));
      seqs.push(String(row.seq));
    }
    const maxSeq = seqs[seqs.length - 1];
    const merged = Buffer.from(Y.mergeUpdates(parts));
    await client.query(
      `INSERT INTO doc_snapshots (doc_id, state, last_seq, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (doc_id) DO UPDATE SET state = EXCLUDED.state, last_seq = GREATEST(doc_snapshots.last_seq, EXCLUDED.last_seq), updated_at = now()`,
      [docId, merged, maxSeq],
    );
    await client.query("DELETE FROM doc_updates WHERE doc_id = $1 AND seq = ANY($2::bigint[])", [docId, seqs]);
    await client.query("UPDATE documents SET updated_at = now() WHERE id = $1", [docId]);
    await client.query("COMMIT");
    return { merged: log.rows.length };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Plain text of a document's main text ("content"), from the database.
export async function docText(db: Db, docId: string): Promise<string> {
  const { state } = await loadDocState(db, docId);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const text = doc.getText("content").toString();
  doc.destroy();
  return text;
}
