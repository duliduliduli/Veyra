#!/usr/bin/env bash
# Start a local Postgres 16 and create the dev role/database (idempotent).
set -euo pipefail
if command -v service >/dev/null && [ "$(id -u)" = 0 ]; then
  service postgresql start >/dev/null
  su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='veyra'\"" | grep -q 1 ||
    su postgres -c "psql -c \"CREATE ROLE veyra LOGIN SUPERUSER PASSWORD 'veyra'\""
  su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='veyra'\"" | grep -q 1 ||
    su postgres -c "createdb -O veyra veyra"
else
  docker run -d --name veyra-pg -e POSTGRES_USER=veyra -e POSTGRES_PASSWORD=veyra \
    -e POSTGRES_DB=veyra -p 5432:5432 postgres:16 >/dev/null
fi
echo "postgresql://veyra:veyra@localhost:5432/veyra"
