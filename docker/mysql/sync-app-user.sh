#!/bin/bash
set -euo pipefail

ROOT_PW="${MYSQL_ROOT_PASSWORD:?MYSQL_ROOT_PASSWORD is required}"
DB_USER="${DB_USER:-video_app}"
DB_PASS="${DB_PASSWORD:?DB_PASSWORD is required}"
DB_NAME="${DB_NAME:-video_portal}"

echo "[db-init] Syncing MySQL user '${DB_USER}' for database '${DB_NAME}'..."

mysql -h db -uroot -p"${ROOT_PW}" --connect-timeout=15 <<EOSQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`;
CREATE USER IF NOT EXISTS '${DB_USER}'@'%' IDENTIFIED BY '${DB_PASS}';
ALTER USER '${DB_USER}'@'%' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'%';
FLUSH PRIVILEGES;
EOSQL

mysql -h db -u"${DB_USER}" -p"${DB_PASS}" --connect-timeout=15 -e "SELECT 1 AS ok;" "${DB_NAME}"
echo "[db-init] MySQL user sync complete."
