# Emerald Utilities — API Reference

**Version:** 0.1.5
**Status:** Active  
**Last Updated:** 22 July 2026

---

## IPC Channels

All IPC communication between renderer and main process uses the `invoke()` pattern via the preload bridge.

### Creator Hub IPC

#### `creator-hub:list-accounts`

Lists all connected accounts (without credentials).

**Returns:**
```javascript
{ ok: true, accounts: PlatformAccount[] }
```

---

#### `creator-hub:get-account`

Gets a single account by ID.

**Parameters:** `{ accountId: string }`

**Returns:**
```javascript
{ ok: true, account: PlatformAccount }
```

---

#### `creator-hub:add-account`

Adds a new platform account.

**Parameters:** `{ platform: string, username: string, credentials: object }`

**Returns:**
```javascript
{ ok: true, account: PlatformAccount }
```

---

#### `creator-hub:delete-account`

Deletes an account by ID.

**Parameters:** `{ accountId: string }`

**Returns:**
```javascript
{ ok: true }
```

---

#### `creator-hub:create-post`

Creates a new post.

**Parameters:**
```javascript
{
    id: string,
    message: string,
    media: Media[],
    tags: string[],
    targets: Target[],
    overrides: Override,
    createdAt: string
}
```

**Returns:**
```javascript
{ ok: true, post: Post }
```

---

#### `creator-hub:update-post`

Updates an existing post.

**Parameters:** `{ postId: string, changes: Partial<Post> }`

**Returns:**
```javascript
{ ok: true, post: Post }
```

---

#### `creator-hub:delete-post`

Deletes a post by ID.

**Parameters:** `{ postId: string }`

**Returns:**
```javascript
{ ok: true }
```

---

#### `creator-hub:get-post`

Gets a single post by ID.

**Parameters:** `{ postId: string }`

**Returns:**
```javascript
{ ok: true, post: Post }
```

---

#### `creator-hub:list-posts`

Lists all posts.

**Returns:**
```javascript
{ ok: true, posts: Post[] }
```

---

#### `creator-hub:publish`

Publishes a post to all enabled targets.

**Parameters:** `{ postId: string }`

**Returns:**
```javascript
{ ok: true, summary: PublishSummary }
```

---

#### `creator-hub:retry-publish`

Retries a failed publish.

**Parameters:** `{ publishId: string }`

**Returns:**
```javascript
{ ok: true, summary: PublishSummary }
```

---

#### `creator-hub:get-publish-history`

Gets publish history for a post.

**Parameters:** `{ postId: string }`

**Returns:**
```javascript
{ ok: true, history: PublishHistoryEntry[] }
```

---

#### `creator-hub:open-file-dialog`

Opens a native file dialog for media selection.

**Parameters:** None

**Returns:**
```javascript
{ ok: true, files: string[] }  // Array of absolute file paths
```

---

#### `creator-hub:read-file`

Reads a file from the main process (bypasses renderer fs restrictions).

**Parameters:** `{ filePath: string }`

**Returns:**
```javascript
{ ok: true, data: string }  // Base64 encoded file content
```

---

#### `creator-hub:get-logs`

Gets Creator Hub log history.

**Parameters:** None

**Returns:**
```javascript
{ ok: true, logs: LogEntry[] }
```

---

#### `creator-hub:clear-logs`

Clears Creator Hub log history.

**Parameters:** None

**Returns:**
```javascript
{ ok: true }
```

---

### General IPC

#### `list-scripts`

Lists all saved scripts.

**Returns:**
```javascript
{ ok: true, scripts: Script[] }
```

---

#### `run-script`

Executes a script.

**Parameters:** `{ scriptId: string }`

**Returns:**
```javascript
{ ok: true, output: string }
```

---

#### `get-network-status`

Gets current network monitoring status.

**Returns:**
```javascript
{ ok: true, status: NetworkStatus }
```

---

## Data Models

### PlatformAccount

```typescript
interface PlatformAccount {
    id: string;
    platform: string;
    username: string;
    displayName?: string;
    status: 'connected' | 'disconnected' | 'error';
    capabilities: {
        text: boolean;
        images: boolean;
        video: boolean;
        maxChars: number;
    };
    encryptedCredentials: string;
    createdAt: string;
    updatedAt: string;
}
```

### Post

```typescript
interface Post {
    id: string;
    message: string;
    media: Media[];
    tags: string[];
    targets: Target[];
    overrides: Override;
    createdAt: string;
}

interface Media {
    path: string;
    name: string;
    type: string;
    size: number;
}

interface Target {
    accountId: string;
    platform: string;
    enabled: boolean;
    override: Override;
}

interface Override {
    message?: string;
    media?: string[];
    tags?: string[];
}
```

### PublishSummary

```typescript
interface PublishSummary {
    postId: string;
    results: PublishResult[];
    startedAt: string;
    finishedAt: string;
}

interface PublishResult {
    platform: string;
    accountId: string;
    success: boolean;
    postId?: string;
    error?: string;
}
```

---

## Platform Service Interface

All platform services must implement:

```typescript
interface PlatformService {
    // Connection
    testConnection(account: PlatformAccount): Promise<ConnectionResult>;
    disconnect(account: PlatformAccount): Promise<DisconnectResult>;

    // Publishing
    publish(
        account: PlatformAccount,
        post: Post,
        text: string,
        mediaPaths: string[]
    ): Promise<PublishResult>;

    // Media (optional)
    uploadMedia?(account: PlatformAccount, mediaPath: string): Promise<UploadResult>;
    supportsMedia(): boolean;
    getCapabilities(): Capabilities;
}
```

---

## Error Codes

| Code | Meaning |
|------|---------|
| `HTTP 401` | Authentication failed |
| `HTTP 403` | Permission denied |
| `HTTP 429` | Rate limited |
| `HTTP 500` | Server error |
| `NETWORK_ERROR` | Connection failed |
| `INVALID_CREDENTIALS` | Bad credentials |
| `MEDIA_PATH_MISSING` | Media file path not provided |
| `MEDIA_TYPE_UNSUPPORTED` | File type not allowed |
| `MEDIA_SIZE_EXCEEDED` | File too large |
