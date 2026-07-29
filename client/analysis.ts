import { z } from "zod";

const metricValueSchema = z.union([z.string().max(80), z.number().finite()]);

const kpiSchema = z.object({
  label: z.string().min(1).max(60),
  value: metricValueSchema,
  unit: z.string().max(20).optional(),
  status: z.enum(["neutral", "positive", "warning", "critical"]).default("neutral"),
}).strict();

const seriesSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/i),
  label: z.string().min(1).max(50),
}).strict();

const chartPointSchema = z.object({
  label: z.string().min(1).max(80),
  values: z.record(z.string(), z.number().finite().nullable()),
  anomaly: z.boolean().optional(),
}).strict();

const chartSchema = z.object({
  type: z.enum(["line", "bar"]),
  title: z.string().min(1).max(100),
  subtitle: z.string().max(160).optional(),
  yLabel: z.string().max(30).optional(),
  series: z.array(seriesSchema).min(1).max(4),
  data: z.array(chartPointSchema).min(1).max(60),
}).strict().superRefine((chart, context) => {
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
}).strict();

export const analyticsPayloadSchema = z.object({
  version: z.literal(1),
  period: z.object({
    label: z.string().min(1).max(60),
    start: z.string().date(),
    end: z.string().date(),
  }).strict().optional(),
  kpis: z.array(kpiSchema).max(6).default([]),
  charts: z.array(chartSchema).max(3).default([]),
  anomalies: z.array(anomalySchema).max(8).default([]),
  notes: z.array(z.string().min(1).max(240)).max(6).default([]),
}).strict();

export type AnalyticsPayload = z.infer<typeof analyticsPayloadSchema>;
export type AnalyticsChart = AnalyticsPayload["charts"][number];

const blockStart = /^```sugi-analytics[ \t]*\r?$/im;

export function parseAnalyticsMessage(content: string): { markdown: string; analytics?: AnalyticsPayload } {
  const match = blockStart.exec(content);
  if (!match || match.index === undefined) return { markdown: content };

  const jsonStart = match.index + match[0].length;
  const remaining = content.slice(jsonStart);
  const closingMatch = /^```[ \t]*\r?$/m.exec(remaining);
  if (!closingMatch || closingMatch.index === undefined) {
    return { markdown: content.slice(0, match.index).trimEnd() };
  }

  const afterBlock = remaining.slice(closingMatch.index + closingMatch[0].length);
  const markdown = `${content.slice(0, match.index).trimEnd()}${afterBlock}`.trim();
  const rawJson = remaining.slice(0, closingMatch.index).trim();
  try {
    const parsed = analyticsPayloadSchema.safeParse(JSON.parse(rawJson));
    return parsed.success ? { markdown, analytics: parsed.data } : { markdown };
  } catch {
    return { markdown };
  }
}
