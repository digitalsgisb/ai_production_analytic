\set ON_ERROR_STOP on

GRANT USAGE ON SCHEMA analytics_v2 TO :"analytics_role";
GRANT SELECT ON ALL TABLES IN SCHEMA analytics_v2 TO :"analytics_role";
GRANT EXECUTE ON FUNCTION analytics_v2.production_date_from_shift_id(TEXT)
  TO :"analytics_role";

ALTER DEFAULT PRIVILEGES IN SCHEMA analytics_v2
  GRANT SELECT ON TABLES TO :"analytics_role";

ALTER ROLE :"analytics_role" SET default_transaction_read_only = ON;
