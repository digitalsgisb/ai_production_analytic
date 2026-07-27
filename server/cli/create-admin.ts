import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { loadConfig } from "../config.js";
import { createPool } from "../db.js";
import { runMigrations } from "../migrate.js";
import { hashPassword, newId, normalizeEmail } from "../security.js";

const config = loadConfig();
const pool = createPool(config);
await runMigrations(pool, config.migrationsDir);
const rl = createInterface({ input: stdin, output: stdout });

async function hiddenQuestion(prompt: string) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return rl.question(prompt);
  rl.pause();
  stdout.write(prompt);
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const previousRaw = stdin.isRaw;
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(previousRaw);
      rl.resume();
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          stdout.write("\n");
          reject(new Error("Cancelled"));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (byte === 8 || byte === 127) {
          if (value.length) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        const character = Buffer.from([byte]).toString("utf8");
        if (character >= " ") {
          value += character;
          stdout.write("*");
        }
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

try {
  const email = normalizeEmail(await rl.question("Administrator email: "));
  const displayName = (await rl.question("Display name: ")).trim();
  const password = await hiddenQuestion("Temporary password (12+ characters): ");
  if (!email.includes("@") || displayName.length < 2 || password.length < 12) {
    throw new Error("Email, display name, or password is invalid.");
  }
  await pool.query(
    `INSERT INTO assistant.users (id, email, display_name, password_hash, role, must_change_password)
     VALUES ($1, $2, $3, $4, 'admin', TRUE)`,
    [newId(), email, displayName, await hashPassword(password)],
  );
  stdout.write("Administrator created. A password change will be required at first sign-in.\n");
} finally {
  rl.close();
  await pool.end();
}
