#!/bin/bash

# volume-restore.sh - Restore PostgreSQL Docker volume from backup
# Usage: volume-restore.sh [database-dir] [backup-file]

set -euo pipefail

# =========================
# WSL detection
# =========================
if ! grep -qi microsoft /proc/version 2>/dev/null; then
    echo "[RESTORE] ERROR: This script must run inside WSL." >&2
    exit 1
fi

# =========================
# Docker CLI check
# =========================
if ! command -v docker >/dev/null 2>&1; then
    echo "[RESTORE] ERROR: docker not found in PATH." >&2
    exit 127
fi

# =========================
# Resolve database directory
# =========================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_DIR="${1:-$(dirname "$SCRIPT_DIR")/database}"

# Convert Windows path to WSL path if needed
if [[ "$DB_DIR" == *[A-Za-z]:\\* ]]; then
    DRIVE=$(echo "$DB_DIR" | cut -d: -f1 | tr '[:upper:]' '[:lower:]')
    REST=$(echo "$DB_DIR" | cut -d: -f2 | tr '\\' '/')
    DB_DIR="/mnt/$DRIVE$REST"
fi

BACKUP_DIR="$DB_DIR/volume-backups"

echo "[RESTORE] Database directory: $DB_DIR"
echo "[RESTORE] Backup directory: $BACKUP_DIR"

# =========================
# Determine backup file
# =========================
if [[ -n "${2:-}" ]]; then
    BACKUP_FILE="$2"
else
    # Find the most recent backup
    BACKUP_FILE=$(ls -t "$BACKUP_DIR"/*.tar.gz 2>/dev/null | head -1)
    if [[ -z "$BACKUP_FILE" ]]; then
        echo "[RESTORE] ERROR: No backup files found in $BACKUP_DIR" >&2
        exit 1
    fi
    echo "[RESTORE] Using most recent backup: $BACKUP_FILE"
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
    echo "[RESTORE] ERROR: Backup file not found: $BACKUP_FILE" >&2
    exit 1
fi

# =========================
# Check if container is running
# =========================
if ! docker ps --format '{{.Names}}' | grep -q '^emerald-postgres$'; then
    echo "[RESTORE] ERROR: PostgreSQL container 'emerald-postgres' is not running." >&2
    echo "[RESTORE] Start the database first with db-start.sh" >&2
    exit 1
fi

# =========================
# Detect the correct volume from container mounts
# =========================
VOLUME_NAME=$(docker inspect emerald-postgres --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}')
if [[ -z "$VOLUME_NAME" ]]; then
    echo "[RESTORE] ERROR: Could not detect volume for emerald-postgres container." >&2
    exit 1
fi
echo "[RESTORE] Detected volume: $VOLUME_NAME"

# =========================
# Restore backup
# =========================
echo "[RESTORE] WARNING: This will overwrite the current database volume!"
read -p "[RESTORE] Continue? (y/N): " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "[RESTORE] Cancelled."
    exit 0
fi

echo "[RESTORE] Restoring volume from backup..."

# Use a temporary container to restore the backup
docker run --rm \
    -v "$VOLUME_NAME:/data" \
    -v "$BACKUP_DIR:/backup" \
    alpine:latest \
    sh -c "cd /data && tar xzf /backup/$(basename "$BACKUP_FILE")"

echo "[RESTORE] Restore completed successfully."
echo "[RESTORE] Size: $(du -h "$BACKUP_FILE" | cut -f1)"

echo "[RESTORE] Done."