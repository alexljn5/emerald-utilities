// src/creator-hub/services/instagram.js
// Instagram Content Publishing API integration.
// Uses Instagram Login for OAuth and the Instagram Graph API for publishing.
//
// Architecture:
//   - Instagram Login (api.instagram.com): OAuth authentication, token exchange
//   - Facebook Graph API (graph.facebook.com): Content Publishing API calls,
//     Page Access Token management, media container creation/publishing
//   - Instagram Basic Display API (graph.instagram.com): profile reads
//
// OAuth scopes:
//   instagram_business_basic, instagram_business_content_publish,
//   instagram_business_manage_comments
//
// Env vars (from centralized envConfig):
//   INSTAGRAM_APP_ID        — Meta app ID
//   INSTAGRAM_APP_SECRET    — Meta app secret
//   INSTAGRAM_REDIRECT_URI  — OAuth redirect (emerald://instagram-callback)
//   INSTAGRAM_ACCESS_TOKEN  — Pre-existing token (optional, manual entry)
//   INSTAGRAM_ACCOUNT_ID    — Pre-existing IG Business Account ID (optional)

import { PlatformService } from './base.js';
import { startDeepLinkOAuthFlow, startLocalhostOAuthFlow, generateState } from '../oauth.js';
import { createLogger } from '../utils/creatorHubLogger.js';
import { startTunnel, stopTunnel, isTunnelRunning, getTunnelUrl } from '../../services/cloudflareTunnel.js';

const instagramLog = createLogger('INSTAGRAM');

// Lazy-loaded Electron modules (main process only)
let electronShell = null;
let electronBrowserWindow = null;

async function getElectronModules() {
    if (!electronShell) {
        try {
            const electron = await import('electron');
            electronShell = electron.shell;
            electronBrowserWindow = electron.BrowserWindow;
        } catch {
            // Not in Electron environment
        }
    }
    return { shell: electronShell, BrowserWindow: electronBrowserWindow };
}

/**
 * Show and focus the main application window.
 * Useful when the app is running in tray-only/background mode
 * so the user knows to complete the OAuth flow in their browser.
 */
async function showMainWindow() {
    const modules = await getElectronModules();
    if (!modules?.BrowserWindow) return;

    try {
        const windows = modules.BrowserWindow.getAllWindows();
        for (const win of windows) {
            if (!win.isDestroyed()) {
                if (win.isMinimized()) win.restore();
                win.show();
                win.focus();
                instagramLog.info('[AUTH] Main window shown and focused for OAuth flow');
                return;
            }
        }
    } catch (err) {
        instagramLog.warn(`[AUTH] Could not show main window: ${err.message}`);
    }
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Instagram Login authorization endpoint */
const IG_AUTH_URL = 'https://www.instagram.com/oauth/authorize';

/** Instagram Login token exchange endpoint */
const IG_TOKEN_URL = 'https://api.instagram.com/oauth/access_token';

/** Facebook Graph API v21.0 — used for Content Publishing */
const FB_GRAPH_API = 'https://graph.facebook.com/v21.0';

/** Instagram Basic Display API — used for profile reads */
const IG_DISPLAY_API = 'https://graph.instagram.com/v21.0';

/** Required OAuth scopes */
const REQUIRED_SCOPES = [
    'instagram_business_basic',
    'instagram_business_content_publish',
    'instagram_business_manage_comments',
];

/** Poll interval when waiting for container status (ms) */
const INSTAGRAM_CONTAINER_POLL_INTERVAL_MS = parseInt(
    process.env.INSTAGRAM_CONTAINER_POLL_INTERVAL_MS || '2000',
    10
);

/** Maximum time to wait for container to become ready (ms) */
const INSTAGRAM_CONTAINER_TIMEOUT_MS = parseInt(
    process.env.INSTAGRAM_CONTAINER_TIMEOUT_MS || '60000',
    10
);

// ── Environment helpers ─────────────────────────────────────────────────────

function getEnv() {
    return {
        clientId: process.env.INSTAGRAM_APP_ID || process.env.INSTAGRAM_CLIENT_ID || '',
        clientSecret: process.env.INSTAGRAM_APP_SECRET || process.env.INSTAGRAM_CLIENT_SECRET || '',
        redirectUri: process.env.INSTAGRAM_REDIRECT_URI || '',
        accessToken: process.env.INSTAGRAM_ACCESS_TOKEN || '',
        accountId: process.env.INSTAGRAM_ACCOUNT_ID || '',
    };
}

// ── File helpers ────────────────────────────────────────────────────────────

async function getMimeType(filePath) {
    const path = await import('path');
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime',
        '.webm': 'video/webm',
    };
    return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Read a file as Buffer (main process only).
 */
async function readFileBuffer(filePath) {
    const fs = await import('fs');
    return fs.readFileSync(filePath);
}

// ── Temporary local HTTP server for media hosting ──────────────────────────
//
// Instagram requires a publicly accessible URL for image_url in the media
// container API. Since this is a desktop app without cloud hosting, we spin
// up a temporary local HTTP server to serve the media file during the brief
// window when Instagram fetches it.

/**
 * Start a temporary HTTP server that serves a single media file.
 * Returns the local URL and a cleanup function.
 *
 * @param {string} filePath - Path to the media file
 * @returns {Promise<{ url: string, close: () => void }>}
 */
/**
 * Get the media path from environment or default to /media.
 */
function getMediaPath() {
    return process.env.INSTAGRAM_MEDIA_PATH || '/media';
}

/**
 * Start a temporary HTTP server that serves a single media file.
 * Returns the local URL and a cleanup function.
 *
 * @param {string} filePath - Path to the media file
 * @returns {Promise<{ url: string, port: number, close: () => void }>}
 */
async function startMediaServer(filePath) {
    const http = await import('http');
    const fs = await import('fs');
    const buffer = await readFileBuffer(filePath);
    const mimeType = await getMimeType(filePath);
    const fileStats = await fs.promises.stat(filePath);
    const fileSize = fileStats.size;
    const mediaPath = getMediaPath();

    instagramLog.info(`[MEDIA] Serving file: ${filePath}`);
    instagramLog.info(`[MEDIA] MIME type: ${mimeType}, Size: ${fileSize} bytes`);
    instagramLog.info(`[MEDIA] Media route: ${mediaPath}`);

    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            // Log every incoming request for debugging
            instagramLog.info(`[MEDIA] Incoming request: ${req.method} ${req.url}`);
            instagramLog.debug(`[MEDIA] User-Agent: ${req.headers['user-agent'] || 'none'}`);

            // Health check endpoint for tunnel readiness
            if (req.url === '/' || req.url === '/health') {
                instagramLog.info(`[MEDIA] Health check: ${req.url}`);
                res.writeHead(200, {
                    'Content-Type': 'text/plain',
                    'Cache-Control': 'no-cache',
                });
                res.end('OK');
                return;
            }

            // Media endpoint
            if (req.url === mediaPath || req.url === mediaPath + '/') {
                instagramLog.info(`[MEDIA] Serving image: Content-Type=${mimeType}, Content-Length=${buffer.length}`);
                res.writeHead(200, {
                    'Content-Type': mimeType,
                    'Content-Length': String(buffer.length),
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-cache',
                    'Accept-Ranges': 'bytes',
                });
                res.end(buffer);
                return;
            }

            // Unknown route
            instagramLog.warn(`[MEDIA] Unknown route requested: ${req.url} — returning 404`);
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        });

        server.on('error', (err) => {
            reject(new Error(`Failed to start media server: ${err.message}`));
        });

        // Listen on 0.0.0.0 so Cloudflare tunnel can reach it
        server.listen(0, '0.0.0.0', () => {
            const port = server.address().port;
            const mediaUrl = `http://0.0.0.0:${port}${mediaPath}`;
            instagramLog.info(`[MEDIA] Temporary server started on port ${port} (0.0.0.0)`);
            resolve({
                url: mediaUrl,
                port,
                close: () => {
                    try { server.close(); } catch { /* ignore */ }
                    instagramLog.info('[MEDIA] Temporary server closed');
                },
            });
        });
    });
}

/**
 * Resolve the public media URL for Instagram publishing.
 * Priority:
 *   1. INSTAGRAM_MEDIA_BASE_URL from .env
 *   2. Existing active Cloudflare tunnel
 *   3. Auto-start a new Cloudflare quick tunnel
 *
 * @param {string} localMediaUrl - Local media server URL (e.g. http://127.0.0.1:50493/media)
 * @param {number} mediaPort - Port the local media server is listening on
 * @returns {Promise<string>} Public media URL
 */
/**
 * Validate that the public tunnel URL actually serves the media file.
 * Fetches the URL and checks for HTTP 200 with correct Content-Type and non-empty body.
 */
async function validateMediaEndpoint(publicMediaUrl, expectedMimeType) {
    instagramLog.info(`[MEDIA] Validating public endpoint: ${publicMediaUrl}`);

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        const response = await fetch(publicMediaUrl, {
            method: 'GET',
            signal: controller.signal,
            redirect: 'follow',
        });
        clearTimeout(timeout);

        instagramLog.info(`[MEDIA] Validation response: HTTP ${response.status}`);
        instagramLog.debug(`[MEDIA] Validation headers: ${JSON.stringify([...response.headers.entries()])}`);

        const contentType = response.headers.get('content-type') || '';
        const contentLength = response.headers.get('content-length') || '0';
        const body = await response.arrayBuffer();
        const bodyLength = body.byteLength;

        instagramLog.info(`[MEDIA] Validation body: Content-Type=${contentType}, Content-Length=${contentLength}, Actual-Bytes=${bodyLength}`);

        if (response.status !== 200) {
            throw new Error(`Media endpoint returned HTTP ${response.status}. Expected 200.`);
        }

        if (!contentType.startsWith('image/') && !contentType.startsWith('video/')) {
            instagramLog.warn(`[MEDIA] Unexpected Content-Type: ${contentType} (expected ${expectedMimeType})`);
        }

        if (bodyLength === 0) {
            throw new Error('Media endpoint returned empty body. Expected image/video bytes.');
        }

        if (bodyLength !== parseInt(contentLength, 10)) {
            instagramLog.warn(`[MEDIA] Content-Length mismatch: header=${contentLength}, actual=${bodyLength}`);
        }

        instagramLog.info(`[MEDIA] Endpoint validation PASSED — ${bodyLength} bytes, ${contentType}`);
        return true;
    } catch (err) {
        instagramLog.error(`[MEDIA] Endpoint validation FAILED: ${err.message}`);
        throw new Error(
            `Cannot reach media endpoint at ${publicMediaUrl}. ` +
            `Cloudflare tunnel may not be proxying correctly. ` +
            `Error: ${err.message}`
        );
    }
}

async function resolvePublicMediaUrl(localMediaUrl, mediaPort, mimeType) {
    const envBaseUrl = process.env.INSTAGRAM_MEDIA_BASE_URL;
    const mediaPath = getMediaPath();

    // Priority 1: Explicit base URL from .env
    if (envBaseUrl) {
        instagramLog.info(`[MEDIA] Using configured media base URL: ${envBaseUrl}`);
        return `${envBaseUrl.replace(/\/$/, '')}${mediaPath}`;
    }

    // Priority 2: Existing active tunnel
    if (isTunnelRunning()) {
        const existingUrl = getTunnelUrl();
        if (existingUrl) {
            instagramLog.info(`[MEDIA] Using existing Cloudflare tunnel: ${existingUrl}`);
            const publicUrl = `${existingUrl}${mediaPath}`;
            await validateMediaEndpoint(publicUrl, mimeType);
            return publicUrl;
        }
    }

    // Priority 3: Auto-start Cloudflare tunnel
    const tunnelEnabled = process.env.CLOUDFLARE_TUNNEL_ENABLED !== 'false';
    if (!tunnelEnabled) {
        throw new Error(
            'Instagram publishing requires a public media URL. ' +
            'Set INSTAGRAM_MEDIA_BASE_URL or enable CLOUDFLARE_TUNNEL_ENABLED=true.'
        );
    }

    const tunnelBinary = process.env.CLOUDFLARE_BINARY || 'cloudflared';
    instagramLog.info('[CLOUDFLARE] Starting quick tunnel...');

    try {
        const tunnelUrl = await startTunnel(mediaPort, tunnelBinary);
        instagramLog.info(`[CLOUDFLARE] Tunnel active: ${tunnelUrl}`);

        // startTunnel already waited for readiness (HTTP 200 on /)
        // Now validate the actual media endpoint
        const publicUrl = `${tunnelUrl}${mediaPath}`;
        await validateMediaEndpoint(publicUrl, mimeType);

        instagramLog.info(`[INSTAGRAM] Using public media URL: ${publicUrl}`);
        return publicUrl;
    } catch (err) {
        throw new Error(
            `Failed to start or validate Cloudflare tunnel: ${err.message}. ` +
            'Ensure cloudflared is installed and accessible, or set INSTAGRAM_MEDIA_BASE_URL.'
        );
    }
}

// ── OAuth helpers ───────────────────────────────────────────────────────────

/**
 * Build the Instagram Login authorization URL.
 */
function buildAuthUrl({ clientId, redirectUri, state }) {
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: REQUIRED_SCOPES.join(','),
        state: state || '',
    });
    return `${IG_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange an authorization code for a short-lived access token.
 * Uses the Instagram Basic Display API token endpoint.
 */
async function exchangeCodeForToken(code, { clientId, clientSecret, redirectUri }) {
    instagramLog.debug(`[AUTH] Exchanging authorization code for token. clientId=${clientId ? 'set' : 'missing'}, redirectUri=${redirectUri}`);

    const response = await fetch(IG_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
            code,
        }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Token exchange failed (HTTP ${response.status}): ${text}`);
    }

    const data = await response.json();
    instagramLog.debug(`[AUTH] Token exchange response keys: ${Object.keys(data).join(', ')}`);
    return data;
}

/**
 * Exchange a short-lived token for a long-lived (60-day) token.
 * Uses the Instagram Graph API endpoint (graph.instagram.com).
 */
async function exchangeForLongLivedToken(shortLivedToken, { clientSecret }) {
    // Defensive: ensure we have a string, not an object
    const tokenStr = typeof shortLivedToken === 'string' ? shortLivedToken : String(shortLivedToken);
    instagramLog.debug(`[AUTH] Exchanging short-lived token for long-lived token. Token length: ${tokenStr.length}, has access_token key: ${typeof shortLivedToken === 'object' && shortLivedToken !== null ? 'yes (object passed!)' : 'no (string passed)'}`);

    const params = new URLSearchParams({
        grant_type: 'ig_exchange_token',
        client_secret: clientSecret,
        access_token: tokenStr,
    });

    const response = await fetch(
        `${IG_DISPLAY_API}/access_token?${params.toString()}`
    );

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Long-lived token exchange failed (HTTP ${response.status}): ${text}`);
    }

    const data = await response.json();
    instagramLog.debug(`[AUTH] Long-lived token response keys: ${Object.keys(data).join(', ')}`);
    return data;
}

/**
 * Refresh a long-lived token before it expires.
 * Long-lived tokens expire after 60 days.
 */
async function refreshLongLivedToken(currentToken) {
    const params = new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: getEnv().clientId,
        client_secret: getEnv().clientSecret,
        fb_exchange_token: currentToken,
    });

    const response = await fetch(
        `${FB_GRAPH_API}/oauth/access_token?${params.toString()}`
    );

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Token refresh failed (HTTP ${response.status}): ${text}`);
    }

    return response.json();
}

// ── Instagram Business Account helpers ──────────────────────────────────────
//
// NOTE: Instagram Business Login tokens can be used directly with the
// Instagram Graph API (graph.instagram.com) for profile reads and
// Content Publishing API calls. No Facebook Pages lookup is needed.
//
// Flow:
//   1. Exchange Instagram Login code -> short-lived token
//   2. Exchange short-lived -> long-lived token (via graph.instagram.com)
//   3. Use long-lived token to get Instagram profile (graph.instagram.com/me)
//   4. Use long-lived token for Content Publishing API calls

/**
 * Get Instagram account info using the Instagram Graph API.
 * Uses the long-lived Instagram token directly (no Facebook Pages needed).
 */
async function getInstagramBusinessAccount(longLivedToken) {
    instagramLog.debug(`[AUTH] Fetching Instagram profile with long-lived token (length: ${longLivedToken.length})`);

    const params = new URLSearchParams({
        fields: 'id,username,account_type,profile_picture_url',
        access_token: longLivedToken,
    });

    const response = await fetch(
        `${IG_DISPLAY_API}/me?${params.toString()}`
    );

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to fetch Instagram profile (HTTP ${response.status}): ${text}`);
    }

    const data = await response.json();
    instagramLog.debug(`[AUTH] Instagram profile response keys: ${Object.keys(data).join(', ')}`);

    return {
        id: data.id,
        username: data.username || 'instagram_user',
        accountType: data.account_type || 'BUSINESS',
        profilePicture: data.profile_picture_url || null,
    };
}

/**
 * Get Instagram account info (username, profile picture, account type).
 * Uses the Instagram Basic Display API with the long-lived token.
 */
async function getInstagramProfile(longLivedToken) {
    const params = new URLSearchParams({
        fields: 'id,username,account_type,profile_picture_url',
        access_token: longLivedToken,
    });
    const response = await fetch(
        `${IG_DISPLAY_API}/me?${params.toString()}`
    );

    if (!response.ok) {
        // Fallback to Facebook Graph API
        const fbParams = new URLSearchParams({
            fields: 'id,name',
            access_token: longLivedToken,
        });
        const fbResponse = await fetch(
            `${FB_GRAPH_API}/me?${fbParams.toString()}`
        );
        if (!fbResponse.ok) {
            const text = await response.text();
            throw new Error(`Instagram profile fetch failed (HTTP ${response.status}): ${text}`);
        }
        const fbData = await fbResponse.json();
        return { id: fbData.id, username: fbData.name || 'instagram_user', accountType: 'BUSINESS' };
    }

    return response.json();
}

// ── Media publishing helpers ────────────────────────────────────────────────

/**
 * Create a media container (single image).
 * Uses the Instagram Graph API with the Instagram user token.
 */
async function createMediaContainerImage(igAccountId, accessToken, imageUrl, caption) {
    const response = await fetch(
        `${IG_DISPLAY_API}/${igAccountId}/media`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                image_url: imageUrl,
                caption: caption || '',
                access_token: accessToken,
            }),
        }
    );

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Media container creation failed (HTTP ${response.status}): ${text}`);
    }

    const data = await response.json();
    return { ...data, id: String(data.id) }; // Ensure string ID
}

/**
 * Create a media container (video).
 * Uses the Instagram Graph API with the Instagram user token.
 */
async function createMediaContainerVideo(igAccountId, accessToken, videoUrl, caption) {
    const response = await fetch(
        `${IG_DISPLAY_API}/${igAccountId}/media`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                video_url: videoUrl,
                caption: caption || '',
                access_token: accessToken,
                media_type: 'VIDEO',
            }),
        }
    );

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Video container creation failed (HTTP ${response.status}): ${text}`);
    }

    const data = await response.json();
    return { ...data, id: String(data.id) }; // Ensure string ID
}

/**
 * Check media container status.
 * Works for both images and videos.
 */
async function getMediaContainerStatus(containerId, accessToken) {
    const containerParams = new URLSearchParams({
        fields: 'status_code,error_message',
        access_token: accessToken,
    });
    const response = await fetch(
        `${IG_DISPLAY_API}/${String(containerId)}?${containerParams.toString()}`
    );

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Container status check failed (HTTP ${response.status}): ${text}`);
    }

    return response.json();
}

/**
 * Publish a media container.
 */
async function publishMediaContainer(igAccountId, accessToken, creationId, containerStatus) {
    const response = await fetch(
        `${IG_DISPLAY_API}/${igAccountId}/media_publish`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                creation_id: String(creationId),
                access_token: accessToken,
            }),
        }
    );

    if (!response.ok) {
        const text = await response.text();
        instagramLog.error(
            `[PUBLISH] media_publish failed: containerId=${creationId}, ` +
            `statusBeforePublish=${containerStatus || 'unknown'}, ` +
            `response=${text}`
        );
        throw new Error(`Media publish failed (HTTP ${response.status}): ${text}`);
    }

    const data = await response.json();
    return { ...data, id: String(data.id) }; // Ensure string ID
}

/**
 * Get the permalink for a published media item.
 */
async function getMediaPermalink(mediaId, accessToken) {
    const mediaParams = new URLSearchParams({
        fields: 'permalink',
        access_token: accessToken,
    });
    const response = await fetch(
        `${IG_DISPLAY_API}/${mediaId}?${mediaParams.toString()}`
    );

    if (!response.ok) {
        return null; // Permalink might not be available immediately
    }

    const data = await response.json();
    return data.permalink || null;
}

/**
 * Wait for a media container to become ready (polling).
 * Works for both images and videos.
 *
 * @param {string} igAccountId
 * @param {string} accessToken
 * @param {string} containerId
 * @param {number} [maxAttempts] - Override max attempts (default from INSTAGRAM_CONTAINER_TIMEOUT_MS)
 */
async function waitForContainerReady(igAccountId, accessToken, containerId, maxAttempts) {
    const timeoutMs = INSTAGRAM_CONTAINER_TIMEOUT_MS;
    const intervalMs = INSTAGRAM_CONTAINER_POLL_INTERVAL_MS;
    const attempts = maxAttempts || Math.ceil(timeoutMs / intervalMs);
    const containerIdStr = String(containerId);

    instagramLog.info(
        `[PUBLISH] Waiting for container ${containerIdStr} to become ready ` +
        `(poll every ${intervalMs}ms, timeout ${timeoutMs}ms)`
    );

    for (let i = 0; i < attempts; i++) {
        const status = await getMediaContainerStatus(containerIdStr, accessToken);
        instagramLog.info(`[PUBLISH] Container ${containerIdStr} status: ${status.status_code}`);

        if (status.status_code === 'FINISHED') {
            instagramLog.info(`[PUBLISH] Container ${containerIdStr} is ready`);
            return status;
        }
        if (status.status_code === 'ERROR') {
            throw new Error(
                `Container ${containerIdStr} processing failed: ` +
                `${status.error_message || 'Unknown error'}`
            );
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    throw new Error(
        `Container ${containerIdStr} did not become ready within ` +
        `${timeoutMs}ms (${attempts} polls)`
    );
}

/**
 * Wait for a video container to finish processing (polling).
 * @deprecated Use waitForContainerReady instead
 */
async function waitForVideoProcessing(igAccountId, pageAccessToken, containerId, maxAttempts = 30) {
    return waitForContainerReady(igAccountId, pageAccessToken, containerId, maxAttempts);
}

// ── Error mapping ──────────────────────────────────────────────────────────

/**
 * Map Instagram API errors to user-friendly messages.
 */
function mapInstagramError(errorMessage) {
    const msg = errorMessage.toLowerCase();

    if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid token') || msg.includes('expired')) {
        return 'Instagram connection expired. Reconnect your account.';
    }
    if (msg.includes('403') || msg.includes('permission')) {
        return 'Instagram permissions are incomplete. Reconnect with all required permissions.';
    }
    if (msg.includes('400') && (msg.includes('media') || msg.includes('image') || msg.includes('video'))) {
        return `Invalid media file. ${errorMessage}`;
    }
    if (msg.includes('not a business') || msg.includes('creator') || msg.includes('account type')) {
        return 'Instagram publishing requires a Creator or Business account.';
    }
    if (msg.includes('rate limit') || msg.includes('too many')) {
        return 'Instagram API rate limit exceeded. Please wait a few minutes and try again.';
    }
    if (msg.includes('duplicate') || msg.includes('already published')) {
        return 'This content appears to be a duplicate. Instagram does not allow identical posts.';
    }

    return `Publish failed: ${errorMessage}`;
}

// ── Service implementation ──────────────────────────────────────────────────

const InstagramService = {
    ...PlatformService,

    // ══════════════════════════════════════════════════════════════════════════
    // AUTHENTICATION
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Authenticate via Instagram Login OAuth flow.
     *
     * Supports two callback transports based on INSTAGRAM_REDIRECT_URI:
     *   - emerald://  → deep-link custom protocol (no localhost server needed)
     *   - http(s)://  → localhost HTTP callback server
     *
     * Flow:
     *   1. Open browser to Instagram Login authorization URL
     *   2. Meta redirects to the configured callback URL with authorization code
     *   3. Capture the callback (deep link or localhost HTTP)
     *   4. Exchange code for short-lived access token
     *   5. Exchange short-lived token for long-lived (60-day) token via FB Graph API
     *   6. Get user's Facebook Pages to find Instagram Business Account
     *   7. Get Page Access Token for Content Publishing API calls
     *
     * @param {Object} params
     * @param {string} [params.username]
     * @returns {{ success: boolean, error?: string, credentials?: Object, username?: string }}
     */
    async authenticate(params = {}) {
        const env = getEnv();
        if (!env.clientId || !env.clientSecret) {
            instagramLog.error('[AUTH] Missing INSTAGRAM_APP_ID or INSTAGRAM_APP_SECRET in environment');
            return {
                success: false,
                error: 'Instagram API credentials not configured. Add INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET to your .env file, then import it in Settings.',
            };
        }

        if (!env.redirectUri) {
            instagramLog.error('[AUTH] INSTAGRAM_REDIRECT_URI is not set in environment');
            return {
                success: false,
                error: 'INSTAGRAM_REDIRECT_URI is not configured. Set it in your .env file.',
            };
        }

        try {
            const state = generateState();
            const authUrl = buildAuthUrl({
                clientId: env.clientId,
                redirectUri: env.redirectUri,
                state,
            });

            instagramLog.info('[AUTH] ============================================');
            instagramLog.info(`[AUTH] Redirect URI: ${env.redirectUri}`);
            instagramLog.info(`[AUTH] Generated OAuth state: ${state}`);
            instagramLog.info(`[AUTH] Authorization URL: ${authUrl}`);
            instagramLog.info('[AUTH] ============================================');

            // Show main window if app is in tray-only/background mode
            await showMainWindow();

            // Open the Meta OAuth URL in the user's default browser
            const modules = await getElectronModules();
            if (modules?.shell) {
                instagramLog.info(`[AUTH] Opening browser to Meta OAuth URL via shell.openExternal`);
                try {
                    await modules.shell.openExternal(authUrl);
                    instagramLog.info('[AUTH] shell.openExternal succeeded');
                } catch (openErr) {
                    instagramLog.error(`[AUTH] shell.openExternal failed: ${openErr.message}`);
                    throw new Error(`Failed to open browser for Instagram OAuth: ${openErr.message}`);
                }
            } else {
                instagramLog.warn('[AUTH] Electron shell not available — cannot open browser automatically.');
                instagramLog.warn(`[AUTH] Please manually open this URL in your browser:\n[URL] ${authUrl}`);
            }

            // Choose callback transport based on redirect URI protocol
            const redirectUriObj = new URL(env.redirectUri);
            let code;

            if (redirectUriObj.protocol === 'emerald:') {
                // Deep-link custom protocol flow
                instagramLog.info('[AUTH] Waiting for deep link callback...');
                const callbackPath = redirectUriObj.pathname.replace(/^\//, '') || 'instagram-callback';
                const result = await startDeepLinkOAuthFlow({
                    callbackPath,
                    expectedState: state,
                    timeout: 120000,
                });
                code = result.code;
                instagramLog.info(`[AUTH] Received callback URL: ${env.redirectUri}?code=...&state=${result.state || state}`);
                if (result.state) {
                    instagramLog.info('[AUTH] OAuth state validated');
                }
            } else if (redirectUriObj.protocol === 'http:' || redirectUriObj.protocol === 'https:') {
                // Localhost callback server flow (HTTP or HTTPS)
                const host = redirectUriObj.host;
                const port = parseInt(host.split(':')[1], 10) || 3541;
                const callbackPath = redirectUriObj.pathname;
                instagramLog.info(`[AUTH] Starting localhost OAuth callback server on ${host}${callbackPath}...`);
                const result = await startLocalhostOAuthFlow({
                    port,
                    callbackPath,
                    protocol: redirectUriObj.protocol,
                    timeout: 120000,
                });
                code = result.code;
                instagramLog.info(`[AUTH] Callback received on localhost:${port}${callbackPath}`);
            } else {
                throw new Error(`Unsupported redirect URI protocol: ${redirectUriObj.protocol}. Use emerald:// or http(s)://`);
            }

            if (!code) {
                throw new Error('No authorization code received from OAuth flow');
            }

            instagramLog.info('[AUTH] Authorization code received, exchanging for token...');
            instagramLog.debug(`[AUTH] Env: clientId=${env.clientId ? 'set' : 'missing'}, clientSecret=${env.clientSecret ? 'set' : 'missing'}, redirectUri=${env.redirectUri}`);

            // Step 1: Exchange code for short-lived token
            const tokenData = await exchangeCodeForToken(code, {
                clientId: env.clientId,
                clientSecret: env.clientSecret,
                redirectUri: env.redirectUri,
            });

            const shortLivedToken = tokenData.access_token;
            const igUserId = tokenData.user_id;
            instagramLog.info(`[AUTH] Short-lived token obtained for user: ${igUserId}`);
            instagramLog.debug(`[AUTH] Short-lived token type: ${typeof shortLivedToken}, length: ${shortLivedToken ? shortLivedToken.length : 0}`);

            // Step 2: Exchange for long-lived (60-day) token via Instagram Graph API
            const longLivedData = await exchangeForLongLivedToken(shortLivedToken, {
                clientSecret: env.clientSecret,
            });

            const longLivedToken = longLivedData.access_token;
            const expiresIn = longLivedData.expires_in || 5184000; // 60 days in seconds
            instagramLog.info('[AUTH] Long-lived token obtained');

            // Step 3: Get Instagram account info via Instagram Graph API
            instagramLog.info('[AUTH] Getting Instagram account info...');
            const igAccount = await getInstagramBusinessAccount(longLivedToken);
            instagramLog.info(`[AUTH] Found Instagram account: @${igAccount.username} (id: ${igAccount.id})`);

            const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

            return {
                success: true,
                credentials: {
                    accessToken: longLivedToken,
                    userAccessToken: longLivedToken,
                    igUserId: String(igUserId),
                    instagramAccountId: igAccount.id,
                    username: igAccount.username,
                    profilePicture: igAccount.profilePicture,
                    accountType: igAccount.accountType,
                    tokenType: 'instagram_user_token',
                    expiresAt,
                },
                username: igAccount.username,
            };
        } catch (err) {
            instagramLog.error(`[AUTH] Authentication failed: ${err.message}`);
            return {
                success: false,
                error: err.message,
            };
        }
    },

    // ══════════════════════════════════════════════════════════════════════════
    // CONNECTION
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Connect with stored credentials.
     * Validates that the token can make API calls.
     *
     * @param {Object} credentials
     * @returns {{ success: boolean, error?: string, username?: string }}
     */
    async connect(credentials) {
        try {
            if (!credentials || !credentials.accessToken) {
                return { success: false, error: 'Instagram requires an access token.' };
            }

            const accessToken = credentials.accessToken;
            const igAccountId = credentials.instagramAccountId;

            if (igAccountId) {
                const accountParams = new URLSearchParams({
                    fields: 'id,username,account_type,profile_picture_url',
                    access_token: accessToken,
                });
                const response = await fetch(
                    `${IG_DISPLAY_API}/${igAccountId}?${accountParams.toString()}`
                );

                if (!response.ok) {
                    return { success: false, error: 'Instagram access token is invalid or expired. Reconnect your account.' };
                }

                const data = await response.json();
                return {
                    success: true,
                    username: data.username || credentials.username || 'instagram_user',
                };
            }

            // Fallback: try to verify via user profile
            try {
                const profile = await getInstagramProfile(accessToken);
                return {
                    success: true,
                    username: profile.username || credentials.username || 'instagram_user',
                };
            } catch {
                return { success: false, error: 'Could not verify Instagram connection. Reconnect your account.' };
            }
        } catch (err) {
            return { success: false, error: `Instagram connection error: ${err.message}` };
        }
    },

    // ══════════════════════════════════════════════════════════════════════════
    // TEST CONNECTION
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Test connection by checking token validity and account info.
     *
     * @param {Object} account
     * @returns {{ valid: boolean, error?: string, username?: string, metadata?: Object }}
     */
    async testConnection(account) {
        try {
            const credentials = account.credentials || {};
            const accessToken = credentials.accessToken;
            const igAccountId = credentials.instagramAccountId;

            if (!accessToken) {
                return { valid: false, error: 'No access token stored. Reconnect account.' };
            }

            // Test with Instagram Business Account ID if available
            if (igAccountId) {
                const testParams = new URLSearchParams({
                    fields: 'id,username,account_type,profile_picture_url',
                    access_token: accessToken,
                });
                const response = await fetch(
                    `${IG_DISPLAY_API}/${igAccountId}?${testParams.toString()}`
                );

                if (!response.ok) {
                    if (response.status === 401 || response.status === 403) {
                        return { valid: false, error: 'Instagram connection expired or revoked. Reconnect.' };
                    }
                    return { valid: false, error: `Instagram API error (HTTP ${response.status}). Reconnect.` };
                }

                const data = await response.json();

                if (credentials.expiresAt) {
                    const expiresAtDate = new Date(credentials.expiresAt);
                    const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
                    if (expiresAtDate < sevenDaysFromNow) {
                        instagramLog.warn(`[CONNECT] Token expires soon: ${credentials.expiresAt}`);
                    }
                }

                return {
                    valid: true,
                    username: data.username || data.name || credentials.username,
                    metadata: {
                        igUserId: data.id,
                        followersCount: data.followers_count,
                        mediaCount: data.media_count,
                    },
                };
            }

            // Fallback: test via me endpoint
            try {
                const profile = await getInstagramProfile(accessToken);
                return {
                    valid: true,
                    username: profile.username || credentials.username,
                    metadata: { igUserId: profile.id },
                };
            } catch {
                return { valid: false, error: 'Could not verify Instagram connection. Reconnect.' };
            }
        } catch (err) {
            return { valid: false, error: err.message };
        }
    },

    // ══════════════════════════════════════════════════════════════════════════
    // PUBLISH
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Publish a post to Instagram.
     *
     * Instagram requires at least one image or video — text-only posts are
     * not supported by the Content Publishing API.
     *
     * Flow:
     *   1. Read media file
     *   2. Start temporary local HTTP server to serve the file
     *   3. Create media container via Facebook Graph API
     *   4. If video, poll until processing completes
     *   5. Publish the container
     *   6. Shut down temporary server
     *   7. Get permalink
     *
     * @param {Object} account
     * @param {Object} post
     * @param {string} text — Caption text
     * @param {string[]} mediaPaths — Paths to media files
     * @returns {{ success: boolean, postId?: string, permalink?: string, error?: string }}
     */
    async publish(account, post, text, mediaPaths = []) {
        const credentials = account.credentials || {};
        const accessToken = credentials.accessToken;
        const igAccountId = credentials.instagramAccountId;

        instagramLog.debug(`[PUBLISH] Account lookup: id=${account.id}, username=${credentials.username || 'unknown'}, token_exists=${!!accessToken}, token_length=${accessToken ? accessToken.length : 0}, token_prefix=${accessToken ? accessToken.slice(0, 5) : 'n/a'}`);

        if (!accessToken) {
            return { success: false, error: 'Instagram connection expired. Reconnect.' };
        }

        if (!igAccountId) {
            return { success: false, error: 'Instagram account ID not found. Reconnect your account.' };
        }

        if (!mediaPaths || mediaPaths.length === 0) {
            return { success: false, error: 'Instagram posts require at least one image or video.' };
        }

        let mediaServer = null;
        let tunnelStarted = false;

        try {
            const mediaPath = mediaPaths[0];
            const path = await import('path');
            const ext = path.extname(mediaPath).toLowerCase();
            const isVideo = ['.mp4', '.mov', '.webm'].includes(ext);
            const mimeType = await getMimeType(mediaPath);

            instagramLog.info(`[PUBLISH] Publishing ${isVideo ? 'video' : 'image'}: ${mediaPath}`);
            instagramLog.info(`[PUBLISH] Caption length: ${text.length} chars`);

            // Start temporary HTTP server to serve the media file
            instagramLog.info('[PUBLISH] Starting temporary media server...');
            mediaServer = await startMediaServer(mediaPath);
            const localMediaUrl = mediaServer.url;
            instagramLog.info(`[PUBLISH] Media available at: ${localMediaUrl}`);

            // Resolve public media URL (via Cloudflare tunnel if needed)
            // Pass mimeType so we can validate the endpoint serves the right content
            const publicMediaUrl = await resolvePublicMediaUrl(localMediaUrl, mediaServer.port, mimeType);
            tunnelStarted = true;
            instagramLog.info(`[PUBLISH] Public media URL: ${publicMediaUrl}`);

            // Create media container
            let container;
            if (isVideo) {
                container = await createMediaContainerVideo(
                    igAccountId,
                    accessToken,
                    publicMediaUrl,
                    text
                );
                instagramLog.info(`[PUBLISH] Video container created: id=${container.id}`);
            } else {
                container = await createMediaContainerImage(
                    igAccountId,
                    accessToken,
                    publicMediaUrl,
                    text
                );
                instagramLog.info(`[PUBLISH] Image container created: id=${container.id}`);
            }

            // Wait for container to be ready (FINISHED) before publishing.
            // Instagram needs time to fetch and process the media.
            // This applies to both images and videos.
            instagramLog.info(`[PUBLISH] Waiting for container ${container.id} to be ready...`);
            const containerStatus = await waitForContainerReady(
                igAccountId,
                accessToken,
                container.id
            );
            instagramLog.info(`[PUBLISH] Container ready: ${container.id}`);

            // DO NOT shut down the media server yet — keep it alive
            // until after publish completes.

            // Publish the container
            instagramLog.info('[PUBLISH] Publishing media container...');
            const published = await publishMediaContainer(
                igAccountId,
                accessToken,
                container.id,
                containerStatus?.status_code
            );
            instagramLog.info(`[PUBLISH] Published successfully: id=${published.id}`);

            // Get permalink (may take a moment to be available)
            const permalink = await getMediaPermalink(published.id, accessToken);
            instagramLog.info(`[PUBLISH] Permalink: ${permalink || 'unavailable yet'}`);

            return {
                success: true,
                postId: published.id,
                permalink: permalink || undefined,
            };
        } catch (err) {
            instagramLog.error(`[PUBLISH] Failed: ${err.message}`);

            return { success: false, error: mapInstagramError(err.message) };
        } finally {
            // Always clean up media server and tunnel
            if (mediaServer) {
                instagramLog.info('[PUBLISH] Cleaning up temporary media server...');
                mediaServer.close();
                mediaServer = null;
            }

            // Stop tunnel if we started it for this publish operation
            if (tunnelStarted && isTunnelRunning()) {
                instagramLog.info('[CLOUDFLARE] Stopping tunnel after publish...');
                stopTunnel();
            }
        }
    },

    // ══════════════════════════════════════════════════════════════════════════
    // UPLOAD MEDIA
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Upload a single media file. For Instagram this returns the file path
     * as the media ID since we handle actual upload in publish().
     *
     * @param {Object} account
     * @param {string} mediaPath
     * @returns {{ success: boolean, mediaId?: string, error?: string }}
     */
    async uploadMedia(account, mediaPath) {
        try {
            const credentials = account.credentials || {};
            if (!credentials.accessToken) {
                return { success: false, error: 'Not authenticated' };
            }
            return { success: true, mediaId: mediaPath };
        } catch (err) {
            return { success: false, error: err.message };
        }
    },

    // ══════════════════════════════════════════════════════════════════════════
    // DISCONNECT
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * Disconnect from Instagram. Revokes the access token.
     */
    async disconnect(account) {
        try {
            const credentials = account.credentials || {};
            if (credentials.accessToken) {
                const revokeParams = new URLSearchParams({
                    access_token: credentials.accessToken,
                });
                const response = await fetch(
                    `${FB_GRAPH_API}/me/permissions?${revokeParams.toString()}`,
                    { method: 'DELETE' }
                );
                if (!response.ok) {
                    instagramLog.warn(`[DISCONNECT] Token revocation returned HTTP ${response.status}`);
                }
            }
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    },

    // ══════════════════════════════════════════════════════════════════════════
    // CAPABILITIES
    // ══════════════════════════════════════════════════════════════════════════

    supportsMedia() {
        return true;
    },

    /**
     * Instagram requires media — text-only posts are not supported.
     * @returns {{ text: boolean, images: boolean, video: boolean, maxChars: number }}
     */
    getCapabilities() {
        return {
            text: true,
            images: true,
            video: true,
            maxChars: 2200,
        };
    },
};

export default InstagramService;
