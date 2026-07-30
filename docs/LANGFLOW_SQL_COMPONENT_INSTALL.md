# Install the secure JSON SQL component

The exported `Production Analytics - SQL Pilot` flow uses Langflow's standard
SQL Database component. Its tool output is a `DataFrame`, and the Agent receives
a shortened display such as:

```text
production_date line_code ... hourly_record_count record_status
```

The hidden columns are not available to the model. This caused Sugi Bobot to
first invent values and, after the prompt was hardened, print placeholders.

## Replace the component

1. Open the `Production Analytics - SQL Pilot` flow in Langflow.
2. Add a Custom Component.
3. Replace its code with
   `langflow/components/secure_analytics_sql.py` from this repository.
4. Set **Database URL** to the existing `PRODUCTION_ANALYTICS_URL` global.
5. Connect **Secure Analytics SQL (JSON)** to the Agent's **Tools** input.
6. Remove the old **SQL Database** connection and component.
7. Save the flow.

The Agent tool must still be named `run_sql_query`. A successful result now has
this complete structure:

```json
{
  "status": "success",
  "row_count": 1,
  "rows": [
    {
      "production_date": "2026-07-28",
      "line_code": "ABB4",
      "plan_quantity": 169,
      "actual_quantity": 169
    }
  ]
}
```

No selected column is replaced by an ellipsis.

## Agent settings

Apply these settings while validating the flow:

- Streaming: **Off**
- Max iterations: **6**
- Number of chat-history messages: **10**
- Calculator tool: **Off** (PostgreSQL performs calculations)
- Current-date tool: **On**
- Handle parsing errors: **On**

Streaming may be reconsidered later only if the graph mechanically prevents
pre-tool answer generation.

## Database protection

The component rejects non-SELECT statements and references outside the approved
`analytics_v2` views. Keep using the restricted PostgreSQL analytics-reader role
as the real database security boundary; prompt instructions and query validation
are additional safeguards, not replacements for database permissions.

## Acceptance query

Ask:

> Analyze ABB4 production for 28 July 2026. Show plan, actual, good quantity,
> rejects, downtime, achievement, shift count, and hourly record count. Use only
> analytics_v2 READY data. Do not estimate or invent missing values.

The first tool call should query `analytics_v2.daily_line_summary`. Its JSON must
contain exactly one row with plan `169`, actual `169`, good `169`, rejects `0`,
downtime `0`, achievement `100.00`, shift count `2`, and hourly record count
`23`. No answer text should be generated before this JSON result is returned.

## GraphRecursionError with limit 17

Do not increase the recursion limit. With Agent maximum iterations set to 6,
Langflow derives a graph recursion limit of `6 * 2 + 5 = 17`. Reaching 17 means
the model repeatedly called tools instead of accepting a success, no-data, or
error result as a stop condition.

Pull the latest `CURRENT.md`, replace the complete Agent instructions, and start
a new Playground session. The current instructions contain deterministic routes
and status rules, including `VALID` for reject, downtime, and adjustment events
and `READY` for completed summary views.

For `Summarise this week's reject patterns`, the correct trace contains exactly:

1. One current-date tool call.
2. One SQL call to `analytics_v2.reject_events` using `record_status = 'VALID'`.
3. One final answer.

If the trace contains repeated SQL calls, capture their JSON tool results. The
first repeated `error_code` or zero-row result identifies the route the Agent is
failing to accept.
