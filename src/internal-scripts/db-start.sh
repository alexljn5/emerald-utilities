#!/bin/bash

# db-start.sh - Start PostgreSQL database via Docker in WSL
# Usage: db-start.sh [database-dir]
#   database-dir: Path to the database directory containing docker-compose.yml
#                 Defaults to searching upward from the script location.

set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"

# Resolve script directory, handling Windows paths from Electron spawn
resolve_wsl_path() {
    local p="$1"
    if [[ "$p" == *[A-Za-z]:\\* ]]; then
        local drive rest
        drive=$(echo "$p" | cut -d: -f1 | tr '[:upper:]' '[:lower:]')
        rest=$(echo "$p" | cut -d: -f2 | tr '\\' '/')
        echo "/mnt/$drive$rest"
    else
        echo "$p"
    fi
}

SCRIPT_DIR="$(cd "$(dirname "$(resolve_wsl_path "$SCRIPT_PATH")")" && pwd)"

# Find database directory by searching upward for docker-compose.yml
find_db_dir() {
    local search_dir="$1"
    local max_depth=5
    local depth=0

    while [[ $depth -lt $max_depth ]]; do
        if [[ -f "$search_dir/docker-compose.yml" ]]; then
            echo "$search_dir"
            return 0
        fi
        # Check if we've reached the filesystem root
        if [[ "$search_dir" == "/" ]] || [[ "$search_dir" == "." ]]; then
            break
        fi
        search_dir=$(dirname "$search_dir")
        depth=$((depth + 1))
    done
    return 1
}

# Use argument if provided, otherwise search from script location
if [[ -n "${1:-}" ]]; then
    DB_DIR=$(resolve_wsl_path "$1")
else
    if ! DB_DIR=$(find_db_dir "$SCRIPT_DIR"); then
        # Fallback: try common relative locations
        for candidate in \
            "$(dirname "$SCRIPT_DIR")/database" \
            "$(dirname "$SCRIPT_DIR")/../database" \
            "$SCRIPT_DIR/../database" \
            "$(pwd)/src/database" \
            "$(pwd)/database"; do
            if [[ -f "$candidate/docker-compose.yml" ]]; then
                DB_DIR="$candidate"
                break
            fi
        done
    fi
fi

if [[ -z "${DB_DIR:-}" ]] || [[ ! -f "$DB_DIR/docker-compose.yml" ]]; then
    echo "[DB] ERROR: Could not locate docker-compose.yml" >&2
    echo "[DB] Script location: $SCRIPT_PATH" >&2
    echo "[DB] Resolved script dir: $SCRIPT_DIR" >&2
    echo "[DB] Current working directory: $(pwd)" >&2
    if [[ -n "${DB_DIR:-}" ]]; then
        echo "[DB] Tried DB_DIR: $DB_DIR" >&2
        ls -la "$DB_DIR" 2>&1 || true
    fi
    exit 1
fi

echo "[DB] Starting PostgreSQL database..."
echo "[DB] Database directory: $DB_DIR"
echo "[DB] Found: $DB_DIR/docker-compose.yml"

# Check if docker command exists
if ! command -v docker >/dev/null 2>&1; then
    echo "[DB] Docker is not installed in WSL." >&2
    echo "[DB] Install with: sudo apt update && sudo apt install -y docker.io docker-compose" >&2
    exit 127
fi

echo "[DB] Docker binary found: $(docker --version)"

# Function to wait for Docker socket to appear
wait_for_docker_socket() {
    local max_retries=${1:-30}
    local retry=0
    while [[ ! -S /var/run/docker.sock ]]; do
        retry=$((retry + 1))
        if [[ $retry -ge $max_retries ]]; then
            return 1
        fi
        echo "[DB] Waiting for Docker socket... ($retry/$max_retries)"
        sleep 1
    done
    return 0
}

# Function to wait for Docker daemon to respond
wait_for_docker_daemon() {
    local max_retries=${1:-30}
    local retry=0
    until docker info >/dev/null 2>&1; do
        retry=$((retry + 1))
        if [[ $retry -ge $max_retries ]]; then
            return 1
        fi
        echo "[DB] Waiting for Docker daemon... ($retry/$max_retries)"
        sleep 1
    done
    return 0
}

# Ensure Docker daemon is running
if [[ ! -S /var/run/docker.sock ]]; then
    echo "[DB] Docker socket not found at /var/run/docker.sock"
    echo "[DB] Attempting to start Docker daemon..."

    # Try systemd service first (works in WSL with systemd enabled)
    if sudo service docker start 2>/dev/null; then
        echo "[DB] Docker service started via systemd"
    else
        echo "[DB] systemd service start failed, trying direct dockerd launch..."
        # Start dockerd directly in background
        nohup sudo dockerd --host=unix:///var/run/docker.sock > /tmp/dockerd.log 2>&1 &
        DOCKERD_PID=$!
        echo "[DB] Started dockerd (PID: $DOCKERD_PID), logging to /tmp/dockerd.log"
    fi

    # Wait for socket and daemon
    if ! wait_for_docker_socket 20; then
        echo "[DB] ERROR: Docker socket did not appear." >&2
        echo "[DB] Check /tmp/dockerd.log for details." >&2
        exit 1
    fi

    if ! wait_for_docker_daemon 30; then
        echo "[DB] ERROR: Docker daemon failed to become ready." >&2
        echo "[DB] Check /tmp/dockerd.log for details." >&2
        exit 1
    fi
else
    echo "[DB] Docker socket found."
    if ! wait_for_docker_daemon 5; then
        echo "[DB] WARNING: Socket exists but daemon not responding. Attempting restart..."
        sudo service docker restart 2>/dev/null || {
            echo "[DB] Attempting direct dockerd launch..."
            nohup sudo dockerd --host=unix:///var/run/docker.sock > /tmp/dockerd.log 2>&1 &
        }
        wait_for_docker_daemon 30 || {
            echo "[DB] ERROR: Docker daemon failed to start." >&2
            exit 1
        }
    fi
fi

echo "[DB] Docker daemon is running: $(docker --version)"

# Start the database container
echo "[DB] Running: docker compose up -d"
cd "$DB_DIR"
docker compose up -d

# Wait for container to be healthy
echo "[DB] Waiting for PostgreSQL to be ready..."
MAX_RETRIES=30
RETRY=0
until docker compose exec -T postgres pg_isready -U emerald -d emerald_utilities >/dev/null 2>&1; do
    RETRY=$((RETRY + 1))
    if [[ $RETRY -ge $MAX_RETRIES ]]; then
        echo "[DB] ERROR: PostgreSQL did not become ready in time." >&2
        echo "[DB] Check logs with: docker compose logs postgres" >&2
        exit 1
    fi
    echo "[DB] Waiting... ($RETRY/$MAX_RETRIES)"
    sleep 2
done

echo "[DB] PostgreSQL is ready!"
echo "[DB] Connection: postgres://emerald:emerald_local@localhost:5432/emerald_utilities"
echo "[DB] Container: emerald-postgres"
