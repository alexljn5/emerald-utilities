#!/usr/bin/env bash
set -euo pipefail

# merge-sins.sh — Canonical idempotent database schema/migration updater
#
# This script is safe to run on EVERY database startup. It:
#   1. Verifies PostgreSQL readiness
#   2. Detects whether the database is fresh (empty) or existing
#   3. For fresh databases: applies envy.sql + pride.sql, then applies all migrations
#   4. For existing databases: applies only pending migrations
#   5. Persists migration_version to PostgreSQL after EACH successful migration
#   6. Verifies critical extensions, indexes, and schema elements
#   7. Returns non-zero exit code on any failure
#
# NEVER wipes or recreates the database_postgres_data volume.
# NEVER blindly re-runs initialization SQL on an existing database.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_DIR="$SCRIPT_DIR"
MIGRATIONS_DIR="$DB_DIR/migrations"

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

POSTGRES_USER="${POSTGRES_USER:-alexljn5}"
POSTGRES_DB="${POSTGRES_DB:-emerald_utilities}"

# ============================================================
# Helpers
# ============================================================

log() {
    echo "[merge-sins] $*"
}

fail() {
    echo "[merge-sins] ERROR: $*" >&2
    exit 1
}

# Run a SQL command inside the container, return stdout
sql() {
    docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1" 2>/dev/null
}

# Run a SQL file inside the container
sql_file() {
    local file="$1"
    docker compose cp "$file" postgres:/tmp/merge_sins.sql 2>/dev/null || fail "Could not copy $file to container"
    docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /tmp/merge_sins.sql >/dev/null 2>&1 || {
        docker compose exec -T postgres rm -f /tmp/merge_sins.sql 2>/dev/null || true
        return 1
    }
    docker compose exec -T postgres rm -f /tmp/merge_sins.sql 2>/dev/null || true
    return 0
}

# Persist migration version to PostgreSQL
persist_migration_version() {
    local version="$1"
    sql "INSERT INTO database_meta (key, value, updated_at) VALUES ('migration_version', '\"$version\"'::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();" 2>/dev/null || \
    fail "Could not persist migration_version=$version to database_meta"
    log "Persisted migration_version=$version to database_meta."
}

# ============================================================
# Pre-flight: PostgreSQL must be ready
# ============================================================

log "Checking PostgreSQL readiness..."
if ! docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    fail "PostgreSQL is not ready. Aborting."
fi
log "PostgreSQL is ready."

# ============================================================
# Detect fresh vs existing database
# ============================================================

log "Detecting database state..."

# Check if database_meta exists and has data
DB_META_EXISTS=$(sql "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'database_meta');")
MIGRATION_VERSION=$(sql "SELECT value::text FROM database_meta WHERE key = 'migration_version';" 2>/dev/null || echo "")
MIGRATION_VERSION="${MIGRATION_VERSION//\"/}"

if [[ "$DB_META_EXISTS" == "f" || -z "$MIGRATION_VERSION" ]]; then
    # Fresh database or database_meta missing
    log "Database appears fresh (no migration_version found)."

    # Double-check: are there any user tables?
    TABLE_COUNT=$(sql "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';" 2>/dev/null || echo "0")
    TABLE_COUNT="${TABLE_COUNT//[[:space:]]/}"

    if [[ "$TABLE_COUNT" -gt 0 ]]; then
        log "Database has $TABLE_COUNT existing tables but no migration_version."
        log "Treating as existing database with missing migration tracking."
        IS_FRESH=false
    else
        log "Database is empty. Applying fresh initialization schema."
        IS_FRESH=true
    fi
else
    log "Existing database detected (migration_version=$MIGRATION_VERSION)."
    IS_FRESH=false
fi

# ============================================================
# Fresh initialization
# ============================================================

if [[ "$IS_FRESH" == "true" ]]; then
    log "Applying fresh initialization schema..."

    # Apply envy.sql (RAG/infrastructure schema)
    if [[ -f "$DB_DIR/envy.sql" ]]; then
        log "Applying envy.sql..."
        sql_file "$DB_DIR/envy.sql" || fail "Failed to apply envy.sql"
        log "envy.sql applied successfully."
    else
        fail "envy.sql not found at $DB_DIR/envy.sql"
    fi

    # Apply pride.sql (tasks/notes schema)
    if [[ -f "$DB_DIR/tasks/pride.sql" ]]; then
        log "Applying tasks/pride.sql..."
        sql_file "$DB_DIR/tasks/pride.sql" || fail "Failed to apply tasks/pride.sql"
        log "tasks/pride.sql applied successfully."
    else
        fail "tasks/pride.sql not found at $DB_DIR/tasks/pride.sql"
    fi

    # Establish baseline migration version
    log "Establishing baseline migration_version=0..."
    persist_migration_version 0
    MIGRATION_VERSION=0

    # ============================================================
    # Apply all migrations for fresh database
    # ============================================================
    log "Applying migrations for fresh database..."

    if [[ -d "$MIGRATIONS_DIR" ]]; then
        for mig_file in "$MIGRATIONS_DIR"/*.sql; do
            [[ -f "$mig_file" ]] || continue
            mig_name=$(basename "$mig_file")
            mig_version=$(echo "$mig_name" | grep -oE '^[0-9]+' | sed 's/^0*//')
            [[ -n "$mig_version" ]] || continue

            log "Applying migration: $mig_name (version $mig_version)"

            # Create backup before each migration
            BACKUP_DIR="$DB_DIR/backups"
            mkdir -p "$BACKUP_DIR"
            BACKUP_FILE="$BACKUP_DIR/pre_migrate_${mig_version}_$(date +%Y-%m-%d_%H%M%S).dump"

            log "Creating pre-migration backup..."
            if docker compose exec -T postgres pg_dump \
                -U "$POSTGRES_USER" \
                -d "$POSTGRES_DB" \
                -Fc \
                -f "/tmp/pre_migrate.dump" 2>&1 >/dev/null; then
                docker compose cp postgres:/tmp/pre_migrate.dump "$BACKUP_FILE" 2>/dev/null || true
                docker compose exec -T postgres rm -f /tmp/pre_migrate.dump 2>/dev/null || true
                log "Backup saved: $BACKUP_FILE"
            else
                fail "Pre-migration backup failed for migration $mig_name. Aborting."
            fi

            # Apply migration
            if sql_file "$mig_file"; then
                log "Migration $mig_name applied successfully."
                persist_migration_version "$mig_version"
                MIGRATION_VERSION="$mig_version"
            else
                fail "Migration $mig_name failed. Database may be in a partially migrated state. Restore from $BACKUP_FILE if needed."
            fi
        done
    fi

    log "Fresh initialization complete. Final migration_version=$MIGRATION_VERSION"
else
    # ============================================================
    # Existing database: apply pending migrations
    # ============================================================

    log "Checking for pending migrations..."

    if [[ ! -d "$MIGRATIONS_DIR" ]]; then
        log "No migrations directory found. Database is up to date."
    else
        PENDING_COUNT=0
        for mig_file in "$MIGRATIONS_DIR"/*.sql; do
            [[ -f "$mig_file" ]] || continue
            mig_name=$(basename "$mig_file")
            mig_version=$(echo "$mig_name" | grep -oE '^[0-9]+' | sed 's/^0*//')
            [[ -n "$mig_version" ]] || continue

            if [[ "$mig_version" -gt "$MIGRATION_VERSION" ]]; then
                ((PENDING_COUNT++)) || true
                log "Applying migration: $mig_name (version $mig_version)"

                # Create backup before each migration
                BACKUP_DIR="$DB_DIR/backups"
                mkdir -p "$BACKUP_DIR"
                BACKUP_FILE="$BACKUP_DIR/pre_migrate_${mig_version}_$(date +%Y-%m-%d_%H%M%S).dump"

                log "Creating pre-migration backup..."
                if docker compose exec -T postgres pg_dump \
                    -U "$POSTGRES_USER" \
                    -d "$POSTGRES_DB" \
                    -Fc \
                    -f "/tmp/pre_migrate.dump" 2>&1 >/dev/null; then
                    docker compose cp postgres:/tmp/pre_migrate.dump "$BACKUP_FILE" 2>/dev/null || true
                    docker compose exec -T postgres rm -f /tmp/pre_migrate.dump 2>/dev/null || true
                    log "Backup saved: $BACKUP_FILE"
                else
                    fail "Pre-migration backup failed for migration $mig_name. Aborting."
                fi

                # Apply migration
                if sql_file "$mig_file"; then
                    log "Migration $mig_name applied successfully."
                    persist_migration_version "$mig_version"
                    MIGRATION_VERSION="$mig_version"
                else
                    fail "Migration $mig_name failed. Database may be in a partially migrated state. Restore from $BACKUP_FILE if needed."
                fi
            fi
        done

        if [[ "$PENDING_COUNT" -eq 0 ]]; then
            log "No pending migrations. Database is up to date (version $MIGRATION_VERSION)."
        else
            log "Applied $PENDING_COUNT migration(s). Final version: $MIGRATION_VERSION"
        fi
    fi
fi

# ============================================================
# Verification
# ============================================================

log "Running post-merge verification..."

# Verify critical extensions
REQUIRED_EXTENSIONS=("uuid-ossp" "pgcrypto" "vector")
for ext in "${REQUIRED_EXTENSIONS[@]}"; do
    if sql "SELECT extname FROM pg_extension WHERE extname = '$ext';" | grep -q "$ext"; then
        log "Extension verified: $ext"
    else
        fail "Required extension missing: $ext"
    fi
done

# Verify critical tables
REQUIRED_TABLES=("notes" "tasks" "task_tags" "network_packet_events" "threat_indicators" "grok_conversations" "grok_raw_imports" "grok_messages" "database_meta")
for table in "${REQUIRED_TABLES[@]}"; do
    if sql "SELECT tablename FROM pg_tables WHERE tablename = '$table';" | grep -q "$table"; then
        log "Table verified: $table"
    else
        fail "Required table missing: $table"
    fi
done

# Verify embedding column type
EMBEDDING_TYPE=$(sql "SELECT atttypid::regtype FROM pg_attribute WHERE attrelid = 'grok_messages'::regclass AND attname = 'embedding';" 2>/dev/null || echo "")
if [[ "$EMBEDDING_TYPE" == "vector" ]]; then
    log "Embedding column type verified: vector"
else
    fail "grok_messages.embedding column is not vector type (found: $EMBEDDING_TYPE)"
fi

# Verify vector dimension using pgvector's vector_dims()
VECTOR_DIM=$(sql "SELECT vector_dims(embedding) FROM grok_messages WHERE embedding IS NOT NULL LIMIT 1;" 2>/dev/null || echo "")
if [[ -n "$VECTOR_DIM" && "$VECTOR_DIM" -eq 768 ]]; then
    log "Vector dimension verified: 768"
elif [[ -z "$VECTOR_DIM" ]]; then
    log "Vector dimension: no embedded rows yet (dimension will be 768 when first row is embedded)"
else
    fail "Vector dimension mismatch: expected 768, found $VECTOR_DIM"
fi

# Verify cosine index exists
if sql "SELECT indexname FROM pg_indexes WHERE indexname = 'idx_grok_messages_embedding_cosine';" | grep -q "idx_grok_messages_embedding_cosine"; then
    log "Cosine vector index verified: idx_grok_messages_embedding_cosine"
else
    log "WARNING: Cosine vector index not found. Run rag-setup.sh to create it."
fi

# Verify is_ip_blacklisted is STABLE (not IMMUTABLE)
VOLATILITY=$(sql "SELECT provolatile FROM pg_proc WHERE proname = 'is_ip_blacklisted';" 2>/dev/null || echo "")
if [[ "$VOLATILITY" == "s" ]]; then
    log "is_ip_blacklisted volatility verified: STABLE"
else
    fail "is_ip_blacklisted has volatility '$VOLATILITY' (expected 's' for STABLE)"
fi

# Final health check
if docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    log "PostgreSQL health check: PASSED"
else
    fail "PostgreSQL health check failed after merge."
fi

log "Merge-sins completed successfully."
exit 0
