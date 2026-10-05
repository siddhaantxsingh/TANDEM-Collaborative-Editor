import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const cfg = loadConfig();
const app = await createApp(cfg);
const port = await app.listen();
app.log.info("listening", { port, redis: Boolean(cfg.redisUrl), node: cfg.nodeId });

let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    app.log.info("shutting down", { signal: sig });
    const force = setTimeout(() => {
      app.log.error("shutdown timed out");
      process.exit(1);
    }, 20_000);
    force.unref();
    app
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        app.log.error("shutdown failed", { err: (err as Error).message });
        process.exit(1);
      });
  });
}
