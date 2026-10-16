// Session and permission revalidation of live WebSocket connections.
//
// A WebSocket is authenticated once, at the upgrade. These tests check that
// a connection does not outlive the session or the permission it was opened
// with:
//   * logout through one node closes that session's sockets on every node,
//   * a session that expires, or is deleted in the database (admin
//     revocation), closes its sockets,
//   * a membership change made without a bus event (a lost pub/sub message;
//     Redis pub/sub is at-most-once) is still enforced on live sockets,
//   * logout ends only the session that logged out; "log out everywhere"
//     ends all of the user's sessions.
import { MsgType, ErrorCode } from "@tandem/protocol";
import * as Y from "yjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { docText } from "../src/store.js";
import { connectClient, createTestDatabase, Http, newUser, rawClient, REDIS_URL, sleep, startServer, waitFor, workspaceWithDoc, type TestServer } from "./helpers.js";

let db: { url: string; drop: () => Promise<void> };
let n1: TestServer;
let n2: TestServer;

// Revalidate often so that the tests are fast; production default is 30 s.
const REVALIDATE_MS = 300;

beforeAll(async () => {
  db = await createTestDatabase();
  n1 = await startServer(db.url, { redisUrl: REDIS_URL, nodeId: "s1", sessionRevalidateMs: REVALIDATE_MS });
  n2 = await startServer(db.url, { redisUrl: REDIS_URL, nodeId: "s2", sessionRevalidateMs: REVALIDATE_MS });
});
afterAll(async () => {
  await n1.app.close();
  await n2.app.close();
  await db.drop();
});

// A second login of the same user: a separate session (another device).
async function secondSession(base: string, email: string) {
  const http = new Http(base);
  const r = await http.post("/api/auth/login", { email, password: "correct horse battery" });
  expect(r.status).toBe(200);
  return http;
}

describe("session revalidation of live sockets", () => {
  it("logout through node 1 closes the same session's socket on node 2", async () => {
    const u = await newUser(n1.base, "lo");
    const sock = await rawClient(n2, u.http.cookie);
    await waitFor(() => sock.msgs.some((m) => m.type === MsgType.Welcome), 5000, "welcome");
    expect((await u.http.post("/api/auth/logout")).status).toBe(200);
    // Well below the revalidation interval would not be enough for a
    // timer-only design to pass reliably; the bus event closes it at once.
    await waitFor(() => sock.closed() === 4001, 2000, "socket on the other node closed");
  });

  it("logout ends only that session; the user's other session stays connected", async () => {
    const u = await newUser(n1.base, "two");
    const other = await secondSession(n1.base, u.email);
    // Both on the node that handles the logout.
    const a = await rawClient(n1, u.http.cookie);
    const b = await rawClient(n1, other.cookie);
    await waitFor(() => a.msgs.some((m) => m.type === MsgType.Welcome) && b.msgs.some((m) => m.type === MsgType.Welcome));
    await u.http.post("/api/auth/logout");
    await waitFor(() => a.closed() === 4001, 2000, "logged-out session closed");
    await sleep(REVALIDATE_MS * 3);
    expect(b.closed()).toBe(0);
    expect((await other.get("/api/me")).status).toBe(200);
    b.ws.close();
  });

  it("log out everywhere ends every session of the user on every node", async () => {
    const u = await newUser(n1.base, "all");
    const other = await secondSession(n2.base, u.email);
    const a = await rawClient(n1, u.http.cookie);
    const b = await rawClient(n2, other.cookie);
    await waitFor(() => a.msgs.some((m) => m.type === MsgType.Welcome) && b.msgs.some((m) => m.type === MsgType.Welcome));
    expect((await u.http.post("/api/auth/logout-all")).status).toBe(200);
    await waitFor(() => a.closed() === 4001 && b.closed() === 4001, 2000, "all sockets closed");
    expect((await other.get("/api/me")).status).toBe(401);
  });

  it("a session that expires while connected is closed", async () => {
    const u = await newUser(n1.base, "exp");
    const sock = await rawClient(n1, u.http.cookie);
    await waitFor(() => sock.msgs.some((m) => m.type === MsgType.Welcome));
    await n1.app.db.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1", [u.id]);
    await waitFor(() => sock.closed() === 4001, REVALIDATE_MS * 10, "expired session closed");
  });

  it("a session deleted directly in the database (admin revocation, no bus event) is closed on every node", async () => {
    const u = await newUser(n1.base, "rev");
    const a = await rawClient(n1, u.http.cookie);
    const b = await rawClient(n2, u.http.cookie);
    await waitFor(() => a.msgs.some((m) => m.type === MsgType.Welcome) && b.msgs.some((m) => m.type === MsgType.Welcome));
    await n1.app.db.query("DELETE FROM sessions WHERE user_id = $1", [u.id]);
    await waitFor(() => a.closed() === 4001 && b.closed() === 4001, REVALIDATE_MS * 10, "revoked sockets closed");
  });

  it("a connection whose session is still valid is not disturbed by revalidation", async () => {
    const u = await newUser(n1.base, "keep");
    const { docId } = await workspaceWithDoc(u.http);
    const c = connectClient(n2, u.http.cookie, docId);
    await waitFor(() => c.handle.synced);
    await sleep(REVALIDATE_MS * 4);
    c.text.insert(0, "still here");
    await waitFor(() => c.handle.unsaved === 0);
    expect(c.conn.lastCloseCode).toBe(0);
    expect(await docText(n1.app.db, docId)).toBe("still here");
    c.destroy();
  });
});

describe("permission revalidation of live sockets (lost bus events)", () => {
  it("membership removed in the database without a bus event: the socket loses the document and cannot write", async () => {
    const owner = await newUser(n1.base, "own");
    const ed = await newUser(n1.base, "ed");
    const { workspaceId, docId } = await workspaceWithDoc(owner.http);
    await owner.http.post(`/api/workspaces/${workspaceId}/members`, { email: ed.email, role: "EDITOR" });
    const sock = await rawClient(n2, ed.http.cookie);
    sock.send({ type: MsgType.Join, ch: 1, docId });
    await waitFor(() => sock.msgs.some((m) => m.type === MsgType.Joined), 5000, "joined");
    // Bypass the API (and with it the bus event): as if the pub/sub message
    // had been lost.
    await n1.app.db.query("DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2", [workspaceId, ed.id]);
    await waitFor(
      () => sock.msgs.some((m) => m.type === MsgType.Error && m.code === ErrorCode.Forbidden && /removed/.test(m.message)),
      REVALIDATE_MS * 10,
      "access removed",
    );
    const d = new Y.Doc();
    d.getText("content").insert(0, "should not be stored");
    sock.send({ type: MsgType.Update, ch: 1, seq: 1, update: Y.encodeStateAsUpdate(d) });
    await sleep(300);
    expect(sock.msgs.some((m) => m.type === MsgType.Ack && m.seq === 1)).toBe(false);
    expect(await docText(n1.app.db, docId)).toBe("");
    sock.ws.close();
  });

  it("role lowered to VIEWER in the database without a bus event: RoleChanged is sent and writes are refused", async () => {
    const owner = await newUser(n1.base, "own2");
    const ed = await newUser(n1.base, "ed2");
    const { workspaceId, docId } = await workspaceWithDoc(owner.http);
    await owner.http.post(`/api/workspaces/${workspaceId}/members`, { email: ed.email, role: "EDITOR" });
    const sock = await rawClient(n1, ed.http.cookie);
    sock.send({ type: MsgType.Join, ch: 1, docId });
    await waitFor(() => sock.msgs.some((m) => m.type === MsgType.Joined));
    await n1.app.db.query("UPDATE memberships SET role = 'VIEWER' WHERE workspace_id = $1 AND user_id = $2", [workspaceId, ed.id]);
    await waitFor(() => sock.msgs.some((m) => m.type === MsgType.RoleChanged && m.role === 1), REVALIDATE_MS * 10, "role change seen");
    const d = new Y.Doc();
    d.getText("content").insert(0, "viewer write");
    sock.send({ type: MsgType.Update, ch: 1, seq: 7, update: Y.encodeStateAsUpdate(d) });
    await waitFor(() => sock.msgs.some((m) => m.type === MsgType.Error && m.code === ErrorCode.Forbidden && m.ref === 7), 3000, "write refused");
    expect(await docText(n1.app.db, docId)).toBe("");
    sock.ws.close();
  });

  it("a document deleted without a bus event is closed for its live clients", async () => {
    const owner = await newUser(n1.base, "own3");
    const { docId } = await workspaceWithDoc(owner.http);
    const sock = await rawClient(n2, owner.http.cookie);
    sock.send({ type: MsgType.Join, ch: 1, docId });
    await waitFor(() => sock.msgs.some((m) => m.type === MsgType.Joined));
    await n1.app.db.query("DELETE FROM documents WHERE id = $1", [docId]);
    await waitFor(() => sock.msgs.some((m) => m.type === MsgType.Error && m.code === ErrorCode.NotFound), REVALIDATE_MS * 10, "deleted doc closed");
    expect(n2.app.rooms.room(docId)).toBeUndefined();
    sock.ws.close();
  });
});
