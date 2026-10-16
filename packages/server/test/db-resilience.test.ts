// A PostgreSQL connection that dies while the server holds it checked out
// from the pool (between the statements of a transaction, as compaction and
// membership changes do) must not crash the server process. node-postgres
// emits 'error' on such a client, and the pool only listens on idle ones;
// an unhandled 'error' event terminates Node. Found by tools/crash-ack.ts
// (PostgreSQL SIGKILL while a server node was running).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ADMIN_URL, createTestDatabase, sleep, startServer, type TestServer } from "./helpers.js";

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

describe("database connection loss", () => {
  it("a checked-out pool client whose backend is killed does not crash the server", async () => {
    const errors: unknown[] = [];
    const onUncaught = (e: unknown) => errors.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      const client = await s.app.db.connect();
      const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
      const admin = new pg.Client({ connectionString: ADMIN_URL });
      await admin.connect();
      await admin.query("SELECT pg_terminate_backend($1)", [pid]);
      await admin.end();
      await sleep(500);
      client.release(true);
      expect(errors).toEqual([]);
      // The pool replaces the connection; the server keeps working.
      expect((await fetch(s.base + "/health/ready")).status).toBe(200);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});
