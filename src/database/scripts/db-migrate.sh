#!/usr/bin/env bash
set -euo pipefail

# db-migrate.sh — Apply explicit database migrations
# Migrations are tracked in database_meta.migration_version.
# A backup is created before any migration is applied.
# Never runs automatically as part of normal startup.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$DB_DIR/migrations"

cd "$DB_DIR"

# Load env
if [[ -f .env ]]; then
    set -a
    source .env
    set +a
fi

POSTGRES_USER="${POSTGRES_USER:-alexljn5}"
POSTGRES_DB="${POSTGRES_DB:-emerald_utilities}"

# --- Verify PostgreSQL is healthy ---
echo "[MIGRATE] Checking PostgreSQL health..."
if ! docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    echo "[MIGRATE] ERROR: PostgreSQL is not ready. Aborting." >&2
    exit 1
fi
echo "[MIGRATE] PostgreSQL is ready."

# --- Get current migration version ---
CURRENT_VERSION=$(docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "
    SELECT value::text FROM database_meta WHERE key = 'migration_version';
" 2>/dev/null | tr -d '[:space:]' || echo "0")

# Strip quotes if present
CURRENT_VERSION="${CURRENT_VERSION//\"/}"

echo "[MIGRATE] Current migration version: $CURRENT_VERSION"

# --- List available migrations ---
if [[ ! -d "$MIGRATIONS_DIR" ]]; then
    echo "[MIGRATE] No migrations directory found at $MIGRATIONS_DIR"
    echo "[MIGRATE] Nothing to migrate."
    exit 0
fi

# Find migration files, sort by name
MIGRATION_FILES=()
while IFS= read -r -d '' file; do
    MIGRATION_FILES+=("$file")
done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' -print0 | sort -z)

if [[ ${#MIGRATION_FILES[@]} -eq 0 ]]; then
    echo "[MIGRATE] No migration files found in $MIGRATIONS_DIR"
    echo "[MIGRATE] Nothing to migrate."
    exit 0
fi

# --- Determine pending migrations ---
PENDING=()
for mig_file in "${MIGRATION_FILES[@]}"; do
    mig_name=$(basename "$mig_file")
    # Extract version from filename (e.g., 001_add_something.sql -> 1)
    mig_version=$(echo "$mig_name" | grep -oE '^[0-9]+' | sed 's/^0*//')
    if [[ -z "$mig_version" ]]; then
        mig_version=0
    fi

    if [[ "$mig_version" -gt "$CURRENT_VERSION" ]]; then
        PENDING+=("$mig_file")
    fi
done

if [[ ${#PENDING[@]} -eq 0 ]]; then
    echo "[MIGRATE] Database is up to date (version $CURRENT_VERSION)."
    exit 0
fi

echo "[MIGRATE] Pending migrations: ${#PENDING[@]}"
for mig_file in "${PENDING[@]}"; do
    echo "[MIGRATE]   - $(basename "$mig_file")"
done
echo ""

# --- Create backup before migration ---
echo "[MIGRATE] Creating pre-migration backup..."
BACKUP_DIR="$DB_DIR/backups"
mkdir -p "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/pre_migrate_${CURRENT_VERSION}_$(date +%Y-%m-%d_%H%M%S).dump"

if docker compose exec -T postgres pg_dump \
    -U "$POSTGRES_USER" \
    -d "$POSTGRES_DB" \
    -Fc \
    -f "/tmp/pre_migrate.dump" 2>&1; then
    docker compose cp postgres:/tmp/pre_migrate.dump "$BACKUP_FILE" 2>/dev/null || true
    docker compose exec -T postgres rm -f /tmp/pre_migrate.dump 2>/dev/null || true
    echo "[MIGRATE] Backup saved: $BACKUP_FILE"
else
    echo "[MIGRATE] WARNING: Pre-migration backup failed. Continuing anyway."
fi
echo ""

# --- Apply migrations ---
NEW_VERSION="$CURRENT_VERSION"
FAILED=false

for mig_file in "${PENDING[@]}"; do
    mig_name=$(basename "$mig_file")
    mig_version=$(echo "$mig_name" | grep -oE '^[0-9]+' | sed 's/^0*//')
    if [[ -z "$mig_version" ]]; then
        mig_version=0
    fi

    echo "[MIGRATE] Applying: $mig_name"

    # Copy migration to container and execute
    if docker compose cp "$mig_file" postgres:/tmp/migrate.sql 2>/dev/null; then
        if docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /tmp/migrate.sql >/dev/null 2>&1; then
            echo "[MIGRATE]   -> SUCCESS"
            NEW_VERSION="$mig_version"
        else
            echo "[MIGRATE]   -> FAILED" >&2
            FAILED=true
            break
        fi
        docker compose exec -T postgres rm -f /tmp/migrate.sql 2>/dev/null || true
    else
        echo "[MIGRATE]   -> FAILED (could not copy file)" >&2
        FAILED=true
        break
    fi
done

# --- Update migration version ---
if [[ "$FAILED" == "false" ]]; then
    echo "[MIGRATE] Updating migration version to $NEW_VERSION..."
    docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
        UPDATE database_meta SET value = '\"$NEW_VERSION\"'::jsonb, updated_at = NOW()
        WHERE key = 'migration_version';
    " 2>/dev/null || {
        # If row doesn't exist, insert it
        docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
            INSERT INTO database_meta (key, value) VALUES ('migration_version', '\"$NEW_VERSION\"'::jsonb);
        " 2>/dev/null || true
    }

    # --- Verify PostgreSQL is still healthy ---
    if docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
        echo "[MIGRATE] PostgreSQL health check: PASSED"
    else
        echo "[MIGRATE] WARNING: PostgreSQL health check failed after migration." >&2
    fi

    echo ""
    echo "[MIGRATE] SUCCESS: Migrated from version $CURRENT_VERSION to $NEW_VERSION"
    exit 0
else
    echo ""
    echo "[MIGRATE] FAILED: Migration stopped at version $NEW_VERSION"
    echo "[MIGRATE] The database may be in a partially migrated state."
    echo "[MIGRATE] A pre-migration backup exists at: $BACKUP_FILE"
    echo "[MIGRATE] To recover: ./scripts/db-restore.sh $BACKUP_FILE"
    exit 1
fi
