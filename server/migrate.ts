import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.js";
import { createPool, type DatabasePool } from "./db.js";

export async function runMigrations(pool: DatabasePool, migrationsDir: string) {
  const absolute = path.resolve(migrationsDir);
  const files = (await readdir(absolute)).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = await readFile(path.join(absolute, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(735_117_042)");
      await client.query(sql);
      await client.query("COMMIT");
      console.info(JSON.stringify({ event: "migration_applied", migration: file }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  const config = loadConfig();
  const pool = createPool(config);
  runMigrations(pool, config.migrationsDir)
    .then(() => pool.end())
    .catch(async (error) => {
      console.error(error);
      await pool.end();
      process.exitCode = 1;
    });
}
