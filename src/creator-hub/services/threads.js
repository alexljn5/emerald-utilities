// src/creator-hub/services/threads.js
// Threads API service — Meta Graph API integration.
// Uses the Threads API (graph.threads.net) for all operations.
//
// Authentication modes:
//   1. Direct access token via THREADS_ACCESS_TOKEN environment variable
//   2. OAuth flow (fallback when no env token is configured)
//
// OAuth scopes required:
//   threads_basic, threads_content_publish
//
// IMPORTANT: Meta requires HTTPS for OAuth redirect URIs.
// Use one of these approaches:
//   1. emerald:// protocol (deep link) — no HTTPS needed
//   2. HTTPS localhost — requires mkcert certificates in src/oauth/certs/
//
// Env vars:
//   THREADS_ACCESS_TOKEN   — Direct access token (preferred, no OAuth needed)
//   THREADS_APP_ID         — Meta app ID (can reuse INSTAGRAM_APP_ID)
//   THREADS_APP_SECRET     — Meta app secret (can reuse INSTAGRAM_APP_SECRET)
//   THREADS_REDIRECT_URI   — OAuth redirect URI (emerald:// or https://)

import { PlatformService } from './base.js';
import { startDeepLinkOAuthFlow, startLocalhostOAuthFlow, generateState } from '../oauth.js';
import { createLogger } from '../utils/creatorHubLogger.js';
import { translateError, translateNetworkError } from './errorTranslator.js';
import { startTunnel, stopTunnel, isTunnelRunning, getTunnelUrl } from '../../services/cloudflareTunnel.js';

const threadsLog = createLogger('THREADS');

// Lazy-loaded Electron modules
let electronShell = null;

async function getElectronModules() {
    if (!electronShell) {
        try {
            const electron = await import('electron');
            electronShell = electron.shell;
        } catch {
            // Not in Electron environment
        }
    }
    return { shell: electronShell };
}

async function showMainWindow() {
    const modules = await getElectronModules();
    if (!modules?.shell) return;
    try {
        const electron = await import('electron');
        const windows = electron.BrowserWindow.getAllWindows();
        for (const win of windows) {
            if (!win.isDestroyed()) {
                if (win.isMinimized()) win.restore();
                win.show();
                win.focus();
                threadsLog.info('[AUTH] Main window shown and focused for OAuth flow');
                return;
            }
        }
    } catch (err) {
        threadsLog.warn(`[AUTH] Could not show main window: ${err.message}`);
    }
}

// ── Constants ───────────────────────────────────────────────────────────────

// Threads API hostname — NOT the Facebook Graph API hostname
const THREADS_API = 'https://graph.threads.net/v1.0';

const REQUIRED_SCOPES = [
    'threads_basic',
    'threads_content_publish',
];

const THREADS_CONTAINER_POLL_INTERVAL_MS = parseInt(
    process.env.THREADS_CONTAINER_POLL_INTERVAL_MS || '2000',
    10
);

const THREADS_CONTAINER_TIMEOUT_MS = parseInt(
    process.env.THREADS_CONTAINER_TIMEOUT_MS || '60000',
    10
);

// ── Environment helpers ─────────────────────────────────────────────────────

function getEnv() {
    return {
        clientId: process.env.THREADS_APP_ID || process.env.INSTAGRAM_APP_ID || '',
        clientSecret: process.env.THREADS_APP_SECRET || process.env.INSTAGRAM_APP_SECRET || '',
        redirectUri: process.env.THREADS_REDIRECT_URI || process.env.INSTAGRAM_REDIRECT_URI || '',
        accessToken: process.env.THREADS_ACCESS_TOKEN || '',
    };
}

/**
 * Check if a direct access token is configured in the environment.
 * @returns {boolean}
 */
function hasEnvAccessToken() {
    return !!process.env.THREADS_ACCESS_TOKEN;
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

async function readFileBuffer(filePath) {
    const fs = await import('fs');
    return fs.readFileSync(filePath);
}

// ── Temporary media server ──────────────────────────────────────────────────

function getMediaPath() {
    return process.env.INSTAGRAM_MEDIA_PATH || '/media';
}

async function startMediaServer(filePath) {
    const http = await import('http');
    const fs = await import('fs');
    const buffer = await readFileBuffer(filePath);
    const mimeType = await getMimeType(filePath);
    const mediaPath = getMediaPath();

    threadsLog.info(`[MEDIA] Serving file: ${filePath}`);

    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            if (req.url === '/' || req.url === '/health') {
                res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-cache' });
                res.end('OK');
                return;
            }

            if (req.url === mediaPath || req.url === mediaPath + '/') {
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

            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        });

        server.on('error', (err) => {
            reject(new Error(`Failed to start media server: ${err.message}`));
        });

        server.listen(0, '0.0.0.0', () => {
            const port = server.address().port;
            const mediaUrl = `http://0.0.0.0:${port}${mediaPath}`;
            threadsLog.info(`[MEDIA] Temporary server started on port ${port}`);
            resolve({
                url: mediaUrl,
                port,
                close: () => {
                    try { server.close(); } catch { /* ignore */ }
                    threadsLog.info('[MEDIA] Temporary server closed');
                },
            });
        });
    });
}

// ── Public media URL resolution ─────────────────────────────────────────────

async function resolvePublicMediaUrl(localMediaUrl, mediaPort, mimeType) {
    const envBaseUrl = process.env.INSTAGRAM_MEDIA_BASE_URL;
    const mediaPath = getMediaPath();

    if (envBaseUrl) {
        threadsLog.info(`[MEDIA] Using configured media base URL: ${envBaseUrl}`);
        return `${envBaseUrl.replace(/\/$/, '')}${mediaPath}`;
    }

    if (isTunnelRunning()) {
        const existingUrl = getTunnelUrl();
        if (existingUrl) {
            threadsLog.info(`[MEDIA] Using existing Cloudflare tunnel: ${existingUrl}`);
            const publicUrl = `${existingUrl}${mediaPath}`;
            await validateMediaEndpoint(publicUrl, mimeType);
            return publicUrl;
        }
    }

    const tunnelEnabled = process.env.CLOUDFLARE_TUNNEL_ENABLED !== 'false';
    if (!tunnelEnabled) {
        throw new Error(
            'Threads publishing requires a public media URL. ' +
            'Set INSTAGRAM_MEDIA_BASE_URL or enable CLOUDFLARE_TUNNEL_ENABLED=true.'
        );
    }

    const tunnelBinary = process.env.CLOUDFLARE_BINARY || 'cloudflared';
    threadsLog.info('[CLOUDFLARE] Starting quick tunnel...');

    try {
        const tunnelUrl = await startTunnel(mediaPort, tunnelBinary);
        threadsLog.info(`[CLOUDFLARE] Tunnel active: ${tunnelUrl}`);
        const publicUrl = `${tunnelUrl}${mediaPath}`;
        await validateMediaEndpoint(publicUrl, mimeType);
        threadsLog.info(`[THREADS] Using public media URL: ${publicUrl}`);
        return publicUrl;
    } catch (err) {
        throw new Error(
            `Failed to start or validate Cloudflare tunnel: ${err.message}. ` +
            'Ensure cloudflared is installed and accessible, or set INSTAGRAM_MEDIA_BASE_URL.'
        );
    }
}

async function validateMediaEndpoint(publicMediaUrl, expectedMimeType) {
    threadsLog.info(`[MEDIA] Validating public endpoint: ${publicMediaUrl}`);

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        const response = await fetch(publicMediaUrl, {
            method: 'GET',
            signal: controller.signal,
            redirect: 'follow',
        });
        clearTimeout(timeout);

        const contentType = response.headers.get('content-type') || '';
        const body = await response.arrayBuffer();
        const bodyLength = body.byteLength;

        threadsLog.info(`[MEDIA] Validation response: HTTP ${response.status}, Content-Type=${contentType}, Bytes=${bodyLength}`);

        if (response.status !== 200) {
            throw new Error(`Media endpoint returned HTTP ${response.status}. Expected 200.`);
        }

        if (bodyLength === 0) {
            throw new Error('Media endpoint returned empty body.');
        }

        threadsLog.info(`[MEDIA] Endpoint validation PASSED`);
        return true;
    } catch (err) {
        threadsLog.error(`[MEDIA] Endpoint validation FAILED: ${err.message}`);
        throw new Error(
            `Cannot reach media endpoint at ${publicMediaUrl}. ` +
            `Cloudflare tunnel may not be proxying correctly. Error: ${err.message}`
        );
    }
}

// ── OAuth helpers ───────────────────────────────────────────────────────────

/**
 * Resolve the effective redirect URI for Threads OAuth.
 * When Cloudflare Tunnel is enabled, uses the tunnel's public URL
 * so Meta can redirect back through the tunnel to the local callback server.
 * When the tunnel is disabled, falls back to the configured localhost URL.
 *
 * @param {string} configuredRedirectUri - The redirect URI from .env (e.g. https://localhost:3541/threads/callback)
 * @returns {Promise<string>} The effective redirect URI
 */
async function resolveThreadsRedirectUri(configuredRedirectUri) {
    // If using emerald:// deep-link protocol, no tunnel needed
    if (configuredRedirectUri.startsWith('emerald://')) {
        return configuredRedirectUri;
    }

    // If tunnel is running, use the tunnel's public URL
    if (isTunnelRunning()) {
        const tunnelUrl = getTunnelUrl();
        if (tunnelUrl) {
            const urlObj = new URL(configuredRedirectUri);
            const callbackPath = urlObj.pathname; // e.g. /threads/callback
            threadsLog.info(`[AUTH] Using Cloudflare tunnel for OAuth redirect: ${tunnelUrl}${callbackPath}`);
            return `${tunnelUrl}${callbackPath}`;
        }
    }

    // Fallback to configured localhost URL
    return configuredRedirectUri;
}

function buildAuthUrl({ clientId, redirectUri, state }) {
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: REQUIRED_SCOPES.join(' '),
        state: state || '',
    });
    return `https://www.threads.net/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForToken(code, { clientId, clientSecret, redirectUri }) {
    threadsLog.debug(`[AUTH] Exchanging authorization code for token`);

    const response = await fetch(`${THREADS_API}/oauth/access_token`, {
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
    threadsLog.debug(`[AUTH] Token exchange response keys: ${Object.keys(data).join(', ')}`);
    return data;
}

async function refreshLongLivedToken(currentToken) {
    const env = getEnv();
    const params = new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: env.clientId,
        client_secret: env.clientSecret,
        fb_exchange_token: currentToken,
    });

    const response = await fetch(
        `${THREADS_API}/oauth/access_token?${params.toString()}`
    );

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Token refresh failed (HTTP ${response.status}): ${text}`);
    }

    return response.json();
}

// ── Threads API helpers ─────────────────────────────────────────────────────

/**
 * Centralized Threads API request helper.
 * Attaches the access token via Authorization: Bearer header.
 * Adds diagnostic logging for all requests.
 *
 * @param {string} method - HTTP method
 * @param {string} path - API path (e.g. '/me', '/me/threads')
 * @param {string} accessToken - Threads access token
 * @param {Object} [body] - Request body for POST/PATCH
 * @param {Object} [queryParams] - Additional query parameters
 * @returns {Promise<Object>} Parsed JSON response
 */
async function threadsApiRequest(method, path, accessToken, body = null, queryParams = {}) {
    const url = new URL(`${THREADS_API}${path}`);

    // Add query parameters
    for (const [key, value] of Object.entries(queryParams)) {
        if (value !== undefined && value !== null) {
            url.searchParams.set(key, String(value));
        }
    }

    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
    };

    const options = {
        method,
        headers,
    };

    if (body && (method === 'POST' || method === 'PATCH')) {
        options.body = JSON.stringify(body);
    }

    // Diagnostic logging — never log the actual token
    threadsLog.info(`[THREADS] API request: ${method} ${path}`);

    const response = await fetch(url.toString(), options);

    const status = response.status;
    threadsLog.info(`[THREADS] API response status: ${status} for ${method} ${path}`);

    let responseData;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        responseData = await response.json();
    } else {
        responseData = await response.text();
    }

    // Sanitize response for logging — remove any token fields
    let sanitizedResponse;
    if (typeof responseData === 'object' && responseData !== null) {
        sanitizedResponse = { ...responseData };
        // Remove any potential token fields from log output
        delete sanitizedResponse.access_token;
        delete sanitizedResponse.accessToken;
    } else {
        sanitizedResponse = responseData;
    }

    threadsLog.info(`[THREADS] API response: ${JSON.stringify(sanitizedResponse)}`);

    if (!response.ok) {
        const errorMessage = typeof responseData === 'string'
            ? responseData
            : JSON.stringify(responseData);
        throw new Error(`Threads API error (HTTP ${status}): ${errorMessage}`);
    }

    return responseData;
}

/**
 * Validate a Threads access token by fetching the authenticated user's profile.
 * Uses the correct Threads API endpoint and authentication.
 *
 * @param {string} accessToken - The Threads access token to validate
 * @returns {Promise<Object>} Profile data with id, username, name
 */
async function validateThreadsToken(accessToken) {
    threadsLog.info('[THREADS] Token validation endpoint: GET /me?fields=id,username,name');
    threadsLog.info('[THREADS] Token validation status: pending');

    try {
        const profile = await threadsApiRequest(
            'GET',
            '/me',
            accessToken,
            null,
            { fields: 'id,username,name' }
        );

        threadsLog.info(`[THREADS] Token validation successful: yes`);
        threadsLog.info(`[THREADS] Authenticated as: @${profile.username || profile.id}`);

        return profile;
    } catch (err) {
        threadsLog.info(`[THREADS] Token validation successful: no`);
        threadsLog.info(`[THREADS] Token validation error: ${err.message}`);
        throw err;
    }
}

async function getThreadsProfile(accessToken) {
    return validateThreadsToken(accessToken);
}

async function createMediaContainer(accessToken, text, mediaUrl, mediaType = 'IMAGE') {
    const body = {
        media_type: mediaType,
        text: text || '',
    };

    if (mediaUrl) {
        if (mediaType === 'VIDEO') {
            body.video_url = mediaUrl;
        } else {
            body.image_url = mediaUrl;
        }
    }

    threadsLog.info(`[THREADS] API request: POST /me/threads`);

    const response = await threadsApiRequest(
        'POST',
        '/me/threads',
        accessToken,
        body
    );

    return { ...response, id: String(response.id) };
}

async function getContainerStatus(containerId, accessToken) {
    const params = {
        fields: 'status_code,error_message',
    };

    threadsLog.info(`[THREADS] API request: GET /me/threads/${containerId}`);

    const response = await threadsApiRequest(
        'GET',
        `/me/threads/${containerId}`,
        accessToken,
        null,
        params
    );

    return response;
}

async function publishContainer(accessToken, creationId) {
    threadsLog.info(`[THREADS] API request: POST /me/threads_publish`);

    const response = await threadsApiRequest(
        'POST',
        '/me/threads_publish',
        accessToken,
        {
            creation_id: String(creationId),
        }
    );

    return { ...response, id: String(response.id) };
}

async function waitForContainerReady(containerId, accessToken, maxAttempts) {
    const timeoutMs = THREADS_CONTAINER_TIMEOUT_MS;
    const intervalMs = THREADS_CONTAINER_POLL_INTERVAL_MS;
    const attempts = maxAttempts || Math.ceil(timeoutMs / intervalMs);
    const containerIdStr = String(containerId);

    threadsLog.info(
        `[PUBLISH] Waiting for container ${containerIdStr} to become ready ` +
        `(poll every ${intervalMs}ms, timeout ${timeoutMs}ms)`
    );

    for (let i = 0; i < attempts; i++) {
        const status = await getContainerStatus(containerIdStr, accessToken);
        threadsLog.info(`[PUBLISH] Container ${containerIdStr} status: ${status.status_code}`);

        if (status.status_code === 'FINISHED') {
            threadsLog.info(`[PUBLISH] Container ${containerIdStr} is ready`);
            return status;
        }
        if (status.status_code === 'ERROR') {
            throw new Error(
                `Container ${containerIdStr} processing failed: ` +
                `${status.error_message || 'Unknown error'}`
            );
        }

        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    throw new Error(
        `Container ${containerIdStr} did not become ready within ` +
        `${timeoutMs}ms (${attempts} polls)`
    );
}

// ── Error mapping ──────────────────────────────────────────────────────────

function mapThreadsError(errorMessage) {
    const msg = errorMessage.toLowerCase();

    if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid token') || msg.includes('expired')) {
        return 'Threads connection expired. Reconnect your account.';
    }
    if (msg.includes('403') || msg.includes('permission')) {
        return 'Threads permissions are incomplete. Reconnect with all required permissions.';
    }
    if (msg.includes('400') && (msg.includes('media') || msg.includes('image') || msg.includes('video'))) {
        return `Invalid media file. ${errorMessage}`;
    }
    if (msg.includes('rate limit') || msg.includes('too many')) {
        return 'Threads API rate limit exceeded. Please wait a few minutes and try again.';
    }
    if (msg.includes('duplicate') || msg.includes('already published')) {
        return 'This content appears to be a duplicate. Threads does not allow identical posts.';
    }

    return `Publish failed: ${errorMessage}`;
}

// ── Service implementation ──────────────────────────────────────────────────

export const ThreadsService = {
    ...PlatformService,

    // ══════════════════════════════════════════════════════════════════════════
    // AUTHENTICATION
    // ══════════════════════════════════════════════════════════════════════════

    async authenticate(params = {}) {
        const env = getEnv();

        // ── Mode 1: Direct access token from environment ──────────────────────
        if (hasEnvAccessToken()) {
            threadsLog.info('[AUTH] Access token configured: yes');
            threadsLog.info('[AUTH] Authentication mode: access-token');

            const accessToken = env.accessToken;

            try {
                // Validate the token by fetching the user profile
                const profile = await validateThreadsToken(accessToken);

                threadsLog.info(`[AUTH] Token validation successful: yes`);
                threadsLog.info(`[AUTH] Authenticated Threads user: @${profile.username}`);

                return {
                    success: true,
                    credentials: {
                        accessToken,
                        username: profile.username,
                        threadsUserId: profile.id,
                        // No expiresAt for env tokens — they don't expire in the same way
                    },
                    username: profile.username,
                };
            } catch (err) {
                threadsLog.error(`[AUTH] Token validation failed: ${err.message}`);
                return {
                    success: false,
                    error: `Threads access token is invalid or expired: ${err.message}`,
                };
            }
        }

        // ── Mode 2: OAuth flow (fallback) ────────────────────────────────────
        threadsLog.info('[AUTH] Access token configured: no');
        threadsLog.info('[AUTH] Authentication mode: oauth');

        if (!env.clientId || !env.clientSecret) {
            threadsLog.error('[AUTH] Missing THREADS_APP_ID or THREADS_APP_SECRET in environment');
            return {
                success: false,
                error: 'Threads API credentials not configured. Add THREADS_APP_ID and THREADS_APP_SECRET to your .env file, or set THREADS_ACCESS_TOKEN.',
            };
        }

        if (!env.redirectUri) {
            threadsLog.error('[AUTH] THREADS_REDIRECT_URI is not set in environment');
            return {
                success: false,
                error: 'THREADS_REDIRECT_URI is not configured. Set it in your .env file.',
            };
        }

        try {
            const state = generateState();

            // Resolve the effective redirect URI:
            // - If tunnel is running, use the tunnel's public URL so Meta can redirect back
            // - If tunnel is disabled, use the configured localhost URL
            // - If emerald:// protocol, use it directly
            const effectiveRedirectUri = await resolveThreadsRedirectUri(env.redirectUri);

            const authUrl = buildAuthUrl({
                clientId: env.clientId,
                redirectUri: effectiveRedirectUri,
                state,
            });

            threadsLog.info('[AUTH] ============================================');
            threadsLog.info(`[AUTH] Configured Redirect URI: ${env.redirectUri}`);
            threadsLog.info(`[AUTH] Effective Redirect URI: ${effectiveRedirectUri}`);
            threadsLog.info(`[AUTH] Authorization URL: ${authUrl}`);
            threadsLog.info('[AUTH] ============================================');

            await showMainWindow();

            const modules = await getElectronModules();
            if (modules?.shell) {
                threadsLog.info(`[AUTH] Opening browser to Threads OAuth URL via shell.openExternal`);
                try {
                    await modules.shell.openExternal(authUrl);
                    threadsLog.info('[AUTH] shell.openExternal succeeded');
                } catch (openErr) {
                    throw new Error(`Failed to open browser for Threads OAuth: ${openErr.message}`);
                }
            } else {
                threadsLog.warn('[AUTH] Electron shell not available — cannot open browser automatically.');
                threadsLog.warn(`[AUTH] Please manually open this URL in your browser:\n[URL] ${authUrl}`);
            }

            const redirectUriObj = new URL(env.redirectUri);
            let code;

            if (redirectUriObj.protocol === 'emerald:') {
                const callbackPath = redirectUriObj.pathname.replace(/^\//, '') || 'threads-callback';
                const result = await startDeepLinkOAuthFlow({
                    callbackPath,
                    expectedState: state,
                    timeout: 120000,
                });
                code = result.code;
            } else if (redirectUriObj.protocol === 'http:' || redirectUriObj.protocol === 'https:') {
                const host = redirectUriObj.host;
                const port = parseInt(host.split(':')[1], 10) || 3541;
                const callbackPath = redirectUriObj.pathname;
                threadsLog.info(`[AUTH] Starting localhost OAuth callback server on ${host}${callbackPath}...`);
                const result = await startLocalhostOAuthFlow({
                    port,
                    callbackPath,
                    protocol: redirectUriObj.protocol,
                    timeout: 120000,
                });
                code = result.code;
            } else {
                throw new Error(`Unsupported redirect URI protocol: ${redirectUriObj.protocol}. Use emerald:// or http(s)://`);
            }

            if (!code) {
                throw new Error('No authorization code received from OAuth flow');
            }

            threadsLog.info('[AUTH] Authorization code received, exchanging for token...');

            const tokenData = await exchangeCodeForToken(code, {
                clientId: env.clientId,
                clientSecret: env.clientSecret,
                redirectUri: effectiveRedirectUri,
            });

            const accessToken = tokenData.access_token;
            threadsLog.info(`[AUTH] Access token obtained`);

            // Exchange for long-lived token
            let longLivedToken = accessToken;
            let expiresIn = tokenData.expires_in || 5184000;

            try {
                const longLivedData = await refreshLongLivedToken(accessToken);
                longLivedToken = longLivedData.access_token;
                expiresIn = longLivedData.expires_in || 5184000;
                threadsLog.info('[AUTH] Long-lived token obtained');
            } catch (refreshErr) {
                threadsLog.warn(`[AUTH] Could not exchange for long-lived token: ${refreshErr.message}. Using short-lived token.`);
            }

            // Get user profile
            const profile = await getThreadsProfile(longLivedToken);
            threadsLog.info(`[AUTH] Found Threads account: @${profile.username}`);

            const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

            return {
                success: true,
                credentials: {
                    accessToken: longLivedToken,
                    username: profile.username,
                    threadsUserId: profile.id,
                    expiresAt,
                },
                username: profile.username,
            };
        } catch (err) {
            threadsLog.error(`[AUTH] Authentication failed: ${err.message}`);
            return {
                success: false,
                error: err.message,
            };
        }
    },

    // ══════════════════════════════════════════════════════════════════════════
    // CONNECTION
    // ══════════════════════════════════════════════════════════════════════════

    async connect(credentials) {
        try {
            if (!credentials || !credentials.accessToken) {
                return { success: false, error: 'Threads requires an access token.' };
            }

            const profile = await getThreadsProfile(credentials.accessToken);
            return {
                success: true,
                username: profile.username || credentials.username || 'threads_user',
            };
        } catch (err) {
            return { success: false, error: `Threads connection error: ${err.message}` };
        }
    },

    // ══════════════════════════════════════════════════════════════════════════
    // TEST CONNECTION
    // ══════════════════════════════════════════════════════════════════════════

    async testConnection(account) {
        try {
            const credentials = account.credentials || {};
            const accessToken = credentials.accessToken;

            if (!accessToken) {
                return { valid: false, error: 'No access token stored. Reconnect account.' };
            }

            const profile = await getThreadsProfile(accessToken);

            if (credentials.expiresAt) {
                const expiresAtDate = new Date(credentials.expiresAt);
                const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
                if (expiresAtDate < sevenDaysFromNow) {
                    threadsLog.warn(`[CONNECT] Token expires soon: ${credentials.expiresAt}`);
                }
            }

            return {
                valid: true,
                username: profile.username || credentials.username,
                displayName: profile.name || profile.username,
            };
        } catch (err) {
            const statusMatch = err.message.match(/HTTP (\d+)/);
            const statusCode = statusMatch ? statusMatch[1] : null;
            if (statusCode) {
                const translated = translateError(statusCode, err.message);
                return { valid: false, error: translated.message };
            }
            const networkError = translateNetworkError(err.message);
            return { valid: false, error: networkError.message };
        }
    },

    // ══════════════════════════════════════════════════════════════════════════
    // PUBLISH
    // ══════════════════════════════════════════════════════════════════════════

    async publish(account, post, text, mediaPaths = []) {
        const credentials = account.credentials || {};
        const accessToken = credentials.accessToken;

        threadsLog.debug(`[PUBLISH] Account lookup: id=${account.id}, username=${credentials.username || 'unknown'}, token_exists=${!!accessToken}`);

        if (!accessToken) {
            return { success: false, error: 'Threads connection expired. Reconnect.' };
        }

        if (!text || text.trim().length === 0) {
            return { success: false, error: 'Threads posts require text content.' };
        }

        let mediaServer = null;
        let tunnelStarted = false;

        try {
            // Determine media type and URL
            let mediaUrl = null;
            let mediaType = 'TEXT_POST';

            if (mediaPaths.length > 0) {
                const mediaPath = mediaPaths[0];
                const path = await import('path');
                const ext = path.extname(mediaPath).toLowerCase();
                const isVideo = ['.mp4', '.mov', '.webm'].includes(ext);

                mediaType = isVideo ? 'VIDEO' : 'IMAGE';

                threadsLog.info(`[PUBLISH] Publishing ${isVideo ? 'video' : 'image'}: ${mediaPath}`);

                // Start temporary HTTP server
                mediaServer = await startMediaServer(mediaPath);
                const localMediaUrl = mediaServer.url;

                // Resolve public media URL
                const mimeType = await getMimeType(mediaPath);
                mediaUrl = await resolvePublicMediaUrl(localMediaUrl, mediaServer.port, mimeType);
                tunnelStarted = true;
                threadsLog.info(`[PUBLISH] Public media URL: ${mediaUrl}`);
            }

            // Create media container
            let container;
            if (mediaType === 'TEXT_POST') {
                // Text-only post
                container = await createMediaContainer(accessToken, text, null, 'TEXT_POST');
            } else {
                container = await createMediaContainer(accessToken, text, mediaUrl, mediaType);
            }
            threadsLog.info(`[PUBLISH] Container created: id=${container.id}`);

            // Wait for container to be ready
            const containerStatus = await waitForContainerReady(container.id, accessToken);
            threadsLog.info(`[PUBLISH] Container ready: ${container.id}`);

            // Publish the container
            threadsLog.info('[PUBLISH] Publishing container...');
            const published = await publishContainer(accessToken, container.id);
            threadsLog.info(`[PUBLISH] Published successfully: id=${published.id}`);

            return {
                success: true,
                postId: published.id,
            };
        } catch (err) {
            threadsLog.error(`[PUBLISH] Failed: ${err.message}`);
            return { success: false, error: mapThreadsError(err.message) };
        } finally {
            if (mediaServer) {
                mediaServer.close();
                mediaServer = null;
            }
            if (tunnelStarted && isTunnelRunning()) {
                threadsLog.info('[CLOUDFLARE] Stopping tunnel after publish...');
                stopTunnel();
            }
        }
    },

    // ══════════════════════════════════════════════════════════════════════════
    // UPLOAD MEDIA
    // ══════════════════════════════════════════════════════════════════════════

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

    async disconnect(account) {
        // Threads doesn't have a logout endpoint, just clear local session
        return { success: true };
    },

    // ══════════════════════════════════════════════════════════════════════════
    // CAPABILITIES
    // ══════════════════════════════════════════════════════════════════════════

    supportsMedia() {
        return true;
    },

    getCapabilities() {
        return {
            text: true,
            images: true,
            video: true,
            maxChars: 500,
        };
    },
};

export default ThreadsService;
