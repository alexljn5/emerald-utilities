#!/bin/bash
set -euo pipefail

# db-start.sh - Start PostgreSQL via Docker Compose (WSL + Electron friendly)

echo "[DB] Starting PostgreSQL database..."

# Resolve the directory this script actually lives in (handles Windows paths from Electron)
SCRIPT_PATH="${BASH_SOURCE[0]}"
if [[ "$SCRIPT_PATH" == *:* ]]; then
    # Windows path → convert to WSL
    drive=$(echo "$SCRIPT_PATH" | cut -d: -f1 | tr '[:upper:]' '[:lower:]')
    rest=$(echo "$SCRIPT_PATH" | cut -d: -f2- | tr '\\' '/')
    SCRIPT_PATH="/mnt/$drive$rest"
fi

SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"

# The database folder is always one level up from internal-scripts
DB_DIR="$SCRIPT_DIR/../database"

if [[ ! -f "$DB_DIR/docker-compose.yml" ]]; then
    echo "[DB] ERROR: Could not find docker-compose.yml at $DB_DIR" >&2
    exit 1
fi

echo "[DB] Database directory: $DB_DIR"

# Make sure Docker is available
if ! command -v docker >/dev/null 2>&1; then
    echo "[DB] ERROR: docker command not found in WSL." >&2
    exit 127
fi

# Start (or ensure) Docker daemon if needed
if [[ ! -S /var/run/docker.sock ]]; then
    echo "[DB] Docker socket missing — trying to start daemon..."
    sudo service docker start 2>/dev/null || nohup sudo dockerd --host=unix:///var/run/docker.sock >/tmp/dockerd.log 2>&1 &
    sleep 3
fi

# Move to the compose file location and start
cd "$DB_DIR"
echo "[DB] Running: docker compose up -d"
docker compose up -d

# Wait for Postgres to be ready
echo "[DB] Waiting for PostgreSQL to accept connections..."
for i in {1..30}; do
    if docker compose exec -T postgres pg_isready -U emerald -d emerald_utilities >/dev/null 2>&1; then
        echo "[DB] PostgreSQL is ready."
        exit 0
    fi
    echo "[DB] Waiting... ($i/30)"
    sleep 1
done

echo "[DB] ERROR: PostgreSQL did not become ready in time." >&2
exit 1