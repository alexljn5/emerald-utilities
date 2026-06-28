#!/usr/bin/env bash
set -euo pipefail

# --- Windows → WSL path fix (if needed) ---
if [[ "$0" =~ ^[A-Za-z]:\\ ]]; then
    SCRIPT_PATH=$(wslpath "$0")
    exec bash "$SCRIPT_PATH" "$@"
fi

# --- Resolve script directory ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_DIR="$SCRIPT_DIR"

# --- Allow custom database directory via argument ---
if [[ -n "${1:-}" ]]; then
    DB_DIR="$(realpath "$1")"
fi

echo "[DB] Using: $DB_DIR"

# --- Validate compose file ---
if [[ ! -f "$DB_DIR/docker-compose.yml" ]]; then
    echo "[DB] ERROR: docker-compose.yml not found in $DB_DIR" >&2
    exit 1
fi

cd "$DB_DIR"

# --- Load env (optional) ---
if [[ -f .env ]]; then
    set -a
    source .env
    set +a
fi

# --- Start services ---
echo "[DB] Starting PostgreSQL via docker compose..."
docker compose up -d

# --- Wait for readiness ---
POSTGRES_USER="${POSTGRES_USER:-alexljn5}"
POSTGRES_DB="${POSTGRES_DB:-emerald_utilities}"

echo "[DB] Waiting for PostgreSQL..."

for i in {1..30}; do
    if docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
        echo "[DB] PostgreSQL ready."
        
        # --- Apply database schema (envy.sql) ---
        if [[ -f envy.sql ]]; then
            echo "[DB] Applying database schema from envy.sql..."
            cat envy.sql | docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" 2>/dev/null || \
                echo "[DB] Note: Schema may already be applied (this is normal for existing databases)"
        fi
        
        exit 0
    fi
    sleep 1
done

echo "[DB] ERROR: PostgreSQL not ready after timeout." >&2
exit 1