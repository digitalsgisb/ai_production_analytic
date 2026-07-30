\set ON_ERROR_STOP on

DO $$
DECLARE
  event_record RECORD;
  processed_count BIGINT := 0;
BEGIN
  FOR event_record IN
    SELECT source.event_id
    FROM ingest.events AS source
    LEFT JOIN analytics_v2.normalization_errors AS errors
      ON errors.source_event_id = source.event_id
    LEFT JOIN analytics_v2.hourly_production AS hourly
      ON hourly.source_event_id = source.event_id
    LEFT JOIN analytics_v2.production_runs AS runs
      ON runs.source_event_id = source.event_id
    LEFT JOIN analytics_v2.reject_events AS rejects
      ON rejects.source_event_id = source.event_id
    LEFT JOIN analytics_v2.downtime_events AS downtime
      ON downtime.source_event_id = source.event_id
    LEFT JOIN analytics_v2.process_parameter_events AS parameters
      ON parameters.source_event_id = source.event_id
    LEFT JOIN analytics_v2.count_adjustments AS adjustments
      ON adjustments.source_event_id = source.event_id
    WHERE source.event_type IN (
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
      AND (
        errors.source_event_id IS NOT NULL
        OR (
          source.event_type IN ('shift.started', 'shift.updated', 'shift.ended')
          AND NOT EXISTS (
            SELECT 1
            FROM analytics_v2.production_shifts AS shifts
            WHERE shifts.line_code = source.line_code
              AND shifts.shift_id = source.shift_id
          )
        )
        OR (source.event_type = 'model.configured' AND runs.source_event_id IS NULL)
        OR (source.event_type = 'hourly.finalized' AND hourly.source_event_id IS NULL)
        OR (source.event_type = 'reject.recorded' AND rejects.source_event_id IS NULL)
        OR (source.event_type = 'downtime.recorded' AND downtime.source_event_id IS NULL)
        OR (source.event_type = 'parameter.recorded' AND parameters.source_event_id IS NULL)
        OR (source.event_type = 'count.adjusted' AND adjustments.source_event_id IS NULL)
      )
    ORDER BY source.occurred_at, source.event_id
  LOOP
    PERFORM analytics_v2.normalize_event(event_record.event_id);
    processed_count := processed_count + 1;

    IF processed_count % 10000 = 0 THEN
      RAISE NOTICE 'Processed % events', processed_count;
    END IF;
  END LOOP;

  RAISE NOTICE 'Normalized backfill processed % candidate events', processed_count;
END;
$$;

SELECT
  event_type,
  COUNT(*) AS failed_events,
  MIN(occurred_at) AS oldest_failure,
  MAX(occurred_at) AS newest_failure
FROM analytics_v2.normalization_errors
GROUP BY event_type
ORDER BY failed_events DESC, event_type;
