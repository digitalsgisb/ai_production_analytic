#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ -z "${ANALYTICS_DB_USER:-}" ]]; then
  echo "Set ANALYTICS_DB_USER to the existing read-only Langflow database role." >&2
  exit 1
fi

if [[ ! "${ANALYTICS_DB_USER}" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]]; then
  echo "ANALYTICS_DB_USER is not a valid PostgreSQL role name." >&2
  exit 1
fi

postgres_container="${PRODUCTION_POSTGRES_CONTAINER:-production-postgres}"
postgres_user="${POSTGRES_ADMIN_USER:-production_admin}"
postgres_database="${POSTGRES_DB:-production_analytics}"

docker exec -i "${postgres_container}" \
  psql \
    --username "${postgres_user}" \
    --dbname "${postgres_database}" \
    --set ON_ERROR_STOP=1 \
    --set "analytics_role=${ANALYTICS_DB_USER}" \
  < postgres/permissions/grant-analytics-reader.sql

echo "Read-only analytics access granted to ${ANALYTICS_DB_USER}."
