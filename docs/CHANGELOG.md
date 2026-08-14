# Emerald Utilities — Changelog

**Version:** 0.1.5
**Status:** Active  
**Last Updated:** 22 July 2026

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
