#!/usr/bin/env bash
# src/containers/infbot-src/start_infbot.sh
# Idempotent deployment script for INF-BOT on homelab.
# Usage:
#   ./start_infbot.sh          # start (default)
#   ./start_infbot.sh start    # start
#   ./start_infbot.sh stop     # stop container
#   ./start_infbot.sh restart  # restart container
#   ./start_infbot.sh status   # show status
#   ./start_infbot.sh logs     # follow logs
#   ./start_infbot.sh update   # rebuild and recreate

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

COMPOSE="docker compose"
CONTAINER="infbot"
REQUIRED_VARS=("TOKEN" "HF_TOKEN")

# ==================== HELPERS ====================

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

# ==================== PREREQUISITE CHECKS ====================

check_docker() {
    if ! command -v docker &>/dev/null; then
        fail "Docker is not installed or not in PATH."
    fi
}

check_compose() {
    if ! docker compose version &>/dev/null; then
        fail "Docker Compose is not available. Install docker-compose-plugin."
    fi
}

check_env_file() {
    if [[ ! -f ".env" ]]; then
        fail ".env file not found. Copy .env.example to .env and fill in values."
    fi
}

check_required_vars() {
    local missing=()
    for var in "${REQUIRED_VARS[@]}"; do
        if ! grep -qE "^${var}=" ".env" 2>/dev/null; then
            missing+=("$var")
        fi
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        fail "Missing required environment variables in .env: ${missing[*]}"
    fi
}

# ==================== ACTIONS ====================

cmd_start() {
    check_docker
    check_compose
    check_env_file
    check_required_vars

    log "Starting INF-BOT container..."
    $COMPOSE up -d

    log "Container started. Use 'docker compose logs -f infbot' to follow logs."
}

cmd_stop() {
    check_docker
    check_compose

    log "Stopping INF-BOT container..."
    $COMPOSE down

    log "Container stopped."
}

cmd_restart() {
    check_docker
    check_compose

    log "Restarting INF-BOT container..."
    $COMPOSE restart

    log "Container restarted."
}

cmd_status() {
    check_docker

    echo ""
    echo "INF-BOT"
    echo "======="

    # Check if container exists
    if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
        local status
        status=$(docker inspect --format='{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo "unknown")

        echo "Container: $CONTAINER"
        echo "Status:    $status"

        if [[ "$status" == "running" ]]; then
            local image
            image=$(docker inspect --format='{{.Config.Image}}' "$CONTAINER" 2>/dev/null || echo "unknown")
            local uptime
            uptime=$(docker inspect --format='{{.State.StartedAt}}' "$CONTAINER" 2>/dev/null || echo "unknown")
            echo "Image:     $image"
            echo "Started:   $uptime"
        fi

        # Show restart policy
        local restart_policy
        restart_policy=$(docker inspect --format='{{.HostConfig.RestartPolicy.Name}}' "$CONTAINER" 2>/dev/null || echo "unknown")
        echo "Restart:   $restart_policy"
    else
        echo "Container: not created"
        echo "Status:    stopped"
    fi

    echo ""
}

cmd_logs() {
    check_docker
    check_compose

    log "Following logs (Ctrl+C to stop)..."
    $COMPOSE logs -f --tail=100 infbot
}

cmd_update() {
    check_docker
    check_compose
    check_env_file
    check_required_vars

    log "Updating INF-BOT..."

    # Pull latest code if in a git repo
    if [[ -d ".git" ]]; then
        log "Pulling latest code..."
        git pull --ff-only || log "Git pull failed or not a git repo, continuing with local files."
    fi

    # Rebuild and recreate
    $COMPOSE up -d --build --force-recreate

    log "Update complete."
}

# ==================== MAIN ====================

ACTION="${1:-start}"

case "$ACTION" in
    start)
        cmd_start
        ;;
    stop)
        cmd_stop
        ;;
    restart)
        cmd_restart
        ;;
    status)
        cmd_status
        ;;
    logs)
        cmd_logs
        ;;
    update)
        cmd_update
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|logs|update}"
        echo ""
        echo "  start    Start the bot container (default)"
        echo "  stop     Stop the bot container"
        echo "  restart  Restart the bot container"
        echo "  status   Show container status"
        echo "  logs     Follow container logs"
        echo "  update   Rebuild image and recreate container"
        exit 1
        ;;
esac
