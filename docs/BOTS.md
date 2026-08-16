# Bots — INFBOT Integration

**Version:** 0.1.0
**Status:** Active
**Last Updated:** 16 August 2026

---

## Overview

INFBOT is a Discord bot integrated into Emerald Utilities. It supports two runtime modes:

- **Docker** (default on Windows/macOS) — runs in a Docker container managed by the app
- **Screen** (default on Linux/homelab) — runs in a GNU Screen session on the homelab server

Both modes survive app/PC restarts. The mode is selected automatically based on platform, or explicitly via the `BOT_MODE` environment variable.

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
│                                                │ OR screen    │
│                                                ▼              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Host / Homelab Server                    │    │
│  │  ┌─────────────────────────────────────────────────┐ │    │
│  │  │  Docker: infbot container (node:20-alpine)       │ │    │
│  │  │  Screen: screen -S infbot (node src/heavensgate) │ │    │
│  │  └─────────────────────────────────────────────────┘ │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## File Structure

```
src/bots/
├── bot-manager.js          # Bot lifecycle manager (Docker + Screen modes)
├── bot-ipc.js              # IPC handlers for renderer communication
├── bots.css                # Bots page styles
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

### 1. Runtime Modes

The bot manager (`src/bots/bot-manager.js`) supports two modes:

| Mode | Default Platform | Process | Survival |
|------|-----------------|---------|----------|
| `docker` | Windows, macOS | Docker container | `--restart unless-stopped` |
| `screen` | Linux, homelab | GNU Screen session | Screen session persists |

Mode selection:
- Auto-detected: `screen` on Linux, `docker` elsewhere
- Override with `BOT_MODE=screen` or `BOT_MODE=docker` environment variable

### 2. Screen Mode (Homelab)

For existing homelab setups using GNU Screen, the bot manager can control a screen session directly:

**Configuration (environment variables):**
- `BOT_MODE=screen` — enable screen mode
- `BOT_SCREEN_SESSION=infbot` — screen session name (default: `infbot`)
- `BOT_SCREEN_DIR=/path/to/infbot` — path to the infbot directory on the homelab
- `BOT_SCREEN_ENTRY=src/heavensgate.js` — entry point file

**How it works:**
- Start: `screen -dmS infbot bash -c "cd /path/to/infbot && node src/heavensgate.js; exec bash"`
- Stop: `screen -S infbot -X quit`
- Status: checks if screen session exists via `screen -list`
- Logs: captures screen scrollback buffer via `screen -X hardcopy`

### 3. Docker Mode (Dev/Windows)

For development or Windows, the bot runs in Docker:

- Built from `src/bots/infbot-src/Dockerfile`
- Runs with `restart: no` (does not auto-start on reboot)
- If the image is missing, the dashboard auto-builds it before starting
- Environment loaded from `src/.env`

### 4. Dashboard Controls

The Bots page (`src/pages/Bots.jsx`) provides:

| Control | Docker Action | Screen Action |
|---------|--------------|---------------|
| **START** | `docker start infbot` | `screen -dmS infbot ...` |
| **STOP** | `docker stop infbot` | `screen -S infbot -X quit` |
| **RESTART** | `docker restart infbot` | stop + start |
| **BUILD IMAGE** | `docker build -t infbot .` | Not available |

### 5. Log Streaming

- **Docker**: `docker logs --follow --tail 0 infbot`
- **Screen**: `screen -S infbot -X hardcopy /tmp/infbot-screen-hardcopy.txt` (periodic snapshots)

### 6. Auto-Start

When Emerald Utilities launches, `autoStartBot()` checks if the bot is already running. If not, it starts it automatically in the configured mode.

## Docker Commands Reference

The dashboard shows these commands for manual management (Docker mode only):

```bash
# Build the image
docker build -t infbot src/bots/infbot-src/

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

## Screen Commands Reference (Homelab)

For screen-based setups using the recommended `infbot-src/` deployment:

```bash
# Start the bot
screen -dmS infbot bash -c "cd /home/alexljn5/INFHUB/infbot && node src/bot-entry.js; exec bash"

# Attach to the session
screen -r infbot

# Detach from session (Ctrl+A then D)

# Stop the bot
screen -S infbot -X quit

# Check if running
screen -list | grep infbot

# Capture logs
screen -S infbot -X hardcopy /tmp/infbot-screen-hardcopy.txt
cat /tmp/infbot-screen-hardcopy.txt
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

### Option A: Screen Mode (Recommended for Homelab)

If you want to manage your existing homelab infbot via the Emerald Utilities dashboard:

1. Copy the bot source to your homelab:
   ```bash
   scp -r src/bots/infbot-src/ user@homelab-host:/home/alexljn5/INFHUB/infbot/
   ```
2. Ensure the entry point is `src/bot-entry.js` (renamed from `heavensgate.js`)
3. Set `BOT_MODE=screen` in the environment where Emerald Utilities runs
4. The dashboard will detect the existing screen session and control it

**Screen commands:**
```bash
# Start the bot
screen -dmS infbot bash -c "cd /home/alexljn5/INFHUB/infbot && node src/bot-entry.js; exec bash"

# Attach to the session
screen -r infbot

# Detach from session (Ctrl+A then D)

# Stop the bot
screen -S infbot -X quit

# Check if running
screen -list | grep infbot
```

### Option B: Docker Mode

For a fresh Docker deployment on homelab:

```bash
# 1. Copy the bot source to homelab
scp -r src/bots/infbot-src/ user@homelab-host:/opt/infbot/

# 2. SSH into homelab
ssh user@homelab-host

# 3. Configure environment
cd /opt/infbot
cp .env.example .env
# Edit .env with real TOKEN and HF_TOKEN

# 4. Start the bot
docker compose up -d
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

### stop_infbot.sh Commands

```bash
./stop_infbot.sh  # stop container (default)
./stop_infbot.sh stop  # stop container
./stop_infbot.sh down  # stop and remove container
```

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

The current `bot-manager.js` uses local Docker CLI or screen commands. For homelab control, replace the CLI calls with SSH commands or API calls — the IPC interface (`bot:start`, `bot:stop`, etc.) stays the same.
