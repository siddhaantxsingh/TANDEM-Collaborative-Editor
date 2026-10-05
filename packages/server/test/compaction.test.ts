// Regression test for a lost-update race found during review: sequence
// numbers are assigned before commit, so a row with a lower seq can become
// visible after compaction has merged a higher one.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { createDb, migrate, type Db } from "../src/db.js";
import { compactDoc, docText, loadDocState } from "../src/store.js";
import { createTestDatabase } from "./helpers.js";

let tdb: { url: string; drop: () => Promise<void> };
let db: Db;

beforeAll(async () => {
  tdb = await createTestDatabase();
  db = createDb(tdb.url);
  await migrate(db);
  const w = await db.query("INSERT INTO workspaces (name) VALUES ('w') RETURNING id");
  await db.query("INSERT INTO documents (id, workspace_id, path) VALUES ('doc1', $1, 'a.txt')", [w.rows[0].id]);
});
afterAll(async () => {
  await db.end();
  await tdb.drop();
});

function edit(base: Y.Doc, text: string): Uint8Array {
  const sv = Y.encodeStateVector(base);
  base.getText("content").insert(base.getText("content").length, text);
  return Y.encodeStateAsUpdate(base, sv);
}

describe("compaction", () => {
  it("does not lose an update whose transaction commits after a higher seq was compacted", async () => {
    const src = new Y.Doc();
    const u1 = edit(src, "first ");
    const u2 = edit(src, "second ");
    // Transaction A takes a seq but does not commit yet.
    const a = new pg.Client({ connectionString: tdb.url });
    await a.connect();
    await a.query("BEGIN");
    await a.query("INSERT INTO doc_updates (doc_id, update, node_id) VALUES ('doc1', $1, 'n')", [Buffer.from(u1)]);
    // Transaction B gets a higher seq and commits.
    await db.query("INSERT INTO doc_updates (doc_id, update, node_id) VALUES ('doc1', $1, 'n')", [Buffer.from(u2)]);
    // Compaction runs now and sees only B's row.
    await compactDoc(db, "doc1");
    await a.query("COMMIT");
    await a.end();
    // A's row must still be applied on load and survive the next compaction.
    expect((await loadDocState(db, "doc1")).logRows).toBe(1);
    expect(await docText(db, "doc1")).toBe("first second ");
    await compactDoc(db, "doc1");
    expect((await loadDocState(db, "doc1")).logRows).toBe(0);
    expect(await docText(db, "doc1")).toBe("first second ");
  });
});
