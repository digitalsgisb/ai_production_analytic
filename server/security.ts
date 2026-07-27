import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { hash, verify } from "@node-rs/argon2";

export const SESSION_COOKIE = "sugi_session";

export function newId() {
  return randomUUID();
}

export function newToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function hashPassword(password: string) {
  return hash(password, {
    algorithm: 2,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    outputLen: 32,
  });
}

export async function verifyPassword(passwordHash: string, password: string) {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

export function constantTimeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export function requestIp(headers: Record<string, unknown>, fallback?: string) {
  const cloudflareIp = headers["cf-connecting-ip"];
  if (typeof cloudflareIp === "string" && cloudflareIp.length <= 64) return cloudflareIp;
  return fallback?.slice(0, 64) ?? null;
}
