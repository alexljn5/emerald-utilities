#!/bin/bash
# stop_db.sh - Stop PostgreSQL database via Docker (keeps data volume)
# Usage: stop_db.sh

set -euo pipefail

echo "[DB] Stopping PostgreSQL database (keeping data volume)..."

# Load environment variables from .env
if [[ -f .env ]]; then
    set -a
    source .env
    set +a
fi

# Use defaults if not set
POSTGRES_USER="${POSTGRES_USER:-alexljn5}"
POSTGRES_DB="${POSTGRES_DB:-emerald_utilities}"

echo "[DB] Running: docker compose down"
docker compose down

echo "[DB] PostgreSQL stopped. Data volume preserved."