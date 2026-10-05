// Shared E2E setup: a real server (built) with a fresh database.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

import { expect, type BrowserContext, type Page } from "@playwright/test";
import pg from "pg";

const ADMIN = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";

export interface E2EServer {
  base: string;
  stop(): Promise<void>;
}

export async function startE2EServer(): Promise<E2EServer> {
  const port = 18080 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  const dbName = "tandem_e2e_" + randomBytes(4).toString("hex");
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  await c.query(`CREATE DATABASE ${dbName}`);
  await c.end();
  const url = new URL(ADMIN);
  url.pathname = "/" + dbName;
  const server: ChildProcess = spawn("node", ["packages/server/dist/main.js"], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATABASE_URL: url.toString(), STATIC_DIR: "packages/client/dist", LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? "warn" },
    stdio: "inherit",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + "/health/ready")).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base,
    stop: async () => {
      // Graceful shutdown writes and compacts; wait for it before dropping the database.
      const exited = new Promise((r) => server.once("exit", r));
      server.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 25_000))]);
      const a = new pg.Client({ connectionString: ADMIN });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await a.end();
    },
  };
}

export async function registerIn(page: Page, base: string, name: string) {
  await page.goto(base);
  await page.getByRole("button", { name: "No account? Register" }).click();
  const email = `${name.toLowerCase()}_${randomBytes(3).toString("hex")}@example.com`;
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByTestId("current-user")).toHaveText(name);
  return email;
}

export async function typeInEditor(page: Page, text: string) {
  await page.locator(".monaco-editor textarea").first().focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(text);
}

export const editorText = (page: Page) => page.locator(".monaco-editor .view-lines").first();

/** Document text as stored on the server, read with the context's session. */
export async function serverText(ctx: BrowserContext, base: string, workspaceId: string, path: string): Promise<string> {
  const cookie = (await ctx.cookies(base)).map((c) => `${c.name}=${c.value}`).join("; ");
  const w = (await (await fetch(`${base}/api/workspaces/${workspaceId}`, { headers: { Cookie: cookie } })).json()) as { documents: { id: string; path: string }[] };
  const doc = w.documents.find((d) => d.path === path)!;
  return (await fetch(`${base}/api/documents/${doc.id}/content`, { headers: { Cookie: cookie } })).text();
}
