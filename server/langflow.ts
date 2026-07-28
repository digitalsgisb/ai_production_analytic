import { setTimeout as delay } from "node:timers/promises";

import type { Config } from "./config.js";
import type { ClientEvent } from "./types.js";

export interface RawSseFrame {
  id?: string;
  data: unknown;
}

export interface WorkflowStatus {
  status: string;
  output?: { text?: string | null };
}

export function buildWorkflowStartBody(
  config: Pick<Config, "langflowFlowId" | "langflowInputComponentId">,
  sessionId: string,
  input: string,
) {
  if (config.langflowInputComponentId) {
    const component = config.langflowInputComponentId;
    return {
      flow_id: config.langflowFlowId,
      background: true,
      stream: false,
      inputs: {
        [`${component}.input_value`]: input,
        [`${component}.session_id`]: sessionId,
      },
    };
  }
  return {
    flow_id: config.langflowFlowId,
    input_value: input,
    session_id: sessionId,
    mode: "background",
    stream_protocol: "agui",
  };
}

export interface LangflowAdapter {
  start(sessionId: string, input: string): Promise<{ jobId: string }>;
  events(jobId: string, lastEventId?: string | null, signal?: AbortSignal): AsyncGenerator<RawSseFrame>;
  status(jobId: string): Promise<WorkflowStatus>;
  cancel(jobId: string): Promise<void>;
}

async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        let id: string | undefined;
        const dataLines: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("id:")) id = line.slice(3).trim();
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
        if (!dataLines.length) continue;
        const raw = dataLines.join("\n");
        let data: unknown = raw;
        try {
          data = JSON.parse(raw);
        } catch {
          // Preserve non-JSON control frames without exposing them to clients.
        }
        yield { id, data } satisfies RawSseFrame;
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

class HttpLangflowAdapter implements LangflowAdapter {
  constructor(private readonly config: Config) {}

  private headers(extra: HeadersInit = {}) {
    return {
      "content-type": "application/json",
      "x-api-key": this.config.langflowApiKey,
      ...extra,
    };
  }

  async start(sessionId: string, input: string) {
    const response = await fetch(`${this.config.langflowBaseUrl}/api/v2/workflows`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(buildWorkflowStartBody(this.config, sessionId, input)),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new LangflowError("langflow_start_failed", response.status);
    const body = (await response.json()) as { job_id?: string };
    if (!body.job_id) throw new LangflowError("langflow_invalid_response", 502);
    return { jobId: body.job_id };
  }

  async *events(jobId: string, lastEventId?: string | null, signal?: AbortSignal) {
    if (this.config.langflowInputComponentId) {
      yield { id: lastEventId ? undefined : "0", data: { type: "RUN_STARTED" } };
      const deadline = Date.now() + this.config.langflowTimeoutMs;
      while (!signal?.aborted) {
        const result = await this.status(jobId);
        const status = result.status.toLowerCase();
        if (status === "completed") {
          yield { id: "1", data: { type: "RUN_FINISHED" } };
          return;
        }
        if (status === "cancelled") {
          yield { id: "1", data: { type: "CUSTOM", name: "langflow.run.cancelled" } };
          return;
        }
        if (["failed", "timed_out", "timeout", "error"].includes(status) || Date.now() >= deadline) {
          yield { id: "1", data: { type: "RUN_ERROR" } };
          return;
        }
        await delay(1_000, undefined, signal ? { signal } : undefined);
      }
      return;
    }
    const headers: Record<string, string> = {
      "x-api-key": this.config.langflowApiKey,
      accept: "text/event-stream",
    };
    if (lastEventId) headers["Last-Event-ID"] = lastEventId;
    const response = await fetch(
      `${this.config.langflowBaseUrl}/api/v2/workflows/${encodeURIComponent(jobId)}/events`,
      { headers, signal: signal ?? AbortSignal.timeout(this.config.langflowTimeoutMs) },
    );
    if (!response.ok || !response.body) throw new LangflowError("langflow_stream_failed", response.status);
    yield* parseSse(response.body, signal);
  }

  async status(jobId: string) {
    const response = await fetch(
      `${this.config.langflowBaseUrl}/api/v2/workflows?job_id=${encodeURIComponent(jobId)}`,
      { headers: this.headers({ accept: "application/json" }), signal: AbortSignal.timeout(30_000) },
    );
    if (!response.ok) throw new LangflowError("langflow_status_failed", response.status);
    return (await response.json()) as WorkflowStatus;
  }

  async cancel(jobId: string) {
    const response = await fetch(`${this.config.langflowBaseUrl}/api/v2/workflows/stop`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ job_id: jobId }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok && response.status !== 409) {
      throw new LangflowError("langflow_cancel_failed", response.status);
    }
  }
}

type MockJob = { cancelled: boolean; output: string };

class MockLangflowAdapter implements LangflowAdapter {
  private jobs = new Map<string, MockJob>();

  async start(_sessionId: string, input: string) {
    const jobId = `mock-${crypto.randomUUID()}`;
    const output = `This is the local preview response for: **${input}**\n\nThe production Langflow connection is disabled on this PC. The Atom deployment will replace this simulator with live, read-only production analysis while keeping the same streaming experience.`;
    this.jobs.set(jobId, { cancelled: false, output });
    return { jobId };
  }

  async *events(jobId: string, lastEventId?: string | null, signal?: AbortSignal) {
    const job = this.jobs.get(jobId);
    if (!job) throw new LangflowError("mock_job_not_found", 404);
    const frames: unknown[] = [
      { type: "RUN_STARTED" },
      { type: "STEP_STARTED", stepName: "Chat Input" },
      { type: "STEP_FINISHED", stepName: "Chat Input" },
      { type: "STEP_STARTED", stepName: "Production data tool" },
      { type: "STEP_FINISHED", stepName: "Production data tool" },
      { type: "TEXT_MESSAGE_START" },
      ...job.output.split(/(\s+)/).filter(Boolean).map((delta) => ({ type: "TEXT_MESSAGE_CONTENT", delta })),
      { type: "TEXT_MESSAGE_END" },
      { type: "RUN_FINISHED" },
    ];
    const startAt = lastEventId ? Math.max(Number.parseInt(lastEventId, 10) + 1, 0) : 0;
    for (let index = startAt; index < frames.length; index += 1) {
      if (signal?.aborted) return;
      if (job.cancelled) {
        yield { id: String(index), data: { type: "CUSTOM", name: "langflow.run.cancelled" } };
        return;
      }
      await delay(index < 6 ? 350 : 35);
      yield { id: String(index), data: frames[index] };
    }
  }

  async status(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) throw new LangflowError("mock_job_not_found", 404);
    return job.cancelled
      ? { status: "cancelled" }
      : { status: "completed", output: { text: job.output } };
  }

  async cancel(jobId: string) {
    const job = this.jobs.get(jobId);
    if (job) job.cancelled = true;
  }
}

export class LangflowError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
  }
}

export function createLangflowAdapter(config: Config): LangflowAdapter {
  return config.langflowMock ? new MockLangflowAdapter() : new HttpLangflowAdapter(config);
}

function safeName(value: unknown) {
  if (typeof value !== "string") return "Workflow step";
  const normalized = value.replace(/[^\p{L}\p{N} _.-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 72);
  return normalized || "Workflow step";
}

export function friendlyStage(name: unknown) {
  const safe = safeName(name);
  const lower = safe.toLowerCase();
  if (/chat input|input|question|intent/.test(lower)) return "Understanding your question";
  if (/sql|database|postgres|query|tool|data/.test(lower)) return "Checking production data";
  if (/review|validate|evidence|result/.test(lower)) return "Reviewing the results";
  if (/prompt|agent|router|plan/.test(lower)) return "Planning the analysis";
  if (/output|model|llm|answer|response/.test(lower)) return "Preparing the answer";
  return "Langflow is working";
}

export function mapAgUiEvent(data: unknown): ClientEvent[] {
  if (!data || typeof data !== "object") return [];
  const event = data as Record<string, unknown>;
  const type = String(event.type ?? event.event ?? "").toUpperCase();
  const stepName = event.stepName ?? event.step_name ?? event.name ?? event.componentName;
  switch (type) {
    case "RUN_STARTED":
      return [{ type: "status", label: "Langflow is working", state: "running" }];
    case "STEP_STARTED":
      return [
        { type: "status", label: friendlyStage(stepName), state: "running" },
        { type: "trace", label: safeName(stepName), state: "running" },
      ];
    case "STEP_FINISHED":
      return [{ type: "trace", label: safeName(stepName), state: "complete" }];
    case "TOOL_CALL_START":
      return [{ type: "status", label: "Checking production data", state: "running" }];
    case "TEXT_MESSAGE_START":
      return [{ type: "status", label: "Preparing the answer", state: "running" }];
    case "TEXT_MESSAGE_CONTENT": {
      const delta = event.delta ?? event.content;
      return typeof delta === "string" ? [{ type: "token", delta }] : [];
    }
    case "RUN_ERROR":
      return [{ type: "error", code: "workflow_failed", message: "The analysis could not be completed.", retryable: true }];
    case "CUSTOM":
      return event.name === "langflow.run.cancelled" ? [{ type: "cancelled" }] : [];
    default:
      return [];
  }
}
