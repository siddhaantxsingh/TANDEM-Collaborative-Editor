// HTTP API (JSON), health checks, metrics and static files. Uses node:http
// directly; every handler validates its input and checks authorization
// against the database (never against anything the client claims).
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

import { isValidDocId, parseRole, Role, roleName } from "@tandem/protocol";

import {
  clearSessionCookie,
  createSession,
  deleteSession,
  dummyPasswordHash,
  hashPassword,
  parseCookies,
  SESSION_COOKIE,
  sessionCookie,
  sessionUser,
  type SessionUser,
  verifyPassword,
} from "./auth.js";
import { audit, auditBestEffort } from "./audit.js";
import type { Bus } from "./bus.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { Logger } from "./logger.js";
import type { Metrics } from "./metrics.js";
import type { AsyncLimiter } from "./ratelimit.js";
import type { RoomManager } from "./rooms.js";
import { docMeta, docText, newDocId, roleIn } from "./store.js";
import { originAllowed } from "./ws.js";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  user?: SessionUser;
  body?: unknown;
  requestId: string;
  ip: string;
}

type Handler = (c: Ctx) => Promise<unknown>;

const MAX_BODY = 64 * 1024;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const PATH_RE = /^(?!\/)(?!.*\/\/)(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._\-/ ]{1,200}(?<!\/)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

// Client address. Behind a reverse proxy every request comes from the proxy,
// so per-IP limits would become global; with TRUST_PROXY the address the
// proxy appended to X-Forwarded-For (the last entry) is used instead. Only
// enable it when the server is reachable through the proxy alone.
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const last = (Array.isArray(xff) ? xff.join(",") : (xff ?? "")).split(",").map((x) => x.trim()).filter(Boolean).pop();
    if (last && last.length <= 64) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}

function str(body: unknown, key: string, opts: { min?: number; max: number; re?: RegExp }): string {
  const v = (body as Record<string, unknown> | undefined)?.[key];
  if (typeof v !== "string") throw new HttpError(400, `${key} is required`);
  const s = v.trim();
  if (s.length < (opts.min ?? 1) || s.length > opts.max) throw new HttpError(400, `${key} must be ${opts.min ?? 1}-${opts.max} characters`);
  if (opts.re && !opts.re.test(s)) throw new HttpError(400, `${key} is invalid`);
  return s;
}

function uuidParam(s: string | undefined): string {
  if (!s || !UUID_RE.test(s)) throw new HttpError(404, "not found");
  return s;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers["content-type"] ?? "";
  if (!type.startsWith("application/json")) throw new HttpError(415, "expected application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export interface Limiters {
  loginIp: AsyncLimiter;
  loginEmail: AsyncLimiter;
  registerIp: AsyncLimiter;
}

export class HttpApi {
  private routes: { method: string; path: string; re: RegExp; auth: boolean; handler: Handler }[] = [];

  constructor(
    private readonly db: Db,
    private readonly rooms: RoomManager,
    private readonly bus: Bus,
    private readonly cfg: Config,
    private readonly log: Logger,
    private readonly metrics: Metrics,
    private readonly limiters: Limiters,
    private readonly onLogout: (userId: string) => void,
  ) {
    this.defineRoutes();
  }

  private route(method: string, path: string, auth: boolean, handler: Handler) {
    const re = new RegExp("^" + path.replace(/:[a-z]+/g, "([^/]+)") + "$");
    this.routes.push({ method, path, re, auth, handler });
  }

  private auditCtx(c: Ctx) {
    return { requestId: c.requestId, ip: c.ip };
  }

  private async requireRole(workspaceId: string, user: SessionUser, min: Role): Promise<Role> {
    const role = await roleIn(this.db, workspaceId, user.id);
    // Non-members get 404 rather than 403 so workspace ids cannot be probed.
    if (role === undefined) throw new HttpError(404, "not found");
    if (role < min) throw new HttpError(403, `requires ${roleName(min)} role`);
    return role;
  }

  private defineRoutes() {
    const r = this.route.bind(this);

    r("POST", "/api/auth/register", false, async (c) => {
      if (!(await this.limiters.registerIp.take(c.ip))) throw new HttpError(429, "too many registrations, try later");
      const email = str(c.body, "email", { max: 254, re: EMAIL_RE }).toLowerCase();
      const password = str(c.body, "password", { min: 10, max: 200 });
      const name = str(c.body, "name", { max: 60 });
      const hash = await hashPassword(password);
      const res = await this.db.query("INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING RETURNING id", [
        email,
        name,
        hash,
      ]);
      if (res.rowCount === 0) throw new HttpError(409, "an account with this email already exists");
      const id = res.rows[0].id as string;
      await auditBestEffort(this.db, { actorId: id, action: "user.register", ...this.auditCtx(c) }, this.log, this.metrics);
      const token = await createSession(this.db, id, this.cfg.sessionTtlHours);
      c.res.setHeader("Set-Cookie", sessionCookie(token, this.cfg.cookieSecure, this.cfg.sessionTtlHours * 3600));
      c.res.statusCode = 201;
      return { user: { id, email, name } };
    });

    r("POST", "/api/auth/login", false, async (c) => {
      const email = str(c.body, "email", { max: 254 }).toLowerCase();
      const password = str(c.body, "password", { max: 200 });
      if (!(await this.limiters.loginIp.take(c.ip)) || !(await this.limiters.loginEmail.take(email))) {
        this.metrics.loginFailures.inc({ reason: "rate_limited" });
        throw new HttpError(429, "too many login attempts, try again in a minute");
      }
      const row = (await this.db.query("SELECT id, email, name, password_hash FROM users WHERE email = $1", [email])).rows[0];
      const ok = await verifyPassword(password, row ? row.password_hash : await dummyPasswordHash());
      if (!row || !ok) {
        this.metrics.loginFailures.inc({ reason: "bad_credentials" });
        await auditBestEffort(this.db, { actorId: row ? row.id : null, action: "auth.login_failed", details: row ? {} : { unknownEmail: true }, ...this.auditCtx(c) }, this.log, this.metrics);
        throw new HttpError(401, "wrong email or password");
      }
      await auditBestEffort(this.db, { actorId: row.id, action: "auth.login", ...this.auditCtx(c) }, this.log, this.metrics);
      const token = await createSession(this.db, row.id, this.cfg.sessionTtlHours);
      c.res.setHeader("Set-Cookie", sessionCookie(token, this.cfg.cookieSecure, this.cfg.sessionTtlHours * 3600));
      return { user: { id: row.id, email: row.email, name: row.name } };
    });

    r("POST", "/api/auth/logout", true, async (c) => {
      const token = parseCookies(c.req.headers.cookie)[SESSION_COOKIE];
      if (token) await deleteSession(this.db, token);
      await auditBestEffort(this.db, { actorId: c.user!.id, action: "auth.logout", ...this.auditCtx(c) }, this.log, this.metrics);
      c.res.setHeader("Set-Cookie", clearSessionCookie(this.cfg.cookieSecure));
      this.onLogout(c.user!.id);
      return { ok: true };
    });

    r("GET", "/api/me", true, async (c) => ({ user: c.user }));

    r("GET", "/api/workspaces", true, async (c) => {
      const res = await this.db.query(
        "SELECT w.id, w.name, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE m.user_id = $1 ORDER BY w.created_at",
        [c.user!.id],
      );
      return { workspaces: res.rows };
    });

    r("POST", "/api/workspaces", true, async (c) => {
      const name = str(c.body, "name", { max: 80 });
      const client = await this.db.connect();
      try {
        await client.query("BEGIN");
        const w = await client.query("INSERT INTO workspaces (name) VALUES ($1) RETURNING id", [name]);
        await client.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'OWNER')", [w.rows[0].id, c.user!.id]);
        await audit(client, { actorId: c.user!.id, action: "workspace.create", workspaceId: w.rows[0].id, details: { name }, ...this.auditCtx(c) });
        await client.query("COMMIT");
        c.res.statusCode = 201;
        return { workspace: { id: w.rows[0].id, name, role: "OWNER" } };
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    });

    r("GET", "/api/workspaces/:id", true, async (c) => {
      const wid = uuidParam(c.params[0]);
      const role = await this.requireRole(wid, c.user!, Role.Viewer);
      const w = await this.db.query("SELECT id, name FROM workspaces WHERE id = $1", [wid]);
      const members = await this.db.query(
        "SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY u.name",
        [wid],
      );
      const docs = await this.db.query("SELECT id, path, updated_at FROM documents WHERE workspace_id = $1 ORDER BY path", [wid]);
      return { workspace: { ...w.rows[0], role: roleName(role) }, members: members.rows, documents: docs.rows };
    });

    r("POST", "/api/workspaces/:id/members", true, async (c) => {
      const wid = uuidParam(c.params[0]);
      await this.requireRole(wid, c.user!, Role.Owner);
      const email = str(c.body, "email", { max: 254 }).toLowerCase();
      const role = parseRole(str(c.body, "role", { max: 10 }));
      if (!role) throw new HttpError(400, "role must be OWNER, EDITOR or VIEWER");
      const u = await this.db.query("SELECT id, name FROM users WHERE email = $1", [email]);
      if (!u.rows[0]) throw new HttpError(404, "no user with that email");
      const ins = await this.db.query(
        "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [wid, u.rows[0].id, roleName(role)],
      );
      if (ins.rowCount === 0) throw new HttpError(409, "already a member");
      await auditBestEffort(this.db, { actorId: c.user!.id, action: "member.add", workspaceId: wid, target: u.rows[0].id, details: { role: roleName(role) }, ...this.auditCtx(c) }, this.log, this.metrics);
      this.bus.publishControl({ type: "membership", workspaceId: wid, userId: u.rows[0].id, role: roleName(role) });
      c.res.statusCode = 201;
      return { member: { id: u.rows[0].id, name: u.rows[0].name, email, role: roleName(role) } };
    });

    r("PATCH", "/api/workspaces/:id/members/:uid", true, async (c) => {
      const wid = uuidParam(c.params[0]);
      const uid = uuidParam(c.params[1]);
      await this.requireRole(wid, c.user!, Role.Owner);
      const role = parseRole(str(c.body, "role", { max: 10 }));
      if (!role) throw new HttpError(400, "role must be OWNER, EDITOR or VIEWER");
      await this.changeMembership(c, wid, uid, role);
      return { ok: true };
    });

    r("DELETE", "/api/workspaces/:id/members/:uid", true, async (c) => {
      const wid = uuidParam(c.params[0]);
      const uid = uuidParam(c.params[1]);
      // Owners may remove anyone; anyone may remove themselves (leave).
      if (uid !== c.user!.id) await this.requireRole(wid, c.user!, Role.Owner);
      else await this.requireRole(wid, c.user!, Role.Viewer);
      await this.changeMembership(c, wid, uid, null);
      return { ok: true };
    });

    r("POST", "/api/workspaces/:id/documents", true, async (c) => {
      const wid = uuidParam(c.params[0]);
      await this.requireRole(wid, c.user!, Role.Editor);
      const path = str(c.body, "path", { max: 200, re: PATH_RE });
      const id = newDocId();
      const ins = await this.db.query(
        "INSERT INTO documents (id, workspace_id, path) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, path) DO NOTHING RETURNING id",
        [id, wid, path],
      );
      if (ins.rowCount === 0) throw new HttpError(409, "a file with this path already exists");
      await auditBestEffort(this.db, { actorId: c.user!.id, action: "document.create", workspaceId: wid, target: id, details: { path }, ...this.auditCtx(c) }, this.log, this.metrics);
      c.res.statusCode = 201;
      return { document: { id, path } };
    });

    r("PATCH", "/api/documents/:id", true, async (c) => {
      const meta = await this.docOr404(c.params[0]);
      await this.requireRole(meta.workspaceId, c.user!, Role.Editor);
      const path = str(c.body, "path", { max: 200, re: PATH_RE });
      try {
        await this.db.query("UPDATE documents SET path = $1, updated_at = now() WHERE id = $2", [path, meta.id]);
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw new HttpError(409, "a file with this path already exists");
        throw e;
      }
      await auditBestEffort(this.db, { actorId: c.user!.id, action: "document.rename", workspaceId: meta.workspaceId, target: meta.id, details: { from: meta.path, to: path }, ...this.auditCtx(c) }, this.log, this.metrics);
      return { document: { id: meta.id, path } };
    });

    r("DELETE", "/api/documents/:id", true, async (c) => {
      const meta = await this.docOr404(c.params[0]);
      await this.requireRole(meta.workspaceId, c.user!, Role.Editor);
      // Flush pending writes first so that they do not fail on a deleted row.
      await this.rooms.room(meta.id)?.flush();
      await this.db.query("DELETE FROM documents WHERE id = $1", [meta.id]);
      await auditBestEffort(this.db, { actorId: c.user!.id, action: "document.delete", workspaceId: meta.workspaceId, target: meta.id, details: { path: meta.path }, ...this.auditCtx(c) }, this.log, this.metrics);
      this.bus.publishControl({ type: "document-deleted", docId: meta.id });
      return { ok: true };
    });

    r("GET", "/api/workspaces/:id/audit", true, async (c) => {
      const wid = uuidParam(c.params[0]);
      await this.requireRole(wid, c.user!, Role.Owner);
      const rows = await this.db.query(
        `SELECT a.at, a.action, a.target, a.details, u.name AS actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
         WHERE a.workspace_id = $1 ORDER BY a.at DESC, a.id DESC LIMIT 200`,
        [wid],
      );
      return { entries: rows.rows };
    });

    r("GET", "/api/documents/:id/content", true, async (c) => {
      const meta = await this.docOr404(c.params[0]);
      await this.requireRole(meta.workspaceId, c.user!, Role.Viewer);
      const room = this.rooms.room(meta.id);
      await room?.flush();
      c.res.setHeader("Content-Type", "text/plain; charset=utf-8");
      c.res.setHeader("Content-Disposition", `attachment; filename="${meta.path.split("/").pop()!.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
      return { __raw: await docText(this.db, meta.id) };
    });
  }

  private async docOr404(id: string | undefined) {
    if (!id || !isValidDocId(id)) throw new HttpError(404, "not found");
    const meta = await docMeta(this.db, id);
    if (!meta) throw new HttpError(404, "not found");
    return meta;
  }

  private async changeMembership(c: Ctx, wid: string, uid: string, role: Role | null) {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      // Lock the workspace's memberships so two concurrent demotions cannot
      // both pass the last-owner check.
      const rows = await client.query("SELECT user_id, role FROM memberships WHERE workspace_id = $1 FOR UPDATE", [wid]);
      const target = rows.rows.find((x) => x.user_id === uid);
      if (!target) throw new HttpError(404, "not a member");
      const owners = rows.rows.filter((x) => x.role === "OWNER").length;
      if (target.role === "OWNER" && owners === 1 && role !== Role.Owner) throw new HttpError(409, "a workspace needs at least one owner");
      if (role === null) await client.query("DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2", [wid, uid]);
      else await client.query("UPDATE memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2", [wid, uid, roleName(role)]);
      await audit(client, {
        actorId: c.user!.id,
        action: role === null ? "member.remove" : "member.role_change",
        workspaceId: wid,
        target: uid,
        details: role === null ? { from: target.role } : { from: target.role, to: roleName(role) },
        ...this.auditCtx(c),
      });
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    this.bus.publishControl({ type: "membership", workspaceId: wid, userId: uid, role: role === null ? null : roleName(role) });
  }

  async handle(req: IncomingMessage, res: ServerResponse, health: () => Promise<{ ok: boolean; checks: Record<string, boolean> }>) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const started = process.hrtime.bigint();
    let routeLabel = "static";
    const incoming = req.headers["x-request-id"];
    const requestId = typeof incoming === "string" && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    const ip = clientIp(req, this.cfg.trustProxy);
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    try {
      if (url.pathname === "/health/live") {
        routeLabel = "health";
        return this.json(res, 200, { status: "ok" });
      }
      if (url.pathname === "/health/ready") {
        routeLabel = "health";
        const h = await health();
        return this.json(res, h.ok ? 200 : 503, { status: h.ok ? "ok" : "unavailable", checks: h.checks });
      }
      if (url.pathname === "/metrics") {
        routeLabel = "metrics";
        if (!this.metricsAllowed(req)) throw new HttpError(404, "not found");
        res.setHeader("Content-Type", "text/plain; version=0.0.4");
        res.end(this.metrics.render());
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        for (const rt of this.routes) {
          const m = rt.method === method ? rt.re.exec(url.pathname) : null;
          if (!m) continue;
          routeLabel = `${rt.method} ${rt.path}`;
          // CSRF defence in depth (besides SameSite cookies): state-changing
          // requests must come from an allowed origin.
          if (method !== "GET" && !originAllowed(req.headers.origin, req.headers.host, this.cfg.allowedOrigins))
            throw new HttpError(403, "cross-origin request rejected");
          const ctx: Ctx = { req, res, url, params: m.slice(1).map((p) => decodeURIComponent(p)), requestId, ip };
          if (rt.auth) {
            ctx.user = await sessionUser(this.db, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
            if (!ctx.user) throw new HttpError(401, "not logged in");
          }
          if (method === "POST" || method === "PATCH") ctx.body = await readJson(req);
          const out = (await rt.handler(ctx)) as Record<string, unknown>;
          if (out && typeof out.__raw === "string") {
            res.statusCode = 200;
            res.end(out.__raw);
            return;
          }
          return this.json(res, res.statusCode === 200 ? 200 : res.statusCode, out);
        }
        throw new HttpError(404, "not found");
      }
      if (method === "GET" || method === "HEAD") return this.serveStatic(url.pathname, res);
      throw new HttpError(405, "method not allowed");
    } catch (err) {
      if (err instanceof HttpError) return this.json(res, err.status, { error: err.message });
      this.metrics.errors.inc({ component: "http" });
      this.log.error("request failed", { method, path: url.pathname, requestId, err: (err as Error).message });
      return this.json(res, 500, { error: "internal error", requestId });
    } finally {
      this.metrics.httpRequests.inc({ route: routeLabel, status: String(res.statusCode) });
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (routeLabel !== "static") this.metrics.httpLatency.observe(ms / 1000, { route: routeLabel });
      if (routeLabel !== "health" && routeLabel !== "metrics")
        this.log.debug("request", { method, path: url.pathname, status: res.statusCode, ms: Math.round(ms * 10) / 10, requestId });
    }
  }

  // /metrics: with METRICS_TOKEN, a matching bearer token is required;
  // without one, only local requests (a sidecar or `curl` on the host).
  private metricsAllowed(req: IncomingMessage): boolean {
    const token = this.cfg.metricsToken;
    if (token) {
      const got = Buffer.from(String(req.headers.authorization ?? ""));
      const want = Buffer.from(`Bearer ${token}`);
      return got.length === want.length && timingSafeEqual(got, want);
    }
    const a = req.socket.remoteAddress ?? "";
    return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
  }

  private json(res: ServerResponse, status: number, body: unknown) {
    if (res.headersSent) return;
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
  }

  private serveStatic(pathname: string, res: ServerResponse) {
    const root = this.cfg.staticDir;
    if (!root) return this.json(res, 404, { error: "not found" });
    let rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
    if (rel.split(sep).includes("..")) return this.json(res, 404, { error: "not found" });
    let file = join(root, rel);
    if (!rel || !existsSync(file) || statSync(file).isDirectory()) {
      rel = "index.html"; // single-page app fallback
      file = join(root, rel);
    }
    if (!existsSync(file)) return this.json(res, 404, { error: "not found" });
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME[extname(file)] ?? "application/octet-stream");
    // Only content-hashed assets may be cached forever; the shell and the
    // service worker must be revalidated so that a deployment is picked up.
    res.setHeader("Cache-Control", rel.startsWith("assets" + sep) || rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self' ws: wss:; worker-src 'self' blob:; frame-ancestors 'none'",
    );
    createReadStream(file).pipe(res);
  }
}
