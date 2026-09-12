#!/bin/bash

# volume-backup.sh - Backup PostgreSQL Docker volume
# Usage: volume-backup.sh [database-dir]

set -euo pipefail

# =========================
# WSL detection
# =========================
if ! grep -qi microsoft /proc/version 2>/dev/null; then
    echo "[BACKUP] ERROR: This script must run inside WSL." >&2
    exit 1
fi

# =========================
# Docker CLI check
# =========================
if ! command -v docker >/dev/null 2>&1; then
    echo "[BACKUP] ERROR: docker not found in PATH." >&2
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

echo "[BACKUP] Database directory: $DB_DIR"
echo "[BACKUP] Backup directory: $BACKUP_DIR"

# =========================
# Ensure backup directory exists
# =========================
if [[ ! -d "$BACKUP_DIR" ]]; then
    echo "[BACKUP] Creating backup directory..."
    mkdir -p "$BACKUP_DIR"
fi

# =========================
# Check if container is running
# =========================
if ! docker ps --format '{{.Names}}' | grep -q '^emerald-postgres$'; then
    echo "[BACKUP] ERROR: PostgreSQL container 'emerald-postgres' is not running." >&2
    echo "[BACKUP] Start the database first with db-start.sh" >&2
    exit 1
fi

# =========================
# Detect the correct volume from container mounts
# =========================
VOLUME_NAME=$(docker inspect emerald-postgres --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}')
if [[ -z "$VOLUME_NAME" ]]; then
    echo "[BACKUP] ERROR: Could not detect volume for emerald-postgres container." >&2
    exit 1
fi
echo "[BACKUP] Detected volume: $VOLUME_NAME"

# =========================
# Create backup
# =========================
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="$BACKUP_DIR/postgres_data_${TIMESTAMP}.tar.gz"

echo "[BACKUP] Creating volume backup..."
echo "[BACKUP] Target: $BACKUP_FILE"

# Use a temporary container to create the backup
docker run --rm \
    -v "$VOLUME_NAME:/data:ro" \
    -v "$BACKUP_DIR:/backup" \
    alpine:latest \
    sh -c "cd /data && tar czf /backup/postgres_data_${TIMESTAMP}.tar.gz ."

if [[ -f "$BACKUP_FILE" ]]; then
    echo "[BACKUP] Backup created successfully: $BACKUP_FILE"
    echo "[BACKUP] Size: $(du -h "$BACKUP_FILE" | cut -f1)"
    
    # List existing backups
    echo "[BACKUP] Existing backups:"
    ls -lh "$BACKUP_DIR"/*.tar.gz 2>/dev/null | tail -5 || echo "[BACKUP] No previous backups found"
else
    echo "[BACKUP] ERROR: Backup file was not created." >&2
    exit 1
fi

echo "[BACKUP] Done."