#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
set -a
. ./.env
set +a

BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="${BACKUP_DIR}/assistant-${STAMP}.dump"

docker exec "${PRODUCTION_POSTGRES_CONTAINER:-production-postgres}" \
  pg_dump --username "${POSTGRES_ADMIN_USER:-production_admin}" \
  --dbname "${POSTGRES_DB:-production_analytics}" \
  --schema assistant --format custom > "${FILE}"

chmod 600 "${FILE}"
find "${BACKUP_DIR}" -type f -name 'assistant-*.dump' -mtime +"${BACKUP_RETENTION_DAYS:-14}" -delete
echo "Assistant backup created: ${FILE}"
