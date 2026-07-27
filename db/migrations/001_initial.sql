CREATE TABLE IF NOT EXISTS assistant.schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS assistant.users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ,
  CONSTRAINT users_email_normalized CHECK (email = LOWER(TRIM(email)))
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx
  ON assistant.users (email);

CREATE TABLE IF NOT EXISTS assistant.auth_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES assistant.users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_idx
  ON assistant.auth_sessions (user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS assistant.conversations (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES assistant.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  langflow_session_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS conversations_owner_updated_idx
  ON assistant.conversations (owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS assistant.messages (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES assistant.conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('streaming', 'complete', 'error', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
  ON assistant.messages (conversation_id, created_at, id);

CREATE TABLE IF NOT EXISTS assistant.runs (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES assistant.conversations(id) ON DELETE CASCADE,
  user_message_id UUID NOT NULL REFERENCES assistant.messages(id) ON DELETE CASCADE,
  assistant_message_id UUID NOT NULL REFERENCES assistant.messages(id) ON DELETE CASCADE,
  langflow_job_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('starting', 'queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out')),
  last_event_id TEXT,
  error_code TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_conversation_idx
  ON assistant.runs (conversation_id)
  WHERE status IN ('starting', 'queued', 'running');

CREATE TABLE IF NOT EXISTS assistant.run_steps (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES assistant.runs(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'complete', 'error')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,
  UNIQUE (run_id, ordinal)
);

CREATE TABLE IF NOT EXISTS assistant.audit_log (
  id UUID PRIMARY KEY,
  actor_user_id UUID REFERENCES assistant.users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_log_created_idx
  ON assistant.audit_log (created_at DESC);

REVOKE ALL ON SCHEMA assistant FROM PUBLIC;
GRANT USAGE ON SCHEMA assistant TO assistant_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA assistant TO assistant_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA assistant
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO assistant_app;

INSERT INTO assistant.schema_migrations (version)
VALUES ('001_initial')
ON CONFLICT (version) DO NOTHING;
