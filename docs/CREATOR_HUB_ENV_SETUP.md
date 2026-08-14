# Creator Hub — Environment Variable Setup Guide

This document explains every environment variable required by the Creator Hub publishing system, with step-by-step setup instructions for each platform.

---

## Quick Reference

| Variable | Platform | Required | Where to get it |
|----------|----------|----------|-----------------|
| `INSTAGRAM_APP_ID` | Instagram | Yes | Meta Developer Portal |
| `INSTAGRAM_APP_SECRET` | Instagram | Yes | Meta Developer Portal |
| `INSTAGRAM_REDIRECT_URI` | Instagram | Yes | Your app settings |
| `INSTAGRAM_MEDIA_BASE_URL` | Instagram | No | Your public URL |
| `CLOUDFLARE_TUNNEL_ENABLED` | Instagram | No | Set to `true` |
| `CLOUDFLARE_BINARY` | Instagram | No | Path to cloudflared |
| `THREADS_APP_ID` | Threads | Yes | Meta Developer Portal |
| `THREADS_APP_SECRET` | Threads | Yes | Meta Developer Portal |
| `THREADS_REDIRECT_URI` | Threads | Yes | Your app settings (must be HTTPS or emerald://) |
| `BLUESKY_USERNAME` | Bluesky | No | Your Bluesky handle |
| `BLUESKY_APP_PASSWORD` | Bluesky | No | Bluesky settings |
| `X_API_KEY` | X/Twitter | No | X Developer Portal |
| `X_API_SECRET` | X/Twitter | No | X Developer Portal |
| `X_ACCESS_TOKEN` | X/Twitter | No | X Developer Portal |
| `X_ACCESS_TOKEN_SECRET` | X/Twitter | No | X Developer Portal |
| `TIKTOK_CLIENT_KEY` | TikTok | Yes | TikTok Developer Portal |
| `TIKTOK_CLIENT_SECRET` | TikTok | Yes | TikTok Developer Portal |
| `TIKTOK_REDIRECT_URI` | TikTok | Yes | Your app settings |
| `YOUTUBE_CLIENT_ID` | YouTube | Yes | Google Cloud Console |
| `YOUTUBE_CLIENT_SECRET` | YouTube | Yes | Google Cloud Console |
| `YOUTUBE_REDIRECT_URI` | YouTube | Yes | Your app settings |

---

## File Location

Create or edit `src/.env` in your project root:

```
emerald-utilities/
├── src/
│   ├── .env          ← Put your variables here
│   └── creator-hub/
│       └── ...
```

The file should **not** be committed to git (it is in `.gitignore`).

---

## Platform Setup Instructions

### Instagram

**Developer Portal:** https://developers.facebook.com/

**Steps:**
1. Go to [Meta Developer Portal](https://developers.facebook.com/)
2. Create a new app → Select **"Business"** as app type
3. Add **Instagram** product to your app
4. Under **Instagram > Settings**, configure:
   - **Valid OAuth Redirect URIs**: `http://localhost:3541/instagram/callback`
   - **Deauthorize Callback URL**: (optional)
   - **Privacy Policy URL**: (required for production)
5. Under **App Review**, request the following permissions:
   - `instagram_business_basic`
   - `instagram_business_content_publish`
   - `instagram_business_manage_comments`
6. Copy your **App ID** and **App Secret**

**Environment Variables:**

```env
# Instagram API with Instagram Login
INSTAGRAM_APP_ID=your_app_id_here
INSTAGRAM_APP_SECRET=your_app_secret_here
INSTAGRAM_REDIRECT_URI=http://localhost:3541/instagram/callback

# Instagram Publishing Media Tunnel
# Instagram Graph API cannot fetch media from localhost.
# Leave empty to auto-start a Cloudflare tunnel.
INSTAGRAM_MEDIA_BASE_URL=
CLOUDFLARE_TUNNEL_ENABLED=true
CLOUDFLARE_BINARY=cloudflared
```

**Notes:**
- Your Instagram account must be a **Creator or Business** account (not personal)
- The `INSTAGRAM_MEDIA_BASE_URL` is only needed if you have your own public URL
- `cloudflared` must be installed and in your PATH if using auto-tunnel

---

### Threads

**Developer Portal:** https://developers.facebook.com/

**IMPORTANT:** Meta requires **HTTPS** for OAuth redirect URIs. You have two options:

**Option A: `emerald://` deep-link protocol (recommended)**
- No HTTPS certificates needed
- Meta never sees the redirect URI
- Set `THREADS_REDIRECT_URI=emerald://threads-callback`

**Option B: HTTPS localhost**
- Requires mkcert development certificates
- Generate certs: `mkdir -p src/oauth/certs && cd src/oauth/certs && mkcert localhost 127.0.0.1 ::1`
- Set `THREADS_REDIRECT_URI=https://localhost:3541/threads/callback`

**Steps:**
1. Use the **same Meta app** as Instagram (recommended) or create a new one
2. Add **Threads** product to your app
3. Under **Threads > Settings**, configure:
   - **Valid OAuth Redirect URIs**: `emerald://threads-callback` (Option A) or `https://localhost:3541/threads/callback` (Option B)
4. Request the following permissions:
   - `threads_basic`
   - `threads_content_publish`
5. Copy your **App ID** and **App Secret**

**Environment Variables:**

```env
# Threads API
# Can reuse INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET if using the same Meta app
THREADS_APP_ID=your_app_id_here
THREADS_APP_SECRET=your_app_secret_here
THREADS_REDIRECT_URI=emerald://threads-callback
```

**Notes:**
- Threads uses the same Meta OAuth infrastructure as Instagram
- If using the same Meta app, you can omit these and the app will fall back to Instagram credentials
- Media serving uses the same Cloudflare tunnel as Instagram
- **Do NOT use `http://localhost`** — Meta blocks insecure redirect URIs with error `1349187`

---

### Bluesky

**Developer Portal:** https://bsky.app/settings/app-passwords

**Steps:**
1. Go to Bluesky → Settings → Privacy & Security
2. Scroll to **App Passwords**
3. Create a new app password (give it a name like "Emerald Utilities")
4. Copy the generated password

**Environment Variables:**

```env
# Bluesky (AT Protocol)
BLUESKY_USERNAME=your-handle.bsky.social
BLUESKY_APP_PASSWORD=your-app-password-here
```

**Notes:**
- Use your full handle (e.g., `alexl.bsky.social`)
- The app password is different from your main password
- These are optional — you can also enter them manually in the Accounts page

---

### X / Twitter

**Developer Portal:** https://developer.twitter.com/

**Steps:**
1. Go to [X Developer Portal](https://developer.twitter.com/)
2. Create a new project and app
3. Under **App Settings > Authentication**, enable **OAuth 1.0a**
4. Generate the following credentials:
   - **API Key** (Consumer Key)
   - **API Secret** (Consumer Secret)
   - **Access Token**
   - **Access Token Secret**
5. Ensure your app has **Read and Write** permissions

**Environment Variables:**

```env
# X / Twitter API
X_API_KEY=your_api_key_here
X_API_SECRET=your_api_secret_here
X_ACCESS_TOKEN=your_access_token_here
X_ACCESS_TOKEN_SECRET=your_access_token_secret_here
```

**Notes:**
- These are optional — you can also enter them manually in the Accounts page
- The app must have Read and Write permissions for posting

---

### TikTok

**Developer Portal:** https://developers.tiktok.com/

**Steps:**
1. Go to [TikTok Developer Portal](https://developers.tiktok.com/)
2. Create a new app → Select **"Content Posting"** as the product
3. Under **App Settings > Redirect URLs**, add:
   - `http://localhost:3541/tiktok/callback`
4. Under **Permissions**, request:
   - `video.publish`
   - `video.upload`
5. Submit for review (required for production use)
6. Copy your **Client Key** and **Client Secret**

**Environment Variables:**

```env
# TikTok Content Posting API
TIKTOK_CLIENT_KEY=your_client_key_here
TIKTOK_CLIENT_SECRET=your_client_secret_here
TIKTOK_REDIRECT_URI=http://localhost:3541/tiktok/callback
```

**Notes:**
- TikTok requires a **video file** for every post (no text-only or image-only posts)
- Maximum video size: 100MB
- Supported formats: MP4, MOV, WebM
- The Content Posting API is in limited availability — you may need to request access

---

### YouTube

**Developer Portal:** https://console.cloud.google.com/

**Steps:**
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select existing)
3. Enable the **YouTube Data API v3**:
   - APIs & Services → Library → Search "YouTube Data API v3" → Enable
4. Go to **APIs & Services > Credentials**
5. Create **OAuth 2.0 Client ID**:
   - Application type: **Desktop app**
   - Add redirect URI: `http://localhost:3541/youtube/callback`
6. Copy your **Client ID** and **Client Secret**

**Environment Variables:**

```env
# YouTube Data API
YOUTUBE_CLIENT_ID=your_client_id_here
YOUTUBE_CLIENT_SECRET=your_client_secret_here
YOUTUBE_REDIRECT_URI=http://localhost:3541/youtube/callback
```

**Notes:**
- Videos default to **private** for safety — change to public in YouTube Studio after upload
- Maximum video size: 256MB (API limit)
- Supported formats: MP4, MOV, WebM
- The first image in your media batch is automatically uploaded as the video thumbnail

---

## Complete Example `src/.env`

```env
# ── Instagram ──────────────────────────────────────
INSTAGRAM_APP_ID=123456789012345
INSTAGRAM_APP_SECRET=abc123def456ghi789jkl012mno345pqr678stu901
INSTAGRAM_REDIRECT_URI=http://localhost:3541/instagram/callback
INSTAGRAM_MEDIA_BASE_URL=
CLOUDFLARE_TUNNEL_ENABLED=true
CLOUDFLARE_BINARY=cloudflared

# ── Threads ────────────────────────────────────────
THREADS_APP_ID=123456789012345
THREADS_APP_SECRET=abc123def456ghi789jkl012mno345pqr678stu901
THREADS_REDIRECT_URI=http://localhost:3541/threads/callback

# ── Bluesky ────────────────────────────────────────
BLUESKY_USERNAME=your-handle.bsky.social
BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx

# ── X / Twitter ────────────────────────────────────
X_API_KEY=abc123XYZ789
X_API_SECRET=def456UVW012
X_ACCESS_TOKEN=ghi789JKL345
X_ACCESS_TOKEN_SECRET=jkl012MNO678

# ── TikTok ─────────────────────────────────────────
TIKTOK_CLIENT_KEY=your_tiktok_client_key
TIKTOK_CLIENT_SECRET=your_tiktok_client_secret
TIKTOK_REDIRECT_URI=http://localhost:3541/tiktok/callback

# ── YouTube ────────────────────────────────────────
YOUTUBE_CLIENT_ID=123456789012-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com
YOUTUBE_CLIENT_SECRET=GOCSPX-abcdefghijklmnopqrstuvwxyz
YOUTUBE_REDIRECT_URI=http://localhost:3541/youtube/callback
```

---

## Security Notes

1. **Never commit `src/.env` to version control** — it contains secrets
2. **Never expose secrets in frontend code** — all API calls happen in the main process
3. **Credentials are encrypted** using Electron's `safeStorage` API before being saved to disk
4. **OAuth tokens are stored server-side** — the renderer process never sees raw credentials
5. **Use app passwords** where available (Bluesky, Google) instead of main passwords

---

## Troubleshooting

### "Missing INSTAGRAM_APP_ID or INSTAGRAM_APP_SECRET"
- Check that `src/.env` exists and contains the variables
- Restart the app after changing `.env` (variables are loaded at startup)

### "OAuth flow timed out"
- Ensure the redirect URI in your developer portal matches exactly
- Check that no firewall is blocking localhost ports

### "Cloudflare tunnel failed"
- Install `cloudflared`: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/
- Or set `INSTAGRAM_MEDIA_BASE_URL` to a public URL you control

### "TikTok API not available"
- The Content Posting API is in limited availability
- Request access at https://developers.tiktok.com/

### "YouTube quota exceeded"
- YouTube Data API has daily quotas
- Default quota: 10,000 units/day
- Each video upload costs ~1600 units
