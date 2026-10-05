// Post-deployment smoke test, run against the public URL (the load balancer).
//
//   npx tsx tools/smoke.ts --url https://tandem.example.com --phase write --state smoke.json
//   (restart / redeploy the application)
//   npx tsx tools/smoke.ts --url https://tandem.example.com --phase verify --state smoke.json
//
// "write" checks health, static app, security headers, that /metrics is not
// public, cookie flags, CSRF/origin refusal, request ids, authorization
// (a second user cannot read the document), then writes a document through
// the real WebSocket protocol and waits for the server's acknowledgement.
// "verify" checks the document survived (restart, redeploy, failover).
// Every check prints PASS/FAIL; exit code 0 only if all passed.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { TandemConnection, type WebSocketLike } from "@tandem/protocol/client";
import { WebSocket } from "ws";
import * as Y from "yjs";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const BASE = (args.get("url") ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const PHASE = args.get("phase") ?? "write";
const STATE = args.get("state") ?? "smoke-state.json";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function req(method: string, path: string, body?: unknown, cookie = "", origin = BASE) {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const text = await r.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { r, text, json, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? cookie };
}

async function register(name: string) {
  const email = `smoke_${name}_${randomBytes(4).toString("hex")}@example.com`;
  const res = await req("POST", "/api/auth/register", { email, password: "smoke test password 1", name });
  return { email, ...res };
}

async function write() {
  const live = await req("GET", "/health/live");
  check("GET /health/live", live.r.status === 200, String(live.r.status));
  const ready = await req("GET", "/health/ready");
  check("GET /health/ready (database reachable)", ready.r.status === 200, ready.text.slice(0, 100));
  const index = await req("GET", "/");
  check("GET / serves the app", index.r.status === 200 && index.text.includes("<div id=\"root\">"), String(index.r.status));
  check("Content-Security-Policy header", (index.r.headers.get("content-security-policy") ?? "").includes("script-src 'self'"));
  check("X-Frame-Options DENY", index.r.headers.get("x-frame-options") === "DENY");
  const sw = await req("GET", "/sw.js");
  check("service worker served, not cached long-term", sw.r.status === 200 && (sw.r.headers.get("cache-control") ?? "").includes("no-cache"));
  const metrics = await req("GET", "/metrics");
  check("/metrics not publicly readable", metrics.r.status === 404 || metrics.r.status === 401 || metrics.r.status === 403, String(metrics.r.status));
  const rid = await fetch(BASE + "/health/live", { headers: { "X-Request-Id": "smoke-req-12345678" } });
  check("request id returned", (rid.headers.get("x-request-id") ?? "").length > 0, rid.headers.get("x-request-id") ?? "none");

  const owner = await register("owner");
  check("register", owner.r.status === 201, String(owner.r.status));
  const setCookie = owner.r.headers.get("set-cookie") ?? "";
  check("session cookie HttpOnly + SameSite", /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie));
  if (BASE.startsWith("https:")) check("session cookie Secure (HTTPS deployment)", /Secure/i.test(setCookie));
  const me = await req("GET", "/api/me", undefined, owner.cookie);
  check("GET /api/me with the session", me.r.status === 200 && me.json?.user?.email === owner.email);
  const csrf = await req("POST", "/api/workspaces", { name: "x" }, owner.cookie, "https://evil.example");
  check("cross-origin POST refused", csrf.r.status === 403, String(csrf.r.status));

  const ws = await req("POST", "/api/workspaces", { name: "smoke" }, owner.cookie);
  const wsId = ws.json?.workspace?.id as string;
  const doc = await req("POST", `/api/workspaces/${wsId}/documents`, { path: "smoke.txt" }, owner.cookie);
  const docId = doc.json?.document?.id as string;
  check("create workspace and document", ws.r.status === 201 && doc.r.status === 201);
  const other = await register("other");
  const peek = await req("GET", `/api/documents/${docId}/content`, undefined, other.cookie);
  check("another user cannot read the document (IDOR)", peek.r.status === 404, String(peek.r.status));
  const noAuth = await req("GET", `/api/documents/${docId}/content`);
  check("anonymous request refused", noAuth.r.status === 401, String(noAuth.r.status));

  // Edit through the real protocol, through the load balancer.
  const text = `smoke ${new Date().toISOString()} ${randomBytes(6).toString("hex")}`;
  const ydoc = new Y.Doc();
  const conn = new TandemConnection({
    url: BASE.replace(/^http/, "ws") + "/ws",
    createSocket: (u) => new WebSocket(u, { headers: { Cookie: owner.cookie, Origin: BASE } }) as unknown as WebSocketLike,
  });
  const handle = conn.open(docId, ydoc);
  const t0 = Date.now();
  while (!handle.synced && Date.now() - t0 < 15_000) await new Promise((r) => setTimeout(r, 50));
  check("WebSocket join + sync through the load balancer", handle.synced, `${Date.now() - t0} ms`);
  ydoc.getText("content").insert(0, text);
  const t1 = Date.now();
  while (handle.unsaved > 0 && Date.now() - t1 < 15_000) await new Promise((r) => setTimeout(r, 50));
  check("edit acknowledged (committed)", handle.unsaved === 0, `${Date.now() - t1} ms`);
  conn.destroy();
  const stored = await req("GET", `/api/documents/${docId}/content`, undefined, owner.cookie);
  check("stored content matches", stored.text === text);
  const evil = new WebSocket(BASE.replace(/^http/, "ws") + "/ws", { headers: { Cookie: owner.cookie, Origin: "https://evil.example" } });
  const evilStatus = await new Promise<number>((resolve) => {
    evil.on("unexpected-response", (_q, res) => resolve(res.statusCode ?? 0));
    evil.on("open", () => resolve(101));
    evil.on("error", () => resolve(-1));
  });
  check("cross-origin WebSocket refused", evilStatus === 403, String(evilStatus));
  writeFileSync(STATE, JSON.stringify({ base: BASE, cookie: owner.cookie, docId, text }));
}

async function verify() {
  const s = JSON.parse(readFileSync(STATE, "utf8")) as { cookie: string; docId: string; text: string };
  const ready = await req("GET", "/health/ready");
  check("GET /health/ready after restart", ready.r.status === 200);
  const me = await req("GET", "/api/me", undefined, s.cookie);
  check("session still valid after restart", me.r.status === 200);
  const stored = await req("GET", `/api/documents/${s.docId}/content`, undefined, s.cookie);
  check("document content survived the restart", stored.text === s.text, stored.text.slice(0, 60));
}

(PHASE === "verify" ? verify() : write())
  .then(() => {
    console.log(failures === 0 ? "SMOKE TEST PASSED" : `SMOKE TEST FAILED (${failures})`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(2);
  });
