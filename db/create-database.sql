SELECT 'CREATE DATABASE production_analytics'
WHERE NOT EXISTS (
  SELECT 1 FROM pg_database WHERE datname = 'production_analytics'
)\gexec
