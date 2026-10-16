// Regression tests for the defects found in the hardening audit
// (docs/HARDENING_AUDIT.md, P1-P9) and for the protocol-v2 connection rules.
import { encode, ErrorCode, MsgType, PROTOCOL_VERSION } from "@tandem/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";

import { docText } from "../src/store.js";
import { connectClient, createTestDatabase, newUser, rawClient, REDIS_URL, sleep, startServer, waitFor, workspaceWithDoc, type TestServer } from "./helpers.js";

let db: { url: string; drop: () => Promise<void> };
let s: TestServer;
beforeAll(async () => {
  db = await createTestDatabase();
  s = await startServer(db.url, { handshakeTimeoutMs: 500, opRatePerSec: 20, opBurst: 40 });
});
afterAll(async () => {
  await s.app.close();
  await db.drop();
});

async function joined(server: TestServer, cookie: string, docId: string) {
  const c = await rawClient(server, cookie);
  c.send({ type: MsgType.Join, ch: 1, docId });
  await waitFor(() => c.msgs.some((m) => m.type === MsgType.Joined), 5000, "joined");
  return c;
}

describe("audit regressions", () => {
  it("P1: an update with missing dependencies is stored before it is acknowledged", async () => {
    const u = await newUser(s.base);
    const { docId } = await workspaceWithDoc(u.http);
    const a = new Y.Doc();
    a.getText("content").insert(0, "a");
    const sv = Y.encodeStateVector(a);
    a.getText("content").insert(1, "b");
    const dependent = Y.encodeStateAsUpdate(a, sv); // needs "a"
    const c = await joined(s, u.http.cookie, docId);
    c.send({ type: MsgType.Update, ch: 1, seq: 7, update: dependent });
    await waitFor(() => c.msgs.some((m) => m.type === MsgType.Ack && m.seq === 7), 5000, "ack");
    const rows = await s.app.db.query("SELECT count(*)::int AS n FROM doc_updates WHERE doc_id = $1", [docId]);
    expect(rows.rows[0].n).toBe(1);
    // Once the dependency arrives, the stored state contains both.
    c.send({ type: MsgType.Update, ch: 1, seq: 8, update: Y.encodeStateAsUpdate(a) });
    await waitFor(() => c.msgs.some((m) => m.type === MsgType.Ack && m.seq === 8));
    expect(await docText(s.app.db, docId)).toBe("ab");
    expect(s.app.metrics.updatesPending.total()).toBeGreaterThan(0);
    c.ws.close();
  });

  it("P10 (2026-10-14): a second update with missing dependencies, while another is already pending, is stored before it is acknowledged", async () => {
    // Yjs merges a new pending update into the existing pending-structs
    // object in place, so a check for "a new pending object appeared" missed
    // it: the update was acknowledged without being written. Found by the
    // offline property test (offline-property.test.ts).
    const u = await newUser(s.base);
    const { docId } = await workspaceWithDoc(u.http);
    const a = new Y.Doc();
    const t = a.getText("content");
    const step = (ch: string) => {
      const sv = Y.encodeStateVector(a);
      t.insert(t.length, ch);
      return Y.encodeStateAsUpdate(a, sv);
    };
    const u1 = step("a");
    const u2 = step("b"); // needs u1
    const u3 = step("c"); // needs u2
    const c = await joined(s, u.http.cookie, docId);
    c.send({ type: MsgType.Update, ch: 1, seq: 2, update: u2 });
    await waitFor(() => c.msgs.some((m) => m.type === MsgType.Ack && m.seq === 2), 5000, "ack 2");
    c.send({ type: MsgType.Update, ch: 1, seq: 3, update: u3 });
    await waitFor(() => c.msgs.some((m) => m.type === MsgType.Ack && m.seq === 3), 5000, "ack 3");
    // Both acknowledged updates must be in PostgreSQL: with the missing
    // dependency added, the stored state reads "abc".
    const { loadDocState } = await import("../src/store.js");
    const stored = new Y.Doc();
    Y.applyUpdate(stored, (await loadDocState(s.app.db, docId)).state);
    Y.applyUpdate(stored, u1);
    expect(stored.getText("content").toString()).toBe("abc");
    c.ws.close();
  });

  it("P2: a document larger than one frame (1.8 MB) can be opened", async () => {
    const u = await newUser(s.base);
    const { docId } = await workspaceWithDoc(u.http);
    const w = connectClient(s, u.http.cookie, docId);
    await waitFor(() => w.handle.synced);
    for (let i = 0; i < 6; i++) w.text.insert(w.text.length, String(i).repeat(300_000));
    await waitFor(() => w.handle.unsaved === 0, 30_000, "saved");
    const r = connectClient(s, u.http.cookie, docId);
    await waitFor(() => r.handle.synced, 30_000, "large document synced");
    expect(r.text.toString()).toBe(w.text.toString());
    w.destroy();
    r.destroy();
  });

  it("P5: offline edits larger than one frame (1.2 MB) are uploaded on reconnect", async () => {
    const u = await newUser(s.base);
    const { docId } = await workspaceWithDoc(u.http);
    const c = connectClient(s, u.http.cookie, docId);
    await waitFor(() => c.handle.synced);
    c.destroy(); // offline
    const offline = new Y.Doc();
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(c.doc));
    for (let i = 0; i < 4; i++) offline.getText("content").insert(0, "y".repeat(300_000));
    const back = connectClient(s, u.http.cookie, docId, offline);
    await waitFor(() => back.handle.joined && back.handle.unsaved === 0, 30_000, "offline edits saved");
    expect((await docText(s.app.db, docId)).length).toBe(1_200_000);
    back.destroy();
  });

  it("P3: presence of a replica that reconnects while its old socket is half-open is accepted; the old socket is closed", async () => {
    const u = await newUser(s.base);
    const { workspaceId, docId } = await workspaceWithDoc(u.http);
    const doc = new Y.Doc();
    const aw = new Awareness(doc);
    aw.setLocalStateField("user", { name: "me", color: "#123456" });
    const old = await joined(s, u.http.cookie, docId);
    old.send({ type: MsgType.Awareness, ch: 1, payload: encodeAwarenessUpdate(aw, [doc.clientID]) });
    await sleep(100);
    const fresh = await joined(s, u.http.cookie, docId);
    fresh.send({ type: MsgType.Awareness, ch: 1, payload: encodeAwarenessUpdate(aw, [doc.clientID]) });
    await waitFor(() => old.closed() === 4010, 5000, "old socket superseded");
    expect(fresh.msgs.some((m) => m.type === MsgType.Error)).toBe(false);
    // Another user may still not claim that id, and claiming it closes nothing.
    const other = await newUser(s.base);
    await u.http.post(`/api/workspaces/${workspaceId}/members`, { email: other.email, role: "EDITOR" });
    const intruder = await joined(s, other.http.cookie, docId);
    intruder.send({ type: MsgType.Awareness, ch: 1, payload: encodeAwarenessUpdate(aw, [doc.clientID]) });
    await waitFor(() => intruder.msgs.some((m) => m.type === MsgType.Error && m.code === ErrorCode.Forbidden), 5000, "intruder refused");
    await sleep(100);
    expect(fresh.closed()).toBe(0);
    intruder.ws.close();
    fresh.ws.close();
    aw.destroy();
  });

  it("P4: an update lost between nodes reaches the other node's clients (anti-entropy)", async () => {
    const a1 = await startServer(db.url, { redisUrl: REDIS_URL, nodeId: "r1", durabilitySweepMs: 500 });
    const a2 = await startServer(db.url, { redisUrl: REDIS_URL, nodeId: "r2", durabilitySweepMs: 500 });
    const u = await newUser(a1.base);
    const { docId } = await workspaceWithDoc(u.http);
    const x = connectClient(a1, u.http.cookie, docId);
    const y = connectClient(a2, u.http.cookie, docId);
    await waitFor(() => x.handle.synced && y.handle.synced);
    const bus = a1.app.bus as unknown as { publish: (...a: unknown[]) => void };
    const publish = bus.publish.bind(bus);
    bus.publish = () => {}; // pub/sub loses this edit
    x.text.insert(0, "lost in transit");
    await waitFor(() => x.handle.unsaved === 0);
    bus.publish = publish;
    await waitFor(() => y.text.toString() === "lost in transit", 5000, "repair");
    expect(a2.app.metrics.antiEntropyRepairs.total()).toBeGreaterThan(0);
    x.destroy();
    y.destroy();
    await a1.app.close();
    await a2.app.close();
  });
});

describe("protocol v2 connection rules", () => {
  it("requires Hello first, answers with Welcome and limits", async () => {
    const u = await newUser(s.base);
    const ok = await rawClient(s, u.http.cookie);
    await waitFor(() => ok.msgs.some((m) => m.type === MsgType.Welcome));
    const w = ok.msgs.find((m) => m.type === MsgType.Welcome)!;
    expect(w.type === MsgType.Welcome && w.maxMessageBytes).toBeGreaterThan(1024 * 1024);
    ok.ws.close();
    const rude = await rawClient(s, u.http.cookie, { hello: false });
    rude.send({ type: MsgType.Ping, nonce: 1 });
    await waitFor(() => rude.closed() === 4000, 5000, "closed without Hello");
    expect(rude.msgs.some((m) => m.type === MsgType.Error && m.code === ErrorCode.BadMessage)).toBe(true);
  });

  it("closes a socket that never says Hello (handshake timeout)", async () => {
    const u = await newUser(s.base);
    const silent = await rawClient(s, u.http.cookie, { hello: false });
    await waitFor(() => silent.closed() === 4011, 5000, "handshake timeout");
  });

  it("tells a client of another protocol version to reload, in that client's own format", async () => {
    const u = await newUser(s.base);
    const old = await rawClient(s, u.http.cookie, { hello: false });
    const raw: Buffer[] = [];
    old.ws.on("message", (d) => raw.push(d as Buffer));
    const v1Join = encode({ type: MsgType.Join, ch: 1, docId: "abc" });
    v1Join[0] = 1;
    old.ws.send(v1Join);
    await waitFor(() => old.closed() === 4000, 5000, "closed");
    expect(PROTOCOL_VERSION).toBe(2);
    expect(raw[0]![0]).toBe(1); // version-1 frame
    expect(raw[0]![1]).toBe(MsgType.Error);
    expect(raw[0]![3]).toBe(ErrorCode.UnsupportedVersion);
  });

  it("a second connection with the same session id replaces the first", async () => {
    const u = await newUser(s.base);
    const a = await rawClient(s, u.http.cookie, { sessionId: "same-session-123" });
    await waitFor(() => a.msgs.some((m) => m.type === MsgType.Welcome));
    const b = await rawClient(s, u.http.cookie, { sessionId: "same-session-123" });
    await waitFor(() => a.closed() === 4010, 5000, "superseded");
    expect(b.closed()).toBe(0);
    // The same session id of another user is unrelated.
    const v = await newUser(s.base);
    const c = await rawClient(s, v.http.cookie, { sessionId: "same-session-123" });
    await sleep(200);
    expect(b.closed()).toBe(0);
    b.ws.close();
    c.ws.close();
  });

  it("errors refer to the refused update by its sequence number", async () => {
    const owner = await newUser(s.base);
    const viewer = await newUser(s.base);
    const { workspaceId, docId } = await workspaceWithDoc(owner.http);
    await owner.http.post(`/api/workspaces/${workspaceId}/members`, { email: viewer.email, role: "VIEWER" });
    const c = await joined(s, viewer.http.cookie, docId);
    const d = new Y.Doc();
    d.getText("content").insert(0, "nope");
    c.send({ type: MsgType.Update, ch: 1, seq: 42, update: Y.encodeStateAsUpdate(d) });
    await waitFor(() => c.msgs.some((m) => m.type === MsgType.Error));
    const e = c.msgs.find((m) => m.type === MsgType.Error)!;
    expect(e.type === MsgType.Error && e.ref).toBe(42);
    c.ws.close();
  });

  it("limits the rate of document operations separately from other messages", async () => {
    const u = await newUser(s.base);
    const { docId } = await workspaceWithDoc(u.http);
    const c = await joined(s, u.http.cookie, docId);
    const d = new Y.Doc();
    for (let i = 0; i < 60; i++) {
      d.getText("content").insert(0, "x");
      c.send({ type: MsgType.Update, ch: 1, seq: i + 1, update: Y.encodeStateAsUpdate(d) });
    }
    await waitFor(() => c.closed() === 4008, 5000, "operation rate limit");
    expect(s.app.metrics.rateLimited.get({ kind: "operations" })).toBeGreaterThan(0);
  });

  it("bounds the bytes waiting in a connection's inbound queue", async () => {
    const tight = await startServer(db.url, { inboundQueueBytes: 64 * 1024, byteBurst: 64 * 1024 * 1024, byteRatePerSec: 64 * 1024 * 1024 });
    const u = await newUser(tight.base);
    const { docId } = await workspaceWithDoc(u.http);
    const c = await rawClient(tight, u.http.cookie);
    // A Join makes the next messages wait for a database round trip.
    c.send({ type: MsgType.Join, ch: 1, docId });
    for (let i = 0; i < 20; i++) c.send({ type: MsgType.Sync1, ch: 1, stateVector: new Uint8Array(16 * 1024) });
    await waitFor(() => c.closed() === 1013, 5000, "inbound queue limit");
    expect(tight.app.metrics.backpressureDrops.get({ reason: "inbound_queue" })).toBeGreaterThan(0);
    await tight.app.close();
  });
});
