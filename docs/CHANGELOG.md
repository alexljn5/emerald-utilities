# Emerald Utilities — Changelog

**Version:** 0.1.7
**Status:** Active
**Last Updated:** 12 September 2026

---

## [0.1.7] — 2026-09-12

### Added
- Centralised date/time formatting utility (`src/utils/dateUtils.js`) with
  `formatDate`, `formatTime`, and `formatDateTime` helpers pinned to the
  `en-GB` locale (day/month/year order)
- Unit tests for the date utility (`tests/unit/dateUtils.test.js`)
- Container viewing bridge on the Containers page — lists all active Docker
  containers (local + remote via Tailscale/SSH) with auto-refresh every 10s
  (`container:list-active` and `container:list-all` IPC handlers)

### Changed
- All user-facing date and time displays now use `en-GB` locale (dd/mm/yy)
  instead of the system default, which produced American mm/dd/yy format on
  US-configured machines
- Updated components: `Dashboard.jsx`, `Tasks.jsx`, `Internet.jsx`,
  `Database.jsx`, `DateTimePicker.jsx`, `notificationService.js`,
  `pages/js/database.js`, `bot-entry.js`, and all Creator Hub UI components
  (`Sidebar.jsx`, `Queue.jsx`, `PostLogs.jsx`, `History.jsx`,
  `AccountPanel.jsx`, `LogViewer.jsx`)
- Renamed `src/bots/` module to `src/containers/` to reflect its purpose as a
  container management module; updated all imports in `heavensgate.js`,
  `main.jsx`, `Dashboard.jsx`, and internal file references
- Renamed `src/pages/Bots.jsx` → `src/pages/Containers.jsx`
- Renamed `src/css/bots.css` → `src/css/containers.css`
- `docs/STANDARDISATION.md` bumped to 0.1.7
- `docs/TODO.md` archived to
  `docs/archive/todo/TODO-12-09-2026-11-13.md`

### Fixed
- Database connection status now shows "Connected" on first load instead of
  "Disconnected" — `getConnectionInfo()` in `wrath.js` now performs a fresh
  health check before returning status
- `wrath.js` `getConnectionInfo()` no longer references undefined `resolved`
  variable; uses `connectionInfo` from `db-pool.js`
- Database host is configurable via the Database Configuration section in the
  Database page (writes to `config.json`, requires app restart)

### Security
- No security changes in this release

---

## [0.1.6] — 2026-09-11

### Added
- Tailscale bridge for safe development access to INFHUB-Server PostgreSQL
  (`docs/TAILSCALE_BRIDGE.md`)
- Clean database abstraction boundary (`src/database/database.js`):
  `connect()`, `query()`, `healthCheck()`, `getConnectionInfo()`, `ping()`
- Standalone database preflight/health check CLI
  (`src/database/scripts/db-preflight.js`)
- Enhanced `checkDbHealth()` reports PostgreSQL version + pgvector
  availability (never logs passwords)
- Future backend/data-layer design doc
  (`docs/FUTURE_BACKEND_DATA_LAYER.md`)

### Changed
- `config.json` no longer hardcodes the public IP `213.197.11.201`;
  safe `127.0.0.1` default now
- `src/.env` and `src/database/.env.example` now use MagicDNS
  `DB_HOST=infhub-server` (Tailscale-bridged)
- `OLLAMA_HOST` now points at `http://infhub-server:11434`
- `docs/DATABASE_ARCHITECTURE.md` rewritten to reflect the actual
  schema (envy.sql + 8 migrations) and the Tailscale bridge
- `docs/CONFIGURATION.md` bumped to 0.1.6 with a Tailscale Bridge section

### Security
- PostgreSQL reachable only through the private Tailscale network
- No router port-forward for 5432; no `0.0.0.0/0` in `pg_hba.conf`
- Credentials remain in git-ignored `src/.env` only
- Zero Tailscale-specific code in Emerald application logic

---

## [0.1.3] — 2026-07-22

### Added
- Creator Hub dashboard-first UI with connected account cards
- Multi-platform composer with per-platform overrides
- Bluesky image upload support via AT Protocol `com.atproto.repo.uploadBlob`
- Electron dialog-based media selection for reliable file paths
- Comprehensive logging system with subsystem prefixes
- Publishing history tracking
- Log viewer in Creator Hub sidebar

### Changed
- Composer now uses two modes: single-account (from dashboard) and multi-platform (from composer tab)
- Media validation now resolves file size from filesystem when not provided
- Publisher crash fixed: guarded `publishResult.error.match()` for success cases
- Bluesky capabilities updated: `images: true`, `supportsMedia()` returns `true`

### Fixed
- Media path loss between Composer and Publisher (file input `path` was unreliable)
- Bluesky image upload now creates `app.bsky.embed.images` embeds
- Publisher no longer crashes when `publishResult.error` is undefined

---

## [0.1.2] — 2026-07-21

### Added
- X/Twitter OAuth 1.0a support
- Basic Bluesky publishing (text only)
- Creator Hub account management
- Post composer with media selection
- Publishing queue

### Changed
- Migrated from hardcoded config to JSON file storage
- Added encrypted credential storage using Electron safeStorage

---

## [0.1.1] — 2026-07-20

### Added
- Initial Creator Hub structure
- Platform service abstraction
- Basic X/Twitter publishing
- Post model and storage

---

## [0.1.0] — 2026-07-19

### Added
- Initial project structure
- Electron + React + Vite setup
- Basic dashboard UI
- Database connection (PostgreSQL + pgvector)
- AI chat with RAG (Ollama)
