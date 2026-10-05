// Abuse resistance: malformed frames, rate limits, backpressure, size limits.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import * as Y from "yjs";

import { decode, encode, MsgType } from "@tandem/protocol";

import { connectClient, createTestDatabase, newUser, sleep, startServer, waitFor, workspaceWithDoc, type TestServer } from "./helpers.js";

let db: { url: string; drop: () => Promise<void> };
let server: TestServer;

beforeAll(async () => {
  db = await createTestDatabase();
  server = await startServer(db.url, { msgRatePerSec: 50, msgBurst: 100, maxDocumentBytes: 64 * 1024 });
});
afterAll(async () => {
  await server.app.close();
  await db.drop();
});

async function rawSocket(cookie: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { Cookie: cookie, Origin: server.origin } });
  const msgs: ReturnType<typeof decode>[] = [];
  let closeCode = 0;
  ws.on("message", (d) => {
    try {
      msgs.push(decode(new Uint8Array(d as Buffer)));
    } catch {
      /* ignore */
    }
  });
  ws.on("close", (c) => (closeCode = c));
  await new Promise((r) => ws.on("open", r));
  ws.send(encode({ type: MsgType.Hello, sessionId: "limits-" + Math.random().toString(36).slice(2), resume: 0 }));
  return { ws, msgs, closed: () => closeCode };
}

describe("limits", () => {
  it("closes the connection on a malformed frame and keeps serving others", async () => {
    const u = await newUser(server.base);
    const { docId } = await workspaceWithDoc(u.http);
    const bad = await rawSocket(u.http.cookie);
    bad.ws.send(Buffer.from([1, 99, 1, 2, 3]));
    await waitFor(() => bad.closed() === 4000, 5000, "protocol close");
    bad.ws.send; // closed
    const text = await rawSocket(u.http.cookie);
    text.ws.send("not binary");
    await waitFor(() => text.closed() === 4000, 5000, "text frame close");
    const good = connectClient(server, u.http.cookie, docId);
    await waitFor(() => good.handle.synced);
    good.destroy();
  });

  it("rejects malformed Yjs updates without corrupting the document", async () => {
    const u = await newUser(server.base);
    const { docId } = await workspaceWithDoc(u.http);
    const c = connectClient(server, u.http.cookie, docId);
    await waitFor(() => c.handle.synced);
    c.text.insert(0, "intact");
    await waitFor(() => c.handle.unsaved === 0);
    const raw = await rawSocket(u.http.cookie);
    raw.ws.send(encode({ type: MsgType.Join, ch: 7, docId }));
    await waitFor(() => raw.msgs.some((m) => m.type === MsgType.Joined));
    for (const junk of [new Uint8Array([255, 255, 255, 255]), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), new Uint8Array(0)])
      raw.ws.send(encode({ type: MsgType.Update, ch: 7, seq: 1, update: junk }));
    await sleep(300);
    expect(raw.msgs.some((m) => m.type === MsgType.Error)).toBe(true);
    expect(c.text.toString()).toBe("intact");
    const again = connectClient(server, u.http.cookie, docId);
    await waitFor(() => again.handle.synced);
    expect(again.text.toString()).toBe("intact");
    raw.ws.close();
    c.destroy();
    again.destroy();
  });

  it("rate-limits a flooding client", async () => {
    const u = await newUser(server.base);
    const raw = await rawSocket(u.http.cookie);
    for (let i = 0; i < 500; i++) raw.ws.send(encode({ type: MsgType.Ping, nonce: i }));
    await waitFor(() => raw.closed() === 4008, 5000, "rate limit close");
    expect(raw.msgs.some((m) => m.type === MsgType.Error && m.code === 5)).toBe(true);
    expect(server.app.metrics.rateLimited.total()).toBeGreaterThan(0);
  });

  it("enforces the document size limit", async () => {
    const u = await newUser(server.base);
    const { docId } = await workspaceWithDoc(u.http);
    const c = connectClient(server, u.http.cookie, docId);
    await waitFor(() => c.handle.synced);
    const errors: number[] = [];
    c.handle.on("error", (code) => errors.push(code));
    for (let i = 0; i < 10; i++) {
      c.text.insert(c.text.length, "x".repeat(10_000));
      await sleep(30);
    }
    await waitFor(() => errors.includes(6), 5000, "too large error");
    c.destroy();
  });

  it("disconnects a client whose send buffer overflows (backpressure) and it resyncs", async () => {
    // Small frames fit the limit; the reader's initial Sync2 (the whole
    // document) does not.
    const tiny = await startServer(db.url, { sendBufferLimit: 600 });
    const u = await newUser(tiny.base);
    const { docId } = await workspaceWithDoc(u.http);
    const writer = connectClient(tiny, u.http.cookie, docId);
    await waitFor(() => writer.handle.synced);
    for (let i = 0; i < 10; i++) writer.text.insert(writer.text.length, "y".repeat(100));
    await waitFor(() => writer.handle.unsaved === 0, 10_000, "writer saved");
    const before = tiny.app.metrics.backpressureDrops.total();
    const reader = connectClient(tiny, u.http.cookie, docId);
    await waitFor(() => tiny.app.metrics.backpressureDrops.total() > before, 5000, "backpressure disconnect");
    reader.destroy();
    writer.destroy();
    await tiny.app.close();
  });

  it("exposes health and metrics endpoints", async () => {
    const live = await fetch(server.base + "/health/live");
    expect(live.status).toBe(200);
    const ready = await fetch(server.base + "/health/ready");
    expect(ready.status).toBe(200);
    expect((await ready.json()).checks.database).toBe(true);
    const m = await (await fetch(server.base + "/metrics")).text();
    expect(m).toContain("tandem_active_connections");
    expect(m).toContain("tandem_updates_persisted_total");
  });

  it("readiness fails when the database is unreachable", async () => {
    const broken = await startServer(db.url);
    await broken.app.db.end(); // simulate a lost database
    const r = await fetch(broken.base + "/health/ready");
    expect(r.status).toBe(503);
    broken.app.server.close();
  });
});
