import path from "node:path";
import { existsSync } from "node:fs";

import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { z, ZodError } from "zod";

import { createAuthMiddleware, requireAdmin, requireCsrf, requirePasswordChanged, sessionCookieOptions } from "./auth.js";
import { writeAudit } from "./audit.js";
import type { Config } from "./config.js";
import type { DatabasePool } from "./db.js";
import { LangflowError, mapAgUiEvent, type LangflowAdapter } from "./langflow.js";
import {
  hashPassword,
  newId,
  newToken,
  normalizeEmail,
  requestIp,
  SESSION_COOKIE,
  tokenHash,
  verifyPassword,
} from "./security.js";
import type { AuthenticatedRequest, ClientEvent } from "./types.js";

const loginSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(256) });
const passwordSchema = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(12).max(256) });
const conversationSchema = z.object({ title: z.string().trim().min(1).max(120).optional() });
const runSchema = z.object({ content: z.string().trim().min(1).max(10_000) });
const adminUserSchema = z.object({
  email: z.string().email().max(254),
  displayName: z.string().trim().min(2).max(100),
  temporaryPassword: z.string().min(12).max(256),
  role: z.enum(["admin", "user"]).default("user"),
});
const adminPatchSchema = z.object({
  active: z.boolean().optional(),
  temporaryPassword: z.string().min(12).max(256).optional(),
}).refine((body) => body.active !== undefined || body.temporaryPassword !== undefined);

function userJson(auth: NonNullable<AuthenticatedRequest["auth"]>) {
  return {
    id: auth.id,
    email: auth.email,
    displayName: auth.displayName,
    role: auth.role,
    mustChangePassword: auth.mustChangePassword,
    csrfToken: auth.csrfToken,
  };
}

function safeErrorMessage(code: string) {
  if (code.includes("cancel")) return "The response was cancelled.";
  if (code.includes("timeout")) return "The analysis took too long. Please try again.";
  return "Sugi Prod Analytic could not complete this request. Please try again.";
}

export function createApp({ config, pool, langflow }: { config: Config; pool: DatabasePool; langflow: LangflowAdapter }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(express.json({ limit: "64kb" }));
  app.use(cookieParser());

  app.use((request, response, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return next();
    const origin = request.get("origin");
    if (origin && origin !== config.publicOrigin) {
      return response.status(403).json({ error: "origin_not_allowed" });
    }
    next();
  });

  app.get("/health/live", (_request, response) => response.json({ status: "ok" }));
  app.get("/health/ready", async (_request, response) => {
    try {
      await pool.query("SELECT 1");
      response.json({ status: "ready" });
    } catch {
      response.status(503).json({ status: "unavailable" });
    }
  });

  const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false });
  app.post("/api/auth/login", loginLimiter, async (request, response, next) => {
    try {
      const body = loginSchema.parse(request.body);
      const email = normalizeEmail(body.email);
      const result = await pool.query<{
        id: string; email: string; display_name: string; password_hash: string; role: "admin" | "user";
        active: boolean; must_change_password: boolean; failed_login_count: number; locked_until: Date | null;
      }>("SELECT * FROM assistant.users WHERE email = $1", [email]);
      const row = result.rows[0];
      const valid = row?.active && (!row.locked_until || row.locked_until.getTime() <= Date.now())
        ? await verifyPassword(row.password_hash, body.password)
        : false;
      if (!valid) {
        if (row) {
          await pool.query(
            `UPDATE assistant.users
                SET failed_login_count = failed_login_count + 1,
                    locked_until = CASE WHEN failed_login_count + 1 >= 5 THEN NOW() + INTERVAL '15 minutes' ELSE locked_until END,
                    updated_at = NOW()
              WHERE id = $1`,
            [row.id],
          );
        }
        return response.status(401).json({ error: "invalid_credentials" });
      }

      const rawToken = newToken();
      const csrfToken = newToken();
      const sessionId = newId();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO assistant.auth_sessions
             (id, user_id, token_hash, csrf_token, expires_at, ip_address, user_agent)
           VALUES ($1, $2, $3, $4, NOW() + ($5 || ' hours')::INTERVAL, $6, $7)`,
          [sessionId, row.id, tokenHash(rawToken), csrfToken, config.sessionTtlHours, requestIp(request.headers, request.ip), request.get("user-agent")?.slice(0, 300) ?? null],
        );
        await client.query(
          "UPDATE assistant.users SET failed_login_count = 0, locked_until = NULL, last_login_at = NOW(), updated_at = NOW() WHERE id = $1",
          [row.id],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      response.cookie(SESSION_COOKIE, rawToken, sessionCookieOptions(config));
      return response.json({
        user: {
          id: row.id, email: row.email, displayName: row.display_name, role: row.role,
          mustChangePassword: row.must_change_password, csrfToken,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  const authenticate = createAuthMiddleware(pool);
  app.use("/api", authenticate);
  app.use("/api", requireCsrf);

  app.get("/api/auth/me", (request: AuthenticatedRequest, response) => response.json({ user: userJson(request.auth!) }));

  app.post("/api/auth/logout", async (request: AuthenticatedRequest, response, next) => {
    try {
      await pool.query("DELETE FROM assistant.auth_sessions WHERE id = $1", [request.auth!.sessionId]);
      const { maxAge: _maxAge, ...clearOptions } = sessionCookieOptions(config);
      response.clearCookie(SESSION_COOKIE, clearOptions);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/change-password", async (request: AuthenticatedRequest, response, next) => {
    try {
      const body = passwordSchema.parse(request.body);
      const result = await pool.query<{ password_hash: string }>("SELECT password_hash FROM assistant.users WHERE id = $1", [request.auth!.id]);
      if (!result.rowCount || !(await verifyPassword(result.rows[0].password_hash, body.currentPassword))) {
        return response.status(400).json({ error: "current_password_invalid" });
      }
      await pool.query(
        "UPDATE assistant.users SET password_hash = $1, must_change_password = FALSE, updated_at = NOW() WHERE id = $2",
        [await hashPassword(body.newPassword), request.auth!.id],
      );
      await writeAudit(pool, { actorUserId: request.auth!.id, action: "password.changed", targetType: "user", targetId: request.auth!.id, ipAddress: requestIp(request.headers, request.ip) });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.use("/api/conversations", requirePasswordChanged);
  app.use("/api/runs", requirePasswordChanged);

  app.get("/api/conversations", async (request: AuthenticatedRequest, response, next) => {
    try {
      const result = await pool.query(
        `SELECT id, title, created_at AS "createdAt", updated_at AS "updatedAt"
           FROM assistant.conversations WHERE owner_id = $1 ORDER BY updated_at DESC`,
        [request.auth!.id],
      );
      response.json({ conversations: result.rows });
    } catch (error) { next(error); }
  });

  app.post("/api/conversations", async (request: AuthenticatedRequest, response, next) => {
    try {
      const body = conversationSchema.parse(request.body ?? {});
      const id = newId();
      const result = await pool.query(
        `INSERT INTO assistant.conversations (id, owner_id, title, langflow_session_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id, title, created_at AS "createdAt", updated_at AS "updatedAt"`,
        [id, request.auth!.id, body.title ?? "New conversation", `sugi-${id}`],
      );
      response.status(201).json({ conversation: result.rows[0] });
    } catch (error) { next(error); }
  });

  app.patch("/api/conversations/:id", async (request: AuthenticatedRequest, response, next) => {
    try {
      const body = conversationSchema.required().parse(request.body);
      const result = await pool.query(
        `UPDATE assistant.conversations SET title = $1, updated_at = NOW()
          WHERE id = $2 AND owner_id = $3
          RETURNING id, title, created_at AS "createdAt", updated_at AS "updatedAt"`,
        [body.title, request.params.id, request.auth!.id],
      );
      if (!result.rowCount) return response.status(404).json({ error: "conversation_not_found" });
      response.json({ conversation: result.rows[0] });
    } catch (error) { next(error); }
  });

  app.delete("/api/conversations/:id", async (request: AuthenticatedRequest, response, next) => {
    try {
      const result = await pool.query("DELETE FROM assistant.conversations WHERE id = $1 AND owner_id = $2 RETURNING id", [request.params.id, request.auth!.id]);
      if (!result.rowCount) return response.status(404).json({ error: "conversation_not_found" });
      response.status(204).end();
    } catch (error) { next(error); }
  });

  app.get("/api/conversations/:id/messages", async (request: AuthenticatedRequest, response, next) => {
    try {
      const result = await pool.query(
        `SELECT m.id, m.role, m.content, m.status, m.created_at AS "createdAt",
                (SELECT r.id FROM assistant.runs r WHERE r.assistant_message_id = m.id ORDER BY r.started_at DESC LIMIT 1) AS "runId"
           FROM assistant.messages m
           JOIN assistant.conversations c ON c.id = m.conversation_id
          WHERE c.id = $1 AND c.owner_id = $2
          ORDER BY m.created_at, m.id`,
        [request.params.id, request.auth!.id],
      );
      response.json({ messages: result.rows });
    } catch (error) { next(error); }
  });

  const chatLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });
  app.post("/api/conversations/:id/runs", chatLimiter, async (request: AuthenticatedRequest, response, next) => {
    try {
      const body = runSchema.parse(request.body);
      const conversationResult = await pool.query<{ id: string; title: string; langflow_session_id: string }>(
        "SELECT id, title, langflow_session_id FROM assistant.conversations WHERE id = $1 AND owner_id = $2",
        [request.params.id, request.auth!.id],
      );
      if (!conversationResult.rowCount) return response.status(404).json({ error: "conversation_not_found" });
      const conversation = conversationResult.rows[0];
      const active = await pool.query("SELECT 1 FROM assistant.runs WHERE conversation_id = $1 AND status IN ('starting', 'queued', 'running')", [conversation.id]);
      if (active.rowCount) return response.status(409).json({ error: "run_already_active" });

      const runId = newId();
      const userMessageId = newId();
      const assistantMessageId = newId();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO assistant.messages (id, conversation_id, role, content, status, completed_at)
           VALUES ($1, $2, 'user', $3, 'complete', NOW()), ($4, $2, 'assistant', '', 'streaming', NULL)`,
          [userMessageId, conversation.id, body.content, assistantMessageId],
        );
        await client.query(
          `INSERT INTO assistant.runs (id, conversation_id, user_message_id, assistant_message_id, status)
           VALUES ($1, $2, $3, $4, 'starting')`,
          [runId, conversation.id, userMessageId, assistantMessageId],
        );
        const suggestedTitle = body.content.replace(/\s+/g, " ").slice(0, 58);
        await client.query(
          `UPDATE assistant.conversations
              SET title = CASE WHEN title = 'New conversation' THEN $1 ELSE title END, updated_at = NOW()
            WHERE id = $2`,
          [suggestedTitle, conversation.id],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }

      try {
        const job = await langflow.start(conversation.langflow_session_id, body.content);
        await pool.query("UPDATE assistant.runs SET langflow_job_id = $1, status = 'queued' WHERE id = $2", [job.jobId, runId]);
        response.status(202).json({ runId, userMessageId, assistantMessageId });
      } catch (error) {
        await pool.query("UPDATE assistant.runs SET status = 'failed', error_code = 'langflow_start_failed', completed_at = NOW() WHERE id = $1", [runId]);
        await pool.query("UPDATE assistant.messages SET status = 'error', content = $1, completed_at = NOW() WHERE id = $2", [safeErrorMessage("start"), assistantMessageId]);
        throw error;
      }
    } catch (error) { next(error); }
  });

  app.get("/api/runs/:id/events", async (request: AuthenticatedRequest, response, next) => {
    const runResult = await pool.query<{
      id: string; status: string; langflow_job_id: string | null; last_event_id: string | null;
      assistant_message_id: string; content: string;
    }>(
      `SELECT r.id, r.status, r.langflow_job_id, r.last_event_id, r.assistant_message_id, m.content
         FROM assistant.runs r
         JOIN assistant.conversations c ON c.id = r.conversation_id
         JOIN assistant.messages m ON m.id = r.assistant_message_id
        WHERE r.id = $1 AND c.owner_id = $2`,
      [request.params.id, request.auth!.id],
    );
    if (!runResult.rowCount) return response.status(404).json({ error: "run_not_found" });
    const run = runResult.rows[0];
    response.status(200);
    response.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    const send = (event: ClientEvent, id?: string) => {
      if (id) response.write(`id: ${id}\n`);
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    if (run.status === "completed") {
      send({ type: "complete", messageId: run.assistant_message_id, content: run.content }, run.last_event_id ?? undefined);
      return response.end();
    }
    if (run.status === "cancelled") {
      send({ type: "cancelled" }, run.last_event_id ?? undefined);
      return response.end();
    }
    if (["failed", "timed_out"].includes(run.status)) {
      send({ type: "error", code: run.status, message: safeErrorMessage(run.status), retryable: true }, run.last_event_id ?? undefined);
      return response.end();
    }
    if (!run.langflow_job_id) {
      send({ type: "error", code: "run_not_ready", message: "The workflow did not start correctly.", retryable: true });
      return response.end();
    }

    const controller = new AbortController();
    request.on("close", () => controller.abort());
    const requestedLastId = request.get("last-event-id") ?? null;
    const resumeFrom = run.last_event_id ?? requestedLastId;
    let finished = false;
    try {
      await pool.query("UPDATE assistant.runs SET status = 'running' WHERE id = $1 AND status = 'queued'", [run.id]);
      for await (const frame of langflow.events(run.langflow_job_id, resumeFrom, controller.signal)) {
        if (controller.signal.aborted) return;
        const raw = frame.data as Record<string, unknown> | null;
        const rawType = raw && typeof raw === "object" ? String(raw.type ?? raw.event ?? "").toUpperCase() : "";
        const mapped = mapAgUiEvent(frame.data);
        for (const event of mapped) {
          if (event.type === "token") {
            const client = await pool.connect();
            try {
              await client.query("BEGIN");
              await client.query("UPDATE assistant.messages SET content = content || $1 WHERE id = $2", [event.delta, run.assistant_message_id]);
              if (frame.id) await client.query("UPDATE assistant.runs SET last_event_id = $1 WHERE id = $2", [frame.id, run.id]);
              await client.query("COMMIT");
            } catch (error) {
              await client.query("ROLLBACK");
              throw error;
            } finally { client.release(); }
          } else if (event.type === "trace") {
            if (event.state === "running") {
              await pool.query(
                `INSERT INTO assistant.run_steps (id, run_id, ordinal, kind, label, state)
                 VALUES ($1, $2, COALESCE((SELECT MAX(ordinal) + 1 FROM assistant.run_steps WHERE run_id = $2), 1), 'component', $3, 'running')
                 ON CONFLICT DO NOTHING`,
                [newId(), run.id, event.label],
              );
            } else {
              const updated = await pool.query<{ duration_ms: number }>(
                `UPDATE assistant.run_steps
                    SET state = $1, completed_at = NOW(), duration_ms = GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::INTEGER
                  WHERE id = (SELECT id FROM assistant.run_steps WHERE run_id = $2 AND label = $3 AND state = 'running' ORDER BY ordinal DESC LIMIT 1)
                  RETURNING duration_ms`,
                [event.state, run.id, event.label],
              );
              if (updated.rowCount) event.durationMs = updated.rows[0].duration_ms;
            }
          } else if (event.type === "cancelled") {
            await pool.query("UPDATE assistant.runs SET status = 'cancelled', completed_at = NOW() WHERE id = $1", [run.id]);
            await pool.query("UPDATE assistant.messages SET status = 'cancelled', completed_at = NOW() WHERE id = $1", [run.assistant_message_id]);
            finished = true;
          } else if (event.type === "error") {
            await pool.query("UPDATE assistant.runs SET status = 'failed', error_code = $1, completed_at = NOW() WHERE id = $2", [event.code, run.id]);
            await pool.query("UPDATE assistant.messages SET status = 'error', content = CASE WHEN content = '' THEN $1 ELSE content END, completed_at = NOW() WHERE id = $2", [event.message, run.assistant_message_id]);
            finished = true;
          }
          if (frame.id && event.type !== "token") await pool.query("UPDATE assistant.runs SET last_event_id = $1 WHERE id = $2", [frame.id, run.id]);
          send(event, frame.id);
        }

        if (rawType === "RUN_FINISHED") {
          const status = await langflow.status(run.langflow_job_id);
          const content = status.output?.text;
          if (typeof content !== "string") throw new LangflowError("langflow_missing_output", 502);
          await pool.query("UPDATE assistant.messages SET content = $1, status = 'complete', completed_at = NOW() WHERE id = $2", [content, run.assistant_message_id]);
          await pool.query("UPDATE assistant.runs SET status = 'completed', last_event_id = COALESCE($1, last_event_id), completed_at = NOW() WHERE id = $2", [frame.id ?? null, run.id]);
          await pool.query("UPDATE assistant.conversations SET updated_at = NOW() WHERE id = (SELECT conversation_id FROM assistant.runs WHERE id = $1)", [run.id]);
          send({ type: "complete", messageId: run.assistant_message_id, content }, frame.id);
          finished = true;
          break;
        }
        if (finished) break;
      }
      if (!finished && !controller.signal.aborted) {
        const status = await langflow.status(run.langflow_job_id);
        if (status.status === "completed" && typeof status.output?.text === "string") {
          await pool.query("UPDATE assistant.messages SET content = $1, status = 'complete', completed_at = NOW() WHERE id = $2", [status.output.text, run.assistant_message_id]);
          await pool.query("UPDATE assistant.runs SET status = 'completed', completed_at = NOW() WHERE id = $1", [run.id]);
          send({ type: "complete", messageId: run.assistant_message_id, content: status.output.text });
        }
      }
      response.end();
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = error instanceof LangflowError ? error.code : "stream_failed";
      await pool.query("UPDATE assistant.runs SET status = 'failed', error_code = $1, completed_at = NOW() WHERE id = $2", [code, run.id]).catch(() => undefined);
      await pool.query("UPDATE assistant.messages SET status = 'error', content = CASE WHEN content = '' THEN $1 ELSE content END, completed_at = NOW() WHERE id = $2", [safeErrorMessage(code), run.assistant_message_id]).catch(() => undefined);
      send({ type: "error", code, message: safeErrorMessage(code), retryable: true });
      response.end();
    }
  });

  app.post("/api/runs/:id/cancel", async (request: AuthenticatedRequest, response, next) => {
    try {
      const result = await pool.query<{ job_id: string; assistant_message_id: string }>(
        `SELECT r.langflow_job_id AS job_id, r.assistant_message_id
           FROM assistant.runs r JOIN assistant.conversations c ON c.id = r.conversation_id
          WHERE r.id = $1 AND c.owner_id = $2 AND r.status IN ('starting', 'queued', 'running')`,
        [request.params.id, request.auth!.id],
      );
      if (!result.rowCount) return response.status(404).json({ error: "active_run_not_found" });
      if (result.rows[0].job_id) await langflow.cancel(result.rows[0].job_id);
      await pool.query("UPDATE assistant.runs SET status = 'cancelled', completed_at = NOW() WHERE id = $1", [request.params.id]);
      await pool.query("UPDATE assistant.messages SET status = 'cancelled', completed_at = NOW() WHERE id = $1", [result.rows[0].assistant_message_id]);
      response.status(202).json({ status: "cancelled" });
    } catch (error) { next(error); }
  });

  app.get("/api/admin/users", requireAdmin, async (_request, response, next) => {
    try {
      const result = await pool.query(
        `SELECT id, email, display_name AS "displayName", role, active,
                must_change_password AS "mustChangePassword", created_at AS "createdAt", last_login_at AS "lastLoginAt"
           FROM assistant.users ORDER BY created_at DESC`,
      );
      response.json({ users: result.rows });
    } catch (error) { next(error); }
  });

  app.post("/api/admin/users", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const body = adminUserSchema.parse(request.body);
      const id = newId();
      const result = await pool.query(
        `INSERT INTO assistant.users (id, email, display_name, password_hash, role, must_change_password)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         RETURNING id, email, display_name AS "displayName", role, active, must_change_password AS "mustChangePassword", created_at AS "createdAt"`,
        [id, normalizeEmail(body.email), body.displayName, await hashPassword(body.temporaryPassword), body.role],
      );
      await writeAudit(pool, { actorUserId: request.auth!.id, action: "user.created", targetType: "user", targetId: id, metadata: { role: body.role }, ipAddress: requestIp(request.headers, request.ip) });
      response.status(201).json({ user: result.rows[0] });
    } catch (error) { next(error); }
  });

  app.patch("/api/admin/users/:id", requireAdmin, async (request: AuthenticatedRequest, response, next) => {
    try {
      const body = adminPatchSchema.parse(request.body);
      if (request.params.id === request.auth!.id && body.active === false) {
        return response.status(400).json({ error: "cannot_deactivate_self" });
      }
      const passwordHash = body.temporaryPassword ? await hashPassword(body.temporaryPassword) : null;
      const result = await pool.query(
        `UPDATE assistant.users
            SET active = COALESCE($1, active),
                password_hash = COALESCE($2, password_hash),
                must_change_password = CASE WHEN $2::TEXT IS NULL THEN must_change_password ELSE TRUE END,
                failed_login_count = CASE WHEN $2::TEXT IS NULL THEN failed_login_count ELSE 0 END,
                locked_until = CASE WHEN $2::TEXT IS NULL THEN locked_until ELSE NULL END,
                updated_at = NOW()
          WHERE id = $3
          RETURNING id, email, display_name AS "displayName", role, active, must_change_password AS "mustChangePassword"`,
        [body.active ?? null, passwordHash, request.params.id],
      );
      if (!result.rowCount) return response.status(404).json({ error: "user_not_found" });
      if (body.active === false) await pool.query("DELETE FROM assistant.auth_sessions WHERE user_id = $1", [request.params.id]);
      await writeAudit(pool, { actorUserId: request.auth!.id, action: body.temporaryPassword ? "user.password_reset" : "user.status_changed", targetType: "user", targetId: String(request.params.id), metadata: body.active === undefined ? {} : { active: body.active }, ipAddress: requestIp(request.headers, request.ip) });
      response.json({ user: result.rows[0] });
    } catch (error) { next(error); }
  });

  const staticDir = path.resolve("dist/client");
  if (existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: false, maxAge: config.nodeEnv === "production" ? "1h" : 0 }));
    app.get("/{*path}", (_request, response) => response.sendFile(path.join(staticDir, "index.html")));
  }

  app.use((_request, response) => response.status(404).json({ error: "not_found" }));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ZodError) return response.status(400).json({ error: "validation_failed", issues: error.issues });
    if (error instanceof LangflowError) return response.status(502).json({ error: error.code, message: safeErrorMessage(error.code) });
    const pgError = error as { code?: string };
    if (pgError?.code === "23505") return response.status(409).json({ error: "already_exists" });
    console.error(JSON.stringify({ event: "request_failed", error: error instanceof Error ? error.name : "unknown" }));
    response.status(500).json({ error: "internal_error", message: "The server could not process this request." });
  });

  return app;
}
