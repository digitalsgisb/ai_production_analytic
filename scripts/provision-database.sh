#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
test -f .env || { echo "Create .env from .env.example first." >&2; exit 1; }
set -a
. ./.env
set +a

: "${ASSISTANT_DB_PASSWORD:?ASSISTANT_DB_PASSWORD is required in .env}"
PRODUCTION_POSTGRES_CONTAINER="${PRODUCTION_POSTGRES_CONTAINER:-production-postgres}"

docker exec -i "${PRODUCTION_POSTGRES_CONTAINER}" \
  psql --set=ON_ERROR_STOP=1 \
  --username "${POSTGRES_ADMIN_USER:-production_admin}" \
  --dbname "${POSTGRES_DB:-production_analytics}" \
  --set=assistant_password="${ASSISTANT_DB_PASSWORD}" \
  < db/provision-role.sql

echo "The isolated assistant database role and schema are ready."
