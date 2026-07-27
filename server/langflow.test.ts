import { describe, expect, it } from "vitest";

import { friendlyStage, mapAgUiEvent } from "./langflow.js";

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
