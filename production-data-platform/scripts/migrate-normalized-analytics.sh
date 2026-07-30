#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

postgres_container="${PRODUCTION_POSTGRES_CONTAINER:-production-postgres}"
postgres_user="${POSTGRES_ADMIN_USER:-production_admin}"
postgres_database="${POSTGRES_DB:-production_analytics}"

docker exec -i "${postgres_container}" \
  psql \
    --username "${postgres_user}" \
    --dbname "${postgres_database}" \
    --set ON_ERROR_STOP=1 \
  < postgres/init/002-normalized-analytics.sql

docker exec -i "${postgres_container}" \
  psql \
    --username "${postgres_user}" \
    --dbname "${postgres_database}" \
    --set ON_ERROR_STOP=1 \
  < postgres/backfill/001-backfill-normalized-analytics.sql

docker exec -i "${postgres_container}" \
  psql \
    --username "${postgres_user}" \
    --dbname "${postgres_database}" \
    --set ON_ERROR_STOP=1 \
  < postgres/verification/normalized-analytics-checks.sql

echo "Normalized analytics migration, backfill, and verification completed."
