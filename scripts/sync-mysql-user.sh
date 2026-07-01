#!/bin/sh
# Sync MySQL app user password with .env (run on the NUC / Dokploy host).
# Usage: sh scripts/sync-mysql-user.sh
# Requires: docker compose, .env with DB_* and MYSQL_ROOT_PASSWORD

set -e
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "Missing .env in project root"
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

DB_USER="${DB_USER:-video_app}"
DB_PASSWORD="${DB_PASSWORD:-video_app_password}"
DB_NAME="${DB_NAME:-video_portal}"
MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-root_password_change_me}"

echo "Syncing MySQL user ${DB_USER} for database ${DB_NAME}..."

docker compose exec -T db mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" <<EOSQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`;
CREATE USER IF NOT EXISTS '${DB_USER}'@'%' IDENTIFIED BY '${DB_PASSWORD}';
ALTER USER '${DB_USER}'@'%' IDENTIFIED BY '${DB_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'%';
FLUSH PRIVILEGES;
EOSQL

echo "Done. Testing login as ${DB_USER}..."
docker compose exec -T db mysql -u"${DB_USER}" -p"${DB_PASSWORD}" -e "SELECT 1 AS ok;" "${DB_NAME}"
echo "Restart app: docker compose restart app"
