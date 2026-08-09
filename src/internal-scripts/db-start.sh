#!/usr/bin/env bash
set -euo pipefail

# =========================
# Platform detection (Linux / macOS / WSL)
# =========================
# This script is cross-platform. It runs on native Linux, macOS (Docker
# Desktop), and inside WSL. Behaviour for starting the Docker daemon differs
# per platform; the rest (compose up, readiness, schema guard) is identical.
OS_KIND="unknown"
case "$(uname -s 2>/dev/null || echo unknown)" in
    Linux*)
        if grep -qi microsoft /proc/version 2>/dev/null; then
            OS_KIND="wsl"
        else
            OS_KIND="linux"
        fi
        ;;
    Darwin*) OS_KIND="macos" ;;
    *) OS_KIND="unknown" ;;
esac
echo "[DB] Detected platform: ${OS_KIND}"

# =========================
# Docker CLI check
# =========================
if ! command -v docker >/dev/null 2>&1; then
    echo "[DB] ERROR: docker not found in PATH." >&2
    exit 127
fi

# =========================
# Ensure Docker daemon is ready
# =========================
ensure_docker() {
    if docker info >/dev/null 2>&1; then
        echo "[DB] Docker is ready."
        return 0
    fi

    echo "[DB] Docker not ready, attempting start..."

    case "$OS_KIND" in
        macos)
            # On macOS the daemon is Docker Desktop; we cannot start it via
            # service/systemctl. Try to launch the app, then wait.
            open -a Docker >/dev/null 2>&1 || \
                echo "[DB] Could not auto-launch Docker Desktop; please start it manually."
            ;;
        linux)
            # Prefer systemd, fall back to SysV service, then raw dockerd.
            if command -v systemctl >/dev/null 2>&1 && sudo systemctl start docker >/dev/null 2>&1; then
                echo "[DB] Docker started via systemctl."
            elif sudo service docker start >/dev/null 2>&1; then
                echo "[DB] Docker started via service."
            else
                nohup sudo dockerd --host=unix:///var/run/docker.sock > /tmp/dockerd.log 2>&1 &
                echo "[DB] dockerd started (fallback)."
            fi
            ;;
        wsl|*)
            # WSL: usually no systemd; use service or raw dockerd.
            if sudo service docker start >/dev/null 2>&1; then
                echo "[DB] Docker service started."
            else
                nohup sudo dockerd --host=unix:///var/run/docker.sock > /tmp/dockerd.log 2>&1 &
                echo "[DB] dockerd started (fallback)."
            fi
            ;;
    esac

    for i in $(seq 1 30); do
        if docker info >/dev/null 2>&1; then
            echo "[DB] Docker ready."
            return 0
        fi
        sleep 1
    done

    echo "[DB] ERROR: Docker failed to start." >&2
    exit 1
}

ensure_docker

# =========================
# Resolve database directory
# =========================
# When run via `wsl bash -s <db-dir>`, $1 is the database directory passed from Electron.
# When run directly, fall back to script-relative path.
if [[ -n "${1:-}" ]]; then
    DB_DIR="$1"
else
    SCRIPT_PATH="${BASH_SOURCE[0]}"
    if [[ "$SCRIPT_PATH" == *:* ]]; then
        drive=$(echo "$SCRIPT_PATH" | cut -d: -f1 | tr '[:upper:]' '[:lower:]')
        rest=$(echo "$SCRIPT_PATH" | cut -d: -f2- | tr '\\' '/')
        SCRIPT_PATH="/mnt/$drive$rest"
    fi
    SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
    DB_DIR="$SCRIPT_DIR/../database"
fi

echo "[DB] Database directory: $DB_DIR"
echo "[DB] Looking for: $DB_DIR/docker-compose.yml"

if [[ ! -f "$DB_DIR/docker-compose.yml" ]]; then
    echo "[DB] ERROR: docker-compose.yml not found at $DB_DIR/docker-compose.yml" >&2
    echo "[DB] Contents of DB_DIR:" >&2
    ls -la "$DB_DIR" 2>&1 || true
    exit 1
fi

cd "$DB_DIR"

# Load environment variables from .env
# Look for .env in the database directory first, then parent (src/.env)
if [[ -f .env ]]; then
    echo "[DB] Loading environment from .env"
    set -a
    source .env
    set +a
elif [[ -f ../.env ]]; then
    echo "[DB] Loading environment from ../.env"
    set -a
    source ../.env
    set +a
fi

# Use defaults if not set
POSTGRES_USER="${POSTGRES_USER:-alexljn5}"
POSTGRES_DB="${POSTGRES_DB:-emerald_utilities}"

echo "[DB] Starting PostgreSQL..."
docker compose up -d

# =========================
# Wait for Postgres
# =========================
for i in $(seq 1 30); do
    if docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
        echo "[DB] PostgreSQL ready."

        # =========================
        # Report data state (non-destructive)
        # =========================
        ROWS=$(docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
            -tAc "SELECT COUNT(*) FROM grok_messages;" 2>/dev/null || echo "unknown")
        echo "[DB] grok_messages row count: ${ROWS}"

        # =========================
        # Run merge-sins.sh for schema/migration verification
        # =========================
        echo "[DB] Running merge-sins.sh..."
        if [[ -f "$DB_DIR/merge-sins.sh" ]]; then
            if bash "$DB_DIR/merge-sins.sh"; then
                echo "[DB] merge-sins.sh completed successfully."
            else
                echo "[DB] ERROR: merge-sins.sh failed. Check output above." >&2
                echo "[DB] Database container is running but schema may be incomplete." >&2
                exit 1
            fi
        else
            echo "[DB] ERROR: merge-sins.sh not found at $DB_DIR/merge-sins.sh" >&2
            exit 1
        fi

        # =========================
        # Run sync-tasks-data.sh for JSON ↔ PostgreSQL reconciliation
        # =========================
        echo "[DB] Running sync-tasks-data.sh..."
        if [[ -f "$DB_DIR/tasks/sync-tasks-data.sh" ]]; then
            if bash "$DB_DIR/tasks/sync-tasks-data.sh"; then
                echo "[DB] sync-tasks-data.sh completed successfully."
            else
                echo "[DB] WARNING: sync-tasks-data.sh failed. Tasks may be in degraded mode." >&2
                echo "[DB] Database is running; check sync logs above." >&2
                # Do not exit 1 — the database itself is healthy
            fi
        else
            echo "[DB] WARNING: sync-tasks-data.sh not found at $DB_DIR/tasks/sync-tasks-data.sh" >&2
            echo "[DB] Skipping tasks data synchronization." >&2
        fi

        echo "[DB] Database startup complete."
        exit 0
    fi
    echo "[DB] Waiting... ($i/30)"
    sleep 1
done

echo "[DB] ERROR: PostgreSQL not ready." >&2
exit 1
