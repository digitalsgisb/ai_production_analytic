import type { NextFunction, Response } from "express";

import type { Config } from "./config.js";
import type { DatabasePool } from "./db.js";
import { constantTimeEqual, SESSION_COOKIE, tokenHash } from "./security.js";
import type { AuthenticatedRequest, AuthUser } from "./types.js";

export function createAuthMiddleware(pool: DatabasePool) {
  return async (request: AuthenticatedRequest, response: Response, next: NextFunction) => {
    const rawToken = request.cookies?.[SESSION_COOKIE];
    if (typeof rawToken !== "string") {
      return response.status(401).json({ error: "authentication_required" });
    }

    try {
      const result = await pool.query<{
        session_id: string;
        csrf_token: string;
        id: string;
        email: string;
        display_name: string;
        role: "admin" | "user";
        must_change_password: boolean;
      }>(
        `SELECT s.id AS session_id, s.csrf_token, u.id, u.email, u.display_name,
                u.role, u.must_change_password
           FROM assistant.auth_sessions s
           JOIN assistant.users u ON u.id = s.user_id
          WHERE s.token_hash = $1
            AND s.expires_at > NOW()
            AND u.active = TRUE`,
        [tokenHash(rawToken)],
      );
      if (!result.rowCount) {
        response.clearCookie(SESSION_COOKIE);
        return response.status(401).json({ error: "session_expired" });
      }
      const row = result.rows[0];
      request.auth = {
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
        mustChangePassword: row.must_change_password,
        csrfToken: row.csrf_token,
        sessionId: row.session_id,
      } satisfies AuthUser;
      void pool.query("UPDATE assistant.auth_sessions SET last_seen_at = NOW() WHERE id = $1", [row.session_id]);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireCsrf(request: AuthenticatedRequest, response: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return next();
  const provided = request.get("x-csrf-token") ?? "";
  if (!request.auth || !constantTimeEqual(provided, request.auth.csrfToken)) {
    return response.status(403).json({ error: "csrf_validation_failed" });
  }
  next();
}

export function requireAdmin(request: AuthenticatedRequest, response: Response, next: NextFunction) {
  if (request.auth?.role !== "admin") return response.status(403).json({ error: "admin_required" });
  next();
}

export function requirePasswordChanged(request: AuthenticatedRequest, response: Response, next: NextFunction) {
  if (request.auth?.mustChangePassword) {
    return response.status(403).json({ error: "password_change_required" });
  }
  next();
}

export function sessionCookieOptions(config: Config) {
  return {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax" as const,
    path: "/",
    maxAge: config.sessionTtlHours * 60 * 60 * 1000,
  };
}
