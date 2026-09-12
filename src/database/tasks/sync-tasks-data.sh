#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# sync-tasks-data.sh — JSON ↔ PostgreSQL Tasks Reconciliation
# ============================================================
# This script is invoked by start_postgres.sh AFTER merge-sins.sh.
# It reconciles legacy JSON task data with PostgreSQL and refreshes
# the JSON mirror from the authoritative PostgreSQL state.
#
# Safe to run repeatedly. Idempotent.
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$DB_DIR"

# Load env
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

POSTGRES_USER="${POSTGRES_USER:-emerald-user}"
POSTGRES_DB="${POSTGRES_DB:-emerald_utilities}"

log() {
    echo "[sync-tasks-data] $*"
}

fail() {
    echo "[sync-tasks-data] ERROR: $*" >&2
    exit 1
}

# Verify PostgreSQL is ready
log "Checking PostgreSQL readiness..."
if ! docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    fail "PostgreSQL is not ready. Aborting sync."
fi
log "PostgreSQL is ready."

# Determine JSON directory
# In production, Electron stores JSON in userData/tasks-data.
# For CLI sync, we use TASKS_JSON_DIR if provided, otherwise default.
JSON_DIR="${TASKS_JSON_DIR:-$DB_DIR/tasks-data}"
log "Using JSON directory: $JSON_DIR"

# Run the Node.js sync script
log "Running JSON ↔ PostgreSQL reconciliation..."
if node "$SCRIPT_DIR/sync-tasks-data-cli.js" --no-backup; then
    log "Reconciliation completed successfully."
else
    fail "Reconciliation failed. Check output above."
fi

log "Sync-tasks-data completed successfully."
exit 0
