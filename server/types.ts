import type { Request } from "express";

export type UserRole = "admin" | "user";

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  mustChangePassword: boolean;
  csrfToken: string;
  sessionId: string;
}

export interface AuthenticatedRequest extends Request {
  auth?: AuthUser;
}

export type ClientEvent =
  | { type: "status"; label: string; state: "queued" | "running"; elapsedMs?: number }
  | { type: "token"; delta: string }
  | { type: "trace"; label: string; state: "running" | "complete" | "error"; durationMs?: number }
  | { type: "complete"; messageId: string; content: string }
  | { type: "cancelled" }
  | { type: "error"; code: string; message: string; retryable: boolean };
