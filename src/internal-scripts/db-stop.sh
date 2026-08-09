#!/usr/bin/env bash

# db-stop.sh - Stop the PostgreSQL database container via Docker.
# Cross-platform: works on native Linux, macOS (Docker Desktop) and WSL.
# Usage: db-stop.sh [database-dir]

set -euo pipefail

# =========================
# Docker CLI check
# =========================
if ! command -v docker >/dev/null 2>&1; then
    echo "[DB] ERROR: docker not found in PATH." >&2
    exit 127
fi

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

# Load environment variables from .env
if [[ -f .env ]]; then
    echo "[DB] Loading environment from .env"
    set -a
    source .env
    set +a
fi

docker compose down

echo "[DB] PostgreSQL stopped."
