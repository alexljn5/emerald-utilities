#!/bin/bash

# db-stop.sh - Stop PostgreSQL database via Docker in WSL
# Usage: db-stop.sh [database-dir]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_DIR="${1:-$(dirname "$SCRIPT_DIR")/database}"

# Convert Windows path to WSL path if needed
if [[ "$DB_DIR" == *[A-Za-z]:\\* ]]; then
    DRIVE=$(echo "$DB_DIR" | cut -d: -f1 | tr '[:upper:]' '[:lower:]')
    REST=$(echo "$DB_DIR" | cut -d: -f2 | tr '\\' '/')
    DB_DIR="/mnt/$DRIVE$REST"
fi

echo "[DB] Stopping PostgreSQL database..."
echo "[DB] Database directory: $DB_DIR"

if [[ ! -f "$DB_DIR/docker-compose.yml" ]]; then
    echo "[DB] ERROR: docker-compose.yml not found in $DB_DIR" >&2
    exit 1
fi

cd "$DB_DIR"
docker compose down

echo "[DB] PostgreSQL stopped."
