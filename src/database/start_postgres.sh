#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# start_postgres.sh — Canonical Emerald PostgreSQL bootstrap
# ============================================================
# This is the single entry point for starting the database from
# the repository. It:
#   1. Resolves its own directory dynamically
#   2. Loads .env if present
#   3. Starts Docker Compose (detached)
#   4. Waits for PostgreSQL readiness
#   5. Invokes merge-sins.sh for schema/migration verification
#   6. Invokes sync-tasks-data.sh for JSON ↔ PostgreSQL reconciliation
#   7. Reports status
#
# Safe to run repeatedly. Never wipes data.
# Works from any working directory.
# ============================================================

# --- Resolve script directory (portable, no hardcoded paths) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_DIR="$SCRIPT_DIR"

echo "[DB] Using: $DB_DIR"

# --- Validate compose file ---
if [[ ! -f "$DB_DIR/docker-compose.yml" ]]; then
    echo "[DB] ERROR: docker-compose.yml not found in $DB_DIR" >&2
    exit 1
fi

cd "$DB_DIR"

# --- Load env (optional) ---
# Look for .env in the database directory first, then parent (src/.env)
if [[ -f .env ]]; then
    set -a
    source .env
    set +a
elif [[ -f ../.env ]]; then
    set -a
    source ../.env
    set +a
fi

# --- Start services (detached) ---
echo "[DB] Starting PostgreSQL via docker compose..."
docker compose up -d

# --- Wait for readiness ---
POSTGRES_USER="${POSTGRES_USER:-alexljn5}"
POSTGRES_DB="${POSTGRES_DB:-emerald_utilities}"

echo "[DB] Waiting for PostgreSQL..."

for i in $(seq 1 60); do
    if docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
        echo "[DB] PostgreSQL ready."

        # --- Report database info ---
        DB_NAME=$(docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT current_database();" 2>/dev/null | tr -d '[:space:]' || echo "unknown")
        DB_VERSION=$(docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT version();" 2>/dev/null | tr -d '[:space:]' | cut -d' ' -f2 || echo "unknown")

        # Get volume info
        VOLUME_NAME=$(docker compose ps -q postgres 2>/dev/null | xargs docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' 2>/dev/null || echo "unknown")

        echo "[DB] Database: $DB_NAME"
        echo "[DB] User:     $POSTGRES_USER"
        echo "[DB] Version:  $DB_VERSION"
        echo "[DB] Volume:   $VOLUME_NAME"

        # --- Report grok_messages count (non-destructive) ---
        ROWS=$(docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
            -tAc "SELECT COUNT(*) FROM grok_messages;" 2>/dev/null || echo "unknown")
        echo "[DB] grok_messages row count: ${ROWS}"

        # --- Run merge-sins.sh for schema/migration verification ---
        echo "[DB] Running merge-sins.sh..."
        if [[ -f "$DB_DIR/merge-sins.sh" ]]; then
            if bash "$DB_DIR/merge-sins.sh"; then
                echo "[DB] merge-sins.sh completed successfully."
            else
                echo "[DB] ERROR: merge-sins.sh failed. Check output above." >&2
                echo "[DB] Database container is running but schema may be incomplete." >&2
                exit 1
            fi
        else
            echo "[DB] ERROR: merge-sins.sh not found at $DB_DIR/merge-sins.sh" >&2
            exit 1
        fi

        # --- Run sync-tasks-data.sh for JSON ↔ PostgreSQL reconciliation ---
        echo "[DB] Running sync-tasks-data.sh..."
        if [[ -f "$DB_DIR/tasks/sync-tasks-data.sh" ]]; then
            if bash "$DB_DIR/tasks/sync-tasks-data.sh"; then
                echo "[DB] sync-tasks-data.sh completed successfully."
            else
                echo "[DB] WARNING: sync-tasks-data.sh failed. Tasks may be in degraded mode." >&2
                echo "[DB] Database is running; check sync logs above." >&2
                # Do not exit 1 — the database itself is healthy
            fi
        else
            echo "[DB] WARNING: sync-tasks-data.sh not found at $DB_DIR/tasks/sync-tasks-data.sh" >&2
            echo "[DB] Skipping tasks data synchronization." >&2
        fi

        echo "[DB] Database startup complete."
        exit 0
    fi
    sleep 1
done

echo "[DB] ERROR: PostgreSQL not ready after timeout." >&2
exit 1
