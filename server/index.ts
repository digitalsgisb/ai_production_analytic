import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { createLangflowAdapter } from "./langflow.js";
import { runMigrations } from "./migrate.js";

const config = loadConfig();
const pool = createPool(config);
await runMigrations(pool, config.migrationsDir);
const app = createApp({ config, pool, langflow: createLangflowAdapter(config) });

const server = app.listen(config.port, "0.0.0.0", () => {
  console.info(JSON.stringify({ event: "server_started", port: config.port, mode: config.langflowMock ? "mock" : "langflow" }));
});

async function shutdown(signal: string) {
  console.info(JSON.stringify({ event: "shutdown", signal }));
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
