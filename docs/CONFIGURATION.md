# Emerald Utilities — Configuration Guide

**Version:** 0.1.5
**Last Updated:** 23 July 2026

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

### Custom Database

To use a different database instance, set the environment variables:

```env
DB_HOST=192.168.1.100
DB_PORT=5432
DB_USER=custom_user
DB_PASSWORD=custom_password
DB_DATABASE=custom_db
```

### Connection Verification

The Settings → Environment page shows the database connection status. You can also use the Database page to test the connection and view schema information.

---

## 7. Importing .env After Packaging

### Step-by-Step

1. **Create a .env file** with your configuration (see [Production Setup](#3-production-setup))
2. **Open Emerald Utilities**
3. **Navigate to Settings** → **Environment Configuration**
4. **Click "Import .env"**
5. **Select your .env file** using the file picker
6. **Verify** the configuration status shows all required variables as configured

### What Happens

- The file is **copied** to the app data directory (`%APPDATA%/Emerald Utilities/config/imported.env`)
- The original file is **not modified**
- Configuration persists across app restarts
- To update, simply import a new .env file

### Clearing Imported Configuration

Click **"Clear Imported"** in Settings → Environment to remove the imported configuration. The app will fall back to development or system environment variables.

---

## 8. Troubleshooting

### "No environment configuration loaded"

**Cause:** No `.env` file found in any source.

**Fix:** 
- Development: Create `src/.env` from `.env.example`
- Production: Import a `.env` file via Settings → Environment

### "Missing required variables: INSTAGRAM_APP_ID"

**Cause:** The Instagram App ID is not set.

**Fix:** Add `INSTAGRAM_APP_ID=your_value` to your `.env` file and reload.

### "Instagram integration unavailable: missing INSTAGRAM_APP_ID"

**Cause:** Instagram is not configured, but other services may still work.

**Fix:** This is expected if you don't use Instagram. The app continues to function with other configured services.

### Imported configuration not persisting

**Cause:** The app data directory may not be writable.

**Fix:** 
- Windows: Check `%APPDATA%/Emerald Utilities/config/` exists and is writable
- Linux: Check `~/.config/Emerald Utilities/config/` exists and is writable
- macOS: Check `~/Library/Application Support/Emerald Utilities/config/` exists and is writable

### "Failed to read imported env"

**Cause:** The imported file may be corrupted or unreadable.

**Fix:** Re-import the `.env` file. Ensure the file is a valid text file with `KEY=VALUE` format.

### Configuration not updating after import

**Cause:** The environment was not reloaded.

**Fix:** Click "Reload" in Settings → Environment after importing.

---

## Quick Reference

### File Locations

| File | Purpose | Location |
|------|---------|----------|
| `.env.example` | Template with all variables | Project root |
| `src/.env` | Development configuration | `src/.env` (git-ignored) |
| `imported.env` | Production configuration | App data directory |
| `config.json` | Application settings | `scripts/config.json` |

### Commands

```bash
# Development: create env file
cp .env.example src/.env

# Edit configuration
nano src/.env

# Verify configuration (in-app)
# Settings → Environment → Validate
