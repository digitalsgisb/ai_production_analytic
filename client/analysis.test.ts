import { describe, expect, it } from "vitest";

import { parseAnalyticsMessage } from "./analysis";

const validPayload = {
  version: 1,
  period: { label: "This week", start: "2026-07-27", end: "2026-07-29" },
  kpis: [{ label: "Recorded rejects", value: 0, unit: "units", status: "positive" }],
  charts: [{
    type: "line",
    title: "Plan vs actual",
    yLabel: "Units",
    series: [{ key: "plan", label: "Plan" }, { key: "actual", label: "Actual" }],
    data: [
      { label: "27 Jul · Day", values: { plan: 100, actual: 92 }, anomaly: true },
      { label: "28 Jul · Day", values: { plan: 100, actual: 101 } },
    ],
  }],
  anomalies: [{ severity: "warning", title: "Output below plan", detail: "The Day shift finished 8% below plan." }],
  notes: ["Two current shifts are not closed."],
};

describe("analytics message contract", () => {
  it("extracts a valid payload and preserves the consumer answer", () => {
    const content = `No rejects were recorded this week.\n\n\`\`\`sugi-analytics\n${JSON.stringify(validPayload)}\n\`\`\``;
    const parsed = parseAnalyticsMessage(content);
    expect(parsed.markdown).toBe("No rejects were recorded this week.");
    expect(parsed.analytics?.charts[0].data).toHaveLength(2);
    expect(parsed.analytics?.kpis[0].status).toBe("positive");
  });

  it("leaves ordinary Markdown unchanged", () => {
    expect(parseAnalyticsMessage("**Shift complete.**")).toEqual({ markdown: "**Shift complete.**" });
  });

  it("accepts a validated analytics payload from a generic JSON fence", () => {
    const content = `Summary\n\n\`\`\`json\n${JSON.stringify(validPayload)}\n\`\`\``;
    const parsed = parseAnalyticsMessage(content);
    expect(parsed.markdown).toBe("Summary");
    expect(parsed.analytics?.period?.start).toBe("2026-07-27");
  });

  it("accepts a validated bare analytics object appended to the answer", () => {
    const content = `Weekly summary\n\n${JSON.stringify(validPayload, null, 2)}`;
    const parsed = parseAnalyticsMessage(content);
    expect(parsed.markdown).toBe("Weekly summary");
    expect(parsed.analytics?.charts[0].title).toBe("Plan vs actual");
  });

  it("hides an incomplete trailing analytics object while it streams", () => {
    const content = "Weekly summary\n\n{\n  \"version\": 1,\n  \"period\":";
    expect(parseAnalyticsMessage(content)).toEqual({ markdown: "Weekly summary", analyticsIssue: "incomplete" });
  });

  it("does not consume an unrelated JSON code sample", () => {
    const content = "Example:\n\n```json\n{\"enabled\":true}\n```";
    expect(parseAnalyticsMessage(content)).toEqual({ markdown: content });
  });

  it("hides an incomplete streamed block until it can be validated", () => {
    const parsed = parseAnalyticsMessage("Trend below.\n\n```sugi-analytics\n{\"version\":1");
    expect(parsed).toEqual({ markdown: "Trend below.", analyticsIssue: "incomplete" });
  });

  it("rejects unknown series keys without exposing raw JSON", () => {
    const invalid = {
      ...validPayload,
      charts: [{
        ...validPayload.charts[0],
        data: [{ ...validPayload.charts[0].data[0], values: { plan: 100, actual: 92, secret: 12 } }],
      }],
    };
    const content = `Summary\n\n\`\`\`sugi-analytics\n${JSON.stringify(invalid)}\n\`\`\``;
    expect(parseAnalyticsMessage(content)).toEqual({ markdown: "Summary", analyticsIssue: "invalid" });
  });

  it("rejects executable or unsupported chart types", () => {
    const invalid = { ...validPayload, charts: [{ ...validPayload.charts[0], type: "javascript" }] };
    const content = `Summary\n\n\`\`\`sugi-analytics\n${JSON.stringify(invalid)}\n\`\`\``;
    expect(parseAnalyticsMessage(content)).toEqual({ markdown: "Summary", analyticsIssue: "invalid" });
  });
});
