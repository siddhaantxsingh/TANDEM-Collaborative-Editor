import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { encode, MsgType, Role } from "@tandem/protocol";
import * as Y from "yjs";

import { hashPassword, verifyPassword } from "../src/auth.js";
import { docText } from "../src/store.js";
import { connectClient, createTestDatabase, Http, newUser, sleep, startServer, waitFor, workspaceWithDoc, type TestServer } from "./helpers.js";

let db: { url: string; drop: () => Promise<void> };
let server: TestServer;

beforeAll(async () => {
  db = await createTestDatabase();
  server = await startServer(db.url, { loginAttemptsPerMinute: 5 });
});
afterAll(async () => {
  await server.app.close();
  await db.drop();
});

describe("passwords", () => {
  it("hashes with a salt and verifies", async () => {
    const h1 = await hashPassword("secret password");
    const h2 = await hashPassword("secret password");
    expect(h1).not.toBe(h2);
    expect(h1.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("secret password", h1)).toBe(true);
    expect(await verifyPassword("secret passworD", h1)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("authentication", () => {
  it("register, me, logout, login", async () => {
    const u = await newUser(server.base, "carol");
    expect((await u.http.get("/api/me")).body.user.email).toBe(u.email);
    const row = await server.app.db.query("SELECT password_hash FROM users WHERE id = $1", [u.id]);
    expect(row.rows[0].password_hash).not.toContain("correct horse");
    expect((await u.http.post("/api/auth/logout")).status).toBe(200);
    expect((await u.http.get("/api/me")).status).toBe(401);
    const again = new Http(server.base);
    expect((await again.post("/api/auth/login", { email: u.email, password: "wrong password!" })).status).toBe(401);
    expect((await again.post("/api/auth/login", { email: u.email, password: "correct horse battery" })).status).toBe(200);
    expect((await again.get("/api/me")).status).toBe(200);
  });

  it("validates registration input and rejects duplicates", async () => {
    const h = new Http(server.base);
    expect((await h.post("/api/auth/register", { email: "bad", password: "correct horse battery", name: "x" })).status).toBe(400);
    expect((await h.post("/api/auth/register", { email: "short@pw.io", password: "short", name: "x" })).status).toBe(400);
    const u = await newUser(server.base, "dup");
    expect((await h.post("/api/auth/register", { email: u.email, password: "correct horse battery", name: "x" })).status).toBe(409);
  });

  it("rate-limits login attempts", async () => {
    const u = await newUser(server.base, "target");
    const h = new Http(server.base);
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await h.post("/api/auth/login", { email: u.email, password: "nope nope nope" })).status);
    expect(statuses).toContain(429);
  });

  it("rejects cross-origin state-changing requests and WebSocket upgrades", async () => {
    const u = await newUser(server.base, "csrf");
    const evil = new Http(server.base, "https://evil.example");
    evil.cookie = u.http.cookie;
    expect((await evil.post("/api/workspaces", { name: "pwned" })).status).toBe(403);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { Cookie: u.http.cookie, Origin: "https://evil.example" } });
    const status = await new Promise<number>((resolve) => ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)));
    expect(status).toBe(403);
  });

  it("rejects WebSocket connections without a session", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { Origin: server.origin } });
    const status = await new Promise<number>((resolve) => ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)));
    expect(status).toBe(401);
  });
});

describe("authorization", () => {
  it("non-members cannot see workspaces or open documents", async () => {
    const owner = await newUser(server.base, "owner");
    const stranger = await newUser(server.base, "stranger");
    const { workspaceId, docId } = await workspaceWithDoc(owner.http);
    expect((await stranger.http.get(`/api/workspaces/${workspaceId}`)).status).toBe(404);
    expect((await stranger.http.get(`/api/documents/${docId}/content`)).status).toBe(404);
    const c = connectClient(server, stranger.http.cookie, docId);
    const errors: number[] = [];
    c.handle.on("error", (code) => errors.push(code));
    await waitFor(() => errors.length > 0);
    expect(c.handle.joined).toBe(false);
    c.destroy();
  });

  it("viewers cannot edit: updates are rejected and never stored or broadcast", async () => {
    const owner = await newUser(server.base, "owner");
    const viewer = await newUser(server.base, "viewer");
    const { workspaceId, docId } = await workspaceWithDoc(owner.http);
    await owner.http.post(`/api/workspaces/${workspaceId}/members`, { email: viewer.email, role: "VIEWER" });
    expect((await viewer.http.post(`/api/workspaces/${workspaceId}/documents`, { path: "x.ts" })).status).toBe(403);
    const o = connectClient(server, owner.http.cookie, docId);
    await waitFor(() => o.handle.synced);
    o.text.insert(0, "owner text");
    await waitFor(() => o.handle.unsaved === 0);

    // A malicious client bypassing the UI: raw socket, sends an update.
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { Cookie: viewer.http.cookie, Origin: server.origin } });
    const received: Uint8Array[] = [];
    ws.on("message", (d) => received.push(new Uint8Array(d as Buffer)));
    await new Promise((r) => ws.on("open", r));
    ws.send(encode({ type: MsgType.Hello, sessionId: "viewer-session-1", resume: 0 }));
    ws.send(encode({ type: MsgType.Join, ch: 1, docId }));
    await sleep(200);
    const evil = new Y.Doc();
    evil.getText("content").insert(0, "HACKED ");
    ws.send(encode({ type: MsgType.Update, ch: 1, seq: 1, update: Y.encodeStateAsUpdate(evil) }));
    ws.send(encode({ type: MsgType.Sync2, ch: 1, update: Y.encodeStateAsUpdate(evil) }));
    await sleep(300);
    expect(o.text.toString()).toBe("owner text");
    expect(await docText(server.app.db, docId)).toBe("owner text");
    const { decode } = await import("@tandem/protocol");
    const types = received.map((f) => decode(f));
    expect(types.some((m) => m.type === MsgType.Joined && m.role === Role.Viewer)).toBe(true);
    expect(types.some((m) => m.type === MsgType.Error && m.code === 3)).toBe(true);
    expect(types.some((m) => m.type === MsgType.Ack && m.seq === 1)).toBe(false);
    ws.close();
    o.destroy();
  });

  it("role changes apply to live connections; removal disconnects", async () => {
    const owner = await newUser(server.base, "owner");
    const ed = await newUser(server.base, "editor");
    const { workspaceId, docId } = await workspaceWithDoc(owner.http);
    await owner.http.post(`/api/workspaces/${workspaceId}/members`, { email: ed.email, role: "EDITOR" });
    const o = connectClient(server, owner.http.cookie, docId);
    const e = connectClient(server, ed.http.cookie, docId);
    await waitFor(() => o.handle.synced && e.handle.synced);
    e.text.insert(0, "allowed ");
    await waitFor(() => o.text.toString() === "allowed ");
    // Editors cannot change roles; owners can.
    expect((await ed.http.patch(`/api/workspaces/${workspaceId}/members/${ed.id}`, { role: "OWNER" })).status).toBe(403);
    expect((await owner.http.patch(`/api/workspaces/${workspaceId}/members/${ed.id}`, { role: "VIEWER" })).status).toBe(200);
    await waitFor(() => e.handle.role === Role.Viewer, 5000, "role change");
    // The client engine refuses to send now; and if it did, the server would reject it.
    e.text.insert(0, "denied ");
    await sleep(300);
    expect(o.text.toString()).toBe("allowed ");
    expect((await owner.http.del(`/api/workspaces/${workspaceId}/members/${ed.id}`)).status).toBe(200);
    await waitFor(() => e.handle.closed, 5000, "removal");
    o.destroy();
    e.destroy();
  });

  it("the last owner cannot be demoted or removed", async () => {
    const owner = await newUser(server.base, "owner");
    const { workspaceId } = await workspaceWithDoc(owner.http);
    expect((await owner.http.patch(`/api/workspaces/${workspaceId}/members/${owner.id}`, { role: "EDITOR" })).status).toBe(409);
    expect((await owner.http.del(`/api/workspaces/${workspaceId}/members/${owner.id}`)).status).toBe(409);
  });

  it("rejects path traversal and invalid file names", async () => {
    const owner = await newUser(server.base, "owner");
    const { workspaceId } = await workspaceWithDoc(owner.http);
    for (const path of ["../etc/passwd", "/abs", "a//b", "a/./b", "a/../b", "", "x".repeat(300), "a\nb"]) {
      expect((await owner.http.post(`/api/workspaces/${workspaceId}/documents`, { path })).status).toBe(400);
    }
    expect((await owner.http.post(`/api/workspaces/${workspaceId}/documents`, { path: "src/app/index.ts" })).status).toBe(201);
    expect((await owner.http.post(`/api/workspaces/${workspaceId}/documents`, { path: "src/app/index.ts" })).status).toBe(409);
  });

  it("deleting a document disconnects its clients", async () => {
    const owner = await newUser(server.base, "owner");
    const { docId } = await workspaceWithDoc(owner.http);
    const o = connectClient(server, owner.http.cookie, docId);
    await waitFor(() => o.handle.synced);
    o.text.insert(0, "bye");
    expect((await owner.http.del(`/api/documents/${docId}`)).status).toBe(200);
    await waitFor(() => o.handle.closed, 5000, "doc closed");
    o.destroy();
  });
});
