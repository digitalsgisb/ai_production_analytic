import { describe, expect, it } from "vitest";

import { buildWorkflowStartBody, friendlyStage, isRetryableWorkflowStatus, mapAgUiEvent, workflowOutputText } from "./langflow.js";

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
});

describe("Langflow event sanitization", () => {
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
});
