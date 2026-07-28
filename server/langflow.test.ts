import { describe, expect, it } from "vitest";

import {
  buildWorkflowStartBody,
  friendlyStage,
  isRetryableWorkflowStatus,
  legacyRunOutputText,
  mapAgUiEvent,
  normalizeLegacyStreamEvent,
  parseSse,
  workflowOutputText,
} from "./langflow.js";

describe("Langflow version compatibility", () => {
  it("retries only transient workflow status responses", () => {
    expect(isRetryableWorkflowStatus(404)).toBe(true);
    expect(isRetryableWorkflowStatus(429)).toBe(true);
    expect(isRetryableWorkflowStatus(503)).toBe(true);
    expect(isRetryableWorkflowStatus(401)).toBe(false);
    expect(isRetryableWorkflowStatus(403)).toBe(false);
    expect(isRetryableWorkflowStatus(422)).toBe(false);
  });

  it("uses component-scoped inputs for boolean background APIs", () => {
    expect(buildWorkflowStartBody(
      { langflowFlowId: "flow-id", langflowInputComponentId: "ChatInput-abc" },
      "conversation-id",
      "hello",
    )).toEqual({
      flow_id: "flow-id",
      background: true,
      stream: false,
      inputs: {
        "ChatInput-abc.input_value": "hello",
        "ChatInput-abc.session_id": "conversation-id",
      },
    });
  });

  it("retains AG-UI background mode when no compatibility component is configured", () => {
    expect(buildWorkflowStartBody(
      { langflowFlowId: "flow-id", langflowInputComponentId: "" },
      "conversation-id",
      "hello",
    )).toEqual({
      flow_id: "flow-id",
      input_value: "hello",
      session_id: "conversation-id",
      mode: "background",
      stream_protocol: "agui",
    });
  });

  it("reads current normalized workflow output text", () => {
    expect(workflowOutputText({
      status: "completed",
      output: { text: "Current API answer" },
    })).toBe("Current API answer");
  });

  it("reads Langflow 1.10 Chat Output content", () => {
    expect(workflowOutputText({
      status: "completed",
      outputs: {
        "ChatOutput-YzKSB": {
          type: "message",
          component_id: "ChatOutput-YzKSB",
          status: "completed",
          content: "Compatibility answer",
        },
      },
    })).toBe("Compatibility answer");
  });

  it("does not treat non-chat component data as the assistant answer", () => {
    expect(workflowOutputText({
      status: "completed",
      outputs: {
        "Postgres-tool": { type: "data", content: "sensitive tool output" },
      },
    })).toBeUndefined();
  });

  it("reads the authoritative Chat Output from the v1 live stream result", () => {
    expect(legacyRunOutputText({
      outputs: [{
        outputs: [{
          component_id: "ChatOutput-YzKSB",
          results: { message: { text: "Live streamed answer" } },
        }],
      }],
    })).toBe("Live streamed answer");
  });
});

describe("Langflow event sanitization", () => {
  it("parses split SSE chunks and Langflow's JSON-line event format", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"TEXT_MESSAGE_CONTENT","delta":"hel'));
        controller.enqueue(encoder.encode('lo"}\n\n{"event":"token","data":{"chunk":" world"}}\n\n'));
        controller.close();
      },
    });
    const frames = [];
    for await (const frame of parseSse(body)) frames.push(frame.data);
    expect(frames).toEqual([
      { type: "TEXT_MESSAGE_CONTENT", delta: "hello" },
      { event: "token", data: { chunk: " world" } },
    ]);
  });

  it("maps production tools to a friendly stage", () => {
    expect(friendlyStage("PostgreSQL production query")).toBe("Checking production data");
  });

  it("streams only text deltas", () => {
    expect(mapAgUiEvent({ type: "TEXT_MESSAGE_CONTENT", delta: "hello" })).toEqual([
      { type: "token", delta: "hello" },
    ]);
  });

  it("never forwards tool arguments or results", () => {
    expect(mapAgUiEvent({ type: "TOOL_CALL_ARGS", args: "SELECT * FROM secrets" })).toEqual([]);
    expect(mapAgUiEvent({ type: "TOOL_CALL_RESULT", result: { password: "secret" } })).toEqual([]);
  });

  it("removes control characters from trace labels", () => {
    const result = mapAgUiEvent({ type: "STEP_STARTED", stepName: "SQL<script>alert(1)</script>" });
    expect(JSON.stringify(result)).not.toContain("<script>");
  });

  it("turns v1 component lifecycle events into sanitized trace events", () => {
    expect(normalizeLegacyStreamEvent({ event: "build_start", data: { id: "Agent-unC8Q" } }).events).toEqual([
      { type: "STEP_STARTED", stepName: "Agent" },
    ]);
    expect(normalizeLegacyStreamEvent({
      event: "end_vertex",
      data: { build_data: { id: "Agent-unC8Q", valid: true, data: { secret: "hidden" } } },
    }).events).toEqual([{ type: "STEP_FINISHED", stepName: "Agent" }]);
  });

  it("shows tool names and states without forwarding inputs, outputs, or SQL", () => {
    const states = new Map<string, "running" | "complete" | "error">();
    const started = normalizeLegacyStreamEvent({
      event: "add_message",
      data: {
        sender: "Machine",
        text: "",
        content_blocks: [{ contents: [{
          type: "tool_use",
          name: "RUN_SQL_QUERY",
          tool_input: { query: "SELECT password FROM users" },
          output: null,
        }] }],
      },
    }, states);
    expect(started.events).toEqual([{ type: "TOOL_CALL_START", toolName: "Run SQL Query" }]);
    expect(JSON.stringify(started.events)).not.toContain("SELECT");

    const completed = normalizeLegacyStreamEvent({
      event: "add_message",
      data: {
        sender: "Machine",
        text: "answer",
        content_blocks: [{ contents: [{
          type: "tool_use",
          name: "RUN_SQL_QUERY",
          tool_input: { query: "SELECT password FROM users" },
          output: [{ password: "secret" }],
        }] }],
      },
    }, states);
    expect(completed.events).toEqual([{ type: "TOOL_CALL_END", toolName: "Run SQL Query" }]);
    expect(completed.assistantText).toBe("answer");
    expect(JSON.stringify(completed.events)).not.toContain("secret");
  });

  it("maps tool lifecycle events into visible progress trace rows", () => {
    expect(mapAgUiEvent({ type: "TOOL_CALL_START", toolName: "GET_CURRENT_DATE" })).toEqual([
      { type: "status", label: "Checking production data", state: "running" },
      { type: "trace", label: "Get Current Date", state: "running" },
    ]);
    expect(mapAgUiEvent({ type: "TOOL_CALL_END", toolName: "GET_CURRENT_DATE" })).toEqual([
      { type: "trace", label: "Get Current Date", state: "complete" },
    ]);
  });
});
