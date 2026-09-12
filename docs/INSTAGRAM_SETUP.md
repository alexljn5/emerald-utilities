# Instagram API — Developer Setup Guide

**Applies to:** Emerald Utilities Creator Hub Instagram adapter  
**Last Updated:** 23 July 2026

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Create a Meta App](#2-create-a-meta-app)
3. [Configure Instagram API](#3-configure-instagram-api)
4. [Permissions Reference](#4-permissions-reference)
5. [OAuth Redirect URIs](#5-oauth-redirect-uris)
6. [Token Exchange Flow](#6-token-exchange-flow)
7. [Environment Configuration](#7-environment-configuration)
8. [Testing & Verification](#8-testing--verification)

---

## 1. Prerequisites

Before starting, you need:

- A **Facebook Developer Account** — [developers.facebook.com](https://developers.facebook.com)
- An **Instagram Professional Account** (Business or Creator) — personal accounts will NOT work
- The Instagram account must be **linked to a Facebook Page** you manage
- For publishing: App must pass **Meta App Review** (or use test users)

---

## 2. Create a Meta App

1. Go to [Meta Developer Portal](https://developers.facebook.com/apps/)
2. Click **Create App**

There are two options:

### Option A: Business App (Recommended)
- Select **Business** as the app type
- This gives access to Instagram Graph API, Instagram Login, and all business endpoints
- Required for publishing content

### Option B: Consumer App
- Select **Consumer** if you only need Instagram Basic Display
- **Limited:** Cannot publish content, read-only

Click **Next**, fill in app name and contact email, then **Create App**.

---

## 3. Configure Instagram API

Once the app is created:

### Add Products

1. In the left sidebar, click **Dashboard**
2. Under **Add a Product**, find **Instagram API with Instagram Login**
3. Click **Set Up**

### Access Token Generation (Quick Test)

Before setting up OAuth, you can generate a test token:

1. In left sidebar, go to **Instagram API with Instagram Login** → **Basic Display**
2. Scroll to **User Token Generator**
3. Click **Generate Token**
4. Log into your Instagram account and authorize
5. Copy the token — this is a **short-lived token** (1 hour)

### App Review (Required for Production)

The permissions `instagram_business_basic` and `instagram_business_content_publish` show in the dashboard as:

| Permission | Status |
|-----------|--------|
| `instagram_business_basic` | Ready for testing |
| `instagram_business_content_publish` | Ready for testing |

**"Ready for testing"** means:
- Works with **test users** and **admins/developers** of the app
- Does NOT work for general users until App Review passes

**To submit for review:**
1. Go to **App Review** → **Permissions and Features**
2. Find `instagram_business_basic` and `instagram_business_content_publish`
3. Click **Submit for Review**
4. Provide:
   - Screen recording showing the feature working
   - Step-by-step instructions for review team
   - Explanation of how users will use the permission
5. Wait for approval (can take 1-14 days)

---

## 4. Permissions Reference

### Required for Emerald Utilities Creator Hub

These **must be enabled** for the Instagram adapter to function:

| Permission | Endpoint | Purpose | Status Required |
|-----------|----------|---------|-----------------|
| `instagram_business_basic` | `GET /{ig-user-id}` | Read profile info, media count | App Review or Test User |
| `instagram_business_content_publish` | `POST /{ig-user-id}/media` | Create and publish feed posts | App Review or Test User |

### Required for OAuth Login

These are used during the Instagram Login flow:

| Permission | Purpose | Auto-Granted |
|-----------|---------|--------------|
| `public_profile` | Read default profile fields | **Yes** — auto-granted |
| `email` | Read primary email | Optional |

### Optional — Feature Expansion

These are **not currently used** but could be added later:

| Permission | Purpose | Notes |
|-----------|---------|-------|
| `instagram_business_manage_comments` | Read/reply to comments | For social engagement features |
| `instagram_business_manage_insights` | Read analytics | For performance tracking |
| `instagram_business_manage_messages` | Read/reply to DMs | For inbox management |
| `instagram_manage_comments` | Create/delete comments | Legacy permission |
| `instagram_manage_contents` | Delete posts | For content management |
| `instagram_manage_engagement` | Like/unlike media | For engagement features |
| `instagram_manage_insights` | Read analytics (legacy) | Older insights API |
| `instagram_manage_messages` | Read/reply to DMs (legacy) | Older messaging API |
| `instagram_manage_upcoming_events` | Create/update events | For event promotion |
| `instagram_shopping_tag_products` | Tag products in posts | For e-commerce |
| `instagram_creator_marketplace_discovery` | Discover creators | For brand partnerships |
| `instagram_branded_content_ads_brand` | Run partnership ads | For sponsored content |
| `instagram_branded_content_brand` | Manage approved creators | For brand safety |
| `instagram_branded_content_creator` | Boost creator content | For content promotion |

### Facebook Page Permissions

Since Instagram Business accounts must be linked to a Facebook Page:

| Permission | Purpose | Notes |
|-----------|---------|-------|
| `pages_show_list` | List Pages user manages | Required to find linked Instagram account |
| `pages_read_engagement` | Read Page content | May be needed for verification |

### Placeholder / Legacy Permissions

These exist in the Meta permissions list but are **not needed** for Emerald Utilities:

| Permission | Reason to Skip |
|-----------|----------------|
| `ads_management` | Not running ads |
| `ads_read` | Not reading ad data |
| `business_management` | Not managing Business Manager |
| `Brazilian partners` | Unless targeting Brazil |
| `Business Asset User Profile Access` | Not reading user assets |
| `Human Agent` | Not using messaging agents |
| `Instagram Public Content Access` | Not doing hashtag search |

---

## 5. OAuth Redirect URIs

### HTTPS Localhost Callback

Emerald Utilities uses an HTTPS localhost callback server for OAuth. Meta requires HTTPS for redirect URIs, so the app uses mkcert to generate a local development certificate for `localhost`.

Add to **Instagram API with Instagram Login** → **Basic Display** → **Valid OAuth Redirect URIs**:

```
https://localhost:3541/instagram-callback
```

### How the Flow Works

```
1. User clicks "Connect Instagram" in Emerald Utilities
2. App generates a random OAuth state value
3. App starts an HTTPS server on https://localhost:3541/instagram-callback
4. Browser opens → https://www.instagram.com/oauth/authorize
   ?client_id={APP_ID}
   &redirect_uri=https://localhost:3541/instagram-callback
   &scope=instagram_business_basic,instagram_business_content_publish
   &response_type=code
5. User logs into Instagram and authorizes
6. Instagram redirects to: https://localhost:3541/instagram-callback?code={AUTH_CODE}&state={STATE}
7. The HTTPS callback server captures the code and state
8. The app validates the state, extracts the code, and exchanges it for:
   - Short-lived access token (1 hour)
9. Short-lived token exchanged for:
   - Long-lived access token (60 days)
10. Token stored encrypted in creator-hub-data/
```

### SSL Certificate Setup

The app requires mkcert certificates for the HTTPS localhost server:

```bash
# Install mkcert (one-time setup)
# macOS: brew install mkcert nss
# Windows: choco install mkcert
# Linux: sudo apt install libnss3-tools

# Generate localhost certificate
mkdir -p src/oauth/certs
cd src/oauth/certs
mkcert localhost 127.0.0.1 ::1
# Rename the generated files to localhost.pem and localhost-key.pem
```

The app will look for certificates at:
- `src/oauth/certs/localhost.pem`
- `src/oauth/certs/localhost-key.pem`

If certificates are missing, the app will print setup instructions and the OAuth flow will fail with a clear error message.

### Token Lifecycle

```
Authorization Code
    ↓ (exchange)
Short-Lived Token (1 hour)
    ↓ (exchange via GET /access_token?grant_type=ig_exchange_token)
Long-Lived Token (60 days)
    ↓ (refresh via GET /refresh_access_token)
Refreshed Long-Lived Token (60 days)
```

**Important:** Long-lived tokens expire after 60 days. They can be refreshed once per token lifetime. After that, the user must re-authorize.

---

## 6. Environment Configuration

Add these to `src/.env`:

```env
# Instagram API with Instagram Login
INSTAGRAM_CLIENT_ID=your_app_id
INSTAGRAM_CLIENT_SECRET=your_app_secret
INSTAGRAM_REDIRECT_URI=https://localhost:3541/instagram-callback
```

- **INSTAGRAM_CLIENT_ID** — App ID from Meta Dashboard
- **INSTAGRAM_CLIENT_SECRET** — App Secret from Meta Dashboard (App Settings → Basic → App Secret)
- **INSTAGRAM_REDIRECT_URI** — Must match exactly what's registered in OAuth settings. Must use `https://` protocol for Meta compliance. The app will start an HTTPS callback server on this address.

### Where to Find Credentials

1. Meta Developer Portal → Apps → Select your app
2. **Dashboard** → Top of page shows **App ID** and **App Secret**
3. Click **Show** to reveal App Secret

---

## 7. Testing & Verification

### Test Users

Before App Review, you can test with:

1. Go to **App Review** → **Roles** → **Test Users**
2. Click **Add** → create a test Instagram user
3. The test user must have a **Business/Creator Instagram account** linked to a Facebook Page
4. Use this account to test OAuth flow and publishing

### Verify Token

```bash
# Check token validity
curl -X GET \
  "https://graph.facebook.com/v21.0/me?fields=id,username&access_token={ACCESS_TOKEN}"

# Check Instagram Business account
curl -X GET \
  "https://graph.facebook.com/v21.0/{IG_USER_ID}?fields=username,account_type,media_count&access_token={ACCESS_TOKEN}"
```

### Verify Publishing

```bash
# Step 1: Create media container
curl -X POST \
  "https://graph.facebook.com/v21.0/{IG_USER_ID}/media?access_token={ACCESS_TOKEN}" \
  -H "Content-Type: multipart/form-data" \
  -F "media_type=IMAGE" \
  -F "file=@/path/to/test-image.jpg"

# Returns: { "id": "12345678901234567" }

# Step 2: Check container status
curl -X GET \
  "https://graph.facebook.com/v21.0/{CONTAINER_ID}?fields=status_code&access_token={ACCESS_TOKEN}"

# Returns: { "status_code": "FINISHED" }

# Step 3: Publish container
curl -X POST \
  "https://graph.facebook.com/v21.0/{IG_USER_ID}/media_publish" \
  -H "Content-Type: application/json" \
  -d '{
    "access_token": "{ACCESS_TOKEN}",
    "creation_id": "{CONTAINER_ID}"
  }'

# Returns: { "id": "12345678901234567" }
```

---

## 8. Common Issues

### "Missing Credentials" Error

```
[INSTAGRAM] publish failed: Missing credentials
```

**Fix:** Ensure Instagram account has `accessToken`, `instagramAccountId` stored. Re-authenticate.

### "Instagram requires at least one media item"

```
[INSTAGRAM] Instagram requires at least one media item
```

**Fix:** Instagram does not support text-only posts. Attach at least one image or video.

### "HTTP 400: (#100) ..."

```
[MEDIA] Container creation failed: HTTP 400: ...
```

**Possible causes:**
- File format not supported (use JPEG, PNG, GIF, MP4)
- File exceeds size limit (max 8MB for images, 100MB for videos)
- Invalid file path
- Token does not have `instagram_business_content_publish`

### Token Expired

```
[INSTAGRAM] publish failed: HTTP 401: ...
```

**Fix:** Re-authenticate. Long-lived tokens last 60 days but cannot be refreshed indefinitely.

### "No Facebook Page linked"

```
Error: Instagram account must be linked to a Facebook Page
```

**Fix:** Go to Instagram → Settings → Account → Linked Accounts → Facebook. Ensure your Business/Creator account is linked to a Facebook Page you manage.

---

## 9. Dashboard Reference

When viewing your Meta App Dashboard, the Instagram API section should look like:

```
Instagram API with Instagram Login
├── Permissions
│   ├── instagram_business_basic ......... [Ready for testing]
│   └── instagram_business_content_publish [Ready for testing]
├── Settings
│   ├── Valid OAuth Redirect URIs
│   │   └── https://localhost:3541/instagram-callback
│   ├── Deauthorize Callback URL
│   │   └── (optional)
│   └── Data Deletion Request URL
│       └── (optional)
└── Tools
    └── Graph API Explorer
```

### Permission Status Meanings

| Status | Meaning |
|--------|---------|
| **Ready for testing** | Works for app admins, developers, and test users |
| **In Review** | Submitted for App Review, waiting for Meta |
| **Approved** | Works for all users after App Review passes |
| **Not submitted** | Not yet sent for App Review |
| **Empty** | Not requested / not configured |

---

## 10. Quick Start Checklist

- [ ] Meta Developer Account created
- [ ] App created (Business type)
- [ ] Instagram API with Instagram Login product added
- [ ] `instagram_business_basic` permission requested and in "Ready for testing"
- [ ] `instagram_business_content_publish` permission requested and in "Ready for testing"
- [ ] OAuth Redirect URIs configured (`https://localhost:3541/instagram-callback`)
- [ ] `INSTAGRAM_CLIENT_ID` in `src/.env`
- [ ] `INSTAGRAM_CLIENT_SECRET` in `src/.env`
- [ ] `INSTAGRAM_REDIRECT_URI` in `src/.env`
- [ ] Instagram account is Business/Creator type
- [ ] Instagram account linked to a Facebook Page
- [ ] Test token generated via Graph API Explorer
- [ ] Media upload test passes
- [ ] Publish test passes

---

## API Reference

All endpoints use **Graph API v21.0**:

```
Base URL: https://graph.facebook.com/v21.0
API:      Instagram Graph API
Auth:     Instagram Login (OAuth 2.0)
```

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/oauth/authorize` | GET | Start OAuth flow (browser) |
| `/oauth/access_token` | POST | Exchange code for short-lived token |
| `/access_token` | GET | Exchange short-lived for long-lived token |
| `/refresh_access_token` | GET | Refresh long-lived token |
| `/{ig-user-id}` | GET | Get profile info |
| `/{ig-user-id}/media` | POST | Create media container |
| `/{container-id}` | GET | Check container status |
| `/{ig-user-id}/media_publish` | POST | Publish container |
| `/me/permissions` | DELETE | Revoke token |
