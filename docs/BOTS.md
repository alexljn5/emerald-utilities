# Bots — INFBOT Integration

**Version:** 0.1.0
**Status:** Active
**Last Updated:** 16 August 2026

---

## Overview

INFBOT is a Discord bot integrated into Emerald Utilities. It runs as a **Docker container** managed by the app, so it survives Emerald Utilities closing and PC restarts.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Emerald Utilities                         │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
│  │   Bots.jsx  │───▶│  bot-ipc.js │───▶│ bot-manager │     │
│  │  (Renderer) │    │  (IPC)      │    │  (Main)     │     │
│  └─────────────┘    └─────────────┘    └──────┬──────┘     │
│                                                │              │
│                                                │ docker CLI   │
│                                                ▼              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Docker Daemon (Host)                    │    │
│  │  ┌─────────────────────────────────────────────────┐ │    │
│  │  │  infbot container (node:20-alpine)               │ │    │
│  │  │  - Runs src/bots/infbot-src/bot-entry.js         │ │    │
│  │  │  - --restart unless-stopped                      │ │    │
│  │  │  - Env from src/.env                             │ │    │
│  │  └─────────────────────────────────────────────────┘ │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## File Structure

```
src/bots/
├── bot-manager.js          # Docker-based bot lifecycle manager
├── bot-ipc.js              # IPC handlers for renderer communication
├── Dockerfile              # Bot container build definition
├── start_infbot.sh         # Original startup script (preserved)
└── infbot-src/
    ├── bot-entry.js        # Bot entry point (renamed from heavensgate.js)
    ├── commands.js         # Discord commands
    ├── randompopups.js     # Random popup messages
    ├── creamai/
    │   ├── cream.js        # Cream AI chat (HuggingFace)
    │   └── agonycream.js   # Agony Cream AI
    ├── network/
    │   ├── imagefetcher.js # DuckDuckGo image search
    │   └── sonic_characters.js # Character config
    ├── games/
    │   ├── game_main.js    # Simple RPG game
    │   └── db.js           # MariaDB connection
    ├── logging/
    │   └── infbot_log_main.js # Error logging
    ├── database/
    │   └── schematic.sql   # Game DB schema
    ├── ascii/              # ASCII art files
    └── economy/            # Economy system (placeholder)
```

## How It Works

### 1. Docker Container Lifecycle

The bot runs in a Docker container named `infbot`. The container is built from `src/bots/Dockerfile` and uses the `node:20-alpine` base image.

**Key features:**
- `--restart unless-stopped` — container auto-restarts on crash or host reboot
- `--env-file src/.env` — loads `TOKEN` and `HF_TOKEN` from the project's `.env`
- Volume mount not needed — all code is baked into the image

### 2. Dashboard Controls

The Bots page (`src/pages/Bots.jsx`) provides:

| Control | Action |
|---------|--------|
| **START** | `docker start infbot` (or `docker run` if container doesn't exist) |
| **STOP** | `docker stop infbot` |
| **RESTART** | `docker restart infbot` |
| **BUILD IMAGE** | `docker build -t infbot src/bots/` |
| **Refresh** | Re-fetch logs from Docker |
| **Clear** | Clear local log buffer |

### 3. Log Streaming

Logs are streamed in real-time using `docker logs --follow --tail 0 infbot`. The bot-manager captures stdout/stderr and broadcasts them to the renderer via the existing `broadcast` system.

### 4. Auto-Start

When Emerald Utilities launches, `autoStartBot()` in `src/heavensgate.js` checks if the container is already running. If not, it starts it automatically.

## Docker Commands Reference

The dashboard shows these commands for manual management:

```bash
# Build the image
docker build -t infbot src/bots/

# Run the container (first time)
docker run -d --name infbot --restart unless-stopped --env-file src/.env infbot

# Start/stop/restart
docker start infbot
docker stop infbot
docker restart infbot

# View logs
docker logs -f infbot

# Remove container (stops auto-restart)
docker rm -f infbot
```

## Environment Variables

The bot reads from `src/.env`:

| Variable | Purpose |
|----------|---------|
| `TOKEN` | Discord bot token |
| `HF_TOKEN` | HuggingFace API token (for Cream AI) |

## Dependencies

Added to `package.json`:
- `discord.js` — Discord API client
- `@huggingface/inference` — HuggingFace AI calls
- `duckduckgo-images-api` — Image search for character commands
- `openai` — OpenAI API (available for future use)

## Bot Commands

| Command | Description |
|---------|-------------|
| `.help` | Show all commands |
| `.cream` | Random Cream the Rabbit image |
| `.big` | Random Big the Cat image |
| `.rouge` | Random Rouge the Bat image |
| `.sonic` | Random Sonic image |
| `.metal` | Random Metal Sonic image |
| `.neometal` | Random Neo Metal Sonic image |
| `.amy` | Random Amy Rose image |
| `.tails` | Random Tails image |
| `.sonicexe` | Random Sonic.EXE image |
| `.cat` | Random ASCII cat |
| `.reverse` | Reverse text |
| `.zalgo` | Zalgo text generator |
| `.talk` | Start Cream AI chat thread |
| `.agony` | Generate unsettling text |
| `.game` | Simple RPG game |

---

## Homelab Deployment

### Self-Contained Deployment Directory

A production-ready deployment package lives at `infbot-deploy/`:

```
infbot-deploy/
├── docker-compose.yml
├── start_infbot.sh
├── .env.example
├── .gitignore
├── Dockerfile
├── package.json
└── infbot-src/
    ├── bot-entry.js
    ├── commands.js
    ├── randompopups.js
    ├── creamai/
    ├── network/
    ├── games/
    ├── logging/
    ├── database/
    ├── ascii/
    └── economy/
```

### Quick Start on Homelab

```bash
# 1. Copy the deployment directory to homelab
scp -r infbot-deploy/ user@homelab-host:/opt/infbot/

# 2. SSH into homelab
ssh user@homelab-host

# 3. Configure environment
cd /opt/infbot
cp .env.example .env
# Edit .env with real TOKEN and HF_TOKEN

# 4. Start the bot
./start_infbot.sh
```

### start_infbot.sh Commands

```bash
./start_infbot.sh        # start (default)
./start_infbot.sh start  # start
./start_infbot.sh stop   # stop container
./start_infbot.sh restart # restart container
./start_infbot.sh status # show status
./start_infbot.sh logs   # follow logs
./start_infbot.sh update # rebuild and recreate
```

The script is **idempotent** — running it multiple times is safe and will not create duplicate containers.

### Update Workflow

```bash
cd /opt/infbot
git pull                    # if using git
./start_infbot.sh update    # rebuild image and recreate container
```

Or if copying files manually:
```bash
cp -r updated/files /opt/infbot/
cd /opt/infbot
./start_infbot.sh update
```

### Environment Variables

Create `.env` from `.env.example`:

```env
TOKEN=your_discord_bot_token_here
HF_TOKEN=your_huggingface_token_here
```

**Never commit `.env` to version control.** The `.gitignore` excludes it.

### One-Time Homelab Setup

```bash
# Install Docker and Docker Compose on the homelab
# Ubuntu/Debian:
sudo apt update
sudo apt install -y docker.io docker-compose-plugin

# Add your user to the docker group (log out/in after)
sudo usermod -aG docker $USER
```

### How Emerald Utilities Can Later Control the Homelab Bot

The bot is completely independent of Emerald Utilities. Future integration options:

1. **SSH-based control** — Emerald Utilities SSHes into the homelab and runs `./start_infbot.sh` commands
2. **API proxy** — Run a small HTTP API on the homelab that exposes Docker control endpoints
3. **Shared monitoring** — Emerald Utilities reads container status via Docker remote API

The current `bot-manager.js` uses local Docker CLI. For homelab control, replace the CLI calls with SSH commands or API calls — the IPC interface (`bot:start`, `bot:stop`, etc.) stays the same.
