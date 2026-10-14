// Authorization matrix (every endpoint x every role, including attempts on
// another workspace's ids), audit log, proxy-aware and shared rate limits,
// metrics protection, session cleanup, request ids, migrations.
import { MsgType } from "@tandem/protocol";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrate } from "../src/db.js";
import { createTestDatabase, Http, newUser, rawClient, REDIS_URL, startServer, waitFor, workspaceWithDoc, type TestServer } from "./helpers.js";

let db: { url: string; drop: () => Promise<void> };
let s: TestServer;
beforeAll(async () => {
  db = await createTestDatabase();
  s = await startServer(db.url);
});
afterAll(async () => {
  await s.app.close();
  await db.drop();
});

type Who = "anonymous" | "outsider" | "viewer" | "editor" | "owner";

describe("authorization matrix", () => {
  it("every endpoint enforces the role server-side, for ids of the workspace and of another one", async () => {
    const owner = await newUser(s.base, "owner");
    const editor = await newUser(s.base, "editor");
    const viewer = await newUser(s.base, "viewer");
    const outsider = await newUser(s.base, "outsider");
    const { workspaceId, docId } = await workspaceWithDoc(owner.http, "a.ts");
    await owner.http.post(`/api/workspaces/${workspaceId}/members`, { email: editor.email, role: "EDITOR" });
    await owner.http.post(`/api/workspaces/${workspaceId}/members`, { email: viewer.email, role: "VIEWER" });
    // The outsider owns another workspace: its ids must not open ours, and ours not its.
    const other = await workspaceWithDoc(outsider.http, "theirs.ts");
    const anon = new Http(s.base);
    const clients: Record<Who, Http> = { anonymous: anon, outsider: outsider.http, viewer: viewer.http, editor: editor.http, owner: owner.http };

    // [method, path, body, minimum role] for our workspace. Expected:
    // anonymous 401, outsider 404 (no probing), below the role 403, else 2xx.
    let n = 0;
    const cases: [string, () => string, () => unknown, "viewer" | "editor" | "owner"][] = [
      ["GET", () => `/api/workspaces/${workspaceId}`, () => undefined, "viewer"],
      ["GET", () => `/api/documents/${docId}/content`, () => undefined, "viewer"],
      ["GET", () => `/api/workspaces/${workspaceId}/audit`, () => undefined, "owner"],
      ["POST", () => `/api/workspaces/${workspaceId}/documents`, () => ({ path: `new${n++}.ts` }), "editor"],
      ["PATCH", () => `/api/documents/${docId}`, () => ({ path: `renamed${n++}.ts` }), "editor"],
      ["POST", () => `/api/workspaces/${workspaceId}/members`, () => ({ email: `nobody${n++}@example.com`, role: "VIEWER" }), "owner"],
      ["PATCH", () => `/api/workspaces/${workspaceId}/members/${viewer.id}`, () => ({ role: "VIEWER" }), "owner"],
    ];
    const rank = { viewer: 1, editor: 2, owner: 3 } as const;
    for (const [method, path, body, min] of cases) {
      for (const who of Object.keys(clients) as Who[]) {
        const r = await clients[who].req(method, path(), body());
        const expected =
          who === "anonymous" ? 401 : who === "outsider" ? 404 : rank[who] < rank[min] ? 403 : null;
        const label = `${method} ${path()} as ${who}`;
        if (expected === null) {
          expect([200, 201, 404], label).toContain(r.status); // 404: "no user with that email" for the invite case
          if (!(method === "POST" && path().endsWith("/members"))) expect(r.status, label).toBeLessThan(300);
        } else {
          expect(r.status, label).toBe(expected);
        }
      }
    }
    // Cross-workspace ids (IDOR): our members acting on the other workspace.
    for (const who of ["viewer", "editor", "owner"] as const) {
      const c = clients[who];
      expect((await c.get(`/api/workspaces/${other.workspaceId}`)).status).toBe(404);
      expect((await c.get(`/api/documents/${other.docId}/content`)).status).toBe(404);
      expect((await c.patch(`/api/documents/${other.docId}`, { path: "pwned.ts" })).status).toBe(404);
      expect((await c.del(`/api/documents/${other.docId}`)).status).toBe(404);
      expect((await c.post(`/api/workspaces/${other.workspaceId}/members`, { email: owner.email, role: "OWNER" })).status).toBe(404);
      expect((await c.patch(`/api/workspaces/${other.workspaceId}/members/${outsider.id}`, { role: "VIEWER" })).status).toBe(404);
      expect((await c.del(`/api/workspaces/${other.workspaceId}/members/${outsider.id}`)).status).toBe(404);
    }
    // A member id of another workspace used with our workspace id.
    expect((await owner.http.patch(`/api/workspaces/${workspaceId}/members/${outsider.id}`, { role: "OWNER" })).status).toBe(404);
    // Privilege escalation: an editor cannot change roles, including its own.
    expect((await editor.http.patch(`/api/workspaces/${workspaceId}/members/${editor.id}`, { role: "OWNER" })).status).toBe(403);
    // Workspace list only shows memberships.
    const list = (await outsider.http.get("/api/workspaces")).body.workspaces.map((w: { id: string }) => w.id);
    expect(list).toContain(other.workspaceId);
    expect(list).not.toContain(workspaceId);
    // Unknown and malformed ids look the same as forbidden ones.
    expect((await owner.http.get(`/api/workspaces/00000000-0000-0000-0000-000000000000`)).status).toBe(404);
    expect((await owner.http.get(`/api/workspaces/not-a-uuid`)).status).toBe(404);
    expect((await owner.http.get(`/api/documents/..%2F..%2Fetc/content`)).status).toBe(404);
    // Deletion last (editor may delete documents).
    expect((await viewer.http.del(`/api/documents/${docId}`)).status).toBe(403);
    expect((await editor.http.del(`/api/documents/${docId}`)).status).toBe(200);
  });

  it("WebSocket join is refused for non-members and unknown documents alike", async () => {
    const owner = await newUser(s.base);
    const outsider = await newUser(s.base);
    const { docId } = await workspaceWithDoc(owner.http);
    const c = await rawClient(s, outsider.http.cookie);
    c.send({ type: MsgType.Join, ch: 1, docId });
    c.send({ type: MsgType.Join, ch: 2, docId: "doesNotExist0000" });
    await waitFor(() => c.msgs.filter((m) => m.type === MsgType.Error).length === 2);
    const errs = c.msgs.filter((m) => m.type === MsgType.Error);
    expect(errs.map((e) => e.type === MsgType.Error && e.code)).toEqual([4, 4]);
    expect(errs.map((e) => e.type === MsgType.Error && e.message)).toEqual(["document not found", "document not found"]);
    expect(c.msgs.some((m) => m.type === MsgType.Joined)).toBe(false);
    c.ws.close();
  });
});

describe("audit log", () => {
  it("records authentication, membership and document actions; only owners can read it", async () => {
    const owner = await newUser(s.base, "aud");
    const member = await newUser(s.base, "mem");
    const { workspaceId, docId } = await workspaceWithDoc(owner.http, "x.ts");
    await owner.http.post(`/api/workspaces/${workspaceId}/members`, { email: member.email, role: "EDITOR" });
    await owner.http.patch(`/api/workspaces/${workspaceId}/members/${member.id}`, { role: "VIEWER" });
    await owner.http.patch(`/api/documents/${docId}`, { path: "y.ts" });
    await owner.http.del(`/api/documents/${docId}`);
    await owner.http.del(`/api/workspaces/${workspaceId}/members/${member.id}`);
    const r = await owner.http.get(`/api/workspaces/${workspaceId}/audit`);
    expect(r.status).toBe(200);
    const actions = r.body.entries.map((e: { action: string }) => e.action).reverse();
    expect(actions).toEqual(["workspace.create", "document.create", "member.add", "member.role_change", "document.rename", "document.delete", "member.remove"]);
    expect(r.body.entries[0].details).toEqual({ from: "VIEWER" });
    const login = await s.app.db.query("SELECT action, request_id, ip FROM audit_log WHERE actor_id = $1 AND action = 'user.register'", [owner.id]);
    expect(login.rows[0].request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(login.rows[0].ip).toMatch(/127\.0\.0\.1/);
  });

  it("records failed logins", async () => {
    const u = await newUser(s.base);
    const h = new Http(s.base);
    await h.post("/api/auth/login", { email: u.email, password: "wrong password!!" });
    const r = await s.app.db.query("SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1 AND action = 'auth.login_failed'", [u.id]);
    expect(r.rows[0].n).toBe(1);
  });
});

describe("rate limits behind a proxy and across nodes", () => {
  it("TRUST_PROXY: the address appended by the proxy is the client; without it X-Forwarded-For is ignored", async () => {
    const behind = await startServer(db.url, { trustProxy: true, loginAttemptsPerMinute: 2 });
    const direct = await startServer(db.url, { trustProxy: false, loginAttemptsPerMinute: 2 });
    const tryLogin = (srv: TestServer, xff: string, n: number) =>
      new Http(srv.base).req("POST", "/api/auth/login", { email: `nobody${n}@example.com`, password: "x" }, { "X-Forwarded-For": xff });
    // Behind the proxy: two clients each get their own budget.
    expect((await tryLogin(behind, "203.0.113.1", 1)).status).toBe(401);
    expect((await tryLogin(behind, "203.0.113.1", 2)).status).toBe(401);
    expect((await tryLogin(behind, "203.0.113.1", 3)).status).toBe(429);
    expect((await tryLogin(behind, "203.0.113.2", 4)).status).toBe(401);
    // A spoofed first entry does not change the client address (last entry counts).
    expect((await tryLogin(behind, "198.51.100.9, 203.0.113.1", 5)).status).toBe(429);
    // Directly exposed: the header is ignored, all requests share the socket address.
    expect((await tryLogin(direct, "203.0.113.7", 6)).status).toBe(401);
    expect((await tryLogin(direct, "203.0.113.8", 7)).status).toBe(401);
    expect((await tryLogin(direct, "203.0.113.9", 8)).status).toBe(429);
    await behind.app.close();
    await direct.app.close();
  });

  it("login attempts are counted across nodes (Redis)", async () => {
    const tag = Math.random().toString(36).slice(2);
    // Behind a proxy with a client address unique to this run: the per-IP
    // counter lives in the shared Redis in fixed one-minute windows, so other
    // tests (or a previous run) logging in from 127.0.0.1 within the same
    // minute must not use up this test's budget.
    const a = await startServer(db.url, { redisUrl: REDIS_URL, nodeId: `rl-a-${tag}`, loginAttemptsPerMinute: 4, trustProxy: true });
    const b = await startServer(db.url, { redisUrl: REDIS_URL, nodeId: `rl-b-${tag}`, loginAttemptsPerMinute: 4, trustProxy: true });
    const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
    const email = `victim-${tag}@example.com`; // per-email limit: 2 per minute
    const st: number[] = [];
    for (const srv of [a, b, a, b])
      st.push((await new Http(srv.base).req("POST", "/api/auth/login", { email, password: "guess guess" }, { "X-Forwarded-For": ip })).status);
    expect(st).toEqual([401, 401, 429, 429]);
    await a.app.close();
    await b.app.close();
  });
});

describe("operational endpoints", () => {
  it("metrics need the bearer token when one is configured", async () => {
    const t = await startServer(db.url, { metricsToken: "s3cret-token" });
    // A pool query must have completed before tandem_db_query_seconds has a
    // series (the startup session cleanup may still be in flight).
    expect((await fetch(t.base + "/health/ready")).status).toBe(200);
    expect((await fetch(t.base + "/metrics")).status).toBe(404);
    expect((await fetch(t.base + "/metrics", { headers: { Authorization: "Bearer wrong-token!" } })).status).toBe(404);
    const ok = await fetch(t.base + "/metrics", { headers: { Authorization: "Bearer s3cret-token" } });
    expect(ok.status).toBe(200);
    const text = await ok.text();
    for (const m of ["tandem_active_connections", "tandem_ack_latency_seconds", "tandem_process_resident_memory_bytes", "tandem_event_loop_lag_p99_seconds", "tandem_db_query_seconds_count"])
      expect(text).toContain(m);
    // Health stays public (load balancers).
    expect((await fetch(t.base + "/health/ready")).status).toBe(200);
    await t.app.close();
  });

  it("every response carries a request id; a valid incoming one is kept", async () => {
    const a = await fetch(s.base + "/api/me");
    expect(a.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    const b = await fetch(s.base + "/api/me", { headers: { "X-Request-Id": "trace-abc.123" } });
    expect(b.headers.get("x-request-id")).toBe("trace-abc.123");
    const c = await fetch(s.base + "/api/me", { headers: { "X-Request-Id": "bad id\twith junk" } });
    expect(c.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("expired sessions are deleted", async () => {
    const u = await newUser(s.base);
    await s.app.db.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [u.id]);
    expect((await u.http.get("/api/me")).status).toBe(401);
    const t = await startServer(db.url, { sessionCleanupMs: 60_000 }); // runs once at start
    await waitFor(async () => (await s.app.db.query("SELECT count(*)::int AS n FROM sessions WHERE user_id = $1", [u.id])).rows[0].n === 0);
    await t.app.close();
  });

  it("security headers on API responses", async () => {
    const r = await fetch(s.base + "/api/me");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

describe("migrations", () => {
  it("upgrade a version-1 database in place, keeping its data; running again changes nothing", async () => {
    const fresh = await createTestDatabase();
    const pool = new pg.Pool({ connectionString: fresh.url });
    pool.on("error", () => {}); // idle clients are terminated when the database is dropped
    // Simulate a database created by the previous release (migration 1 only).
    const { MIGRATIONS } = await import("../src/db.js");
    await pool.query("CREATE TABLE schema_migrations (id int PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    await pool.query(MIGRATIONS[0]!.sql);
    await pool.query("INSERT INTO schema_migrations (id, name) VALUES (1, 'initial schema')");
    await pool.query("INSERT INTO users (email, name, password_hash) VALUES ('old@example.com', 'Old', 'x')");
    expect(await migrate(pool)).toEqual([2]);
    expect(await migrate(pool)).toEqual([]);
    expect((await pool.query("SELECT name FROM users")).rows).toEqual([{ name: "Old" }]);
    const idx = (await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")).rows.map((r) => r.indexname);
    for (const i of ["sessions_expires_idx", "audit_log_workspace_idx", "doc_updates_doc_seq_idx", "memberships_user_idx"]) expect(idx).toContain(i);
    await pool.end();
    await fresh.drop();
  });
});
