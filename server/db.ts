import pg from "pg";

import type { Config } from "./config.js";

const { Pool } = pg;

export function createPool(config: Config) {
  return new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export type DatabasePool = ReturnType<typeof createPool>;
