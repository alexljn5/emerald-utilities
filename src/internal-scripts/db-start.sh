#!/bin/bash
set -euo pipefail

# =========================
# WSL detection
# =========================
IS_WSL=false
if grep -qi microsoft /proc/version 2>/dev/null; then
    IS_WSL=true
fi

if [ "$IS_WSL" = false ]; then
    echo "[DB] ERROR: This script must run inside WSL." >&2
    exit 1
fi

# =========================
# Ensure Docker CLI exists
# =========================
if ! command -v docker >/dev/null 2>&1; then
    echo "[DB] ERROR: docker not found in PATH." >&2
    exit 127
fi

# =========================
# Ensure Docker daemon is ready
# =========================
ensure_docker_daemon() {
    echo "[DB] Checking Docker daemon..."

    if docker info >/dev/null 2>&1; then
        echo "[DB] Docker daemon is ready."
        return 0
    fi

    echo "[DB] Docker daemon is not reachable. Attempting to start..."

    # Try systemd service first
    if sudo service docker start 2>/dev/null; then
        echo "[DB] Docker service started via systemd."
    else
        echo "[DB] systemd unavailable, starting dockerd directly..."
        nohup sudo dockerd --host=unix:///var/run/docker.sock > /tmp/dockerd.log 2>&1 &
        echo "[DB] dockerd launched in background (log: /tmp/dockerd.log)"
    fi

    # Wait for socket
    echo "[DB] Waiting for Docker socket..."
    for i in {1..30}; do
        if [ -S /var/run/docker.sock ]; then
            echo "[DB] Docker socket appeared."
            break
        fi
        sleep 1
    done

    # Wait for daemon to respond
    echo "[DB] Waiting for Docker daemon to respond..."
    for i in {1..30}; do
        if docker info >/dev/null 2>&1; then
            echo "[DB] Docker daemon is ready."
            return 0
        fi
        sleep 1
    done

    echo "[DB] ERROR: Docker daemon failed to start." >&2
    echo "[DB] Check /tmp/dockerd.log for details." >&2
    echo "[DB] You can also start Docker Desktop on Windows and enable WSL integration." >&2
    return 1
}

if ! ensure_docker_daemon; then
    exit 1
fi

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

echo "[DB] Starting PostgreSQL..."
docker compose up -d

# =========================
# Wait for Postgres
# =========================
for i in {1..30}; do
    if docker compose exec -T postgres pg_isready -U emerald -d emerald_utilities >/dev/null 2>&1; then
        echo "[DB] PostgreSQL ready."
        exit 0
    fi
    echo "[DB] Waiting... ($i/30)"
    sleep 1
done

echo "[DB] ERROR: PostgreSQL not ready." >&2
exit 1
