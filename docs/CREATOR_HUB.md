# Emerald Utilities — Creator Hub

**Version:** 0.1.7
**Status:** Active  
**Last Updated:** 12 September 2026

---

## Overview

Creator Hub is the social media publishing module of Emerald Utilities. It provides a unified interface for composing and publishing content to multiple platforms.

---

## Supported Platforms

| Platform | Status | Text | Images | Video | Notes |
|----------|--------|------|--------|-------|-------|
| X (Twitter) | Stable | Yes | Yes | Yes | OAuth 2.0 / 1.0a |
| Bluesky | Stable | Yes | Yes | No | AT Protocol |
| Instagram | Stable | No | Yes | Yes | Instagram API with Instagram Login |
| Threads | Implemented | Yes | Yes | Yes | Meta Graph API |
| TikTok | Implemented | Yes | No | Yes | TikTok Content Posting API |
| YouTube | Implemented | Yes | No | Yes | YouTube Data API v3 |
| Facebook | Stub | No | No | No | Placeholder only |
| itch.io | Stub | No | No | No | Placeholder only |

---

## Architecture

```
Creator Hub
├── models.js          # Post, PlatformAccount, PublishSummary
├── storage.js         # JSON file persistence
├── publisher.js       # Publish orchestrator
├── ipc.js             # IPC handlers
├── services/
│   ├── platforms.js   # Platform registry
│   ├── base.js        # Base service class
│   ├── twitter.js     # X/Twitter adapter
│   ├── bluesky.js     # Bluesky adapter
│   ├── instagram.js   # Instagram adapter
│   ├── threads.js     # Threads stub
│   ├── facebook.js    # Facebook stub
│   ├── tiktok.js      # TikTok stub
│   ├── youtube.js     # YouTube stub
│   ├── itch.js        # itch.io stub
│   ├── oauth1.js      # OAuth 1.0a helper
│   └── errorTranslator.js
├── ui/
│   ├── CreatorHubPage.jsx  # Main container
│   ├── Sidebar.jsx         # Navigation
│   ├── Accounts.jsx        # Account management
│   ├── Composer.jsx        # Post composer
│   ├── History.jsx         # Publishing history
│   ├── LogViewer.jsx       # Log viewer
│   ├── PublishProgress.jsx # Progress display
│   └── Queue.jsx           # Publish queue
└── utils/
    ├── mediaHandler.js     # Media validation & upload
    └── creatorHubLogger.js # Logging
```

---

## Data Models

### Post

```javascript
{
    id: string,           // Unique post ID
    message: string,      // Post text content
    media: Media[],       // Attached media files
    tags: string[],       // Hashtags
    targets: Target[],    // Publish targets
    overrides: Override,  // Per-platform overrides
    createdAt: string     // ISO timestamp
}
```

### Media

```javascript
{
    path: string,         // Absolute filesystem path
    name: string,         // Filename
    type: string,         // MIME type
    size: number          // File size in bytes (0 if unknown)
}
```

### Target

```javascript
{
    accountId: string,    // Account ID
    platform: string,     // Platform ID (e.g., 'x', 'bluesky')
    enabled: boolean,     // Whether to publish to this target
    override: Override    // Per-platform overrides
}
```

### Override

```javascript
{
    message: string,      // Override post text
    media: string[],      // Override media paths
    tags: string[]        // Override tags
}
```

---

## Publishing Flow

1. User creates post in Composer
2. Post is saved to storage via `creator-hub:create-post` IPC
3. User triggers publish via `creator-hub:publish` IPC
4. Publisher loads post from storage
5. For each enabled target:
   - Validate account status
   - Test connection
   - Upload media (if supported)
   - Publish post via platform service
   - Record result in publish history
6. Return summary to UI

---

## Media Pipeline

```
Composer (file selection)
    │
    ▼
IPC (creator-hub:create-post)
    │
    ▼
Storage (JSON persistence)
    │
    ▼
Publisher (publishPost)
    │
    ▼
mediaHandler.processMediaBatch()
    │
    ├── validateMedia() → checks path, type, size
    ├── compressImageIfNeeded() → resize if needed
    └── uploadMedia() → platform-specific upload
    │
    ▼
Platform service.publish()
```

**Media path handling:**
- Composer uses Electron `dialog.showOpenDialog` to get absolute paths
- Paths are stored in post media objects
- `validateMedia` resolves actual file size from filesystem if not provided
- Platform services receive file paths for upload

---

## Account Management

Accounts are stored in JSON files with encrypted credentials.

- Credentials are encrypted using Electron's `safeStorage` API
- Decryption happens only in the main process
- Renderer process never sees raw credentials

---

## Logging

Creator Hub uses a structured logging system:

- `[BLUESKY]` — Bluesky service operations
- `[INSTAGRAM]` — Instagram service operations
- `[X]` — X/Twitter service operations
- `[PUBLISHER]` — Publishing orchestrator
- `[MEDIA]` — Media handling
- `[IPC]` — IPC handler operations
- `[STORAGE]` — Storage operations

**Rules:**
- Never log raw credentials
- Never log full media paths in production (use relative or hash)
- User-facing logs are translated; developer logs are raw

---

## Implemented Platforms

### Threads

- Authentication: Meta OAuth (reuses Instagram/Facebook Meta app)
- Scopes: `threads_basic`, `threads_content_publish`
- Publishing: Meta Graph API `/threads/media` → `/threads/media_publish`
- Media: Images and video via public URL (Cloudflare tunnel)
- Text-only posts supported

### TikTok

- Authentication: OAuth 2.0 PKCE
- Scopes: `video.publish`, `video.upload`
- Publishing: TikTok Content Posting API `/post/publish/video/init/`
- Media: Video upload via direct upload to TikTok CDN
- Status polling until `PUBLISH_COMPLETE`
- Text-only posts not supported (video required)

### YouTube

- Authentication: Google OAuth 2.0
- Scopes: `https://www.googleapis.com/auth/youtube.upload`
- Publishing: YouTube Data API v3 resumable upload
- Media: Video upload in 256KB chunks
- Supports title, description, tags, privacy status
- Thumbnail upload from first image in media batch
- Default privacy: private (user can change in YouTube Studio)

---

## Platform Capability Standardisation

Every platform must expose:

```javascript
{
    id: string,
    name: string,
    capabilities: {
        text: boolean,
        images: boolean,
        video: boolean,
        threads: boolean
    },
    limits: {
        characters: number,
        imageCount: number,
        maxFileSize: number
    },
    requirements: {
        authentication: string,
        billing: boolean
    }
}
```

Examples:

**X:**
```javascript
{ text: true, images: true, video: true, billing: true }
```

**Bluesky:**
```javascript
{ text: true, images: true, video: false, billing: false }
```

**Instagram:**
```javascript
{ text: false, images: true, video: true }
```

**Threads:**
```javascript
{ text: true, images: true, video: true }
```

---

## UI Flow

### Dashboard First

1. User opens Creator Hub
2. Dashboard shows connected account cards
3. Click account card → opens Composer with that account selected
4. Composer shows platform-specific fields only
5. No legacy generic fields (title, project, category)

### Composer Modes

**Single-account mode:**
- Opened from dashboard card click
- One known account, no overrides
- Platform-specific fields only

**Multi-platform mode:**
- Opened from Composer tab
- User selects multiple targets
- Optional per-platform overrides

---

## Publishing History

Every publish attempt records:

```javascript
{
    platform: string,
    account: string,
    text: string,
    media: Media[],
    timestamp: string,
    status: 'success' | 'failed' | 'skipped',
    error: string | null,
    url: string | null
}
```

---

## Known Issues

1. **Media path handling** — Fixed: Composer now uses Electron dialog for reliable paths
2. **Image upload to Bluesky** — Fixed: `uploadBlob()` implemented using AT Protocol
3. **Publisher crash on success** — Fixed: Guarded `publishResult.error.match()`
4. **Retry variable shadowing** — Fixed: Renamed shadowed `entry` variable in `retryPublish`
5. **TikTok video requirements** — TikTok requires video files; image posts not yet supported via Content Posting API
6. **YouTube privacy** — Defaults to private; user must change to public in YouTube Studio if desired
