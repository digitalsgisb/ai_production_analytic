SELECT format(
  'CREATE ROLE assistant_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L',
  :'assistant_password'
)
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = 'assistant_app'
)\gexec

ALTER ROLE assistant_app PASSWORD :'assistant_password';
GRANT CONNECT ON DATABASE production_analytics TO assistant_app;
CREATE SCHEMA IF NOT EXISTS assistant AUTHORIZATION assistant_app;
ALTER SCHEMA assistant OWNER TO assistant_app;
REVOKE ALL ON SCHEMA assistant FROM PUBLIC;
