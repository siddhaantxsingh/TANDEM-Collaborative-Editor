// Offline-first behaviour in a real browser: a page reload and a browser
// restart while offline keep unsaved edits (IndexedDB + service-worker app
// shell), the UI says they are not saved yet, and they reach the server
// after reconnecting.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, expect, test } from "@playwright/test";

import { editorText, registerIn, serverText, startE2EServer, typeInEditor, type E2EServer } from "./support";

let srv: E2EServer;
test.beforeAll(async () => {
  srv = await startE2EServer();
});
test.afterAll(async () => {
  await srv.stop();
});

const workspaceIdOf = (url: string) => /#\/w\/([0-9a-f-]{36})/.exec(url)![1]!;

test("reload while offline: edits survive, are shown as unsaved, and are saved after reconnecting", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await registerIn(page, srv.base, "Olivia");
  await page.getByPlaceholder("New workspace name").fill("Offline");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByTestId("new-file").fill("notes.md");
  await page.getByTestId("new-file").press("Enter");
  await expect(page.getByTestId("role")).toHaveText("OWNER"); // editable from here on
  await typeInEditor(page, "online line;");
  await expect(editorText(page)).toContainText("online line;");
  await expect(page.getByTestId("save-status")).toHaveText("All changes saved");
  const wid = workspaceIdOf(page.url());
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null || navigator.serviceWorker.ready.then(() => true));

  await ctx.setOffline(true);
  await expect(page.getByTestId("conn-status")).toHaveText("offline", { timeout: 60_000 });
  await typeInEditor(page, " offline-edit-1;");
  await expect(page.getByTestId("save-status")).toHaveText("Offline — changes kept locally");
  // A real browser asks for confirmation before unloading a page with
  // unsaved changes (beforeunload), which gives IndexedDB time to commit the
  // last keystrokes; page.reload() skips that prompt, so wait explicitly.
  await page.waitForTimeout(500);

  await page.reload(); // still offline: shell from the service worker
  await expect(page.getByRole("status").filter({ hasText: "Started offline" })).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("file-notes.md").click();
  await expect(editorText(page)).toContainText("online line; offline-edit-1;", { timeout: 15_000 });
  await expect(page.getByTestId("save-status")).toHaveText("Offline — changes kept locally");
  expect(await serverText(ctx, srv.base, wid, "notes.md").catch(() => "")).not.toContain("offline-edit-1");

  await ctx.setOffline(false);
  await expect(page.getByTestId("conn-status")).toHaveText("online", { timeout: 30_000 });
  await expect(page.getByTestId("save-status")).toHaveText("All changes saved", { timeout: 15_000 });
  expect(await serverText(ctx, srv.base, wid, "notes.md")).toBe("online line; offline-edit-1;");
  await ctx.close();
});

test("browser restart while offline: edits made before the restart are saved after reconnecting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tandem-profile-"));
  const launch = (offline: boolean) =>
    chromium.launchPersistentContext(dir, { headless: true, offline, executablePath: process.env.CHROMIUM_PATH || undefined });
  let ctx = await launch(false);
  let page = ctx.pages()[0] ?? (await ctx.newPage());
  await registerIn(page, srv.base, "Rafael");
  await page.getByPlaceholder("New workspace name").fill("Restart");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByTestId("new-file").fill("main.go");
  await page.getByTestId("new-file").press("Enter");
  await expect(page.getByTestId("role")).toHaveText("OWNER");
  await typeInEditor(page, "package main;");
  await expect(editorText(page)).toContainText("package main;");
  await expect(page.getByTestId("save-status")).toHaveText("All changes saved");
  const url = page.url();
  const wid = workspaceIdOf(url);
  await page.waitForFunction(() => navigator.serviceWorker.ready.then(() => true));
  await ctx.setOffline(true);
  await expect(page.getByTestId("conn-status")).toHaveText("offline", { timeout: 60_000 });
  await typeInEditor(page, " // before restart");
  await expect(page.getByTestId("save-status")).toHaveText("Offline — changes kept locally");
  await page.waitForTimeout(500); // let IndexedDB finish its write
  await ctx.close(); // the browser goes away

  ctx = await launch(true); // starts without network
  page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(url);
  await page.getByTestId("file-main.go").click({ timeout: 15_000 });
  await expect(editorText(page)).toContainText("package main; // before restart", { timeout: 15_000 });
  await expect(page.getByTestId("save-status")).toHaveText("Offline — changes kept locally");
  await ctx.setOffline(false);
  await expect(page.getByTestId("save-status")).toHaveText("All changes saved", { timeout: 30_000 });
  expect(await serverText(ctx, srv.base, wid, "main.go")).toBe("package main; // before restart");
  await ctx.close();
  rmSync(dir, { recursive: true, force: true });
});
