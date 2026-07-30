# AI production analytics contract

The AI must use the typed `analytics_v2` schema for routine analysis. The raw
`ingest.events` table is reserved for audit, lineage, and troubleshooting.

## Authoritative sources

| Question grain | Source |
| --- | --- |
| One production day and line | `analytics_v2.daily_line_summary` |
| One shift | `analytics_v2.shift_summary` |
| Hourly detail | `analytics_v2.hourly_output` |
| Downtime causes | `analytics_v2.downtime_events` |
| Reject causes | `analytics_v2.reject_events` |
| Manual corrections | `analytics_v2.count_adjustments` |
| Original source envelope | `ingest.events` |

## Required filters

1. Production reporting uses `production_date`, not `occurred_at::date`.
2. Shift analysis always groups or filters by `production_date`, `line_code`,
   and `shift_id`.
3. Never infer `line_code` or `shift_id` from `model_code`.
4. Do not combine shifts or lines unless the user explicitly requests a combined
   result and the SQL groups each component first.
5. Final daily or shift analysis requires `record_status = 'READY'`. If the
   status is not ready, state the quality problem instead of estimating values.

## Calculation rules

All arithmetic must be performed in PostgreSQL. The model explains returned
results and must not mentally total result rows.

- Achievement percent: `100 * actual_quantity / NULLIF(plan_quantity, 0)`.
- Shortfall: `plan_quantity - actual_quantity`.
- Good quantity: `actual_quantity - reject_quantity`.
- Reject percent: `100 * reject_quantity / NULLIF(actual_quantity, 0)`.
- A zero plan produces a `NULL` achievement, not zero percent.

The response must include the production date, line, shift scope, number of
source rows, and data-quality status. Possible causes must be tied to recorded
downtime, reject, parameter, or adjustment evidence. Unrecorded causes must be
labelled as unknown and must never be invented.

## Verification before narration

For a shift answer, retrieve `analytics_v2.shift_summary` first. Retrieve hourly
detail only with the exact same `production_date`, `line_code`, and `shift_id`.
Confirm that hourly `SUM(plan_quantity)` and `SUM(actual_quantity)` match the
shift summary. If they do not, stop and report a reconciliation failure.
