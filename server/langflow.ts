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
  outputs?: Record<string, unknown>;
}

export function isRetryableWorkflowStatus(status: number) {
  return [404, 408, 409, 425, 429].includes(status) || status >= 500;
}

export function workflowOutputText(result: WorkflowStatus) {
  if (typeof result.output?.text === "string") return result.output.text;
  if (!result.outputs || typeof result.outputs !== "object") return undefined;

  for (const [componentId, rawOutput] of Object.entries(result.outputs)) {
    if (!componentId.toLowerCase().startsWith("chatoutput-")) continue;
    if (!rawOutput || typeof rawOutput !== "object" || Array.isArray(rawOutput)) continue;

    const output = rawOutput as Record<string, unknown>;
    if (output.type !== undefined && output.type !== "message") continue;
    if (typeof output.content === "string") return output.content;
  }

  return undefined;
}

export function legacyRunOutputText(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const run = result as Record<string, unknown>;
  if (!Array.isArray(run.outputs)) return undefined;

  for (const graphOutput of run.outputs) {
    if (!graphOutput || typeof graphOutput !== "object" || Array.isArray(graphOutput)) continue;
    const componentOutputs = (graphOutput as Record<string, unknown>).outputs;
    if (!Array.isArray(componentOutputs)) continue;
    for (const componentOutput of componentOutputs) {
      if (!componentOutput || typeof componentOutput !== "object" || Array.isArray(componentOutput)) continue;
      const component = componentOutput as Record<string, unknown>;
      const componentId = String(component.component_id ?? component.componentId ?? "");
      if (!componentId.toLowerCase().startsWith("chatoutput-")) continue;
      if (!component.results || typeof component.results !== "object" || Array.isArray(component.results)) continue;
      const results = component.results as Record<string, unknown>;
      if (!results.message || typeof results.message !== "object" || Array.isArray(results.message)) continue;
      const text = (results.message as Record<string, unknown>).text;
      if (typeof text === "string") return text;
    }
  }

  return undefined;
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

export async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
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
        const raw = dataLines.length ? dataLines.join("\n") : block.trim();
        if (!raw || raw.startsWith(":")) continue;
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

type BufferedStreamJob = {
  id: string;
  controller: AbortController;
  frames: RawSseFrame[];
  waiters: Set<() => void>;
  status: WorkflowStatus;
  done: boolean;
  sessionId: string;
  input: string;
  lastAssistantText?: string;
  toolStates: Map<string, "running" | "complete" | "error">;
};

class HttpLangflowAdapter implements LangflowAdapter {
  private readonly streamJobs = new Map<string, BufferedStreamJob>();

  constructor(private readonly config: Config) {}

  private pushFrame(job: BufferedStreamJob, data: unknown) {
    const frame = { id: String(job.frames.length), data } satisfies RawSseFrame;
    job.frames.push(frame);
    for (const wake of job.waiters) wake();
    job.waiters.clear();
  }

  private finishStreamJob(job: BufferedStreamJob, status: WorkflowStatus) {
    if (job.done) return;
    job.status = status;
    job.done = true;
    job.input = "";
    job.sessionId = "";
    job.toolStates.clear();
    const type = status.status === "completed"
      ? "RUN_FINISHED"
      : status.status === "cancelled"
        ? "CUSTOM"
        : "RUN_ERROR";
    this.pushFrame(job, type === "CUSTOM" ? { type, name: "langflow.run.cancelled" } : { type });
    const cleanup = setTimeout(() => {
      if (this.streamJobs.get(job.id) === job) this.streamJobs.delete(job.id);
    }, 15 * 60_000);
    cleanup.unref();
  }

  private async runLiveProgress(job: BufferedStreamJob) {
    this.pushFrame(job, { type: "RUN_STARTED" });
    job.status = { status: "in_progress" };
    const timeoutSignal = AbortSignal.timeout(this.config.langflowTimeoutMs);
    const signal = AbortSignal.any([job.controller.signal, timeoutSignal]);

    try {
      const response = await fetch(
        `${this.config.langflowBaseUrl}/api/v1/run/${encodeURIComponent(this.config.langflowFlowId)}?stream=true`,
        {
          method: "POST",
          headers: this.headers({ accept: "text/event-stream" }),
          body: JSON.stringify({
            input_value: job.input,
            input_type: "chat",
            output_type: "chat",
            session_id: job.sessionId,
          }),
          signal,
        },
      );
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!response.ok || !response.body || !contentType.includes("text/event-stream")) {
        throw new LangflowError("langflow_stream_failed", response.status);
      }

      for await (const frame of parseSse(response.body, signal)) {
        const normalized = normalizeLegacyStreamEvent(frame.data, job.toolStates);
        for (const event of normalized.events) this.pushFrame(job, event);
        if (normalized.assistantText !== undefined) job.lastAssistantText = normalized.assistantText;
        if (normalized.result !== undefined) {
          const output = legacyRunOutputText(normalized.result) ?? job.lastAssistantText;
          if (typeof output !== "string") {
            this.finishStreamJob(job, { status: "failed" });
          } else {
            this.finishStreamJob(job, { status: "completed", output: { text: output } });
          }
          return;
        }
        if (normalized.failed) {
          this.finishStreamJob(job, { status: "failed" });
          return;
        }
      }

      if (!job.done) this.finishStreamJob(job, { status: "failed" });
    } catch (error) {
      if (job.done) return;
      if (job.controller.signal.aborted) this.finishStreamJob(job, { status: "cancelled" });
      else this.finishStreamJob(job, { status: "failed" });
    }
  }

  private headers(extra: HeadersInit = {}) {
    return {
      "content-type": "application/json",
      "x-api-key": this.config.langflowApiKey,
      ...extra,
    };
  }

  async start(sessionId: string, input: string) {
    if (this.config.langflowLiveProgress) {
      const jobId = `stream-${crypto.randomUUID()}`;
      const job: BufferedStreamJob = {
        id: jobId,
        controller: new AbortController(),
        frames: [],
        waiters: new Set(),
        status: { status: "queued" },
        done: false,
        sessionId,
        input,
        toolStates: new Map(),
      };
      this.streamJobs.set(jobId, job);
      void this.runLiveProgress(job);
      return { jobId };
    }
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
    const liveJob = this.streamJobs.get(jobId);
    if (liveJob) {
      let index = lastEventId ? Math.max(Number.parseInt(lastEventId, 10) + 1, 0) : 0;
      if (!Number.isFinite(index)) index = 0;
      while (!signal?.aborted) {
        while (index < liveJob.frames.length) {
          yield liveJob.frames[index];
          index += 1;
        }
        if (liveJob.done) return;
        await new Promise<void>((resolve) => {
          const wake = () => {
            liveJob.waiters.delete(wake);
            signal?.removeEventListener("abort", wake);
            resolve();
          };
          liveJob.waiters.add(wake);
          signal?.addEventListener("abort", wake, { once: true });
        });
      }
      return;
    }
    if (jobId.startsWith("stream-")) {
      yield { data: { type: "RUN_ERROR" } };
      return;
    }
    if (this.config.langflowInputComponentId) {
      yield { id: lastEventId ? undefined : "0", data: { type: "RUN_STARTED" } };
      const deadline = Date.now() + this.config.langflowTimeoutMs;
      while (!signal?.aborted) {
        let result: WorkflowStatus;
        try {
          result = await this.status(jobId);
        } catch (error) {
          if (
            error instanceof LangflowError &&
            error.code === "langflow_status_failed" &&
            isRetryableWorkflowStatus(error.status) &&
            Date.now() < deadline
          ) {
            await delay(1_000, undefined, signal ? { signal } : undefined);
            continue;
          }
          throw error;
        }
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
    const liveJob = this.streamJobs.get(jobId);
    if (liveJob) return liveJob.status;
    if (jobId.startsWith("stream-")) return { status: "failed" };
    const url = `${this.config.langflowBaseUrl}/api/v2/workflows?job_id=${encodeURIComponent(jobId)}`;
    let lastStatus = 502;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: this.headers({ accept: "application/json" }),
          signal: AbortSignal.timeout(30_000),
        });
        lastStatus = response.status;
        if (response.ok) {
          const result = (await response.json()) as WorkflowStatus;
          const text = workflowOutputText(result);
          return text === undefined ? result : { ...result, output: { text } };
        }
        if (!isRetryableWorkflowStatus(response.status)) {
          throw new LangflowError("langflow_status_failed", response.status);
        }
      } catch (error) {
        if (error instanceof LangflowError) throw error;
        lastStatus = 502;
      }

      if (attempt < 3) await delay(250 * (2 ** attempt));
    }

    throw new LangflowError("langflow_status_failed", lastStatus);
  }

  async cancel(jobId: string) {
    const liveJob = this.streamJobs.get(jobId);
    if (liveJob) {
      liveJob.controller.abort();
      this.finishStreamJob(liveJob, { status: "cancelled" });
      return;
    }
    if (jobId.startsWith("stream-")) return;
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

function displayName(value: unknown) {
  const safe = safeName(value)
    .replace(/-[A-Za-z0-9]{5,}$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!safe) return "Workflow step";
  return safe.split(" ").map((word) => {
    if (/^(sql|oee|ai|llm|abb\d*)$/i.test(word)) return word.toUpperCase();
    return word.slice(0, 1).toUpperCase() + word.slice(1).toLowerCase();
  }).join(" ");
}

type NormalizedLegacyEvent = {
  events: unknown[];
  assistantText?: string;
  result?: unknown;
  failed?: boolean;
};

export function normalizeLegacyStreamEvent(
  data: unknown,
  toolStates = new Map<string, "running" | "complete" | "error">(),
): NormalizedLegacyEvent {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { events: [] };
  const envelope = data as Record<string, unknown>;
  const type = String(envelope.event ?? envelope.type ?? "").toLowerCase();
  const payload = envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)
    ? envelope.data as Record<string, unknown>
    : {};

  if (type === "build_start") {
    return payload.id
      ? { events: [{ type: "STEP_STARTED", stepName: displayName(payload.id) }] }
      : { events: [{ type: "RUN_STARTED" }] };
  }
  if (type === "end_vertex") {
    const buildData = payload.build_data && typeof payload.build_data === "object" && !Array.isArray(payload.build_data)
      ? payload.build_data as Record<string, unknown>
      : {};
    if (!buildData.id) return { events: [] };
    return {
      events: [{
        type: buildData.valid === false ? "STEP_ERROR" : "STEP_FINISHED",
        stepName: displayName(buildData.id),
      }],
    };
  }
  if (type === "token") {
    return typeof payload.chunk === "string"
      ? { events: [{ type: "TEXT_MESSAGE_CONTENT", delta: payload.chunk }] }
      : { events: [] };
  }
  if (type === "add_message") {
    const events: unknown[] = [];
    const nameCounts = new Map<string, number>();
    const blocks = Array.isArray(payload.content_blocks) ? payload.content_blocks : [];
    for (const block of blocks) {
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      const contents = (block as Record<string, unknown>).contents;
      if (!Array.isArray(contents)) continue;
      for (const content of contents) {
        if (!content || typeof content !== "object" || Array.isArray(content)) continue;
        const tool = content as Record<string, unknown>;
        if (tool.type !== "tool_use" || typeof tool.name !== "string") continue;
        const label = displayName(tool.name);
        const occurrence = nameCounts.get(label) ?? 0;
        nameCounts.set(label, occurrence + 1);
        const key = `${label}:${occurrence}`;
        const state = tool.error !== null && tool.error !== undefined
          ? "error"
          : tool.output !== null && tool.output !== undefined
            ? "complete"
            : "running";
        const previous = toolStates.get(key);
        if (!previous) events.push({ type: "TOOL_CALL_START", toolName: label });
        if (state !== "running" && previous !== state) {
          events.push({ type: state === "error" ? "TOOL_CALL_ERROR" : "TOOL_CALL_END", toolName: label });
        }
        toolStates.set(key, state);
      }
    }
    const sender = String(payload.sender ?? payload.sender_name ?? "").toLowerCase();
    return {
      events,
      assistantText: /machine|ai|assistant/.test(sender) && typeof payload.text === "string"
        ? payload.text
        : undefined,
    };
  }
  if (type === "end") return { events: [], result: payload.result };
  if (type === "error") return { events: [], failed: true };
  return { events: [] };
}

export function friendlyStage(name: unknown) {
  const safe = displayName(name);
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
  const stepName = event.stepName ?? event.step_name ?? event.toolName ?? event.name ?? event.componentName;
  switch (type) {
    case "RUN_STARTED":
      return [{ type: "status", label: "Langflow is working", state: "running" }];
    case "STEP_STARTED":
      return [
        { type: "status", label: friendlyStage(stepName), state: "running" },
        { type: "trace", label: displayName(stepName), state: "running" },
      ];
    case "STEP_FINISHED":
      return [{ type: "trace", label: displayName(stepName), state: "complete" }];
    case "STEP_ERROR":
      return [{ type: "trace", label: displayName(stepName), state: "error" }];
    case "TOOL_CALL_START":
      return [
        { type: "status", label: "Checking production data", state: "running" },
        { type: "trace", label: displayName(stepName), state: "running" },
      ];
    case "TOOL_CALL_END":
      return [{ type: "trace", label: displayName(stepName), state: "complete" }];
    case "TOOL_CALL_ERROR":
      return [{ type: "trace", label: displayName(stepName), state: "error" }];
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
