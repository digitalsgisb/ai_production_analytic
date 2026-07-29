import { z } from "zod";

const metricValueSchema = z.union([z.string().max(80), z.number().finite()]);

const kpiSchema = z.object({
  label: z.string().min(1).max(60),
  value: metricValueSchema,
  unit: z.string().max(20).optional(),
  status: z.enum(["neutral", "positive", "warning", "critical"]).default("neutral"),
});

const seriesSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/i),
  label: z.string().min(1).max(50),
});

const chartPointSchema = z.object({
  label: z.string().min(1).max(80),
  values: z.record(z.string(), z.number().finite().nullable()),
  anomaly: z.boolean().optional(),
});

const chartSchema = z.object({
  type: z.enum(["line", "bar"]),
  title: z.string().min(1).max(100),
  subtitle: z.string().max(160).optional(),
  yLabel: z.string().max(30).optional(),
  series: z.array(seriesSchema).min(1).max(4),
  data: z.array(chartPointSchema).min(1).max(60),
}).superRefine((chart, context) => {
  const keys = new Set(chart.series.map((series) => series.key));
  if (keys.size !== chart.series.length) {
    context.addIssue({ code: "custom", message: "Chart series keys must be unique" });
  }
  chart.data.forEach((point, pointIndex) => {
    Object.keys(point.values).forEach((key) => {
      if (!keys.has(key)) {
        context.addIssue({ code: "custom", path: ["data", pointIndex, "values", key], message: "Unknown series key" });
      }
    });
  });
});

const anomalySchema = z.object({
  severity: z.enum(["info", "warning", "critical"]),
  title: z.string().min(1).max(100),
  detail: z.string().min(1).max(280),
});

export const analyticsPayloadSchema = z.object({
  version: z.literal(1),
  period: z.object({
    label: z.string().min(1).max(60),
    start: z.string().date(),
    end: z.string().date(),
  }).optional(),
  kpis: z.array(kpiSchema).max(6).default([]),
  charts: z.array(chartSchema).max(3).default([]),
  anomalies: z.array(anomalySchema).max(8).default([]),
  notes: z.array(z.string().min(1).max(240)).max(6).default([]),
});

export type AnalyticsPayload = z.infer<typeof analyticsPayloadSchema>;
export type AnalyticsChart = AnalyticsPayload["charts"][number];

export type ParsedAnalyticsMessage = {
  markdown: string;
  analytics?: AnalyticsPayload;
  analyticsIssue?: "incomplete" | "invalid";
};

const completeBlock = /^[ \t]{0,3}```([a-z0-9-]*)[ \t]*\r?\n([\s\S]*?)^[ \t]{0,3}```[ \t]*\r?$/gim;
const incompleteSugiBlock = /^[ \t]{0,3}```sugi-analytics[ \t]*\r?$/im;

function withoutBlock(content: string, start: number, length: number) {
  return `${content.slice(0, start).trimEnd()}${content.slice(start + length)}`.trim();
}

function looksLikeAnalytics(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1 || Array.isArray(candidate.kpis) || Array.isArray(candidate.charts);
}

export function parseAnalyticsMessage(content: string): ParsedAnalyticsMessage {
  completeBlock.lastIndex = 0;
  for (const match of content.matchAll(completeBlock)) {
    const language = match[1].toLowerCase();
    if (!["", "json", "sugi-analytics"].includes(language) || match.index === undefined) continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(match[2].trim());
    } catch {
      if (language === "sugi-analytics") {
        return { markdown: withoutBlock(content, match.index, match[0].length), analyticsIssue: "invalid" };
      }
      continue;
    }
    const parsed = analyticsPayloadSchema.safeParse(decoded);
    const markdown = withoutBlock(content, match.index, match[0].length);
    if (parsed.success) return { markdown, analytics: parsed.data };
    if (language === "sugi-analytics" || looksLikeAnalytics(decoded)) return { markdown, analyticsIssue: "invalid" };
  }

  const incomplete = incompleteSugiBlock.exec(content);
  if (incomplete?.index !== undefined) return { markdown: content.slice(0, incomplete.index).trimEnd(), analyticsIssue: "incomplete" };
  return { markdown: content };
}
