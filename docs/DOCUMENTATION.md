# Emerald Utilities — Master Documentation

**Version:** 0.1.6
**Status:** Active
**Last Updated:** 11 September 2026

---

## Table of Contents

1. [Application Overview](#application-overview)
2. [Technology Stack](#technology-stack)
3. [Electron Architecture](#electron-architecture)
4. [Module Documentation](#module-documentation)
5. [IPC Reference](#ipc-reference)
6. [Security](#security)
7. [Feature Status](#feature-status)
8. [Instagram Publishing Pipeline](#instagram-publishing-pipeline)
9. [Development Standards](#development-standards)
10. [Styling Standards](#styling-standards)
11. [Database & Storage](#database--storage)
12. [Testing](#testing)
13. [Release Checklist](#release-checklist)
14. [External Documentation](#external-documentation)

---

## External Documentation

| Document | Purpose |
|----------|---------|
| [`TAILSCALE_BRIDGE.md`](./TAILSCALE_BRIDGE.md) | Tailscale bridge setup for INFHUB-Server PostgreSQL |
| [`FUTURE_BACKEND_DATA_LAYER.md`](./FUTURE_BACKEND_DATA_LAYER.md) | Future backend/API design TODO (not implemented) |
| [`DATABASE_ARCHITECTURE.md`](./DATABASE_ARCHITECTURE.md) | PostgreSQL schema, migrations, pgvector, backups |
| [`CHANGELOG.md`](./CHANGELOG.md) | Version history |
| [`CONFIGURATION.md`](./CONFIGURATION.md) | Environment variables and setup guide |

---

## Application Overview

Emerald Utilities is a private desktop productivity environment built with Electron + React.

It is a personal utility platform for:

- Script execution and scheduling
- Network monitoring and traffic capture
- Database management (PostgreSQL + pgvector)
- AI chat with RAG (Retrieval-Augmented Generation)
- Social media publishing (Creator Hub)
- Portfolio monitoring
- Internet browsing and scraping (XScraper)

### Long-term Vision

A stable, self-contained desktop utility that replaces multiple disconnected tools with a single, themed, private workspace.

---

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Electron 37 |
| UI framework | React 19 + Vite |
| Styling | CSS with custom properties (pixel/gothic theme) |
| Database | PostgreSQL 16 + pgvector (Docker) |
| AI backend | Ollama (local LLM + embeddings) |
| IPC | Electron ipcMain / ipcRenderer |
| State | React useState / useEffect |
| Build | Vite + electron-builder |

---

## Electron Architecture

```
Renderer Process (React / Vite)
    │
    │ IPC (preload.js bridge)
    │
Main Process (heavensgate.js)
    │
    ├── ipcHandlers.js (general IPC)
    ├── creator-hub/ipc.js (publishing IPC)
    ├── xscraperIpcHandlers.js (scraper IPC)
    │
    ├── Services / Storage / APIs
    │   ├── scriptManager.js
    │   ├── networkManager.js
    │   ├── db-pool.js
    │   ├── rag-query.js
    │   └── creator-hub/services/
    │
    └── External
        ├── PostgreSQL (Docker)
        ├── Ollama (local)
        └── X/Twitter API
```

### Renderer Rules

Renderer may contain:

- UI components (JSX)
- React state and effects
- User interaction handlers
- IPC calls via `invoke()`

Renderer must NOT:

- Access filesystem directly
- Access databases directly
- Handle credentials directly
- Execute privileged operations
- Contain business logic

### Main Process Rules

Main process handles:

- Filesystem access (scripts, config, storage)
- Database communication (pg Pool)
- Authentication and credential management
- External API calls (OAuth, publishing)
- Background processing (cron, network capture)
- Credential encryption/decryption

---

## Module Documentation

### `src/` — Application Source

| Path | Purpose | Allowed Dependencies | Forbidden Dependencies | Security |
|------|---------|---------------------|----------------------|----------|
| `ui/` | React page components | React, CSS, electronApi | Direct fs/db access | No secrets in UI state |
| `services/` | Platform adapters (X, Bluesky, etc.) | fetch, oauth1, models | Direct fs/db access | No credential logging |
| `ipc/` | IPC handler registration | Main process modules | Renderer-only code | Validate all inputs |
| `database/` | PostgreSQL, RAG, migrations | pg, fs, dotenv | None | Credentials in .env only |
| `internal-scripts/` | Shell scripts for server mgmt | None | None | N/A |
| `scrapers/` | XScraper browser extension | None | None | N/A |
| `portfolio/` | Price tracking providers | fetch | None | API keys in .env |
| `utils/` | Shared utilities | Varies | None | No secrets in logs |
| `css/` | Stylesheets | None | None | N/A |
| `pages/` | HTML page templates | None | None | N/A |
| `mascot/` | Mascot images | None | None | N/A |
| `img/` | Static images | None | None | N/A |
| `fonts/` | Custom fonts | None | None | N/A |
| `logs/` | Network capture logs | None | None | N/A |
| `core/` | Core systems (script, network) | Varies | None | N/A |
| `creator-hub/` | Publishing system | Varies | None | Encrypted credentials |

### `src/creator-hub/` — Publishing System

| Path | Purpose |
|------|---------|
| `index.js` | Entry point / barrel export |
| `ipc.js` | IPC handler registration for all creator-hub:* channels |
| `models.js` | Data models and validation (PlatformAccount, Post) |
| `storage.js` | JSON file persistence for accounts and posts |
| `publisher.js` | Publish orchestrator — iterates targets, calls services |
| `oauth.js` | OAuth 2.0 PKCE flow helper |
| `services/` | Platform adapters (twitter.js, bluesky.js, etc.) |
| `services/oauth1.js` | OAuth 1.0a request signing |
| `services/base.js` | Platform service interface |
| `services/platforms.js` | Platform registry with metadata and capabilities |
| `utils/mediaHandler.js` | Unified media pipeline (validation, compression, upload) |
| `ui/` | React components (Composer, Queue, Accounts, Sidebar) |

### `src/utils/` — Shared Utilities

| Path | Purpose |
|------|---------|
| `electronApi.js` | Renderer-side IPC invoke/on wrappers |
| `ipcHandlers.js` | General IPC handler registration |
| `xscraperIpcHandlers.js` | XScraper-specific IPC handlers |
| `logger.js` | Logging utility |
| `pathResolver.js` | Path resolution helpers |
| `terminalHooks.js` | Terminal output hooks |

---

## IPC Reference

### General IPC

| Channel | Input | Output | Description |
|---------|-------|--------|-------------|
| `settings:get` | — | `{ ok, ui }` | Load UI settings |
| `settings:update` | `ui` | `{ ok, ui }` | Save UI settings |
| `config:save` | `{ config }` | `{ ok }` | Save full config |
| `run-script` | `{ file }` | `{ ok, pid }` | Execute a script |
| `stop-script` | `{ file }` | `{ ok }` | Stop a running script |
| `start-cron-script` | `{ file, intervalMs }` | `{ ok }` | Schedule cron script |
| `stop-cron-script` | `{ file }` | `{ ok }` | Stop cron job |
| `get-running-scripts` | — | `[]` | List running scripts |
| `get-cron-scripts` | — | `[]` | List cron jobs |
| `get-script-log-history` | `maxLines` | `[]` | Script log history |
| `network-start-capture` | `options` | `{ ok }` | Start tcpdump capture |
| `network-stop-capture` | — | `{ ok }` | Stop tcpdump capture |
| `network-capture:get-status` | — | `{ running, ... }` | Capture status |
| `network-logs:list` | `{ folder }` | `{ ok, files }` | List network logs |
| `network-logs:read` | `{ folder, file }` | `{ ok, content }` | Read network log |
| `select-directory` | — | `{ canceled, filePaths }` | Open directory dialog |
| `select-file` | `options` | `{ canceled, filePaths }` | Open file dialog |
| `get-user-data-path` | — | `string` | Electron userData path |
| `scripts:list` | — | `{ ok, scripts }` | List available scripts |
| `scripts:read` | `{ file }` | `{ ok, content }` | Read script file |
| `scripts:write` | `{ file, content }` | `{ ok }` | Write script file |
| `scripts:set-directory` | `{ customScriptsPath }` | `{ ok }` | Set scripts directory |
| `scripts:dependency-exists` | `{ file }` | `{ ok, exists }` | Check script dependency |
| `mod-updater:get-default-folder` | — | `{ path }` | Default mods folder |
| `mod-updater:select-folder` | — | `{ canceled, filePaths }` | Select mods folder |
| `mod-updater:get-minecraft-versions` | — | `{ ok, versions }` | List MC versions |
| `mod-updater:analyze` | `options` | `{ ok, mods }` | Analyze mods folder |
| `mod-updater:check` | `options` | `{ ok, updates }` | Check for updates |
| `mod-updater:download` | `options` | `{ ok, results }` | Download updates |
| `database:get-stats` | — | `{ ok, stats }` | Database statistics |
| `database:get-connection-info` | — | `{ ok, info }` | Connection info |
| `database:query` | `{ sql }` | `{ ok, rows }` | Execute SQL query |
| `database:open-pgadmin` | — | `{ ok }` | Open pgAdmin |
| `database:import-network-log` | `{ file }` | `{ ok }` | Import network log |
| `database:import-grok-export` | — | `{ ok }` | Import Grok export |
| `database:import-blacklist` | — | `{ ok }` | Import blacklist |
| `rag-auto-setup` | — | `{ ok }` | Auto-setup RAG |
| `grok-query` | `{ userQuery }` | `{ ok, answer }` | RAG query |
| `database:backup` | — | `{ ok, path }` | Backup database |
| `database:restore` | `{ backupFile }` | `{ ok }` | Restore database |
| `database:verify` | — | `{ ok, valid }` | Verify database |
| `cream-save-chat` | `{ messages }` | `{ ok }` | Save AI chat |
| `cream-load-chat` | — | `{ ok, messages }` | Load AI chat |
| `database:list-backups` | — | `{ ok, backups }` | List backups |
| `portfolio:getHoldings` | — | `{ ok, holdings }` | Get portfolio holdings |
| `portfolio:fetchQuotes` | — | `{ ok, quotes }` | Fetch live prices |
| `portfolio:fetchHistory` | `{ symbol, limit }` | `{ ok, history }` | Fetch price history |
| `devtools:toggle` | `show` | `{ ok }` | Toggle DevTools |

### Creator Hub IPC

| Channel | Input | Output | Description |
|---------|-------|--------|-------------|
| `creator-hub:list-accounts` | — | `{ ok, accounts }` | List all accounts (no credentials) |
| `creator-hub:get-account` | `{ accountId }` | `{ ok, account }` | Get single account (no credentials) |
| `creator-hub:add-account` | `{ platform, username, displayName, credentials }` | `{ ok, account, testResult?, warning? }` | Add account, test connection, set status |
| `creator-hub:authenticate-account` | `{ platform, username }` | `{ ok, account }` | OAuth flow authentication |
| `creator-hub:connect-account` | `{ accountId, credentials }` | `{ ok, account }` | Connect with new credentials |
| `creator-hub:test-account` | `{ accountId }` | `{ ok, ...result, account }` | Test connection, update status |
| `creator-hub:disconnect-account` | `{ accountId }` | `{ ok, account }` | Disconnect account |
| `creator-hub:remove-account` | `{ accountId }` | `{ ok }` | Delete account |
| `creator-hub:list-posts` | — | `{ ok, posts }` | List all posts |
| `creator-hub:get-post` | `{ postId }` | `{ ok, post }` | Get single post |
| `creator-hub:create-post` | `postData` | `{ ok, post }` | Create post |
| `creator-hub:update-post` | `{ postId, changes }` | `{ ok, post }` | Update post |
| `creator-hub:delete-post` | `{ postId }` | `{ ok }` | Delete post |
| `creator-hub:publish` | `{ postId }` | `{ ok, summary }` | Publish post to targets |
| `creator-hub:list-platforms` | — | `{ ok, platforms }` | List supported platforms with metadata |
| `creator-hub:get-platforms` | — | `{ ok, platforms }` | List supported platforms (alias) |
| `creator-hub:get-env-credentials` | — | `{ ok, credentials }` | Load X credentials from .env |

---

## Security

### Credentials

- All credentials are encrypted using Electron `safeStorage` before being written to disk
- Fallback to base64 encoding if `safeStorage` is unavailable
- Credentials are never returned to the renderer process
- Credentials are never logged
- Credentials are removed when an account is disconnected

### IPC Security

- Renderer can only call pre-defined IPC channels
- All inputs are validated before processing
- Errors do not leak secrets or internal paths
- No arbitrary function execution from renderer

### Filesystem Security

- Script execution is sandboxed to configured directories
- Path traversal is prevented by `sanitizeScriptFile()`
- File operations use validated paths only

### Network Security

- API secrets are never sent to the renderer
- OAuth 1.0a signatures are generated in the main process
- Sensitive API responses are sanitized before logging

---

## Feature Status

| Feature | Status |
|---------|--------|
| Script Runner | Stable |
| Network Monitoring | Stable |
| Database Integration | Stable |
| RAG Assistant | Testing |
| Portfolio Monitor | Stable |
| XScraper | Stable |
| Creator Hub | Testing |
| Instagram Publishing | Working |
| Multi-Platform Publishing | Testing |
| Platform Registry | Complete |
| Media Pipeline | Complete |
| Settings | Stable |
| DevTools Toggle | Stable |

---

## Instagram Publishing Pipeline

### Architecture

Instagram publishing uses a temporary local HTTP server + Cloudflare quick tunnel to expose media files to Instagram's crawler. The app runs behind NAT with no public IP, so a tunnel is required.

```
Electron main process
    │
    ├── startMediaServer(filePath)
    │       └── HTTP server on 0.0.0.0:{random-port}
    │           ├── GET /        → 200 OK (health check for tunnel readiness)
    │           └── GET /media   → 200 image/png (actual binary)
    │
    ├── startTunnel(port)
    │       └── cloudflared tunnel --url http://127.0.0.1:{port}
    │           └── returns https://{random}.trycloudflare.com
    │
    ├── waitForTunnelReady(url)
    │       └── polls GET / every 500ms until HTTP 200
    │
    ├── validateMediaEndpoint(publicUrl)
    │       └── verifies Content-Type, Content-Length, non-empty body
    │
    ├── createMediaContainer(igAccountId, token, imageUrl, caption)
    │       └── POST /{ig-id}/media → { id: "container_id" }
    │
    ├── waitForContainerReady(igAccountId, token, containerId)
    │       └── polls GET /{container-id}?fields=status_code
    │           until status_code === "FINISHED"
    │
    ├── publishMediaContainer(igAccountId, token, creationId)
    │       └── POST /{ig-id}/media_publish → { id: "media_id" }
    │
    └── cleanup
            ├── close media server
            └── stop tunnel
```

### Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `INSTAGRAM_APP_ID` | Meta app ID | — |
| `INSTAGRAM_APP_SECRET` | Meta app secret | — |
| `INSTAGRAM_REDIRECT_URI` | OAuth callback URL | — |
| `CLOUDFLARE_TUNNEL_ENABLED` | Enable auto tunnel | `true` |
| `CLOUDFLARE_BINARY` | Path to cloudflared | `cloudflared` |
| `INSTAGRAM_MEDIA_PATH` | Media route path | `/media` |
| `INSTAGRAM_MEDIA_BASE_URL` | Fixed public URL (disables tunnel) | — |
| `INSTAGRAM_CONTAINER_POLL_INTERVAL_MS` | Container status poll interval | `2000` |
| `INSTAGRAM_CONTAINER_TIMEOUT_MS` | Max wait for container ready | `60000` |

### Key Implementation Details

1. **Server binding**: The temporary media server binds to `0.0.0.0` (all interfaces), not `127.0.0.1`. Cloudflare tunnel connects to `127.0.0.1:{port}`.

2. **Health check**: `GET /` returns `200 OK` with `text/plain`. This is used by `waitForTunnelReady` to verify the tunnel edge is connected before proceeding.

3. **Media endpoint**: `GET /media` (or configured `INSTAGRAM_MEDIA_PATH`) returns the actual image binary with:
   - `Content-Type: image/png` (or detected MIME)
   - `Content-Length: {file-size}`
   - `Cache-Control: no-cache`
   - `Accept-Ranges: bytes`

4. **Tunnel readiness**: The tunnel URL appearing in cloudflared logs does NOT mean the edge is connected. `waitForTunnelReady` polls the public URL until it returns HTTP 200.

5. **Container lifecycle**: After `POST /{ig-id}/media` creates a container, Instagram needs time to fetch and process the media. The app polls `GET /{container-id}?fields=status_code` until `status_code === "FINISHED"` before calling `media_publish`.

6. **String IDs**: All Instagram IDs are handled as strings. IDs like `18073144205700788` exceed JavaScript's safe integer limit.

7. **Server lifetime**: The media server and tunnel stay alive until AFTER `media_publish` completes. Cleanup happens in the `finally` block.

### Debug Logging

```
[MEDIA] Serving file: D:\Pictures\...\hello-world.png
[MEDIA] MIME type: image/png, Size: 1056 bytes
[MEDIA] Temporary server started on port 59223 (0.0.0.0)
[CLOUDFLARE] Starting quick tunnel...
[CLOUDFLARE] Public URL detected: https://...
[CLOUDFLARE] Waiting for tunnel readiness...
[CLOUDFLARE] Tunnel ready after 1500ms (attempt 3/30)
[MEDIA] Validating public endpoint: https://.../media
[MEDIA] Validation body: Content-Type=image/png, Content-Length=1056, Actual-Bytes=1056
[MEDIA] Endpoint validation PASSED
[PUBLISH] Image container created: id=18073144205700788
[PUBLISH] Waiting for container 18073144205700788 to be ready...
[PUBLISH] Container 18073144205700788 status: IN_PROGRESS
[PUBLISH] Container 18073144205700788 status: FINISHED
[PUBLISH] Publishing media container...
[PUBLISH] Published successfully: id=17883960564610413
```

### Known Issues

- **Small test images**: The current test image (`hello-world.png`) is only 1056 bytes. Instagram accepts it, but larger real-world images should be tested.
- **Tunnel URL changes**: Each quick tunnel gets a new random URL. For production, use a named tunnel or `INSTAGRAM_MEDIA_BASE_URL`.
- **Cloudflared on Windows**: The quick tunnel does not auto-update on Windows. Manual updates may be needed.

---

## Development Standards

### Code Standards

Before adding code:

- Check existing modules for similar functionality
- Follow existing naming conventions
- Update documentation if behavior changes
- Consider security implications of new code

Avoid:

- Unused imports
- Duplicate logic
- Undocumented behavior
- Temporary solutions
- Hardcoded secrets

### Naming Conventions

- Files: `camelCase.jsx` for components, `camelCase.js` for modules
- Functions: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- CSS classes: `camelCase` with component prefix (e.g., `chButton`, `chPanel`)

---

## Styling Standards

All styles live in `src/css/`.

Rules:

- No random CSS files
- No unnecessary inline styles (use CSS classes where possible)
- Follow Emerald Utilities theme (dark, pixel/gothic)
- Accessibility first

UI requirements:

- Readable fonts (pixelSans)
- Proper contrast
- Consistent spacing (clamp-based responsive)
- Minimal unnecessary animations
- Intentional icon usage

---

## Database & Storage

### Local Storage

- Creator Hub accounts and posts: `creator-hub-data/` (dev) or `%APPDATA%/Emerald Utilities/creator-hub-data/` (prod)
- Script logs: `src/logs/logs-network/`
- AI chat: `src/database/cream/`

### Offsite Database

- PostgreSQL 16 + pgvector running in Docker
- Host: configurable via `DB_HOST` in `.env`
- Database: `emerald_utilities`
- Used for: RAG vector search, AI chat history, network log analysis

### Backup Strategy

- Database backups via `database:backup` IPC
- Volume backups via `scripts/volume-backup.sh`
- Backup verification via `database:verify` IPC

---

## Testing

### Test Infrastructure

```
tests/
  fixtures/
  integration/
```

### Testing Checklist

**Startup:**

- [ ] Fresh install launches
- [ ] Existing configuration loads
- [ ] Missing configuration handled
- [ ] Broken data recovery works

**Storage:**

- [ ] Create data
- [ ] Update data
- [ ] Delete data
- [ ] Restart persistence
- [ ] Corruption recovery

**IPC:**

- [ ] Valid input
- [ ] Missing input
- [ ] Invalid input
- [ ] Unexpected data
- [ ] Permission failure

**External APIs:**

- [ ] Authentication
- [ ] Invalid credentials
- [ ] Network failure
- [ ] Rate limits
- [ ] Permission errors

---

## Release Checklist

Before any release:

- [ ] Version updated in `globals.js` and `package.json`
- [ ] Changelog written
- [ ] Documentation updated
- [ ] Tests completed
- [ ] No secrets committed
- [ ] Production build succeeds
- [ ] Fresh install tested
- [ ] Existing data migration tested
