#!/usr/bin/env bash
set -euo pipefail

# db-status.sh — Read-only database status report
# Never modifies database contents.

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
POSTGRES_PORT="${POSTGRES_PORT:-5432}"

echo "========================================"
echo " Emerald Utilities — Database Status"
echo "========================================"
echo ""

# --- Container status ---
echo "[Container]"
if docker ps --format '{{.Names}}' | grep -q '^emerald-postgres$'; then
    STATUS=$(docker inspect emerald-postgres --format '{{.State.Status}}' 2>/dev/null || echo "unknown")
    echo "  Container:    emerald-postgres"
    echo "  Status:       $STATUS"
    echo "  Image:        $(docker inspect emerald-postgres --format '{{.Config.Image}}' 2>/dev/null || echo 'unknown')"
else
    echo "  Container:    emerald-postgres"
    echo "  Status:       NOT RUNNING"
fi
echo ""

# --- PostgreSQL readiness ---
echo "[Readiness]"
if docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    echo "  PostgreSQL:   READY"
else
    echo "  PostgreSQL:   NOT READY"
fi
echo ""

# --- Database info ---
echo "[Database]"
if docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    DB_NAME=$(docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT current_database();" 2>/dev/null | tr -d '[:space:]' || echo "unknown")
    DB_VERSION=$(docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT version();" 2>/dev/null | tr -d '[:space:]' | cut -d' ' -f2 || echo "unknown")
    echo "  Name:         $DB_NAME"
    echo "  Version:      $DB_VERSION"
    echo "  User:         $POSTGRES_USER"
    echo "  Port:         $POSTGRES_PORT"
fi
echo ""

# --- Extensions ---
echo "[Extensions]"
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "
    SELECT extname || ' (' || extversion || ')'
    FROM pg_extension
    WHERE extname IN ('uuid-ossp', 'pgcrypto', 'vector')
    ORDER BY extname;
" 2>/dev/null || echo "  (could not query extensions)"
echo ""

# --- Tables ---
echo "[Tables]"
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename;
" 2>/dev/null || echo "  (could not query tables)"
echo ""

# --- Row counts ---
echo "[Row Counts]"
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "
    SELECT 'notes: ' || COUNT(*) FROM notes
    UNION ALL
    SELECT 'tasks: ' || COUNT(*) FROM tasks
    UNION ALL
    SELECT 'task_tags: ' || COUNT(*) FROM task_tags
    UNION ALL
    SELECT 'network_packet_events: ' || COUNT(*) FROM network_packet_events
    UNION ALL
    SELECT 'threat_indicators: ' || COUNT(*) FROM threat_indicators
    UNION ALL
    SELECT 'grok_conversations: ' || COUNT(*) FROM grok_conversations
    UNION ALL
    SELECT 'grok_raw_imports: ' || COUNT(*) FROM grok_raw_imports
    UNION ALL
    SELECT 'grok_messages: ' || COUNT(*) FROM grok_messages
    UNION ALL
    SELECT 'database_meta: ' || COUNT(*) FROM database_meta;
" 2>/dev/null || echo "  (could not query row counts)"
echo ""

# --- Volume ---
echo "[Volume]"
VOLUME_NAME=$(docker compose ps -q postgres 2>/dev/null | xargs docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' 2>/dev/null || echo "unknown")
echo "  Volume:       $VOLUME_NAME"
echo "  Mount:        /var/lib/postgresql/data"
echo ""

# --- Connection test ---
echo "[Connection]"
if docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    echo "  Accepting connections: YES"
else
    echo "  Accepting connections: NO"
fi
echo ""

echo "========================================"
echo " Status report complete (read-only)"
echo "========================================"
