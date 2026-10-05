import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { Role } from "@tandem/protocol";

import { docText } from "../src/store.js";
import { connectClient, createTestDatabase, newUser, sleep, startServer, waitFor, workspaceWithDoc, type TestServer } from "./helpers.js";

let db: { url: string; drop: () => Promise<void> };
let server: TestServer;

beforeAll(async () => {
  db = await createTestDatabase();
  server = await startServer(db.url);
});

afterAll(async () => {
  await server.app.close();
  await db.drop();
});

describe("synchronization", () => {
  it("two editors converge and edits are acknowledged after persistence", async () => {
    const alice = await newUser(server.base, "alice");
    const bob = await newUser(server.base, "bob");
    const { workspaceId, docId } = await workspaceWithDoc(alice.http);
    await alice.http.post(`/api/workspaces/${workspaceId}/members`, { email: bob.email, role: "EDITOR" });
    const a = connectClient(server, alice.http.cookie, docId);
    const b = connectClient(server, bob.http.cookie, docId);
    await waitFor(() => a.handle.synced && b.handle.synced, 10_000, "sync");
    expect(a.handle.role).toBe(Role.Owner);
    expect(b.handle.role).toBe(Role.Editor);
    a.text.insert(0, "hello ");
    b.text.insert(0, "world");
    await waitFor(() => a.text.toString() === b.text.toString() && a.text.length === 11, 10_000, "convergence");
    await waitFor(() => a.handle.unsaved === 0 && b.handle.unsaved === 0, 10_000, "acks");
    expect(await docText(server.app.db, docId)).toBe(a.text.toString());
    a.destroy();
    b.destroy();
  });

  it("offline edits on both sides merge on reconnect without loss", async () => {
    const alice = await newUser(server.base, "alice");
    const { docId } = await workspaceWithDoc(alice.http);
    const a = connectClient(server, alice.http.cookie, docId);
    const b = connectClient(server, alice.http.cookie, docId);
    await waitFor(() => a.handle.synced && b.handle.synced);
    a.text.insert(0, "base\n");
    await waitFor(() => b.text.toString() === "base\n");
    a.conn.dropConnection();
    b.conn.dropConnection();
    a.text.insert(a.text.length, "from-a\n");
    b.text.insert(0, "from-b\n");
    expect(a.handle.unsaved).toBeGreaterThan(0);
    await waitFor(() => a.handle.joined && b.handle.joined, 10_000, "reconnect");
    await waitFor(() => a.text.toString() === b.text.toString() && a.text.toString().includes("from-a") && a.text.toString().includes("from-b"));
    await waitFor(() => a.handle.unsaved === 0 && b.handle.unsaved === 0, 10_000, "saved");
    expect(await docText(server.app.db, docId)).toBe(a.text.toString());
    a.destroy();
    b.destroy();
  });

  it("content survives a server restart and compaction", async () => {
    const alice = await newUser(server.base, "alice");
    const { docId } = await workspaceWithDoc(alice.http);
    const a = connectClient(server, alice.http.cookie, docId);
    await waitFor(() => a.handle.synced);
    for (let i = 0; i < 50; i++) a.text.insert(a.text.length, `line ${i}\n`);
    await waitFor(() => a.handle.unsaved === 0);
    const expected = a.text.toString();
    a.destroy();
    await server.app.close();
    server = await startServer(db.url, { compactEvery: 10 });
    const fresh = connectClient(server, alice.http.cookie, docId);
    await waitFor(() => fresh.handle.synced);
    expect(fresh.text.toString()).toBe(expected);
    // Trigger compaction by more edits, then reload from the database.
    for (let i = 0; i < 20; i++) fresh.text.insert(0, "x");
    await waitFor(() => fresh.handle.unsaved === 0);
    await sleep(200);
    const rows = await server.app.db.query("SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1", [docId]);
    const snaps = await server.app.db.query("SELECT count(*)::int AS n FROM doc_snapshots WHERE doc_id = $1", [docId]);
    expect(snaps.rows[0].n).toBe(1);
    expect(rows.rows[0].n).toBeLessThan(20);
    expect(await docText(server.app.db, docId)).toBe(fresh.text.toString());
    fresh.destroy();
  });

  it("a client that reconnects with a stale replica receives what it missed", async () => {
    const alice = await newUser(server.base, "alice");
    const { docId } = await workspaceWithDoc(alice.http);
    const a = connectClient(server, alice.http.cookie, docId);
    await waitFor(() => a.handle.synced);
    a.text.insert(0, "v1");
    await waitFor(() => a.handle.unsaved === 0);
    // Keep a copy of the replica, then edit further.
    const stale = new Y.Doc();
    Y.applyUpdate(stale, Y.encodeStateAsUpdate(a.doc));
    a.text.insert(2, " v2");
    await waitFor(() => a.handle.unsaved === 0);
    const b = connectClient(server, alice.http.cookie, docId, stale);
    await waitFor(() => b.text.toString() === "v1 v2");
    a.destroy();
    b.destroy();
  });

  it("presence is relayed and the user identity cannot be spoofed", async () => {
    const alice = await newUser(server.base, "alice");
    const bob = await newUser(server.base, "bob");
    const { workspaceId, docId } = await workspaceWithDoc(alice.http);
    await alice.http.post(`/api/workspaces/${workspaceId}/members`, { email: bob.email, role: "VIEWER" });
    const a = connectClient(server, alice.http.cookie, docId);
    const b = connectClient(server, bob.http.cookie, docId);
    await waitFor(() => a.handle.joined && b.handle.joined);
    b.awareness.setLocalStateField("user", { name: "Alice (fake)", color: "#ff0000" });
    b.awareness.setLocalStateField("cursor", { index: 3 });
    await waitFor(() => a.awareness.getStates().has(b.doc.clientID), 5000, "presence");
    const st = a.awareness.getStates().get(b.doc.clientID) as any;
    expect(st.user.name).toBe(bob.name);
    expect(st.user.id).toBe(bob.id);
    expect(st.user.color).toBe("#ff0000");
    expect(st.cursor).toEqual({ index: 3 });
    b.destroy();
    await waitFor(() => !a.awareness.getStates().has(b.doc.clientID), 5000, "presence removal");
    a.destroy();
  });
});
