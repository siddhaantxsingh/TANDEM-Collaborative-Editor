// Test harness: a fresh PostgreSQL database per test file, servers on
// random ports, and HTTP / WebSocket clients that behave like a browser
// (cookies, Origin header).
import { randomBytes } from "node:crypto";

import pg from "pg";
import { WebSocket } from "ws";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

import { decode, encode, type Message, MsgType } from "@tandem/protocol";
import { TandemConnection, type DocHandle, type WebSocketLike } from "@tandem/protocol/client";

import { createApp, type App } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { createLogger } from "../src/logger.js";

export const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
export const REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379";

export async function createTestDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = "tandem_test_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(ADMIN_URL);
  u.pathname = "/" + name;
  return {
    url: u.toString(),
    drop: async () => {
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export interface TestServer {
  app: App;
  port: number;
  base: string;
  origin: string;
  cfg: Config;
  logs: string[];
}

export async function startServer(databaseUrl: string, overrides: Partial<Config> = {}): Promise<TestServer> {
  const logs: string[] = [];
  const cfg = loadConfig({
    port: 0,
    host: "127.0.0.1",
    databaseUrl,
    redisUrl: undefined,
    logLevel: "warn",
    roomIdleMs: 200,
    heartbeatMs: 60_000,
    registrationsPerHour: 100_000,
    ...overrides,
  });
  const app = await createApp(cfg, { log: createLogger(cfg.logLevel, { node: cfg.nodeId }, (l) => logs.push(l)) });
  const port = await app.listen();
  return { app, port, base: `http://127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, cfg, logs };
}

export class Http {
  cookie = "";
  constructor(public base: string, public origin = base) {}
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        Origin: this.origin,
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0]!;
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  }
  get = (p: string) => this.req("GET", p);
  post = (p: string, b?: unknown) => this.req("POST", p, b ?? {});
  patch = (p: string, b: unknown) => this.req("PATCH", p, b);
  del = (p: string) => this.req("DELETE", p);
}

let userCounter = 0;
export async function newUser(base: string, name = "user") {
  const http = new Http(base);
  const email = `${name}${++userCounter}_${randomBytes(3).toString("hex")}@example.com`;
  const r = await http.post("/api/auth/register", { email, password: "correct horse battery", name });
  if (r.status !== 201) throw new Error("register failed: " + JSON.stringify(r.body));
  return { http, email, id: r.body.user.id as string, name };
}

export async function workspaceWithDoc(owner: Http, path = "main.ts") {
  const w = await owner.post("/api/workspaces", { name: "ws" });
  const d = await owner.post(`/api/workspaces/${w.body.workspace.id}/documents`, { path });
  return { workspaceId: w.body.workspace.id as string, docId: d.body.document.id as string };
}

export function socketFactory(cookie: string, origin: string) {
  return (url: string) => new WebSocket(url, { headers: { Cookie: cookie, Origin: origin } }) as unknown as WebSocketLike;
}

export interface TestClient {
  conn: TandemConnection;
  doc: Y.Doc;
  awareness: Awareness;
  handle: DocHandle;
  text: Y.Text;
  destroy(): void;
}

export function connectClient(server: { port: number; origin: string }, cookie: string, docId: string, ydoc = new Y.Doc()): TestClient {
  const conn = new TandemConnection({
    url: `ws://127.0.0.1:${server.port}/ws`,
    createSocket: socketFactory(cookie, server.origin),
    minBackoffMs: 50,
    maxBackoffMs: 500,
  });
  const awareness = new Awareness(ydoc);
  const handle = conn.open(docId, ydoc, awareness);
  return { conn, doc: ydoc, awareness, handle, text: ydoc.getText("content"), destroy: () => conn.destroy() };
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000, what = "condition") {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A raw protocol client (no sync engine) for tests that act like a malicious
// or buggy client. Sends Hello first unless hello = false.
export async function rawClient(server: { port: number; origin: string }, cookie: string, opts: { hello?: boolean; sessionId?: string } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { Cookie: cookie, Origin: server.origin } });
  const msgs: Message[] = [];
  let closeCode = 0;
  ws.on("message", (d) => {
    try {
      msgs.push(decode(new Uint8Array(d as Buffer)));
    } catch {
      /* not decodable (e.g. a version-1 frame): ignore */
    }
  });
  ws.on("close", (c) => (closeCode = c));
  await new Promise((r, j) => {
    ws.on("open", r);
    ws.on("error", j);
  });
  const send = (m: Message) => ws.send(encode(m));
  if (opts.hello !== false) send({ type: MsgType.Hello, sessionId: opts.sessionId ?? "test-" + randomBytes(6).toString("hex"), resume: 0 });
  return { ws, msgs, send, closed: () => closeCode };
}
