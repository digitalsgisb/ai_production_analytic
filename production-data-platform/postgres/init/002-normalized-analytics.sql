BEGIN;

CREATE SCHEMA IF NOT EXISTS analytics_v2;

REVOKE CREATE ON SCHEMA analytics_v2 FROM PUBLIC;

CREATE OR REPLACE FUNCTION analytics_v2.try_numeric(value TEXT)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
BEGIN
  IF value IS NULL OR BTRIM(value) = '' THEN
    RETURN NULL;
  END IF;

  RETURN value::NUMERIC;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION analytics_v2.try_integer(value TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
BEGIN
  IF value IS NULL OR BTRIM(value) = '' THEN
    RETURN NULL;
  END IF;

  RETURN value::INTEGER;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION analytics_v2.invalid_numeric(value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT value IS NOT NULL
     AND BTRIM(value) <> ''
     AND analytics_v2.try_numeric(value) IS NULL;
$$;

CREATE OR REPLACE FUNCTION analytics_v2.try_date(value TEXT)
RETURNS DATE
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
BEGIN
  IF value IS NULL OR BTRIM(value) = '' THEN
    RETURN NULL;
  END IF;

  RETURN value::DATE;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION analytics_v2.try_timestamptz(value TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
AS $$
BEGIN
  IF value IS NULL OR BTRIM(value) = '' THEN
    RETURN NULL;
  END IF;

  RETURN value::TIMESTAMPTZ;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION analytics_v2.try_boolean(value TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
BEGIN
  IF value IS NULL OR BTRIM(value) = '' THEN
    RETURN NULL;
  END IF;

  RETURN value::BOOLEAN;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION analytics_v2.production_date_from_shift_id(value TEXT)
RETURNS DATE
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  compact_date TEXT;
BEGIN
  compact_date := SUBSTRING(value FROM '^([0-9]{8})');
  IF compact_date IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN TO_DATE(compact_date, 'YYYYMMDD');
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
  RETURN NULL;
END;
$$;

CREATE TABLE IF NOT EXISTS analytics_v2.production_shifts (
  line_code TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  production_date DATE NOT NULL,
  source_line TEXT,
  shift_name TEXT,
  group_name TEXT,
  working_time TEXT,
  overtime BOOLEAN NOT NULL DEFAULT FALSE,
  scheduled_end_at TIMESTAMPTZ,
  supervisor TEXT,
  line_leader TEXT,
  forming_operators TEXT,
  waterjet_operators TEXT,
  assembly_operators TEXT,
  quality_inspector TEXT,
  model_code TEXT,
  lot_number TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  end_reason TEXT,
  reported_shift_output NUMERIC,
  reported_model_output NUMERIC,
  reported_rejects NUMERIC,
  record_status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (record_status IN ('ACTIVE', 'ENDED', 'INCOMPLETE')),
  source_start_event_id TEXT REFERENCES ingest.events(event_id),
  source_last_event_id TEXT NOT NULL REFERENCES ingest.events(event_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (line_code, shift_id)
);

CREATE TABLE IF NOT EXISTS analytics_v2.production_runs (
  source_event_id TEXT PRIMARY KEY REFERENCES ingest.events(event_id),
  line_code TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  production_date DATE NOT NULL,
  model_code TEXT NOT NULL,
  lot_number TEXT,
  target_quantity NUMERIC CHECK (target_quantity IS NULL OR target_quantity >= 0),
  standard_cycle_minutes NUMERIC
    CHECK (standard_cycle_minutes IS NULL OR standard_cycle_minutes > 0),
  configured_at TIMESTAMPTZ NOT NULL,
  record_status TEXT NOT NULL DEFAULT 'VALID'
    CHECK (record_status IN ('VALID', 'INCOMPLETE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS analytics_v2.hourly_production (
  source_event_id TEXT PRIMARY KEY REFERENCES ingest.events(event_id),
  line_code TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  production_date DATE NOT NULL,
  source_line TEXT,
  shift_name TEXT,
  hour_slot TEXT NOT NULL,
  hour_start_at TIMESTAMPTZ,
  hour_end_at TIMESTAMPTZ,
  model_code TEXT,
  lot_number TEXT,
  plan_quantity NUMERIC CHECK (plan_quantity IS NULL OR plan_quantity >= 0),
  actual_quantity NUMERIC CHECK (actual_quantity IS NULL OR actual_quantity >= 0),
  rest_minutes NUMERIC CHECK (rest_minutes IS NULL OR rest_minutes >= 0),
  finalization_reason TEXT,
  finalized_at TIMESTAMPTZ NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  delivery_attempt_count INTEGER NOT NULL,
  record_status TEXT NOT NULL DEFAULT 'VALID'
    CHECK (record_status IN ('VALID', 'INCOMPLETE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS analytics_v2.reject_events (
  source_event_id TEXT PRIMARY KEY REFERENCES ingest.events(event_id),
  line_code TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  production_date DATE NOT NULL,
  hour_slot TEXT NOT NULL,
  slab_quantity NUMERIC,
  slab_code TEXT,
  return_roll_quantity NUMERIC,
  oht_number TEXT,
  reject_quantity NUMERIC,
  reject_code TEXT,
  loft_quantity NUMERIC,
  loft_code TEXT,
  recorded_at TIMESTAMPTZ NOT NULL,
  record_status TEXT NOT NULL DEFAULT 'VALID'
    CHECK (record_status IN ('VALID', 'INCOMPLETE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS analytics_v2.downtime_events (
  source_event_id TEXT PRIMARY KEY REFERENCES ingest.events(event_id),
  line_code TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  production_date DATE NOT NULL,
  hour_slot TEXT NOT NULL,
  category TEXT,
  code TEXT,
  downtime_minutes NUMERIC CHECK (downtime_minutes IS NULL OR downtime_minutes >= 0),
  description TEXT,
  remarks TEXT,
  recorded_at TIMESTAMPTZ NOT NULL,
  record_status TEXT NOT NULL DEFAULT 'VALID'
    CHECK (record_status IN ('VALID', 'INCOMPLETE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS analytics_v2.process_parameter_events (
  source_event_id TEXT PRIMARY KEY REFERENCES ingest.events(event_id),
  line_code TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  production_date DATE NOT NULL,
  model_code TEXT,
  heating TEXT,
  cooling TEXT,
  shuttle TEXT,
  waterjet TEXT,
  temperature_rh NUMERIC,
  temperature_ctr NUMERIC,
  temperature_lh NUMERIC,
  glue_standard NUMERIC,
  glue_actual NUMERIC,
  recorded_at TIMESTAMPTZ NOT NULL,
  record_status TEXT NOT NULL DEFAULT 'VALID'
    CHECK (record_status IN ('VALID', 'INCOMPLETE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS analytics_v2.count_adjustments (
  source_event_id TEXT PRIMARY KEY REFERENCES ingest.events(event_id),
  line_code TEXT NOT NULL,
  shift_id TEXT NOT NULL,
  production_date DATE NOT NULL,
  adjustment INTEGER NOT NULL,
  hourly_output_after NUMERIC,
  model_output_after NUMERIC,
  shift_output_after NUMERIC,
  reason TEXT,
  operator_name TEXT,
  recorded_at TIMESTAMPTZ NOT NULL,
  record_status TEXT NOT NULL DEFAULT 'VALID'
    CHECK (record_status IN ('VALID', 'INCOMPLETE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS analytics_v2.normalization_errors (
  source_event_id TEXT PRIMARY KEY REFERENCES ingest.events(event_id),
  event_type TEXT NOT NULL,
  line_code TEXT NOT NULL,
  shift_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  error_message TEXT NOT NULL,
  first_failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  failure_count INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS production_shifts_date_line_idx
  ON analytics_v2.production_shifts (production_date DESC, line_code, shift_name);

CREATE INDEX IF NOT EXISTS hourly_production_date_line_idx
  ON analytics_v2.hourly_production (production_date DESC, line_code, shift_name);

CREATE INDEX IF NOT EXISTS hourly_production_shift_time_idx
  ON analytics_v2.hourly_production (line_code, shift_id, finalized_at);

CREATE INDEX IF NOT EXISTS hourly_production_model_date_idx
  ON analytics_v2.hourly_production (model_code, production_date DESC);

CREATE INDEX IF NOT EXISTS reject_events_shift_slot_idx
  ON analytics_v2.reject_events (line_code, shift_id, hour_slot);

CREATE INDEX IF NOT EXISTS reject_events_date_line_idx
  ON analytics_v2.reject_events (production_date DESC, line_code);

CREATE INDEX IF NOT EXISTS downtime_events_shift_slot_idx
  ON analytics_v2.downtime_events (line_code, shift_id, hour_slot);

CREATE INDEX IF NOT EXISTS downtime_events_date_line_idx
  ON analytics_v2.downtime_events (production_date DESC, line_code);

CREATE INDEX IF NOT EXISTS parameter_events_shift_time_idx
  ON analytics_v2.process_parameter_events (line_code, shift_id, recorded_at);

CREATE INDEX IF NOT EXISTS count_adjustments_shift_time_idx
  ON analytics_v2.count_adjustments (line_code, shift_id, recorded_at);

CREATE INDEX IF NOT EXISTS count_adjustments_date_line_idx
  ON analytics_v2.count_adjustments (production_date DESC, line_code);

CREATE INDEX IF NOT EXISTS normalization_errors_date_line_idx
  ON analytics_v2.normalization_errors (occurred_at DESC, line_code, event_type);

CREATE INDEX IF NOT EXISTS ingest_events_occurred_at_brin_idx
  ON ingest.events USING BRIN (occurred_at);

CREATE INDEX IF NOT EXISTS hourly_production_occurred_at_brin_idx
  ON analytics_v2.hourly_production USING BRIN (occurred_at);

CREATE INDEX IF NOT EXISTS downtime_events_recorded_at_brin_idx
  ON analytics_v2.downtime_events USING BRIN (recorded_at);

CREATE INDEX IF NOT EXISTS reject_events_recorded_at_brin_idx
  ON analytics_v2.reject_events USING BRIN (recorded_at);

CREATE OR REPLACE FUNCTION analytics_v2.normalize_event(p_event_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ingest, analytics
AS $$
DECLARE
  event_row ingest.events%ROWTYPE;
  event_payload JSONB;
  production_day DATE;
  normalized_shift_id TEXT;
BEGIN
  SELECT *
  INTO event_row
  FROM ingest.events
  WHERE event_id = p_event_id;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  event_payload := event_row.payload;
  normalized_shift_id := NULLIF(BTRIM(event_row.shift_id), '');
  production_day := COALESCE(
    analytics_v2.try_date(event_payload->>'date'),
    analytics_v2.try_date(event_payload#>>'{shift,date}'),
    analytics_v2.production_date_from_shift_id(normalized_shift_id),
    (event_row.occurred_at AT TIME ZONE 'Asia/Kuala_Lumpur')::DATE
  );

  BEGIN
    CASE
      WHEN event_row.event_type IN ('shift.started', 'shift.updated') THEN
        INSERT INTO analytics_v2.production_shifts (
          line_code,
          shift_id,
          production_date,
          source_line,
          shift_name,
          group_name,
          working_time,
          overtime,
          scheduled_end_at,
          supervisor,
          line_leader,
          forming_operators,
          waterjet_operators,
          assembly_operators,
          quality_inspector,
          model_code,
          lot_number,
          started_at,
          record_status,
          source_start_event_id,
          source_last_event_id
        ) VALUES (
          event_row.line_code,
          normalized_shift_id,
          production_day,
          NULLIF(event_payload#>>'{shift,line}', ''),
          NULLIF(event_payload#>>'{shift,shift}', ''),
          NULLIF(event_payload#>>'{shift,group}', ''),
          NULLIF(event_payload#>>'{shift,workingTime}', ''),
          COALESCE(analytics_v2.try_boolean(event_payload#>>'{shift,overtime}'), FALSE),
          analytics_v2.try_timestamptz(event_payload#>>'{shift,scheduled_end_at}'),
          NULLIF(event_payload#>>'{shift,supervisor}', ''),
          NULLIF(event_payload#>>'{shift,leader}', ''),
          NULLIF(event_payload#>>'{shift,forming}', ''),
          NULLIF(event_payload#>>'{shift,waterjet}', ''),
          NULLIF(event_payload#>>'{shift,assembly}', ''),
          NULLIF(event_payload#>>'{shift,quality}', ''),
          NULLIF(event_payload#>>'{shift,model}', ''),
          NULLIF(event_payload#>>'{shift,lot_number}', ''),
          event_row.occurred_at,
          CASE
            WHEN normalized_shift_id IS NULL
              OR NULLIF(event_payload#>>'{shift,shift}', '') IS NULL
              THEN 'INCOMPLETE'
            ELSE 'ACTIVE'
          END,
          CASE WHEN event_row.event_type = 'shift.started' THEN event_row.event_id END,
          event_row.event_id
        )
        ON CONFLICT (line_code, shift_id) DO UPDATE SET
          production_date = EXCLUDED.production_date,
          source_line = COALESCE(EXCLUDED.source_line, analytics_v2.production_shifts.source_line),
          shift_name = COALESCE(EXCLUDED.shift_name, analytics_v2.production_shifts.shift_name),
          group_name = COALESCE(EXCLUDED.group_name, analytics_v2.production_shifts.group_name),
          working_time = COALESCE(EXCLUDED.working_time, analytics_v2.production_shifts.working_time),
          overtime = EXCLUDED.overtime,
          scheduled_end_at = COALESCE(EXCLUDED.scheduled_end_at, analytics_v2.production_shifts.scheduled_end_at),
          supervisor = COALESCE(EXCLUDED.supervisor, analytics_v2.production_shifts.supervisor),
          line_leader = COALESCE(EXCLUDED.line_leader, analytics_v2.production_shifts.line_leader),
          forming_operators = COALESCE(EXCLUDED.forming_operators, analytics_v2.production_shifts.forming_operators),
          waterjet_operators = COALESCE(EXCLUDED.waterjet_operators, analytics_v2.production_shifts.waterjet_operators),
          assembly_operators = COALESCE(EXCLUDED.assembly_operators, analytics_v2.production_shifts.assembly_operators),
          quality_inspector = COALESCE(EXCLUDED.quality_inspector, analytics_v2.production_shifts.quality_inspector),
          model_code = COALESCE(EXCLUDED.model_code, analytics_v2.production_shifts.model_code),
          lot_number = COALESCE(EXCLUDED.lot_number, analytics_v2.production_shifts.lot_number),
          started_at = COALESCE(analytics_v2.production_shifts.started_at, EXCLUDED.started_at),
          record_status = CASE
            WHEN analytics_v2.production_shifts.record_status = 'ENDED' THEN 'ENDED'
            ELSE EXCLUDED.record_status
          END,
          source_start_event_id = COALESCE(
            analytics_v2.production_shifts.source_start_event_id,
            EXCLUDED.source_start_event_id
          ),
          source_last_event_id = EXCLUDED.source_last_event_id,
          updated_at = NOW();

      WHEN event_row.event_type = 'shift.ended' THEN
        INSERT INTO analytics_v2.production_shifts (
          line_code,
          shift_id,
          production_date,
          source_line,
          model_code,
          lot_number,
          overtime,
          scheduled_end_at,
          ended_at,
          end_reason,
          reported_shift_output,
          reported_model_output,
          reported_rejects,
          record_status,
          source_last_event_id
        ) VALUES (
          event_row.line_code,
          normalized_shift_id,
          production_day,
          NULLIF(event_payload->>'source_line', ''),
          NULLIF(event_payload->>'model', ''),
          NULLIF(event_payload->>'lot_number', ''),
          COALESCE(analytics_v2.try_boolean(event_payload->>'overtime'), FALSE),
          analytics_v2.try_timestamptz(event_payload->>'scheduled_end_at'),
          COALESCE(analytics_v2.try_timestamptz(event_payload->>'ended_at'), event_row.occurred_at),
          NULLIF(event_payload->>'end_reason', ''),
          analytics_v2.try_numeric(event_payload->>'shift_total_output'),
          analytics_v2.try_numeric(event_payload->>'model_total_output'),
          analytics_v2.try_numeric(event_payload->>'total_rejects'),
          'ENDED',
          event_row.event_id
        )
        ON CONFLICT (line_code, shift_id) DO UPDATE SET
          production_date = EXCLUDED.production_date,
          source_line = COALESCE(EXCLUDED.source_line, analytics_v2.production_shifts.source_line),
          model_code = COALESCE(EXCLUDED.model_code, analytics_v2.production_shifts.model_code),
          lot_number = COALESCE(EXCLUDED.lot_number, analytics_v2.production_shifts.lot_number),
          overtime = EXCLUDED.overtime,
          scheduled_end_at = COALESCE(EXCLUDED.scheduled_end_at, analytics_v2.production_shifts.scheduled_end_at),
          ended_at = EXCLUDED.ended_at,
          end_reason = EXCLUDED.end_reason,
          reported_shift_output = EXCLUDED.reported_shift_output,
          reported_model_output = EXCLUDED.reported_model_output,
          reported_rejects = EXCLUDED.reported_rejects,
          record_status = 'ENDED',
          source_last_event_id = EXCLUDED.source_last_event_id,
          updated_at = NOW();

      WHEN event_row.event_type = 'model.configured' THEN
        INSERT INTO analytics_v2.production_runs (
          source_event_id,
          line_code,
          shift_id,
          production_date,
          model_code,
          lot_number,
          target_quantity,
          standard_cycle_minutes,
          configured_at,
          record_status
        ) VALUES (
          event_row.event_id,
          event_row.line_code,
          normalized_shift_id,
          production_day,
          NULLIF(event_payload->>'model', ''),
          NULLIF(event_payload->>'lot_number', ''),
          analytics_v2.try_numeric(event_payload->>'target'),
          analytics_v2.try_numeric(event_payload->>'standard_cycle'),
          event_row.occurred_at,
          CASE
            WHEN normalized_shift_id IS NULL OR NULLIF(event_payload->>'model', '') IS NULL
              OR analytics_v2.invalid_numeric(event_payload->>'target')
              OR analytics_v2.invalid_numeric(event_payload->>'standard_cycle')
              THEN 'INCOMPLETE'
            ELSE 'VALID'
          END
        )
        ON CONFLICT (source_event_id) DO NOTHING;

      WHEN event_row.event_type = 'hourly.finalized' THEN
        INSERT INTO analytics_v2.hourly_production (
          source_event_id,
          line_code,
          shift_id,
          production_date,
          source_line,
          shift_name,
          hour_slot,
          hour_start_at,
          hour_end_at,
          model_code,
          lot_number,
          plan_quantity,
          actual_quantity,
          rest_minutes,
          finalization_reason,
          finalized_at,
          occurred_at,
          received_at,
          delivery_attempt_count,
          record_status
        ) VALUES (
          event_row.event_id,
          event_row.line_code,
          normalized_shift_id,
          production_day,
          NULLIF(event_payload->>'line', ''),
          NULLIF(event_payload->>'shift', ''),
          NULLIF(event_payload->>'hour_slot', ''),
          analytics_v2.try_timestamptz(event_payload->>'hour_start_at'),
          analytics_v2.try_timestamptz(event_payload->>'hour_end_at'),
          NULLIF(event_payload->>'model', ''),
          NULLIF(event_payload->>'lot_number', ''),
          analytics_v2.try_numeric(event_payload->>'plan'),
          analytics_v2.try_numeric(event_payload->>'actual'),
          analytics_v2.try_numeric(event_payload->>'rest_time'),
          NULLIF(event_payload->>'reason', ''),
          COALESCE(analytics_v2.try_timestamptz(event_payload->>'finalized_at'), event_row.occurred_at),
          event_row.occurred_at,
          event_row.received_at,
          event_row.attempt_count,
          CASE
            WHEN normalized_shift_id IS NULL
              OR NULLIF(event_payload->>'hour_slot', '') IS NULL
              OR analytics_v2.try_numeric(event_payload->>'plan') IS NULL
              OR analytics_v2.try_numeric(event_payload->>'actual') IS NULL
              OR analytics_v2.invalid_numeric(event_payload->>'rest_time')
              THEN 'INCOMPLETE'
            ELSE 'VALID'
          END
        )
        ON CONFLICT (source_event_id) DO NOTHING;

      WHEN event_row.event_type = 'reject.recorded' THEN
        INSERT INTO analytics_v2.reject_events (
          source_event_id,
          line_code,
          shift_id,
          production_date,
          hour_slot,
          slab_quantity,
          slab_code,
          return_roll_quantity,
          oht_number,
          reject_quantity,
          reject_code,
          loft_quantity,
          loft_code,
          recorded_at,
          record_status
        ) VALUES (
          event_row.event_id,
          event_row.line_code,
          normalized_shift_id,
          production_day,
          NULLIF(event_payload->>'hour_slot', ''),
          analytics_v2.try_numeric(event_payload->>'slab_quantity'),
          NULLIF(event_payload->>'slab_code', ''),
          analytics_v2.try_numeric(event_payload->>'return_roll_quantity'),
          NULLIF(event_payload->>'oht_number', ''),
          analytics_v2.try_numeric(event_payload->>'ng_quantity'),
          NULLIF(event_payload->>'ng_code', ''),
          analytics_v2.try_numeric(event_payload->>'loft_quantity'),
          NULLIF(event_payload->>'loft_code', ''),
          event_row.occurred_at,
          CASE
            WHEN normalized_shift_id IS NULL
              OR NULLIF(event_payload->>'hour_slot', '') IS NULL
              OR analytics_v2.invalid_numeric(event_payload->>'slab_quantity')
              OR analytics_v2.invalid_numeric(event_payload->>'return_roll_quantity')
              OR analytics_v2.invalid_numeric(event_payload->>'ng_quantity')
              OR analytics_v2.invalid_numeric(event_payload->>'loft_quantity')
              THEN 'INCOMPLETE'
            ELSE 'VALID'
          END
        )
        ON CONFLICT (source_event_id) DO NOTHING;

      WHEN event_row.event_type = 'downtime.recorded' THEN
        INSERT INTO analytics_v2.downtime_events (
          source_event_id,
          line_code,
          shift_id,
          production_date,
          hour_slot,
          category,
          code,
          downtime_minutes,
          description,
          remarks,
          recorded_at,
          record_status
        ) VALUES (
          event_row.event_id,
          event_row.line_code,
          normalized_shift_id,
          production_day,
          NULLIF(event_payload->>'hour_slot', ''),
          NULLIF(event_payload->>'category', ''),
          NULLIF(event_payload->>'code', ''),
          analytics_v2.try_numeric(event_payload->>'duration_minutes'),
          NULLIF(event_payload->>'description', ''),
          NULLIF(event_payload->>'remarks', ''),
          event_row.occurred_at,
          CASE
            WHEN normalized_shift_id IS NULL
              OR NULLIF(event_payload->>'hour_slot', '') IS NULL
              OR analytics_v2.try_numeric(event_payload->>'duration_minutes') IS NULL
              THEN 'INCOMPLETE'
            ELSE 'VALID'
          END
        )
        ON CONFLICT (source_event_id) DO NOTHING;

      WHEN event_row.event_type = 'parameter.recorded' THEN
        INSERT INTO analytics_v2.process_parameter_events (
          source_event_id,
          line_code,
          shift_id,
          production_date,
          model_code,
          heating,
          cooling,
          shuttle,
          waterjet,
          temperature_rh,
          temperature_ctr,
          temperature_lh,
          glue_standard,
          glue_actual,
          recorded_at,
          record_status
        ) VALUES (
          event_row.event_id,
          event_row.line_code,
          normalized_shift_id,
          production_day,
          NULLIF(event_payload->>'model', ''),
          NULLIF(event_payload->>'heating', ''),
          NULLIF(event_payload->>'cooling', ''),
          NULLIF(event_payload->>'shuttle', ''),
          NULLIF(event_payload->>'waterjet', ''),
          analytics_v2.try_numeric(event_payload->>'rh'),
          analytics_v2.try_numeric(event_payload->>'ctr'),
          analytics_v2.try_numeric(event_payload->>'lh'),
          analytics_v2.try_numeric(event_payload->>'glue_standard'),
          analytics_v2.try_numeric(event_payload->>'glue_actual'),
          event_row.occurred_at,
          CASE
            WHEN normalized_shift_id IS NULL
              OR analytics_v2.invalid_numeric(event_payload->>'rh')
              OR analytics_v2.invalid_numeric(event_payload->>'ctr')
              OR analytics_v2.invalid_numeric(event_payload->>'lh')
              OR analytics_v2.invalid_numeric(event_payload->>'glue_standard')
              OR analytics_v2.invalid_numeric(event_payload->>'glue_actual')
              THEN 'INCOMPLETE'
            ELSE 'VALID'
          END
        )
        ON CONFLICT (source_event_id) DO NOTHING;

      WHEN event_row.event_type = 'count.adjusted' THEN
        INSERT INTO analytics_v2.count_adjustments (
          source_event_id,
          line_code,
          shift_id,
          production_date,
          adjustment,
          hourly_output_after,
          model_output_after,
          shift_output_after,
          reason,
          operator_name,
          recorded_at,
          record_status
        ) VALUES (
          event_row.event_id,
          event_row.line_code,
          normalized_shift_id,
          production_day,
          analytics_v2.try_integer(event_payload->>'adjustment'),
          analytics_v2.try_numeric(event_payload->>'hourly_output_after'),
          analytics_v2.try_numeric(event_payload->>'model_output_after'),
          analytics_v2.try_numeric(event_payload->>'shift_output_after'),
          NULLIF(event_payload->>'reason', ''),
          NULLIF(event_payload->>'operator', ''),
          event_row.occurred_at,
          CASE
            WHEN normalized_shift_id IS NULL
              OR NULLIF(event_payload->>'reason', '') IS NULL
              OR NULLIF(event_payload->>'operator', '') IS NULL
              THEN 'INCOMPLETE'
            ELSE 'VALID'
          END
        )
        ON CONFLICT (source_event_id) DO NOTHING;

      ELSE
        NULL;
    END CASE;

    DELETE FROM analytics_v2.normalization_errors
    WHERE source_event_id = event_row.event_id;

    RETURN TRUE;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO analytics_v2.normalization_errors (
      source_event_id,
      event_type,
      line_code,
      shift_id,
      occurred_at,
      error_message
    ) VALUES (
      event_row.event_id,
      event_row.event_type,
      event_row.line_code,
      event_row.shift_id,
      event_row.occurred_at,
      SQLERRM
    )
    ON CONFLICT (source_event_id) DO UPDATE SET
      error_message = EXCLUDED.error_message,
      last_failed_at = NOW(),
      failure_count = analytics_v2.normalization_errors.failure_count + 1;

    RETURN FALSE;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION analytics_v2.normalize_event_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, ingest, analytics
AS $$
BEGIN
  PERFORM analytics_v2.normalize_event(NEW.event_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS normalize_ingested_event ON ingest.events;

CREATE TRIGGER normalize_ingested_event
AFTER INSERT ON ingest.events
FOR EACH ROW
EXECUTE FUNCTION analytics_v2.normalize_event_trigger();

CREATE OR REPLACE VIEW analytics_v2.hourly_output AS
WITH hourly AS (
  SELECT
    production_date,
    line_code,
    shift_id,
    MAX(shift_name) AS shift_name,
    hour_slot,
    MIN(hour_start_at) AS hour_start_at,
    MAX(hour_end_at) AS hour_end_at,
    STRING_AGG(DISTINCT model_code, ', ' ORDER BY model_code)
      FILTER (WHERE model_code IS NOT NULL) AS model_codes,
    STRING_AGG(DISTINCT lot_number, ', ' ORDER BY lot_number)
      FILTER (WHERE lot_number IS NOT NULL) AS lot_numbers,
    SUM(COALESCE(plan_quantity, 0)) AS plan_quantity,
    SUM(COALESCE(actual_quantity, 0)) AS actual_quantity,
    SUM(COALESCE(rest_minutes, 0)) AS rest_minutes,
    STRING_AGG(DISTINCT finalization_reason, '; ' ORDER BY finalization_reason)
      FILTER (WHERE finalization_reason IS NOT NULL) AS finalization_reasons,
    MIN(finalized_at) AS first_finalized_at,
    MAX(finalized_at) AS last_finalized_at,
    MIN(occurred_at) AS first_occurred_at,
    MAX(received_at) AS last_received_at,
    ARRAY_AGG(source_event_id ORDER BY occurred_at, source_event_id) AS source_event_ids,
    COUNT(*) AS source_event_count,
    COUNT(*) FILTER (WHERE record_status <> 'VALID') AS incomplete_source_count
  FROM analytics_v2.hourly_production
  GROUP BY production_date, line_code, shift_id, hour_slot
),
rejects AS (
  SELECT
    production_date,
    line_code,
    shift_id,
    hour_slot,
    SUM(COALESCE(reject_quantity, 0)) AS reject_quantity,
    COUNT(*) AS reject_record_count
  FROM analytics_v2.reject_events
  WHERE record_status = 'VALID'
  GROUP BY production_date, line_code, shift_id, hour_slot
),
downtime AS (
  SELECT
    production_date,
    line_code,
    shift_id,
    hour_slot,
    SUM(COALESCE(downtime_minutes, 0)) AS downtime_minutes,
    COUNT(*) AS downtime_record_count
  FROM analytics_v2.downtime_events
  WHERE record_status = 'VALID'
  GROUP BY production_date, line_code, shift_id, hour_slot
)
SELECT
  hourly.production_date,
  hourly.line_code,
  hourly.shift_id,
  hourly.shift_name,
  hourly.hour_slot,
  hourly.hour_start_at,
  hourly.hour_end_at,
  hourly.model_codes,
  hourly.lot_numbers,
  hourly.plan_quantity,
  hourly.actual_quantity,
  hourly.actual_quantity - COALESCE(rejects.reject_quantity, 0) AS good_quantity,
  COALESCE(rejects.reject_quantity, 0) AS reject_quantity,
  COALESCE(downtime.downtime_minutes, 0) AS downtime_minutes,
  COALESCE(rejects.reject_record_count, 0) AS reject_record_count,
  COALESCE(downtime.downtime_record_count, 0) AS downtime_record_count,
  hourly.rest_minutes,
  hourly.finalization_reasons,
  hourly.first_finalized_at,
  hourly.last_finalized_at,
  hourly.first_occurred_at,
  hourly.last_received_at,
  hourly.source_event_ids,
  hourly.source_event_count,
  CASE
    WHEN hourly.incomplete_source_count > 0 THEN 'INCOMPLETE'
    ELSE 'READY'
  END AS record_status
FROM hourly
LEFT JOIN rejects
  ON rejects.production_date = hourly.production_date
 AND rejects.line_code = hourly.line_code
 AND rejects.shift_id = hourly.shift_id
 AND rejects.hour_slot = hourly.hour_slot
LEFT JOIN downtime
  ON downtime.production_date = hourly.production_date
 AND downtime.line_code = hourly.line_code
 AND downtime.shift_id = hourly.shift_id
 AND downtime.hour_slot = hourly.hour_slot;

CREATE OR REPLACE VIEW analytics_v2.shift_summary AS
WITH hourly AS (
  SELECT
    line_code,
    shift_id,
    production_date,
    MAX(shift_name) AS shift_name,
    SUM(COALESCE(plan_quantity, 0)) AS plan_quantity,
    SUM(COALESCE(actual_quantity, 0)) AS actual_quantity,
    COUNT(*) AS hourly_record_count,
    COUNT(*) FILTER (WHERE record_status <> 'VALID') AS incomplete_hourly_records,
    MIN(occurred_at) AS first_hourly_event_at,
    MAX(occurred_at) AS last_hourly_event_at
  FROM analytics_v2.hourly_production
  GROUP BY line_code, shift_id, production_date
),
rejects AS (
  SELECT
    line_code,
    shift_id,
    production_date,
    SUM(COALESCE(reject_quantity, 0)) AS reject_quantity,
    COUNT(*) AS reject_record_count,
    COUNT(*) FILTER (WHERE record_status <> 'VALID') AS incomplete_reject_records
  FROM analytics_v2.reject_events
  GROUP BY line_code, shift_id, production_date
),
downtime AS (
  SELECT
    line_code,
    shift_id,
    production_date,
    SUM(COALESCE(downtime_minutes, 0)) AS downtime_minutes,
    COUNT(*) AS downtime_record_count,
    COUNT(*) FILTER (WHERE record_status <> 'VALID') AS incomplete_downtime_records
  FROM analytics_v2.downtime_events
  GROUP BY line_code, shift_id, production_date
),
adjustments AS (
  SELECT
    line_code,
    shift_id,
    production_date,
    SUM(adjustment) AS net_count_adjustment,
    COUNT(*) AS adjustment_record_count,
    COUNT(*) FILTER (WHERE record_status <> 'VALID') AS incomplete_adjustment_records
  FROM analytics_v2.count_adjustments
  GROUP BY line_code, shift_id, production_date
),
normalization_failures AS (
  SELECT
    line_code,
    shift_id,
    COUNT(*) AS normalization_error_count
  FROM analytics_v2.normalization_errors
  WHERE shift_id IS NOT NULL
  GROUP BY line_code, shift_id
),
keys AS (
  SELECT line_code, shift_id, production_date FROM analytics_v2.production_shifts
  UNION
  SELECT line_code, shift_id, production_date FROM hourly
  UNION
  SELECT line_code, shift_id, production_date FROM rejects
  UNION
  SELECT line_code, shift_id, production_date FROM downtime
  UNION
  SELECT
    failures.line_code,
    failures.shift_id,
    COALESCE(
      shifts.production_date,
      analytics_v2.production_date_from_shift_id(failures.shift_id)
    ) AS production_date
  FROM normalization_failures AS failures
  LEFT JOIN analytics_v2.production_shifts AS shifts
    ON shifts.line_code = failures.line_code
   AND shifts.shift_id = failures.shift_id
  WHERE COALESCE(
    shifts.production_date,
    analytics_v2.production_date_from_shift_id(failures.shift_id)
  ) IS NOT NULL
)
SELECT
  keys.production_date,
  keys.line_code,
  keys.shift_id,
  COALESCE(shifts.shift_name, hourly.shift_name) AS shift_name,
  shifts.group_name,
  shifts.working_time,
  shifts.started_at,
  shifts.ended_at,
  shifts.end_reason,
  COALESCE(hourly.plan_quantity, 0) AS plan_quantity,
  COALESCE(hourly.actual_quantity, 0) AS actual_quantity,
  COALESCE(hourly.actual_quantity, 0) - COALESCE(rejects.reject_quantity, 0) AS good_quantity,
  COALESCE(rejects.reject_quantity, 0) AS reject_quantity,
  COALESCE(downtime.downtime_minutes, 0) AS downtime_minutes,
  CASE
    WHEN COALESCE(hourly.plan_quantity, 0) = 0 THEN NULL
    ELSE ROUND(100 * hourly.actual_quantity / hourly.plan_quantity, 2)
  END AS achievement_percent,
  CASE
    WHEN COALESCE(hourly.actual_quantity, 0) = 0 THEN NULL
    ELSE ROUND(100 * COALESCE(rejects.reject_quantity, 0) / hourly.actual_quantity, 2)
  END AS reject_percent,
  COALESCE(adjustments.net_count_adjustment, 0) AS net_count_adjustment,
  COALESCE(hourly.hourly_record_count, 0) AS hourly_record_count,
  COALESCE(rejects.reject_record_count, 0) AS reject_record_count,
  COALESCE(downtime.downtime_record_count, 0) AS downtime_record_count,
  COALESCE(adjustments.adjustment_record_count, 0) AS adjustment_record_count,
  COALESCE(normalization_failures.normalization_error_count, 0) AS normalization_error_count,
  shifts.reported_shift_output,
  shifts.reported_rejects,
  COALESCE(hourly.actual_quantity, 0) - shifts.reported_shift_output AS output_reconciliation_variance,
  CASE
    WHEN COALESCE(normalization_failures.normalization_error_count, 0) > 0
      THEN 'NORMALIZATION_ERROR'
    WHEN COALESCE(hourly.hourly_record_count, 0) = 0 THEN 'NO_HOURLY_DATA'
    WHEN COALESCE(hourly.incomplete_hourly_records, 0)
       + COALESCE(rejects.incomplete_reject_records, 0)
       + COALESCE(downtime.incomplete_downtime_records, 0)
       + COALESCE(adjustments.incomplete_adjustment_records, 0) > 0
      THEN 'INCOMPLETE'
    WHEN shifts.ended_at IS NULL THEN 'OPEN_SHIFT'
    WHEN shifts.reported_shift_output IS NULL THEN 'INCOMPLETE'
    WHEN COALESCE(hourly.actual_quantity, 0) <> shifts.reported_shift_output
      THEN 'RECONCILIATION_FAILED'
    ELSE 'READY'
  END AS record_status,
  hourly.first_hourly_event_at,
  hourly.last_hourly_event_at
FROM keys
LEFT JOIN analytics_v2.production_shifts AS shifts
  ON shifts.line_code = keys.line_code
 AND shifts.shift_id = keys.shift_id
LEFT JOIN hourly
  ON hourly.line_code = keys.line_code
 AND hourly.shift_id = keys.shift_id
 AND hourly.production_date = keys.production_date
LEFT JOIN rejects
  ON rejects.line_code = keys.line_code
 AND rejects.shift_id = keys.shift_id
 AND rejects.production_date = keys.production_date
LEFT JOIN downtime
  ON downtime.line_code = keys.line_code
 AND downtime.shift_id = keys.shift_id
 AND downtime.production_date = keys.production_date
LEFT JOIN adjustments
  ON adjustments.line_code = keys.line_code
 AND adjustments.shift_id = keys.shift_id
 AND adjustments.production_date = keys.production_date
LEFT JOIN normalization_failures
  ON normalization_failures.line_code = keys.line_code
 AND normalization_failures.shift_id = keys.shift_id;

CREATE OR REPLACE VIEW analytics_v2.downtime_summary AS
SELECT
  production_date,
  line_code,
  shift_id,
  hour_slot,
  category,
  code AS downtime_code,
  SUM(COALESCE(downtime_minutes, 0)) AS downtime_minutes,
  COUNT(*) AS downtime_event_count,
  MIN(recorded_at) AS first_recorded_at,
  MAX(recorded_at) AS last_recorded_at,
  CASE
    WHEN COUNT(*) FILTER (WHERE record_status <> 'VALID') > 0 THEN 'INCOMPLETE'
    ELSE 'READY'
  END AS record_status
FROM analytics_v2.downtime_events
GROUP BY production_date, line_code, shift_id, hour_slot, category, code;

CREATE OR REPLACE VIEW analytics_v2.shift_end_events AS
SELECT
  production_date,
  line_code,
  shift_id,
  shift_name,
  ended_at,
  end_reason,
  reported_shift_output,
  reported_model_output,
  reported_rejects,
  source_last_event_id,
  record_status
FROM analytics_v2.production_shifts
WHERE ended_at IS NOT NULL;

CREATE OR REPLACE VIEW analytics_v2.model_performance AS
SELECT
  production_date,
  line_code,
  shift_id,
  MAX(shift_name) AS shift_name,
  model_code,
  lot_number,
  SUM(COALESCE(plan_quantity, 0)) AS plan_quantity,
  SUM(COALESCE(actual_quantity, 0)) AS actual_quantity,
  CASE
    WHEN SUM(COALESCE(plan_quantity, 0)) = 0 THEN NULL
    ELSE ROUND(
      100 * SUM(COALESCE(actual_quantity, 0)) /
      SUM(COALESCE(plan_quantity, 0)),
      2
    )
  END AS achievement_percent,
  COUNT(*) AS source_event_count,
  MIN(finalized_at) AS first_finalized_at,
  MAX(finalized_at) AS last_finalized_at,
  CASE
    WHEN COUNT(*) FILTER (WHERE record_status <> 'VALID') > 0 THEN 'INCOMPLETE'
    ELSE 'READY'
  END AS record_status
FROM analytics_v2.hourly_production
WHERE model_code IS NOT NULL
GROUP BY production_date, line_code, shift_id, model_code, lot_number;

CREATE OR REPLACE VIEW analytics_v2.data_quality_issues AS
SELECT
  'NORMALIZATION_ERROR'::TEXT AS issue_code,
  'critical'::TEXT AS severity,
  COALESCE(
    analytics_v2.production_date_from_shift_id(errors.shift_id),
    (errors.occurred_at AT TIME ZONE 'Asia/Kuala_Lumpur')::DATE
  ) AS production_date,
  errors.line_code,
  errors.shift_id,
  errors.source_event_id,
  errors.occurred_at,
  errors.error_message AS detail
FROM analytics_v2.normalization_errors AS errors
UNION ALL
SELECT
  'INCOMPLETE_HOURLY_EVENT'::TEXT AS issue_code,
  'warning'::TEXT AS severity,
  hourly.production_date,
  hourly.line_code,
  hourly.shift_id,
  hourly.source_event_id,
  hourly.occurred_at,
  'A required hourly value is missing or invalid.'::TEXT AS detail
FROM analytics_v2.hourly_production AS hourly
WHERE hourly.record_status <> 'VALID'
UNION ALL
SELECT
  'SHIFT_' || summary.record_status AS issue_code,
  CASE
    WHEN summary.record_status IN ('NORMALIZATION_ERROR', 'RECONCILIATION_FAILED')
      THEN 'critical'
    ELSE 'warning'
  END AS severity,
  summary.production_date,
  summary.line_code,
  summary.shift_id,
  NULL::TEXT AS source_event_id,
  COALESCE(summary.last_hourly_event_at, summary.ended_at, summary.started_at) AS occurred_at,
  CASE summary.record_status
    WHEN 'NO_HOURLY_DATA' THEN 'No finalized hourly production was found.'
    WHEN 'OPEN_SHIFT' THEN 'The shift has not ended, so final totals are unavailable.'
    WHEN 'RECONCILIATION_FAILED' THEN 'Hourly actual does not match reported shift output.'
    WHEN 'NORMALIZATION_ERROR' THEN 'At least one source event failed normalization.'
    ELSE 'One or more required shift values are incomplete.'
  END AS detail
FROM analytics_v2.shift_summary AS summary
WHERE summary.record_status <> 'READY';

CREATE OR REPLACE VIEW analytics_v2.daily_line_summary AS
SELECT
  production_date,
  line_code,
  SUM(plan_quantity) AS plan_quantity,
  SUM(actual_quantity) AS actual_quantity,
  SUM(good_quantity) AS good_quantity,
  SUM(reject_quantity) AS reject_quantity,
  SUM(downtime_minutes) AS downtime_minutes,
  CASE
    WHEN SUM(plan_quantity) = 0 THEN NULL
    ELSE ROUND(100 * SUM(actual_quantity) / SUM(plan_quantity), 2)
  END AS achievement_percent,
  CASE
    WHEN SUM(actual_quantity) = 0 THEN NULL
    ELSE ROUND(100 * SUM(reject_quantity) / SUM(actual_quantity), 2)
  END AS reject_percent,
  SUM(net_count_adjustment) AS net_count_adjustment,
  SUM(hourly_record_count) AS hourly_record_count,
  COUNT(*) AS shift_count,
  COUNT(*) FILTER (WHERE record_status = 'READY') AS ready_shift_count,
  CASE
    WHEN COUNT(*) FILTER (WHERE record_status <> 'READY') = 0 THEN 'READY'
    ELSE 'REVIEW_REQUIRED'
  END AS record_status
FROM analytics_v2.shift_summary
GROUP BY production_date, line_code;

COMMENT ON SCHEMA analytics_v2 IS
  'Typed, AI-safe production facts and verified summaries derived from ingest.events.';

COMMENT ON TABLE analytics_v2.hourly_production IS
  'One row per source hourly.finalized event. Multiple rows may share an hour slot after a model change.';

COMMENT ON VIEW analytics_v2.hourly_output IS
  'Primary flat hourly source for AI analysis; never infer line or shift from model_code.';

COMMENT ON VIEW analytics_v2.shift_summary IS
  'One row per production_date, line_code, and shift_id with SQL-calculated KPIs and quality status.';

COMMENT ON VIEW analytics_v2.daily_line_summary IS
  'One row per production_date and line_code. Use only READY rows for final reporting.';

COMMENT ON VIEW analytics_v2.data_quality_issues IS
  'AI-facing quality exceptions. The assistant must not present affected scopes as final.';

REVOKE ALL ON ALL TABLES IN SCHEMA analytics_v2 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA analytics_v2 FROM PUBLIC;

COMMIT;
