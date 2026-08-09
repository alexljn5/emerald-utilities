#!/usr/bin/env bash
set -euo pipefail

# stop_db.sh — Stop Emerald PostgreSQL database via Docker (keeps data volume)
# Usage: stop_db.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_DIR="$SCRIPT_DIR"

echo "[DB] Using: $DB_DIR"

if [[ ! -f "$DB_DIR/docker-compose.yml" ]]; then
    echo "[DB] ERROR: docker-compose.yml not found in $DB_DIR" >&2
    exit 1
fi

cd "$DB_DIR"

# Load environment variables from .env
if [[ -f .env ]]; then
    set -a
    source .env
    set +a
fi

echo "[DB] Stopping Emerald PostgreSQL database (keeping data volume)..."
echo "[DB] Running: docker compose down"

docker compose down

echo "[DB] PostgreSQL stopped. Data volume preserved."
echo "[DB] To restart: ./start_postgres.sh"
