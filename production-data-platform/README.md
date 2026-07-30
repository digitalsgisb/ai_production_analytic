# Production analytics v2 migration package

This package adds typed, AI-safe production tables and views to the existing
ATOM PostgreSQL database. It does not contain the ingest API or Docker Compose
stack and does not replace the legacy `analytics` schema.

## Resulting schemas

- `ingest.events` remains the immutable raw audit source.
- `analytics` remains untouched for rollback and comparison.
- `analytics_v2` contains normalized facts and verified AI-facing views.

The AI-facing sources are:

- `analytics_v2.daily_line_summary`
- `analytics_v2.shift_summary`
- `analytics_v2.hourly_output`
- `analytics_v2.downtime_events`
- `analytics_v2.downtime_summary`
- `analytics_v2.reject_events`
- `analytics_v2.count_adjustments`
- `analytics_v2.data_quality_issues`
- `analytics_v2.shift_end_events`
- `analytics_v2.model_performance`

## Deploy after a normal Git pull on ATOM

```bash
cd /srv/apps/sugi-prod-analytic/production-data-platform

docker exec production-postgres \
  pg_dump -U production_admin -d production_analytics -Fc \
  > "production_analytics-before-v2-$(date +%Y%m%d-%H%M%S).dump"

chmod 750 scripts/*.sh
./scripts/migrate-normalized-analytics.sh
```

The migration script installs the idempotent schema, normalizes historical
events, and prints reconciliation checks. Review every row returned from
`analytics_v2.normalization_errors` and `analytics_v2.data_quality_issues`.

Grant the existing Langflow database role read-only access only after the checks
are acceptable:

```bash
ANALYTICS_DB_USER=YOUR_EXISTING_LANGFLOW_DB_ROLE \
  ./scripts/grant-analytics-reader.sh
```

Finally replace the deployed Langflow Agent Instructions with
`../docs/ai-instructions/CURRENT.md`. Keep Langflow on the legacy instruction
until the migration and backfill have completed successfully.

## Safety properties

- New raw events normalize automatically through an `AFTER INSERT` trigger.
- A failed normalization never deletes the raw event.
- Each normalized fact retains its `source_event_id` lineage.
- The AI role receives `SELECT` access and defaults to read-only transactions.
- Final reports require `record_status = 'READY'`.
