#!/bin/bash
set -euo pipefail

# =========================
# WSL detection
# =========================
if ! grep -qi microsoft /proc/version 2>/dev/null; then
    echo "[DB] ERROR: This script must run inside WSL." >&2
    exit 1
fi

# =========================
# Docker CLI check
# =========================
if ! command -v docker >/dev/null 2>&1; then
    echo "[DB] ERROR: docker not found in PATH." >&2
    exit 127
fi

# =========================
# Ensure Docker daemon is ready
# =========================
ensure_docker() {
    if docker info >/dev/null 2>&1; then
        echo "[DB] Docker is ready."
        return 0
    fi

    echo "[DB] Docker not ready, attempting start..."

    if sudo service docker start >/dev/null 2>&1; then
        echo "[DB] Docker service started."
    else
        nohup sudo dockerd --host=unix:///var/run/docker.sock > /tmp/dockerd.log 2>&1 &
        echo "[DB] dockerd started (fallback)."
    fi

    for i in {1..30}; do
        if docker info >/dev/null 2>&1; then
            echo "[DB] Docker ready."
            return 0
        fi
        sleep 1
    done

    echo "[DB] ERROR: Docker failed to start." >&2
    exit 1
}

ensure_docker

# =========================
# Resolve database directory
# =========================
# When run via `wsl bash -s <db-dir>`, $1 is the database directory passed from Electron.
# When run directly, fall back to script-relative path.
if [[ -n "${1:-}" ]]; then
    DB_DIR="$1"
else
    SCRIPT_PATH="${BASH_SOURCE[0]}"
    if [[ "$SCRIPT_PATH" == *:* ]]; then
        drive=$(echo "$SCRIPT_PATH" | cut -d: -f1 | tr '[:upper:]' '[:lower:]')
        rest=$(echo "$SCRIPT_PATH" | cut -d: -f2- | tr '\\' '/')
        SCRIPT_PATH="/mnt/$drive$rest"
    fi
    SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
    DB_DIR="$SCRIPT_DIR/../database"
fi

echo "[DB] Database directory: $DB_DIR"
echo "[DB] Looking for: $DB_DIR/docker-compose.yml"

if [[ ! -f "$DB_DIR/docker-compose.yml" ]]; then
    echo "[DB] ERROR: docker-compose.yml not found at $DB_DIR/docker-compose.yml" >&2
    echo "[DB] Contents of DB_DIR:" >&2
    ls -la "$DB_DIR" 2>&1 || true
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

# Use defaults if not set
POSTGRES_USER="${POSTGRES_USER:-alexljn5}"
POSTGRES_DB="${POSTGRES_DB:-emerald_utilities}"

echo "[DB] Starting PostgreSQL..."
docker compose up -d

# =========================
# Wait for Postgres
# =========================
for i in {1..30}; do
    if docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
        echo "[DB] PostgreSQL ready."
        
        # =========================
        # Apply database schema (envy.sql)
        # =========================
        if [[ -f envy.sql ]]; then
            echo "[DB] Applying database schema from envy.sql..."
            cat envy.sql | docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" 2>/dev/null || \
                echo "[DB] Note: Schema may already be applied (this is normal for existing databases)"
        fi
        
        exit 0
    fi
    echo "[DB] Waiting... ($i/30)"
    sleep 1
done

echo "[DB] ERROR: PostgreSQL not ready." >&2
exit 1
