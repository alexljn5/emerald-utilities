# Social Media API Setup Guide

This document explains how to configure API credentials for each social media platform supported by Emerald Utilities Creator Hub.

---

## Table of Contents

- [Bluesky](#bluesky)
- [Instagram](#instagram)
- [X (Twitter)](#x-twitter)
- [Facebook](#facebook)
- [Threads](#threads)
- [YouTube](#youtube)
- [TikTok](#tiktok)
- [itch.io](#itchio)
- [Mastodon](#mastodon)

---

## Environment Configuration

All API credentials are managed through the **Environment Configuration** section in **Settings > Developer Configuration**.

### Methods

1. **Development mode**: Create a `src/.env` file in the project root with your credentials.
2. **Production mode**: Use the **Import .env** button in Settings to import a `.env` file after building the app.
3. **System environment variables**: Set variables in your OS environment.

### Priority

The system loads credentials in this order (highest priority first):

1. **Imported .env** — User-imported file stored in app data directory
2. **Development .env** — `src/.env` in the project directory
3. **System environment variables** — OS-level environment variables

### Required Variables

Each platform requires specific environment variables. See the platform sections below for details.

---

## Bluesky

Bluesky uses the AT Protocol with app passwords for authentication.

### Prerequisites

1. A Bluesky account
2. An app password (not your main password)

### Creating an App Password

1. Go to [bsky.app/settings](https://bsky.app/settings)
2. Scroll to **App Passwords**
3. Click **Add App Password**
4. Name it (e.g., "Emerald Utilities")
5. Copy the generated password

### Environment Variables

```env
BLUESKY_IDENTIFIER=your-handle.bsky.social
BLUESKY_APP_PASSWORD=your-app-password
```

### Connecting in Creator Hub

1. Go to **Creator Hub > Accounts**
2. Click **Add Bluesky**
3. Enter your handle (e.g., `your-handle.bsky.social`)
4. Enter your app password
5. Click **Add Account**

### Capabilities

- Text posts (300 character limit)
- Image attachments (up to 4 images)
- Supported formats: PNG, JPEG, WebP

---

## Instagram

Instagram uses the Instagram Content Publishing API with OAuth 2.0 authentication.

### Prerequisites

1. A **Meta for Developers** account
2. A **Facebook Page** connected to your Instagram account
3. Your Instagram account must be a **Business** or **Creator** account
4. A Meta App with Instagram Basic Display and Instagram Content Publishing products

### Step 1: Create a Meta App

1. Go to [developers.facebook.com](https://developers.facebook.com)
2. Click **My Apps** > **Create App**
3. Choose **Business** as the app type
4. Add the **Instagram Basic Display** product
5. Add the **Instagram Content Publishing** product

### Step 2: Configure OAuth

1. In your Meta App dashboard, go to **Instagram Basic Display** > **Basic Display**
2. Add the OAuth redirect URI: `https://localhost:3541/instagram-callback`
3. Note your **App ID** and **App Secret**

### Step 3: Required OAuth Scopes

The following scopes are required:

- `instagram_business_basic` — Read basic profile info
- `instagram_business_content_publish` — Publish content
- `instagram_business_manage_comments` — Manage comments
- `instagram_business_manage_messages` — Manage messages

### Step 4: Convert to Business/Creator Account

1. Open Instagram
2. Go to **Settings** > **Account** > **Switch to Professional Account**
3. Choose **Business** or **Creator**
4. Connect to a Facebook Page (required for API access)

### Step 5: Environment Variables

```env
INSTAGRAM_APP_ID=your-meta-app-id
INSTAGRAM_APP_SECRET=your-meta-app-secret
INSTAGRAM_REDIRECT_URI=https://localhost:3541/instagram-callback
```

### Connecting in Creator Hub

1. Go to **Settings > Developer Configuration**
2. Import a `.env` file with `INSTAGRAM_APP_ID` and `INSTAGRAM_APP_SECRET`
3. Go to **Creator Hub > Accounts**
4. Click **Add Instagram**
5. Click **Connect Instagram** to start the OAuth flow
6. Authorize the app in your browser
7. The account will be added automatically

### Capabilities

- Image posts (at least 1 image required)
- Video posts
- Caption up to 2,200 characters
- Supported formats: PNG, JPEG, WebP, MP4

### Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| "Missing credentials" | INSTAGRAM_APP_ID or INSTAGRAM_APP_SECRET not set | Import .env file in Settings |
| "No Instagram Business Account found" | Account not connected to Facebook Page | Connect Instagram to a Facebook Page |
| "Account type is PERSONAL" | Account not set to Business/Creator | Switch to Business or Creator account |
| "Token exchange failed" | Invalid app ID or secret | Verify credentials in Meta Developer Console |
| "Media container creation failed" | Invalid image URL or format | Ensure image is PNG, JPEG, or WebP |

---

## X (Twitter)

X uses OAuth 1.0a with API keys and access tokens.

### Prerequisites

1. A **X Developer** account
2. A **Project** with read and write permissions

### Creating API Credentials

1. Go to [developer.twitter.com](https://developer.twitter.com)
2. Create a Project and an App
3. Generate **API Key** and **API Secret**
4. Generate **Access Token** and **Access Token Secret**

### Environment Variables

```env
X_API_KEY=your-api-key
X_API_SECRET=your-api-secret
X_ACCESS_TOKEN=your-access-token
X_ACCESS_TOKEN_SECRET=your-access-token-secret
X_USERNAME=your-twitter-username
```

### Connecting in Creator Hub

1. Go to **Creator Hub > Accounts**
2. Click **Add X**
3. Fill in all four credential fields
4. Click **Add Account**

### Capabilities

- Text posts (280 character limit)
- Image attachments (up to 4)
- Video attachments
- Supported formats: PNG, JPEG, GIF, WebP, MP4

---

## Facebook

Facebook uses the Graph API with a long-lived page access token.

### Prerequisites

1. A **Meta for Developers** account
2. A **Facebook Page**
3. A Meta App with the **Pages API** product

### Getting a Page Access Token

1. Go to [developers.facebook.com/tools/explorer](https://developers.facebook.com/tools/explorer)
2. Select your app and the **Pages API** scope
3. Get a short-lived user token
4. Exchange it for a long-lived page token

### Environment Variables

```env
FACEBOOK_PAGE_ID=your-facebook-page-id
FACEBOOK_ACCESS_TOKEN=your-page-access-token
```

### Connecting in Creator Hub

1. Go to **Creator Hub > Accounts**
2. Click **Add Facebook**
3. Enter your access token
4. Click **Add Account**

### Capabilities

- Text posts (63,206 character limit)
- Single image attachment
- Video attachments
- Supported formats: PNG, JPEG, WebP, MP4

---

## Threads

Threads uses the Threads API with a long-lived access token.

### Prerequisites

1. A **Meta for Developers** account
2. A Threads account
3. A Meta App with the **Threads API** product

### Getting a Token

1. Go to [developers.facebook.com](https://developers.facebook.com)
2. Add the **Threads API** product to your app
3. Follow the OAuth flow to get an access token

### Environment Variables

```env
THREADS_ACCESS_TOKEN=your-threads-access-token
THREADS_USER_ID=your-threads-user-id
```

### Connecting in Creator Hub

1. Go to **Creator Hub > Accounts**
2. Click **Add Threads**
3. Enter your access token
4. Click **Add Account**

### Capabilities

- Text posts (500 character limit)
- Image attachments (up to 10)
- Video attachments
- Thread support
- Supported formats: PNG, JPEG, WebP, MP4

---

## YouTube

YouTube uses the YouTube Data API v3 with OAuth 2.0.

### Prerequisites

1. A **Google Cloud** project
2. **YouTube Data API v3** enabled
3. OAuth 2.0 credentials configured

### Getting Credentials

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project or select existing
3. Enable **YouTube Data API v3**
4. Create **OAuth 2.0 Client ID** credentials
5. Add redirect URI: `http://localhost`

### Environment Variables

```env
YOUTUBE_CLIENT_ID=your-google-client-id
YOUTUBE_CLIENT_SECRET=your-google-client-secret
YOUTUBE_REFRESH_TOKEN=your-oauth-refresh-token
```

### Connecting in Creator Hub

1. Go to **Creator Hub > Accounts**
2. Click **Add YouTube**
3. Enter your access token
4. Click **Add Account**

### Capabilities

- Video uploads
- Description (5,000 character limit)
- Supported formats: MP4

---

## TikTok

TikTok uses the TikTok Business API with OAuth 2.0.

### Prerequisites

1. A **TikTok for Developers** account
2. A **TikTok Business** account
3. A TikTok App with the **Video Upload** scope

### Getting Credentials

1. Go to [developers.tiktok.com](https://developers.tiktok.com)
2. Create an app
3. Enable **Video Upload** permission
4. Get your **Client Key** and **Client Secret**

### Environment Variables

```env
TIKTOK_CLIENT_KEY=your-tiktok-client-key
TIKTOK_CLIENT_SECRET=your-tiktok-client-secret
TIKTOK_ACCESS_TOKEN=your-tiktok-access-token
```

### Connecting in Creator Hub

1. Go to **Creator Hub > Accounts**
2. Click **Add TikTok**
3. Enter your access token
4. Click **Add Account**

### Capabilities

- Video uploads (at least 1 video required)
- Caption (2,200 character limit)
- Supported formats: MP4

---

## itch.io

itch.io uses a simple API key for authentication.

### Prerequisites

1. An itch.io account
2. An API key

### Getting an API Key

1. Go to [itch.io/user/settings/api-keys](https://itch.io/user/settings/api-keys)
2. Generate a new API key

### Environment Variables

```env
ITCH_API_KEY=your-itch-api-key
ITCH_USERNAME=your-itch-username
```

### Connecting in Creator Hub

1. Go to **Creator Hub > Accounts**
2. Click **Add itch.io**
3. Enter your API key
4. Click **Add Account**

### Capabilities

- Text posts (10,000 character limit)
- Image attachments (up to 5)
- Supported formats: PNG, JPEG, WebP

---

## Mastodon

Mastodon uses OAuth 2.0 with an access token.

### Prerequisites

1. A Mastodon account on any instance
2. An access token with write permissions

### Getting an Access Token

1. Go to your Mastodon instance's settings
2. Navigate to **Development** > **New Application**
3. Enable **write:statuses** and **write:media** scopes
4. Copy the access token

### Environment Variables

```env
MASTODON_ACCESS_TOKEN=your-mastodon-access-token
MASTODON_INSTANCE_URL=https://your-instance.social
```

### Connecting in Creator Hub

1. Go to **Creator Hub > Accounts**
2. Click **Add Mastodon**
3. Enter your access token
4. Click **Add Account**

### Capabilities

- Text posts (500 character limit)
- Image attachments (up to 4)
- Video attachments
- Polls
- Supported formats: PNG, JPEG, GIF, WebP, MP4

---

## .env.example

Create a `.env` file in your project root with the variables you need:

```env
# === BLUESKY ===
BLUESKY_IDENTIFIER=
BLUESKY_APP_PASSWORD=

# === INSTAGRAM ===
INSTAGRAM_APP_ID=
INSTAGRAM_APP_SECRET=
INSTAGRAM_REDIRECT_URI=https://localhost:3541/instagram-callback

# === X (TWITTER) ===
X_API_KEY=
X_API_SECRET=
X_ACCESS_TOKEN=
X_ACCESS_TOKEN_SECRET=
X_USERNAME=

# === FACEBOOK ===
FACEBOOK_PAGE_ID=
FACEBOOK_ACCESS_TOKEN=

# === THREADS ===
THREADS_ACCESS_TOKEN=
THREADS_USER_ID=

# === YOUTUBE ===
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_REFRESH_TOKEN=

# === TIKTOK ===
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
TIKTOK_ACCESS_TOKEN=

# === ITCH.IO ===
ITCH_API_KEY=
ITCH_USERNAME=

# === MASTODON ===
MASTODON_ACCESS_TOKEN=
MASTODON_INSTANCE_URL=

# === DATABASE ===
POSTGRES_USER=emerald
POSTGRES_PASSWORD=emerald
POSTGRES_DB=emerald
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
```

---

## Validation

After importing your `.env` file, use the **Validate** button in **Settings > Developer Configuration** to check that all required variables are present.

The system will show:
- ✅ Green indicators for configured variables
- ❌ Red indicators for missing variables
- Provider status cards showing which services are ready to use
