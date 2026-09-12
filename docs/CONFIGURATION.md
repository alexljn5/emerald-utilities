# Emerald Utilities — Configuration Guide

**Version:** 0.1.8
**Last Updated:** 12 September 2026

---

## Table of Contents

1. [Overview](#1-overview)
2. [Development Setup](#2-development-setup)
3. [Production Setup](#3-production-setup)
4. [Environment Variables Reference](#4-environment-variables-reference)
5. [API Keys & Developer Portals](#5-api-keys--developer-portals)
6. [Database Configuration](#6-database-configuration)
7. [Importing .env After Packaging](#7-importing-env-after-packaging)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Overview

Emerald Utilities uses a **centralised environment configuration system** to manage API keys, secrets, and database credentials.

### Priority Order

When loading environment variables, the system checks sources in this order:

1. **Imported .env file** — user-selected file stored in app data directory
2. **Project .env** — `src/.env` or root `.env` (development fallback)
3. **System environment variables** — lowest priority, fills gaps

This means:
- In **development**, `src/.env` is used automatically
- In **production**, the user imports a `.env` file via Settings → Environment
- System env vars fill any missing values

### Security

- Secrets are **never** sent to the renderer process
- The Settings UI shows `********` for secret values
- A "Reveal" button allows temporary viewing with confirmation
- Imported .env files are stored in the app data directory (not the project folder)
- Production builds never bundle `.env` files

---

## 2. Development Setup

### Prerequisites

- Node.js 18+
- Git

### Step 1: Clone and Install

```bash
git clone <repository-url>
cd emerald-utilities
npm install
```

### Step 2: Create Environment File

Copy the example file:

```bash
cp .env.example src/.env
```

### Step 3: Configure Variables

Edit `src/.env` with your API keys:

```env
# Instagram
INSTAGRAM_APP_ID=your_app_id
INSTAGRAM_APP_SECRET=your_app_secret
INSTAGRAM_REDIRECT_URI=https://localhost:3541/instagram-callback

# Bluesky
BLUESKY_USERNAME=your-handle.bsky.social
BLUESKY_APP_PASSWORD=your-app-password

# Database (defaults work for local Docker)
DB_HOST=localhost
DB_PORT=5432
DB_USER=emerald
DB_PASSWORD=your_db_password
DB_DATABASE=emerald_utilities
```

### Step 4: Verify Configuration

```bash
# Start the app
npm run dev:electron
```

Then open **Settings → Environment** to see the configuration status.

---

## 3. Production Setup

### First-Time Setup After Downloading

1. **Open Settings** — navigate to the Settings page
2. **Import .env** — click "Import .env" and select your configuration file
3. **Validate Configuration** — click "Validate" to check all required variables
4. **Connect Social Accounts** — go to Creator Hub → Accounts to connect platforms

### Why Manual Import?

Development files (including `.env`) are **not included in production builds** for security reasons. This prevents API keys from being bundled with the application and exposed in the binary.

### Creating a Production .env File

Create a `.env` file anywhere on your system (e.g., `C:\Users\<you>\Documents\Emerald Utilities\.env`):

```env
# Instagram
INSTAGRAM_APP_ID=your_app_id
INSTAGRAM_APP_SECRET=your_app_secret
INSTAGRAM_REDIRECT_URI=https://localhost:3541/instagram-callback

# Threads
THREADS_APP_ID=your_threads_app_id
THREADS_APP_SECRET=your_threads_app_secret
THREADS_REDIRECT_URI=http://localhost:3541/threads/callback

# Bluesky
BLUESKY_USERNAME=your-handle.bsky.social
BLUESKY_APP_PASSWORD=your-app-password

# Database
DB_HOST=localhost
DB_PORT=5432
DB_USER=emerald
DB_PASSWORD=your_password
DB_DATABASE=emerald_utilities
```

Then import it via **Settings → Environment → Import .env**.

---

## 4. Environment Variables Reference

### Instagram API with Instagram Login

| Variable | Required | Type | Description |
|----------|----------|------|-------------|
| `INSTAGRAM_APP_ID` | Yes | Public | Meta App ID (OAuth client ID) |
| `INSTAGRAM_APP_SECRET` | Yes | Secret | Meta App Secret (OAuth client secret) |
| `INSTAGRAM_REDIRECT_URI` | Yes | Public | OAuth callback URL |

**Required permissions:** `instagram_business_basic`, `instagram_business_content_publish`

### Threads API

| Variable | Required | Type | Description |
|----------|----------|------|-------------|
| `THREADS_APP_ID` | Yes | Public | Meta App ID for Threads |
| `THREADS_APP_SECRET` | Yes | Secret | Meta App Secret for Threads |
| `THREADS_REDIRECT_URI` | Yes | Public | OAuth callback URL |

**Required permissions:** `threads_basic`, `threads_content_publish`

### Bluesky (AT Protocol)

| Variable | Required | Type | Description |
|----------|----------|------|-------------|
| `BLUESKY_USERNAME` | Yes | Public | Bluesky handle (e.g., user.bsky.social) |
| `BLUESKY_APP_PASSWORD` | Yes | Secret | App password from Settings → Privacy & Security |

### X / Twitter API

| Variable | Required | Type | Description |
|----------|----------|------|-------------|
| `X_API_KEY` | No | Secret | Twitter API key |
| `X_API_SECRET` | No | Secret | Twitter API secret |
| `X_BEARER_TOKEN` | No | Secret | Twitter bearer token |

### Database

| Variable | Required | Type | Description |
|----------|----------|------|-------------|
| `DB_HOST` | No | Public | Database host (default: localhost) |
| `DB_PORT` | No | Public | Database port (default: 5432) |
| `DB_USER` | No | Public | Database user (default: emerald) |
| `DB_PASSWORD` | No | Secret | Database password |
| `DB_DATABASE` | No | Public | Database name (default: emerald_utilities) |

### Portfolio Monitor

| Variable | Required | Type | Description |
|----------|----------|------|-------------|
| `EODHD_API` | No | Secret | EOD Historical Data API key |

---

## 5. API Keys & Developer Portals

### Where to Get Credentials

| Service | Developer Portal | Required Account Type |
|---------|-----------------|----------------------|
| Instagram | [Meta Developer Portal](https://developers.facebook.com/) | Instagram Professional (Business/Creator) |
| Threads | [Meta Developer Portal](https://developers.facebook.com/) | Threads profile |
| Bluesky | [Bluesky Docs](https://docs.bsky.app/) | Bluesky account |
| X/Twitter | [Twitter Developer Portal](https://developer.twitter.com/) | Developer account |
| EODHD | [EOD Historical Data](https://eodhd.com/) | API subscription |

### Detailed Setup Guides

- [Instagram API Setup](INSTAGRAM_SETUP.md)
- [Social Media API Setup](SOCIAL_MEDIA_API_SETUP.md)
- [Developer Portals Reference](DEVELOPER_PORTALS.md)

---

## 6. Database Configuration

### Default Configuration

The database module connects to a local Docker PostgreSQL instance by default:

```env
DB_HOST=localhost
DB_PORT=5432
DB_USER=emerald
DB_PASSWORD=
DB_DATABASE=emerald_utilities
```

### Docker Setup

The database runs in a Docker container defined in `src/database/docker-compose.yml`:

```bash
# Start the database
./src/internal-scripts/db-start.sh

# Stop the database
./src/internal-scripts/db-stop.sh
```

### Tailscale Bridge (Development / Homelab)

For development against the homelab PostgreSQL server on `<server-hostname>-Server`,
Emerald connects through the private Tailscale mesh network.

**Tailscale is OS-level infrastructure only.** Emerald never starts,
stops, or authenticates Tailscale — it just opens a normal PostgreSQL
connection to whatever `DB_HOST` is configured.

Configure the host using the <server-hostname> MagicDNS hostname (preferred)
or the direct Tailscale IP (fallback):

```env
# MagicDNS (preferred)
DB_HOST=<server-hostname>
DB_PORT=5432

# Direct Tailscale IP (fallback)
DB_HOST=100.125.191.76
DB_PORT=5432
```

For pure local development, keep `DB_HOST=localhost` (or `127.0.0.1`).

Full details: [`docs/TAILSCALE_BRIDGE.md`](./TAILSCALE_BRIDGE.md).

#### Preflight Check

Before starting the app, verify database connectivity:

```bash
node src/database/scripts/db-preflight.js
```

This reports host, port, database name, connection status, PostgreSQL
version, and pgvector availability — without ever printing the password.

---

## 7. Importing .env After Packaging

When you build the app for production (`npm run build` or `npm run package`), the `.env` file is **not** included in the output. This is intentional — API keys must never be bundled.

To use the app with your credentials:

1. Copy your `.env` file to a safe location outside the project folder
2. Run the packaged app
3. Go to **Settings → Environment**
4. Click **Import .env** and select your file
5. Click **Validate** to confirm all variables are loaded

The imported file is stored in the app data directory (e.g., `%APPDATA%/Emerald Utilities/.env` on Windows).

---

## 8. Troubleshooting

### Database Connection Failed

1. Check that Docker is running: `docker ps`
2. Check that the PostgreSQL container is up: `docker logs emerald-postgres`
3. Verify `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` in `.env`
4. Run the database diagnostic from Settings → Database

### OAuth Redirect URI Mismatch

- Instagram/Threads require HTTPS for OAuth in production
- Use `emerald://` deep-link protocol or `https://localhost:3541/` with mkcert certificates
- Ensure the redirect URI in your Meta App Dashboard matches exactly

### API Key Invalid

- Verify the key in the developer portal
- Check for extra whitespace in `.env` values
- Some keys require specific permissions — review the developer portal docs
