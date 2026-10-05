// Two server nodes sharing PostgreSQL and Redis.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { docText } from "../src/store.js";
import { connectClient, createTestDatabase, newUser, REDIS_URL, sleep, startServer, waitFor, workspaceWithDoc, type TestServer } from "./helpers.js";

let db: { url: string; drop: () => Promise<void> };
let n1: TestServer;
let n2: TestServer;

beforeAll(async () => {
  db = await createTestDatabase();
  n1 = await startServer(db.url, { redisUrl: REDIS_URL, nodeId: "node1" });
  n2 = await startServer(db.url, { redisUrl: REDIS_URL, nodeId: "node2" });
});
afterAll(async () => {
  await n1.app.close();
  await n2.app.close();
  await db.drop();
});

describe("multi-node", () => {
  it("clients on different nodes see each other's edits and presence", async () => {
    const alice = await newUser(n1.base, "alice");
    const { docId } = await workspaceWithDoc(alice.http);
    const a = connectClient(n1, alice.http.cookie, docId);
    const b = connectClient(n2, alice.http.cookie, docId);
    await waitFor(() => a.handle.synced && b.handle.synced);
    a.text.insert(0, "from node1 ");
    b.text.insert(0, "from node2 ");
    await waitFor(() => a.text.toString() === b.text.toString() && a.text.length === 22, 10_000, "cross-node convergence");
    a.awareness.setLocalStateField("cursor", { index: 1 });
    await waitFor(() => b.awareness.getStates().has(a.doc.clientID), 5000, "cross-node presence");
    await waitFor(() => a.handle.unsaved === 0 && b.handle.unsaved === 0);
    expect(await docText(n1.app.db, docId)).toBe(a.text.toString());
    a.destroy();
    b.destroy();
  });

  it("role changes made through one node reach connections on the other", async () => {
    const owner = await newUser(n1.base, "owner");
    const ed = await newUser(n1.base, "ed");
    const { workspaceId, docId } = await workspaceWithDoc(owner.http);
    await owner.http.post(`/api/workspaces/${workspaceId}/members`, { email: ed.email, role: "EDITOR" });
    const e = connectClient(n2, ed.http.cookie, docId);
    await waitFor(() => e.handle.synced);
    await owner.http.patch(`/api/workspaces/${workspaceId}/members/${ed.id}`, { role: "VIEWER" });
    await waitFor(() => e.handle.role === 1, 5000, "role change across nodes");
    e.destroy();
  });

  it("a client failing over to another node keeps its edits", async () => {
    const alice = await newUser(n1.base, "alice");
    const { docId } = await workspaceWithDoc(alice.http);
    const a = connectClient(n1, alice.http.cookie, docId);
    await waitFor(() => a.handle.synced);
    a.text.insert(0, "before failover\n");
    await waitFor(() => a.handle.unsaved === 0);
    a.conn.dropConnection();
    a.text.insert(a.text.length, "edited while offline\n");
    a.destroy();
    // Same replica reconnects through node2.
    const b = connectClient(n2, alice.http.cookie, docId, a.doc);
    await waitFor(() => b.handle.synced && b.handle.unsaved === 0);
    await sleep(100);
    expect(await docText(n2.app.db, docId)).toBe("before failover\nedited while offline\n");
    b.destroy();
  });
});

describe("durability sweep", () => {
  it("writes updates that only exist in another node's memory", async () => {
    const alice = await newUser(n1.base, "alice");
    const { docId } = await workspaceWithDoc(alice.http);
    const a = connectClient(n1, alice.http.cookie, docId);
    const b = connectClient(n2, alice.http.cookie, docId);
    await waitFor(() => a.handle.synced && b.handle.synced);
    a.text.insert(0, "saved ");
    await waitFor(() => a.handle.unsaved === 0 && b.text.toString() === "saved ");
    // Simulate node1 crashing after applying an update but before writing it:
    // remove the row it wrote. node2 still has the content in memory.
    a.text.insert(6, "lost?");
    await waitFor(() => b.text.toString() === "saved lost?" && a.handle.unsaved === 0);
    await n1.app.db.query("DELETE FROM doc_updates WHERE doc_id = $1 AND seq = (SELECT max(seq) FROM doc_updates WHERE doc_id = $1)", [docId]);
    a.destroy(); // the originating client never comes back
    expect(await docText(n1.app.db, docId)).toBe("saved ");
    await n2.app.rooms.room(docId)!.sweep();
    expect(await docText(n1.app.db, docId)).toBe("saved lost?");
    expect(n2.app.metrics.sweepRepairs.get()).toBe(1);
    // A second sweep finds nothing to do.
    await n2.app.rooms.room(docId)!.sweep();
    expect(n2.app.metrics.sweepRepairs.get()).toBe(1);
    b.destroy();
  });

  it("does not count an edit that arrives while the sweep reads the database as missing (found under load)", async () => {
    const alice = await newUser(n1.base, "alice2");
    const { docId } = await workspaceWithDoc(alice.http);
    const a = connectClient(n1, alice.http.cookie, docId);
    await waitFor(() => a.handle.synced);
    a.text.insert(0, "x");
    await waitFor(() => a.handle.unsaved === 0);
    const db = n1.app.db as unknown as { query: (...args: unknown[]) => Promise<unknown> };
    const query = db.query.bind(db);
    let edited = false;
    let releaseInsert = () => {};
    const insertHeld = new Promise<void>((r) => (releaseInsert = r));
    db.query = async (...args: unknown[]) => {
      const sql = String(args[0]);
      // The edit's INSERT commits only after the sweep has read the database.
      if (sql.startsWith("INSERT INTO doc_updates")) await insertHeld;
      // While the sweep reads the snapshot, a client edit is applied in memory.
      if (!edited && sql.startsWith("SELECT state FROM doc_snapshots")) {
        edited = true;
        a.text.insert(1, "y");
        await waitFor(() => n1.app.rooms.room(docId)!.doc.getText("content").toString() === "xy");
      }
      return query(...args);
    };
    const sweepDone = n1.app.rooms.room(docId)!.sweep();
    const before = n1.app.metrics.sweepRepairs.get();
    try {
      await waitFor(() => edited);
      // The sweep returns early (queue busy) or after its own writes; either
      // way its database read happened while the INSERT was held.
      await Promise.race([sweepDone, sleep(1000)]);
    } finally {
      releaseInsert();
      await sweepDone;
      db.query = query;
    }
    expect(edited).toBe(true);
    expect(n1.app.metrics.sweepRepairs.get()).toBe(before);
    await waitFor(() => a.handle.unsaved === 0);
    expect(await docText(n1.app.db, docId)).toBe("xy");
    a.destroy();
  });
});
