#!/bin/bash
set -euo pipefail

# HARD REQUIRE WSL
if ! grep -qi microsoft /proc/version 2>/dev/null; then
    echo "[DB] ERROR: This script must run inside WSL." >&2
    exit 1
fi

# =========================
# Ensure Docker CLI exists
# =========================
if ! command -v docker >/dev/null 2>&1; then
    echo "[DB] ERROR: docker not found in PATH." >&2
    exit 127
fi

# =========================
# Ensure Docker daemon is ready
# (NO systemctl, NO dockerd fallback)
# =========================
if ! docker info >/dev/null 2>&1; then
    echo "[DB] ERROR: Docker daemon is not reachable."

    if $IS_WSL; then
        echo "[DB] Running inside WSL."
        echo "[DB] Fix required: start Docker via system service OR Docker Desktop."
    fi

    exit 1
else
    echo "[DB] Docker daemon is ready."
fi

# =========================
# Resolve script directory
# =========================
SCRIPT_PATH="${BASH_SOURCE[0]}"

if [[ "$SCRIPT_PATH" == *:* ]]; then
    drive=$(echo "$SCRIPT_PATH" | cut -d: -f1 | tr '[:upper:]' '[:lower:]')
    rest=$(echo "$SCRIPT_PATH" | cut -d: -f2- | tr '\\' '/')
    SCRIPT_PATH="/mnt/$drive$rest"
fi

SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
DB_DIR="$SCRIPT_DIR/../database"

if [[ ! -f "$DB_DIR/docker-compose.yml" ]]; then
    echo "[DB] ERROR: docker-compose.yml not found at $DB_DIR" >&2
    exit 1
fi

cd "$DB_DIR"

echo "[DB] Starting PostgreSQL..."
docker compose up -d

# =========================
# Wait for Postgres
# =========================
for i in {1..30}; do
    if docker compose exec -T postgres pg_isready -U emerald -d emerald_utilities >/dev/null 2>&1; then
        echo "[DB] PostgreSQL ready."
        exit 0
    fi
    echo "[DB] Waiting... ($i/30)"
    sleep 1
done

echo "[DB] ERROR: PostgreSQL not ready." >&2
exit 1