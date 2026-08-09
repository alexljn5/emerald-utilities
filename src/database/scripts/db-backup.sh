#!/usr/bin/env bash
set -euo pipefail

# db-backup.sh — PostgreSQL logical backup using pg_dump
# Produces a timestamped custom-format dump.
# Never deletes the database.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$DB_DIR"

# Load env
if [[ -f .env ]]; then
    set -a
    source .env
    set +a
fi

POSTGRES_USER="${POSTGRES_USER:-alexljn5}"
POSTGRES_DB="${POSTGRES_DB:-emerald_utilities}"
BACKUP_DIR="${BACKUP_DIR:-$DB_DIR/backups}"

TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/emerald_utilities_${TIMESTAMP}.dump"

echo "[BACKUP] Starting PostgreSQL backup..."
echo "[BACKUP] Database: $POSTGRES_DB"
echo "[BACKUP] User:     $POSTGRES_USER"
echo "[BACKUP] Output:   $BACKUP_FILE"

# --- Verify PostgreSQL is healthy ---
if ! docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    echo "[BACKUP] ERROR: PostgreSQL is not ready. Aborting." >&2
    exit 1
fi

# --- Create backup directory ---
mkdir -p "$BACKUP_DIR"

# --- Perform backup ---
echo "[BACKUP] Running pg_dump..."
if docker compose exec -T postgres pg_dump \
    -U "$POSTGRES_USER" \
    -d "$POSTGRES_DB" \
    -Fc \
    -f "/tmp/backup.dump" 2>&1; then
    echo "[BACKUP] pg_dump completed inside container."
else
    echo "[BACKUP] ERROR: pg_dump failed." >&2
    exit 1
fi

# --- Copy from container ---
echo "[BACKUP] Copying backup to host..."
if docker compose cp postgres:/tmp/backup.dump "$BACKUP_FILE" 2>&1; then
    echo "[BACKUP] Backup copied successfully."
else
    echo "[BACKUP] ERROR: Failed to copy backup from container." >&2
    exit 1
fi

# --- Clean up container temp file ---
docker compose exec -T postgres rm -f /tmp/backup.dump 2>/dev/null || true

# --- Verify backup file ---
if [[ -f "$BACKUP_FILE" ]]; then
    SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    echo "[BACKUP] SUCCESS: Backup created."
    echo "[BACKUP] Path:   $BACKUP_FILE"
    echo "[BACKUP] Size:   $SIZE"
else
    echo "[BACKUP] ERROR: Backup file not found after copy." >&2
    exit 1
fi

echo ""
echo "[BACKUP] To restore this backup:"
echo "[BACKUP]   ./scripts/db-restore.sh $BACKUP_FILE"
