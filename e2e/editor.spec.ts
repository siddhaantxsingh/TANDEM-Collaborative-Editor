// End-to-end: two browser users editing the same file in real time, presence,
// offline editing in one browser, and read-only enforcement for a viewer.
// Starts a real server (built) with a fresh database.
import { expect, test, type Browser } from "@playwright/test";

import { editorText, registerIn, startE2EServer, type E2EServer } from "./support";

let srv: E2EServer;
let BASE = "";
test.beforeAll(async () => {
  srv = await startE2EServer();
  BASE = srv.base;
});
test.afterAll(async () => {
  await srv.stop();
});

async function register(browser: Browser, name: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const email = await registerIn(page, BASE, name);
  return { ctx, page, email };
}

async function typeInEditor(page: import("@playwright/test").Page, text: string) {
  await page.locator(".monaco-editor textarea").first().focus();
  await page.keyboard.type(text);
}

test("two users collaborate in real time, offline edits merge, viewers are read-only", async ({ browser }) => {
  const alice = await register(browser, "Alice");
  const bob = await register(browser, "Bob");
  const carol = await register(browser, "Carol");

  // Alice creates a workspace and a file, invites Bob (editor) and Carol (viewer).
  await alice.page.getByPlaceholder("New workspace name").fill("Team");
  await alice.page.getByRole("button", { name: "Create" }).click();
  await alice.page.getByTestId("new-file").fill("src/main.ts");
  await alice.page.getByTestId("new-file").press("Enter");
  await expect(alice.page.getByTestId("role")).toHaveText("OWNER");
  const wsUrl = alice.page.url();
  for (const [who, role] of [[bob, "EDITOR"], [carol, "VIEWER"]] as const) {
    await alice.page.getByPlaceholder("email").fill(who.email);
    await alice.page.locator("aside form select").last().selectOption(role);
    await alice.page.getByRole("button", { name: "Add" }).click();
    await expect(alice.page.locator(".members")).toContainText(role === "EDITOR" ? "Bob" : "Carol");
  }

  await bob.page.goto(wsUrl);
  await bob.page.getByTestId("file-src/main.ts").click();
  await expect(bob.page.getByTestId("role")).toHaveText("EDITOR");

  await typeInEditor(alice.page, "const a = 1;");
  await expect(editorText(bob.page)).toContainText("const a = 1;");
  await expect(bob.page.getByTestId("presence").locator(".avatar")).toHaveCount(1);
  await expect(alice.page.getByTestId("save-status")).toHaveText("All changes saved");

  // Bob goes offline, keeps typing; Alice keeps typing too.
  await bob.ctx.setOffline(true);
  await expect(bob.page.getByTestId("conn-status")).toHaveText("offline", { timeout: 60_000 });
  await bob.page.locator(".monaco-editor textarea").first().focus();
  await bob.page.keyboard.press("Control+End");
  await bob.page.keyboard.type(" // bob offline");
  await expect(bob.page.getByTestId("save-status")).toHaveText("Offline — changes kept locally");
  await alice.page.keyboard.press("Control+Home");
  await alice.page.keyboard.type("// alice ");
  await bob.ctx.setOffline(false);
  await expect(bob.page.getByTestId("conn-status")).toHaveText("online", { timeout: 30_000 });
  await expect(editorText(alice.page)).toContainText("bob offline", { timeout: 15_000 });
  await expect(editorText(bob.page)).toContainText("// alice", { timeout: 15_000 });
  await expect(bob.page.getByTestId("save-status")).toHaveText("All changes saved");

  // Carol (viewer) sees the text but cannot change it.
  await carol.page.goto(wsUrl);
  await carol.page.getByTestId("file-src/main.ts").click();
  await expect(carol.page.getByTestId("role")).toHaveText("VIEWER (read-only)");
  await expect(editorText(carol.page)).toContainText("bob offline");
  await typeInEditor(carol.page, "VIEWER WAS HERE");
  await carol.page.waitForTimeout(500);
  await expect(editorText(alice.page)).not.toContainText("VIEWER WAS HERE");
  await expect(carol.page.getByRole("button", { name: /Run/ })).toBeDisabled();
});
