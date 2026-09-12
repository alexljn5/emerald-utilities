# Emerald Utilities — Developer Portals Reference

**Last Updated:** 23 July 2026

---

## Table of Contents

1. [Meta Developer Portal](#1-meta-developer-portal)
2. [Instagram API Dashboard](#2-instagram-api-dashboard)
3. [Threads API Dashboard](#3-threads-api-dashboard)
4. [Bluesky Developer Documentation](#4-bluesky-developer-documentation)
5. [X/Twitter Developer Portal](#5-xtwitter-developer-portal)
6. [Database Administration](#6-database-administration)
7. [Docker Configuration](#7-docker-configuration)

---

## 1. Meta Developer Portal

**URL:** [https://developers.facebook.com/](https://developers.facebook.com/)

### Overview

The Meta Developer Portal is the central hub for all Meta-owned platforms:
- Instagram API with Instagram Login
- Threads API
- Facebook Graph API

### Getting Started

1. **Create a Meta Developer Account**
   - Go to [developers.facebook.com](https://developers.facebook.com/)
   - Click **Get Started**
   - Verify your Facebook account

2. **Create an App**
   - Click **My Apps** → **Create App**
   - Select **Business** as the app type
   - Fill in app name and contact email
   - Click **Create App ID**

3. **Add Products**
   - From the Dashboard, find **Add a Product**
   - Select **Instagram API with Instagram Login**
   - Click **Set Up**

4. **Configure App Settings**
   - **App ID:** Found at the top of the Dashboard page
   - **App Secret:** Found in App Settings → Basic → App Secret (click **Show**)
   - **Valid OAuth Redirect URIs:** Settings → Advanced → Security → **Client OAuth Settings**

### Key Sections

| Section | Purpose | Location |
|---------|---------|----------|
| Dashboard | App overview, ID, metrics | Top-level |
| App Settings → Basic | App ID, App Secret, contact info | Left sidebar |
| App Settings → Advanced | OAuth settings, security | Left sidebar |
| Instagram API | Permissions, token generator | Left sidebar |
| Roles → Test Users | Create test accounts | Left sidebar |
| App Review | Submit permissions for approval | Left sidebar |

### Required Actions

- [ ] App created (Business type)
- [ ] Instagram API with Instagram Login product added
- [ ] `instagram_business_basic` permission requested
- [ ] `instagram_business_content_publish` permission requested
- [ ] Valid OAuth Redirect URIs configured
- [ ] App ID and App Secret noted

---

## 2. Instagram API Dashboard

**URL:** [https://developers.facebook.com/apps/{APP_ID}/instagram/](https://developers.facebook.com/apps/{APP_ID}/instagram/)

### Overview

The Instagram API section manages permissions, token generation, and webhook configuration for the Instagram Graph API.

### Permissions Required

| Permission | Status | Purpose |
|-----------|--------|---------|
| `instagram_business_basic` | Ready for testing | Read profile info and media |
| `instagram_business_content_publish` | Ready for testing | Create and publish feed posts |

### Testing Without App Review

1. **Add Test Users**
   - Go to **App Review** → **Roles** → **Test Users**
   - Click **Add** → create a test Instagram user
   - The test user must have a **Business/Creator Instagram account**

2. **Add Instagram Tester Role**
   - In Instagram API settings, go to **Instagram Tester**
   - Add the test user's Instagram handle
   - The test user must accept the invitation

3. **Generate Test Token**
   - Use the **Graph API Explorer** tool
   - Select your app
   - Select the Instagram Business account
   - Generate token with required permissions

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| "Insufficient developer role" | Account not added as tester | Add account under Roles → Test Users |
| "Invalid user ID" | Using profile URL instead of ID | Use the Instagram Professional account ID |
| "Permission not granted" | User didn't authorize scopes | Re-authenticate with correct scopes |
| "App not in development mode" | App mode set to Live | Set to Development mode for testing |

---

## 3. Threads API Dashboard

**URL:** [https://developers.facebook.com/apps/{APP_ID}/threads/](https://developers.facebook.com/apps/{APP_ID}/threads/)

### Overview

Threads API allows posting and managing content on Threads via the Instagram Graph API infrastructure.

### Required Permissions

| Permission | Purpose |
|-----------|---------|
| `threads_basic` | Read Threads profile info |
| `threads_content_publish` | Create and publish Threads posts |
| `threads_manage_insights` | Read analytics data |
| `threads_manage_mentions` | Read @mentions |
| `threads_manage_replies` | Reply to Threads |

### Setup Steps

1. **Enable Threads API Product**
   - In your Meta App Dashboard, click **Add Product**
   - Find **Threads API** and click **Set Up**

2. **Link Threads Account**
   - Your Threads account must be linked to a Facebook Page
   - Go to Threads → Settings → Account → Linked Accounts

3. **Generate Token**
   - Use the Graph API Explorer with `https://www.threads.net/` as the app's domain
   - Select `threads_basic` and `threads_content_publish` scopes

### Environment Variables

```env
THREADS_APP_ID=your_threads_app_id
THREADS_APP_SECRET=your_threads_app_secret
THREADS_REDIRECT_URI=http://localhost:3541/threads/callback
```

---

## 4. Bluesky Developer Documentation

**URL:** [https://docs.bsky.app/](https://docs.bsky.app/)

### Overview

Bluesky uses the AT Protocol (ATP) for decentralized social networking. Authentication uses app passwords, not OAuth.

### Authentication

Bluesky does not use OAuth. Instead:

1. **Create a Bluesky account** at [bsky.app](https://bsky.app/)
2. **Generate an App Password:**
   - Go to **Settings** → **Privacy & Security**
   - Scroll to **App Passwords**
   - Click **Add App Password**
   - Name it (e.g., "Emerald Utilities")
   - Copy the generated password
3. **Configure Environment:**
   
```env
   BLUESKY_USERNAME=your-handle.bsky.social
   BLUESKY_APP_PASSWORD=your-app-password-here
   
```

### Key API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `com.atproto.server.createSession` | POST | Authenticate and get session token |
| `com.atproto.repo.uploadBlob` | POST | Upload image binary |
| `com.atproto.repo.createRecord` | POST | Create a post record |

### Image Upload Workflow

1. **Read file** as binary (via IPC)
2. **Upload blob** to `com.atproto.repo.uploadBlob`
3. **Receive blob object** containing `ref.$link`, `mimeType`, `size`
4. **Use blob object directly** in the embed — do not reconstruct it
5. **Create record** with `embed` containing the blob

### Important Notes

- App passwords are **not** your main password
- Each app should have its own app password
- App passwords can be revoked individually
- The full blob object from `uploadBlob()` must be reused directly

---

## 5. X/Twitter Developer Portal

**URL:** [https://developer.twitter.com/](https://developer.twitter.com/)

### Overview

X (Twitter) API v2 provides posting and media upload capabilities.

### Setup

1. **Apply for a Developer Account** at [developer.twitter.com](https://developer.twitter.com/)
2. **Create a Project** → **Create an App** within the project
3. **Generate API Keys:**
   - API Key (Client ID)
   - API Secret Key (Client Secret)
   - Bearer Token

### Authentication

X/Twitter uses OAuth 1.0a for user-context requests (posting) and OAuth 2.0 Bearer for app-only requests.

### Environment Variables

```env
X_API_KEY=your_api_key
X_API_SECRET=your_api_secret
X_BEARER_TOKEN=your_bearer_token
```

---

## 6. Database Administration

### PostgreSQL (Docker)

**Connection:** `localhost:5432` (default)
**Database:** `emerald_utilities`
**User:** `emerald`

### Admin Tools

| Tool | URL | Purpose |
|------|-----|---------|
| pgAdmin | `http://localhost:5050` | Web-based PostgreSQL admin |
| psql CLI | `docker exec -it emerald-postgres psql -U emerald -d emerald_utilities` | Command-line access |

### Docker Commands

```bash
# Check container status
docker ps | grep emerald-postgres

# View logs
docker logs emerald-postgres

# Restart container
docker restart emerald-postgres

# Access psql
docker exec -it emerald-postgres psql -U emerald -d emerald_utilities

# Backup
docker exec emerald-postgres pg_dump -U emerald emerald_utilities > backup.sql
```

### Schema Management

The database schema is defined in `src/database/envy.sql`. It is idempotent — safe to re-run.

---

## 7. Docker Configuration

### Docker Compose

The Docker setup is defined in `src/database/docker-compose.yml`:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    container_name: emerald-postgres
    environment:
      POSTGRES_DB: emerald_utilities
      POSTGRES_USER: emerald
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    ports:
      - "5432:5432"
    volumes:
      - emerald-postgres-data:/var/lib/postgresql/data
```

### Container Management Scripts

| Script | Purpose |
|--------|---------|
| `db-start.sh` | Start PostgreSQL container |
| `db-stop.sh` | Stop PostgreSQL container |
| `volume-backup.sh` | Backup database volume |
| `volume-restore.sh` | Restore database volume |
| `volume-verify.sh` | Verify backup integrity |
| `rag-setup.sh` | Ensure pgvector and embedding index |

### Environment Variables

```env
DB_HOST=localhost
DB_PORT=5432
DB_USER=emerald
DB_PASSWORD=your_password
DB_DATABASE=emerald_utilities
```

---

## Quick Reference Dashboard

| Service | Portal URL | Key Credentials |
|---------|-----------|-----------------|
| Meta / Instagram | [developers.facebook.com](https://developers.facebook.com/) | App ID + App Secret |
| Bluesky | [docs.bsky.app](https://docs.bsky.app/) | Handle + App Password |
| X/Twitter | [developer.twitter.com](https://developer.twitter.com/) | API Key + Secret + Bearer Token |
| Database | Docker localhost:5432 | User + Password |
