# Langflow SQL-first guardrail

## Why this is required

The production database can be correct while the assistant still hallucinates.
In the observed live test on 30 July 2026, the assistant started streaming
production totals while `Run SQL Query` was still running. When the tool later
finished, the response retained invented totals and incorporated only one real
field from the result.

Prompt rules reduce this risk, but the Langflow graph must also enforce the
ordering mechanically.

## Required execution order

1. Resolve the user's date, line, shift, and requested metrics.
2. Execute the approved read-only SQL query.
3. Wait until the SQL component returns a successful result.
4. Pass the user's request and the completed SQL result to the answer model.
5. Generate the Markdown and optional `sugi-analytics` JSON only from that result.
6. If SQL fails or returns no rows, take the explicit failure or no-data path.

The answer model must not be connected to a path that can stream a factual
answer before step 3 completes.

## Recommended Langflow design

Use a deterministic two-stage flow instead of relying on one autonomous agent
to decide when to use SQL:

```text
Chat Input
  -> intent/filter extraction
  -> approved SQL query/tool
  -> SQL result validation
  -> answer generator (CURRENT.md + user request + SQL result)
  -> Chat Output
```

If an Agent remains in the flow, require its structured response to include the
resolved filters and query result fields, and place a separate answer-generation
component after the successful tool result. Disable or ignore pre-tool answer
tokens in the user interface.

## Acceptance test

Use this fixed test after every instruction or flow deployment:

> Analyze ABB4 production for 28 July 2026. Show plan, actual, good quantity,
> rejects, downtime, achievement, shift count, and hourly record count. Use only
> analytics_v2 READY data. Do not estimate or invent missing values.

Expected values from `analytics_v2.daily_line_summary`:

| Field | Expected value |
|---|---:|
| plan_quantity | 169 |
| actual_quantity | 169 |
| good_quantity | 169 |
| reject_quantity | 0 |
| downtime_minutes | 0 |
| achievement_percent | 100.00 |
| shift_count | 2 |
| hourly_record_count | 23 |

The test fails if any other production number appears, if a shift label or time
is invented, or if answer text begins before the SQL result is available.

## Operational rule

Until this acceptance test passes repeatedly, Sugi Bobot must not be used as the
source for production decisions. Operators should use the verified
`analytics_v2` views directly.
