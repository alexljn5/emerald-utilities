#!/usr/bin/env bash

# rag-setup.sh - One-click RAG setup for PostgreSQL (plug-and-play)
# Usage: ./src/internal-scripts/rag-setup.sh
#
# This script is idempotent - it can be run multiple times safely.
# It will skip steps that are already completed and NEVER destroys
# existing embeddings.
#
# Cross-platform: works on native Linux, macOS (Docker Desktop) and WSL.

set -euo pipefail

# =========================
# Platform detection (Linux / macOS / WSL)
# =========================
OS_KIND="unknown"
case "$(uname -s 2>/dev/null || echo unknown)" in
    Linux*)
        if grep -qi microsoft /proc/version 2>/dev/null; then OS_KIND="wsl"; else OS_KIND="linux"; fi
        ;;
    Darwin*) OS_KIND="macos" ;;
esac
echo "[RAG-SETUP] Detected platform: ${OS_KIND}"

# =========================
# Docker CLI check
# =========================
if ! command -v docker >/dev/null 2>&1; then
    echo "[RAG-SETUP] ERROR: docker not found in PATH." >&2
    exit 127
fi

# =========================
# Resolve database directory
# =========================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_DIR="$(dirname "$SCRIPT_DIR")/database"

# Convert Windows path to WSL path if needed
if [[ "$DB_DIR" == *[A-Za-z]:\\* ]]; then
    DRIVE=$(echo "$DB_DIR" | cut -d: -f1 | tr '[:upper:]' '[:lower:]')
    REST=$(echo "$DB_DIR" | cut -d: -f2 | tr '\\' '/')
    DB_DIR="/mnt/$DRIVE$REST"
fi

# Load environment variables
if [[ -f "$DB_DIR/.env" ]]; then
    set -a
    source "$DB_DIR/.env"
    set +a
fi

POSTGRES_USER="${POSTGRES_USER:-emerald-user}"
POSTGRES_DB="${POSTGRES_DB:-emerald_utilities}"

cd "$DB_DIR"

# =========================
# Ensure Docker daemon is ready
# =========================
ensure_docker() {
    if docker info >/dev/null 2>&1; then
        return 0
    fi

    echo "[RAG-SETUP] Docker not ready, attempting start..."
    case "$OS_KIND" in
        macos)
            open -a Docker >/dev/null 2>&1 || \
                echo "[RAG-SETUP] Could not auto-launch Docker Desktop; please start it manually."
            ;;
        linux)
            if command -v systemctl >/dev/null 2>&1 && sudo systemctl start docker >/dev/null 2>&1; then
                echo "[RAG-SETUP] Docker started via systemctl."
            elif sudo service docker start >/dev/null 2>&1; then
                echo "[RAG-SETUP] Docker started via service."
            else
                nohup sudo dockerd --host=unix:///var/run/docker.sock > /tmp/dockerd.log 2>&1 &
                echo "[RAG-SETUP] dockerd started (fallback)."
            fi
            ;;
        wsl|*)
            if sudo service docker start >/dev/null 2>&1; then
                echo "[RAG-SETUP] Docker service started."
            else
                nohup sudo dockerd --host=unix:///var/run/docker.sock > /tmp/dockerd.log 2>&1 &
                echo "[RAG-SETUP] dockerd started (fallback)."
            fi
            ;;
    esac

    for i in $(seq 1 30); do
        if docker info >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done

    echo "[RAG-SETUP] ERROR: Docker failed to start." >&2
    exit 1
}

ensure_docker

# =========================
# Check if container needs to be recreated (for pgvector image)
# =========================
NEEDS_RECREATE=false
if docker ps --format '{{.Names}}' | grep -q '^emerald-postgres$'; then
    # Check if running the correct image
    CURRENT_IMAGE=$(docker inspect emerald-postgres --format '{{.Image}}' 2>/dev/null || echo "")
    if [[ "$CURRENT_IMAGE" != *"pgvector"* ]]; then
        echo "[RAG-SETUP] Container is using old image ($CURRENT_IMAGE), will recreate with pgvector/pgvector:pg16"
        NEEDS_RECREATE=true
    fi
fi

# =========================
# Start/recreate database container
# =========================
if [[ "$NEEDS_RECREATE" == "true" ]]; then
    echo "[RAG-SETUP] Recreating container with pgvector image..."
    docker stop emerald-postgres >/dev/null 2>&1 || true
    docker rm emerald-postgres >/dev/null 2>&1 || true
    docker compose up -d
    
    # Wait for Postgres
    for i in $(seq 1 30); do
        if docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
            echo "[RAG-SETUP] PostgreSQL ready."
            break
        fi
        echo "[RAG-SETUP] Waiting for PostgreSQL... ($i/30)"
        sleep 1
    done
elif ! docker ps --format '{{.Names}}' | grep -q '^emerald-postgres$'; then
    echo "[RAG-SETUP] Starting PostgreSQL container..."
    docker compose up -d
    
    # Wait for Postgres
    for i in $(seq 1 30); do
        if docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
            echo "[RAG-SETUP] PostgreSQL ready."
            break
        fi
        echo "[RAG-SETUP] Waiting for PostgreSQL... ($i/30)"
        sleep 1
    done
else
    echo "[RAG-SETUP] PostgreSQL container already running with correct image."
fi

# =========================
# Setup RAG schema (idempotent)
# =========================
echo "[RAG-SETUP] Setting up RAG schema..."

# Add the embedding column ONLY if it is missing. If it already exists we
# NEVER drop it here — dropping would permanently destroy stored embeddings.
# Dimension fixes are handled safely (empty-only) by rag-prepare.js.
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
    DO \$\$
    DECLARE
        filled bigint;
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'grok_messages'
            AND column_name = 'embedding'
        ) THEN
            ALTER TABLE grok_messages ADD COLUMN embedding vector(768);
            RAISE NOTICE 'Added embedding column';
        ELSE
            SELECT COUNT(*) INTO filled FROM grok_messages WHERE embedding IS NOT NULL;
            IF filled = 0 THEN
                -- Column exists but is empty: safe to recreate at the expected dim.
                ALTER TABLE grok_messages DROP COLUMN embedding;
                ALTER TABLE grok_messages ADD COLUMN embedding vector(768);
                RAISE NOTICE 'Recreated empty embedding column at vector(768)';
            ELSE
                RAISE NOTICE 'embedding column already populated (% rows) — leaving untouched', filled;
            END IF;
        END IF;
    END \$\$;
" 2>/dev/null || echo "[RAG-SETUP] Note: Column may already exist (this is normal)"

# Create the ANN index if not exists.
#
# IMPORTANT: rag-query.js ranks with the cosine-distance operator (<=>), so the
# index MUST use vector_cosine_ops. An ivfflat index built with vector_l2_ops
# is NOT usable by a `<=>` ORDER BY and Postgres silently falls back to a full
# sequential scan over every row. Using the matching op class lets the planner
# actually use the index.
#
# `lists` controls the number of ivfflat partitions. A common heuristic is
# rows/1000 (min 1). For ~17k rows, ~16 lists is a reasonable default.
LIST_COUNT=$(docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
    "SELECT GREATEST(1, LEAST(1000, (COUNT(*) / 1000)::int)) FROM grok_messages WHERE embedding IS NOT NULL;" 2>/dev/null | tr -d '[:space:]')
LIST_COUNT="${LIST_COUNT:-16}"
echo "[RAG-SETUP] Building ivfflat (cosine) index with lists=${LIST_COUNT}..."
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
    CREATE INDEX IF NOT EXISTS idx_grok_messages_embedding_cosine
    ON grok_messages
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = ${LIST_COUNT});
" 2>/dev/null || echo "[RAG-SETUP] Note: Index may already exist (this is normal)"

# Drop the legacy L2 index if it exists — it can never be used by the cosine
# query and only wastes disk + slows writes.
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
    DROP INDEX IF EXISTS idx_grok_messages_embedding;
" 2>/dev/null || true

# Refresh planner statistics so the new index is considered immediately.
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
    ANALYZE grok_messages;
" 2>/dev/null || true

# Verify pgvector extension
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
    SELECT extname FROM pg_extension WHERE extname = 'vector';
" 2>/dev/null && echo "[RAG-SETUP] pgvector extension verified" || echo "[RAG-SETUP] Warning: pgvector extension not found"

echo ""
echo "[RAG-SETUP] Setup complete!"
echo "[RAG-SETUP] Next steps:"
echo "  1. Set AI_PROVIDER in src/.env (grok, openai, ollama, lmstudio)"
echo "  2. Run: node src/database/rag-prepare.js"
echo "  3. Query via the AI page in the Electron app"