#!/usr/bin/env bash
set -euo pipefail

# db-restore.sh — Restore a PostgreSQL logical backup
# DELIBERATELY DESTRUCTIVE. Requires explicit confirmation.
# NEVER runs automatically.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$DB_DIR"

# Load env
if [[ -f .env ]]; then
    set -a
    source .env
    set +a
fi

POSTGRES_USER="${POSTGRES_USER:-emerald-user}"
POSTGRES_DB="${POSTGRES_DB:-emerald_utilities}"

# --- Validate arguments ---
if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <backup-file.dump>"
    echo ""
    echo "Example:"
    echo "  $0 backups/emerald_utilities_2026-08-08_120000.dump"
    exit 1
fi

BACKUP_FILE="$1"

if [[ ! -f "$BACKUP_FILE" ]]; then
    echo "[RESTORE] ERROR: Backup file not found: $BACKUP_FILE" >&2
    exit 1
fi

# --- Safety checks ---
echo "========================================"
echo "  DATABASE RESTORE — DESTRUCTIVE"
echo "========================================"
echo ""
echo "This will PERMANENTLY OVERWRITE the current database:"
echo "  Database: $POSTGRES_DB"
echo "  User:     $POSTGRES_USER"
echo "  Backup:   $BACKUP_FILE"
echo ""
echo "ALL existing data will be replaced with the backup contents."
echo ""
echo "To proceed, type exactly: YES"
echo "Any other input will abort."
echo ""
read -r CONFIRM

if [[ "$CONFIRM" != "YES" ]]; then
    echo "[RESTORE] Aborted. No changes made."
    exit 0
fi

echo ""
echo "[RESTORE] Confirmation received. Proceeding..."

# --- Verify PostgreSQL is healthy ---
if ! docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    echo "[RESTORE] ERROR: PostgreSQL is not ready. Aborting." >&2
    exit 1
fi

# --- Copy backup to container ---
echo "[RESTORE] Copying backup to container..."
docker compose cp "$BACKUP_FILE" postgres:/tmp/restore.dump

# --- Drop and recreate database ---
echo "[RESTORE] Dropping existing database connections..."
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres -c "
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = '$POSTGRES_DB'
      AND pid <> pg_backend_pid();
" 2>/dev/null || true

echo "[RESTORE] Dropping database $POSTGRES_DB..."
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS $POSTGRES_DB;" 2>/dev/null || true

echo "[RESTORE] Creating database $POSTGRES_DB..."
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE $POSTGRES_DB;" 2>/dev/null || {
    echo "[RESTORE] ERROR: Failed to create database." >&2
    exit 1
}

# --- Restore from backup ---
echo "[RESTORE] Restoring from backup..."
if docker compose exec -T postgres pg_restore \
    -U "$POSTGRES_USER" \
    -d "$POSTGRES_DB" \
    -c \
    /tmp/restore.dump 2>&1; then
    echo "[RESTORE] pg_restore completed."
else
    echo "[RESTORE] WARNING: pg_restore reported errors (some may be harmless)."
fi

# --- Clean up ---
docker compose exec -T postgres rm -f /tmp/restore.dump 2>/dev/null || true

# --- Verify ---
echo "[RESTORE] Verifying restore..."
TABLE_COUNT=$(docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "
    SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';
" 2>/dev/null | tr -d '[:space:]' || echo "0")

echo "[RESTORE] Tables restored: $TABLE_COUNT"
echo ""
echo "[RESTORE] Restore complete."
echo "[RESTORE] Start PostgreSQL if not already running: ./start_postgres.sh"
