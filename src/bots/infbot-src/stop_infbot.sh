#!/usr/bin/env bash
# src/bots/infbot-src/stop_infbot.sh
# Stop the infbot Docker container.
# Usage:
#   ./stop_infbot.sh        # stop container
#   ./stop_infbot.sh down   # stop and remove container

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

COMPOSE="docker compose"
CONTAINER="infbot"

log() {
    echo "[infbot] $*"
}

log_err() {
    echo "[infbot] ERROR: $*" >&2
}

fail() {
    log_err "$*"
    exit 1
}

check_docker() {
    if ! command -v docker &>/dev/null; then
        fail "Docker is not installed or not in PATH."
    fi
}

cmd_stop() {
    check_docker

    log "Stopping INF-BOT container..."
    $COMPOSE down

    log "Container stopped."
}

cmd_down() {
    check_docker

    log "Stopping and removing INF-BOT container..."
    $COMPOSE down --remove-orphans

    log "Container removed."
}

ACTION="${1:-stop}"

case "$ACTION" in
    stop)
        cmd_stop
        ;;
    down)
        cmd_down
        ;;
    *)
        echo "Usage: $0 {stop|down}"
        echo ""
        echo "  stop    Stop the bot container (default)"
        echo "  down    Stop and remove the bot container"
        exit 1
        ;;
esac
