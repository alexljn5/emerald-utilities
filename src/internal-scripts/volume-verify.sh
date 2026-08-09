#!/bin/bash

# volume-verify.sh - Verify PostgreSQL Docker volume backup integrity
# Usage: volume-verify.sh [database-dir] [backup-file]

set -euo pipefail

# =========================
# WSL detection
# =========================
if ! grep -qi microsoft /proc/version 2>/dev/null; then
    echo "[VERIFY] ERROR: This script must run inside WSL." >&2
    exit 1
fi

# =========================
# Docker CLI check
# =========================
if ! command -v docker >/dev/null 2>&1; then
    echo "[VERIFY] ERROR: docker not found in PATH." >&2
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

echo "[VERIFY] Database directory: $DB_DIR"
echo "[VERIFY] Backup directory: $BACKUP_DIR"

# =========================
# Determine backup file
# =========================
if [[ -n "${2:-}" ]]; then
    BACKUP_FILE="$2"
else
    # Find the most recent backup
    BACKUP_FILE=$(ls -t "$BACKUP_DIR"/*.tar.gz 2>/dev/null | head -1)
    if [[ -z "$BACKUP_FILE" ]]; then
        echo "[VERIFY] ERROR: No backup files found in $BACKUP_DIR" >&2
        exit 1
    fi
    echo "[VERIFY] Using most recent backup: $BACKUP_FILE"
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
    echo "[VERIFY] ERROR: Backup file not found: $BACKUP_FILE" >&2
    exit 1
fi

# =========================
# Check if container is running
# =========================
if ! docker ps --format '{{.Names}}' | grep -q '^emerald-postgres$'; then
    echo "[VERIFY] ERROR: PostgreSQL container 'emerald-postgres' is not running." >&2
    echo "[VERIFY] Start the database first with db-start.sh" >&2
    exit 1
fi

# =========================
# Detect the correct volume from container mounts
# =========================
VOLUME_NAME=$(docker inspect emerald-postgres --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}')
if [[ -z "$VOLUME_NAME" ]]; then
    echo "[VERIFY] ERROR: Could not detect volume for emerald-postgres container." >&2
    exit 1
fi
echo "[VERIFY] Detected volume: $VOLUME_NAME"

# =========================
# Verify backup integrity
# =========================
echo "[VERIFY] Verifying backup integrity..."

# Check if backup file is a valid gzip archive
if ! gzip -t "$BACKUP_FILE" 2>/dev/null; then
    echo "[VERIFY] ERROR: Backup file is corrupted or not a valid gzip archive." >&2
    exit 1
fi
echo "[VERIFY] Backup file is a valid gzip archive."

# Create temporary directory for extraction
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

echo "[VERIFY] Extracting backup to temporary directory..."
tar xzf "$BACKUP_FILE" -C "$TEMP_DIR"

# Compare file counts
LIVE_COUNT=$(docker run --rm -v "$VOLUME_NAME:/data" alpine:latest find /data -type f | wc -l)
BACKUP_COUNT=$(find "$TEMP_DIR" -type f | wc -l)

echo "[VERIFY] Live volume file count: $LIVE_COUNT"
echo "[VERIFY] Backup file count: $BACKUP_COUNT"

if [[ "$LIVE_COUNT" -ne "$BACKUP_COUNT" ]]; then
    echo "[VERIFY] WARNING: File counts differ between live volume and backup."
fi

# Compare checksums
echo "[VERIFY] Comparing file checksums..."
docker run --rm -v "$VOLUME_NAME:/data" alpine:latest sh -c "find /data -type f -exec md5sum {} \; | sort" > "$TEMP_DIR/live.md5"
find "$TEMP_DIR" -type f -exec md5sum {} \; | sort > "$TEMP_DIR/backup.md5"

# Remove the backup.md5 file itself from comparison (it's inside the temp dir)
grep -v "backup.md5" "$TEMP_DIR/backup.md5" > "$TEMP_DIR/backup_clean.md5" 2>/dev/null || true

if diff "$TEMP_DIR/live.md5" "$TEMP_DIR/backup_clean.md5" >/dev/null 2>&1; then
    echo "[VERIFY] SUCCESS: Backup matches live volume exactly!"
else
    echo "[VERIFY] WARNING: Differences found between backup and live volume."
    echo "[VERIFY] Files that differ:"
    diff "$TEMP_DIR/live.md5" "$TEMP_DIR/backup_clean.md5" | head -20 || true
fi

# Show backup size
echo "[VERIFY] Backup size: $(du -h "$BACKUP_FILE" | cut -f1)"

echo "[VERIFY] Done."