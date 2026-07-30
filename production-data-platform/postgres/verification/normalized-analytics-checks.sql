\set ON_ERROR_STOP on

SELECT
  'raw_supported_events' AS check_name,
  COUNT(*) AS record_count
FROM ingest.events
WHERE event_type IN (
  'shift.started',
  'shift.updated',
  'shift.ended',
  'model.configured',
  'hourly.finalized',
  'reject.recorded',
  'downtime.recorded',
  'parameter.recorded',
  'count.adjusted'
)
UNION ALL
SELECT
  'normalization_errors',
  COUNT(*)
FROM analytics_v2.normalization_errors;

SELECT
  event_type,
  line_code,
  shift_id,
  occurred_at,
  error_message,
  failure_count
FROM analytics_v2.normalization_errors
ORDER BY occurred_at DESC
LIMIT 100;

SELECT
  production_date,
  line_code,
  shift_id,
  shift_name,
  plan_quantity,
  actual_quantity,
  good_quantity,
  reject_quantity,
  downtime_minutes,
  achievement_percent,
  reported_shift_output,
  output_reconciliation_variance,
  hourly_record_count,
  record_status
FROM analytics_v2.shift_summary
ORDER BY production_date DESC, line_code, shift_id
LIMIT 100;

WITH hourly AS (
  SELECT
    production_date,
    line_code,
    shift_id,
    SUM(plan_quantity) AS hourly_plan,
    SUM(actual_quantity) AS hourly_actual
  FROM analytics_v2.hourly_output
  GROUP BY production_date, line_code, shift_id
)
SELECT
  summary.production_date,
  summary.line_code,
  summary.shift_id,
  hourly.hourly_plan,
  summary.plan_quantity AS summary_plan,
  hourly.hourly_actual,
  summary.actual_quantity AS summary_actual
FROM analytics_v2.shift_summary AS summary
JOIN hourly
  ON hourly.production_date = summary.production_date
 AND hourly.line_code = summary.line_code
 AND hourly.shift_id = summary.shift_id
WHERE hourly.hourly_plan IS DISTINCT FROM summary.plan_quantity
   OR hourly.hourly_actual IS DISTINCT FROM summary.actual_quantity
ORDER BY summary.production_date DESC, summary.line_code, summary.shift_id;
