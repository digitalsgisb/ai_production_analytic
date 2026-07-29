# Langflow analytics output contract

Sugi Bobot renders ordinary Markdown answers as before. To add KPI cards, trends, comparisons, and anomaly callouts, append one fenced `sugi-analytics` JSON block to the final answer.

Paste the following section at the end of the Langflow Agent Instructions for the flow configured by `LANGFLOW_FLOW_ID`.

````text
CONSUMER-FRIENDLY ANSWER AND VISUAL OUTPUT

- Lead with the operational finding, not the database source or query method.
- Use plain production language. Do not mention analytics view names unless explaining a genuine data limitation.
- Do not list raw event IDs or shift IDs unless the user explicitly requests them.
- Do not include future dates in a current-period answer.
- Distinguish completed shifts, active shifts with NULL final values, recorded zero, and missing data.
- Never claim hourly rejects because analytics.hourly_output has no reject quantity.
- Keep the written answer brief when a visual communicates the comparison more clearly.

When the result contains a time trend, line/shift comparison, KPI summary, or evidence-backed anomaly, append exactly one `sugi-analytics` fenced JSON block after the Markdown answer.

The JSON is data only. Never place SQL, HTML, JavaScript, Markdown, credentials, tool output, or database errors inside it.

Use this exact structure:

```sugi-analytics
{
  "version": 1,
  "period": {
    "label": "This week",
    "start": "2026-07-27",
    "end": "2026-07-29"
  },
  "kpis": [
    {
      "label": "Recorded rejects",
      "value": 0,
      "unit": "units",
      "status": "positive"
    }
  ],
  "charts": [
    {
      "type": "line",
      "title": "Plan vs actual by shift",
      "subtitle": "Completed shifts only",
      "yLabel": "Units",
      "series": [
        { "key": "plan", "label": "Plan" },
        { "key": "actual", "label": "Actual" }
      ],
      "data": [
        {
          "label": "27 Jul · ABB2 Day",
          "values": { "plan": 100, "actual": 92 },
          "anomaly": true
        }
      ]
    }
  ],
  "anomalies": [
    {
      "severity": "warning",
      "title": "ABB2 Day finished below plan",
      "detail": "Actual output was 8% below plan for the completed shift."
    }
  ],
  "notes": [
    "Two current shifts are still open, so their final reject values are not available."
  ]
}
```

Contract rules:

- `version` must be the number 1.
- `period.start` and `period.end` must be ISO dates and must match the SQL filters.
- `kpis` may contain at most 6 items.
- KPI `status` must be `neutral`, `positive`, `warning`, or `critical`.
- `charts` may contain at most 3 charts.
- Chart `type` must be `line` or `bar`.
- Each chart may have at most 4 series and 60 data points.
- Series keys must contain only letters, numbers, or underscores and must match keys in every `values` object.
- Numeric chart values must come directly from SQL results or calculations performed inside the read-only SQL query.
- Use `null` for a genuinely unavailable point. Do not convert missing data to zero.
- Mark `anomaly: true` only when the same point is supported by a stated rule, threshold, or baseline comparison.
- An anomaly severity must be `info`, `warning`, or `critical`.
- Do not call a point anomalous merely because it is the largest or smallest value in a small sample.
- If there is insufficient history for anomaly detection, omit the anomaly and state the limitation in `notes`.
- Do not create a meaningless flat chart when all values are zero and the written KPI already communicates the result.
- Omit empty optional sections rather than inventing content.
- The fenced block must be the final item in the response, with no content after it.
````

The browser validates the payload strictly. It recognises the preferred `sugi-analytics` fence and also tolerates `json` or an unlabelled fence when—and only when—the contents validate as this analytics contract. Unsupported chart types, invalid dates, unknown series keys, oversized payloads, and malformed JSON are never executed. Unknown inert fields are ignored. The Markdown answer remains visible as a fallback.

## Recommended POC anomaly rules

Keep initial anomalies explainable and calculate them in SQL:

- plan achievement below the business threshold;
- downtime minutes above the approved threshold;
- non-zero output reconciliation variance above the approved tolerance;
- a completed shift without a final reject value;
- output more than two standard deviations below a sufficiently large historical baseline.

Do not enable a statistical rule until the baseline window and minimum sample size are agreed with production owners.
