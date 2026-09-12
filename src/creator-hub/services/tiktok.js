// src/creator-hub/services/tiktok.js
// TikTok Content Posting API service.
// Uses OAuth 2.0 PKCE and the TikTok Content Posting API.
//
// OAuth scopes required:
//   video.publish, video.upload
//
// Env vars:
//   TIKTOK_CLIENT_KEY        — TikTok app client key
//   TIKTOK_CLIENT_SECRET     — TikTok app client secret
//   TIKTOK_REDIRECT_URI      — OAuth redirect URI

import { PlatformService } from './base.js';
import { startOAuthFlow, generateState, generateCodeVerifier, generateCodeChallenge } from '../oauth.js';
import { createLogger } from '../utils/creatorHubLogger.js';
import { translateError, translateNetworkError } from './errorTranslator.js';

const tiktokLog = createLogger('TIKTOK');

// ── Constants ───────────────────────────────────────────────────────────────

const TIKTOK_AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const TIKTOK_API_BASE = 'https://open.tiktokapis.com/v2';

const TIKTOK_SCOPES = ['video.publish', 'video.upload'];

const TIKTOK_POLL_INTERVAL_MS = parseInt(
    process.env.TIKTOK_POLL_INTERVAL_MS || '3000',
    10
);

const TIKTOK_POLL_TIMEOUT_MS = parseInt(
    process.env.TIKTOK_POLL_TIMEOUT_MS || '120000',
    10
);

// ── Environment helpers ─────────────────────────────────────────────────────

function getEnv() {
    return {
        clientKey: process.env.TIKTOK_CLIENT_KEY || '',
        clientSecret: process.env.TIKTOK_CLIENT_SECRET || '',
        redirectUri: process.env.TIKTOK_REDIRECT_URI || '',
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

async function readFileBuffer(filePath) {
    const fs = await import('fs');
    return fs.readFileSync(filePath);
}

// ── OAuth helpers ───────────────────────────────────────────────────────────

async function exchangeCodeForToken(code, codeVerifier, { clientKey, clientSecret, redirectUri }) {
    tiktokLog.debug(`[AUTH] Exchanging authorization code for token`);

    const response = await fetch(TIKTOK_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cache-Control': 'no-cache',
        },
        body: new URLSearchParams({
            client_key: clientKey,
            client_secret: clientSecret,
            code,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
        }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Token exchange failed (HTTP ${response.status}): ${text}`);
    }

    const data = await response.json();
    tiktokLog.debug(`[AUTH] Token exchange response keys: ${Object.keys(data).join(', ')}`);
    return data;
}

async function refreshAccessToken(refreshToken, { clientKey, clientSecret }) {
    const response = await fetch(TIKTOK_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cache-Control': 'no-cache',
        },
        body: new URLSearchParams({
            client_key: clientKey,
            client_secret: clientSecret,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
        }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Token refresh failed (HTTP ${response.status}): ${text}`);
    }

    return response.json();
}

// ── TikTok API helpers ──────────────────────────────────────────────────────

async function getTikTokUserInfo(accessToken) {
    const response = await fetch(`${TIKTOK_API_BASE}/user/info/`, {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json; charset=UTF-8',
        },
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to fetch TikTok user info (HTTP ${response.status}): ${text}`);
    }

    const data = await response.json();
    if (data.error) {
        throw new Error(`TikTok API error: ${data.error.message || JSON.stringify(data.error)}`);
    }

    return data.data?.user || {};
}

async function initVideoUpload(accessToken, videoPath, title, description) {
    const fs = await import('fs');
    const stats = await fs.promises.stat(videoPath);
    const fileSize = stats.size;

    const mimeType = await getMimeType(videoPath);

    const body = {
        source: "FILE_UPLOAD",
        video_filename: videoPath.split(/[\\/]/).pop() || 'video.mp4',
        file_size: fileSize,
        file_type: mimeType,
        title: title || '',
        description: description || '',
        privacy_level: "SELF_ONLY", // Default to private; user can change in TikTok app
    };

    tiktokLog.info(`[PUBLISH] Initializing video upload: size=${fileSize}, type=${mimeType}`);

    const response = await fetch(`${TIKTOK_API_BASE}/post/publish/video/init/`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Video upload init failed (HTTP ${response.status}): ${text}`);
    }

    const data = await response.json();
    if (data.error) {
        throw new Error(`TikTok API error: ${data.error.message || JSON.stringify(data.error)}`);
    }

    tiktokLog.info(`[PUBLISH] Upload initialized: publishId=${data.data?.publish_id}`);
    return data.data;
}

async function uploadVideoToTikTok(uploadUrl, videoPath) {
    const buffer = await readFileBuffer(videoPath);
    const mimeType = await getMimeType(videoPath);

    tiktokLog.info(`[PUBLISH] Uploading video to TikTok CDN: ${videoPath}`);

    const response = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
            'Content-Type': mimeType,
            'Content-Length': String(buffer.length),
        },
        body: buffer,
    });

    if (!response.ok) {
        throw new Error(`Video upload to TikTok CDN failed (HTTP ${response.status})`);
    }

    tiktokLog.info(`[PUBLISH] Video uploaded successfully to TikTok CDN`);
    return true;
}

async function checkUploadStatus(accessToken, publishId) {
    const response = await fetch(
        `${TIKTOK_API_BASE}/post/publish/status/?publish_id=${encodeURIComponent(publishId)}`,
        {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json; charset=UTF-8',
            },
        }
    );

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Status check failed (HTTP ${response.status}): ${text}`);
    }

    const data = await response.json();
    if (data.error) {
        throw new Error(`TikTok API error: ${data.error.message || JSON.stringify(data.error)}`);
    }

    return data.data;
}

async function waitForUploadComplete(accessToken, publishId) {
    const timeoutMs = TIKTOK_POLL_TIMEOUT_MS;
    const intervalMs = TIKTOK_POLL_INTERVAL_MS;
    const maxAttempts = Math.ceil(timeoutMs / intervalMs);

    tiktokLog.info(
        `[PUBLISH] Waiting for TikTok upload to complete ` +
        `(poll every ${intervalMs}ms, timeout ${timeoutMs}ms)`
    );

    for (let i = 0; i < maxAttempts; i++) {
        const status = await checkUploadStatus(accessToken, publishId);
        tiktokLog.info(`[PUBLISH] Upload status: ${status.status}`);

        if (status.status === 'PUBLISH_COMPLETE') {
            tiktokLog.info(`[PUBLISH] Upload complete: ${status.status}`);
            return status;
        }
        if (status.status === 'FAILED') {
            const failReason = status.fail_reason || status.error || 'Unknown error';
            throw new Error(`TikTok upload failed: ${failReason}`);
        }

        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    throw new Error(
        `TikTok upload did not complete within ${timeoutMs}ms (${maxAttempts} polls)`
    );
}

// ── Error mapping ──────────────────────────────────────────────────────────

function mapTikTokError(errorMessage) {
    const msg = errorMessage.toLowerCase();

    if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid token') || msg.includes('expired')) {
        return 'TikTok connection expired. Reconnect your account.';
    }
    if (msg.includes('403') || msg.includes('permission')) {
        return 'TikTok permissions are incomplete. Reconnect with video.publish and video.upload permissions.';
    }
    if (msg.includes('400') && (msg.includes('video') || msg.includes('file'))) {
        return `Invalid video file. ${errorMessage}`;
    }
    if (msg.includes('rate limit') || msg.includes('too many')) {
        return 'TikTok API rate limit exceeded. Please wait a few minutes and try again.';
    }
    if (msg.includes('file too large') || msg.includes('size')) {
        return 'Video file is too large for TikTok. Maximum size is 100MB.';
    }

    return `Publish failed: ${errorMessage}`;
}

// ── Service implementation ──────────────────────────────────────────────────

export const TikTokService = {
    ...PlatformService,

    // ══════════════════════════════════════════════════════════════════════════
    // AUTHENTICATION
    // ══════════════════════════════════════════════════════════════════════════

    async authenticate(params = {}) {
        const env = getEnv();
        if (!env.clientKey || !env.clientSecret) {
            tiktokLog.error('[AUTH] Missing TIKTOK_CLIENT_KEY or TIKTOK_CLIENT_SECRET in environment');
            return {
                success: false,
                error: 'TikTok API credentials not configured. Add TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET to your .env file.',
            };
        }

        if (!env.redirectUri) {
            tiktokLog.error('[AUTH] TIKTOK_REDIRECT_URI is not set in environment');
            return {
                success: false,
                error: 'TIKTOK_REDIRECT_URI is not configured. Set it in your .env file.',
            };
        }

        try {
            const state = generateState();
            const codeVerifier = generateCodeVerifier();
            const codeChallenge = await generateCodeChallenge(codeVerifier);

            const authUrl = new URL(TIKTOK_AUTH_URL);
            authUrl.searchParams.set('client_key', env.clientKey);
            authUrl.searchParams.set('redirect_uri', env.redirectUri);
            authUrl.searchParams.set('response_type', 'code');
            authUrl.searchParams.set('scope', TIKTOK_SCOPES.join(' '));
            authUrl.searchParams.set('state', state);
            authUrl.searchParams.set('code_challenge', codeChallenge);
            authUrl.searchParams.set('code_challenge_method', 'S256');

            tiktokLog.info('[AUTH] ============================================');
            tiktokLog.info(`[AUTH] Redirect URI: ${env.redirectUri}`);
            tiktokLog.info(`[AUTH] Authorization URL: ${authUrl.toString()}`);
            tiktokLog.info('[AUTH] ============================================');

            const result = await startOAuthFlow({
                authUrl: authUrl.toString(),
                callbackUrl: env.redirectUri,
                timeout: 120000,
            });

            if (!result) {
                return { success: false, error: 'OAuth flow was cancelled' };
            }

            tiktokLog.info('[AUTH] Authorization code received, exchanging for token...');

            const tokenData = await exchangeCodeForToken(result.code, codeVerifier, {
                clientKey: env.clientKey,
                clientSecret: env.clientSecret,
                redirectUri: env.redirectUri,
            });

            const accessToken = tokenData.access_token;
            const refreshToken = tokenData.refresh_token;
            const expiresIn = tokenData.expires_in || 86400; // 24 hours default
            const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

            tiktokLog.info(`[AUTH] Access token obtained`);

            // Get user info
            const userInfo = await getTikTokUserInfo(accessToken);
            tiktokLog.info(`[AUTH] Found TikTok account: @${userInfo.username || 'unknown'}`);

            return {
                success: true,
                credentials: {
                    accessToken,
                    refreshToken,
                    expiresAt,
                    openId: tokenData.open_id,
                },
                username: userInfo.username || 'tiktok_user',
            };
        } catch (err) {
            tiktokLog.error(`[AUTH] Authentication failed: ${err.message}`);
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
                return { success: false, error: 'TikTok requires an access token.' };
            }

            const userInfo = await getTikTokUserInfo(credentials.accessToken);
            return {
                success: true,
                username: userInfo.username || credentials.username || 'tiktok_user',
            };
        } catch (err) {
            return { success: false, error: `TikTok connection error: ${err.message}` };
        }
    },

    // ══════════════════════════════════════════════════════════════════════════
    // TEST CONNECTION
    // ══════════════════════════════════════════════════════════════════════════

    async testConnection(account) {
        try {
            const credentials = account.credentials || {};
            let accessToken = credentials.accessToken;

            if (!accessToken) {
                return { valid: false, error: 'No access token stored. Reconnect account.' };
            }

            // Try to refresh if expired
            if (credentials.expiresAt) {
                const expiresAtDate = new Date(credentials.expiresAt);
                if (expiresAtDate < new Date() && credentials.refreshToken) {
                    try {
                        const env = getEnv();
                        const refreshed = await refreshAccessToken(credentials.refreshToken, {
                            clientKey: env.clientKey,
                            clientSecret: env.clientSecret,
                        });
                        accessToken = refreshed.access_token;
                        tiktokLog.info('[CONNECT] Token refreshed successfully');
                    } catch (refreshErr) {
                        tiktokLog.warn(`[CONNECT] Token refresh failed: ${refreshErr.message}`);
                    }
                }
            }

            const userInfo = await getTikTokUserInfo(accessToken);

            if (credentials.expiresAt) {
                const expiresAtDate = new Date(credentials.expiresAt);
                const oneDayFromNow = new Date(Date.now() + 24 * 60 * 60 * 1000);
                if (expiresAtDate < oneDayFromNow) {
                    tiktokLog.warn(`[CONNECT] Token expires soon: ${credentials.expiresAt}`);
                }
            }

            return {
                valid: true,
                username: userInfo.username || credentials.username,
                displayName: userInfo.display_name || userInfo.username,
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
        let accessToken = credentials.accessToken;

        tiktokLog.debug(`[PUBLISH] Account lookup: id=${account.id}, username=${credentials.username || 'unknown'}`);

        if (!accessToken) {
            return { success: false, error: 'TikTok connection expired. Reconnect.' };
        }

        // Try to refresh token if needed
        if (credentials.expiresAt) {
            const expiresAtDate = new Date(credentials.expiresAt);
            if (expiresAtDate < new Date() && credentials.refreshToken) {
                try {
                    const env = getEnv();
                    const refreshed = await refreshAccessToken(credentials.refreshToken, {
                        clientKey: env.clientKey,
                        clientSecret: env.clientSecret,
                    });
                    accessToken = refreshed.access_token;
                    tiktokLog.info('[PUBLISH] Token refreshed for publishing');
                } catch (refreshErr) {
                    tiktokLog.warn(`[PUBLISH] Token refresh failed: ${refreshErr.message}`);
                }
            }
        }

        if (!mediaPaths || mediaPaths.length === 0) {
            return { success: false, error: 'TikTok posts require a video file.' };
        }

        const videoPath = mediaPaths[0];
        const path = await import('path');
        const ext = path.extname(videoPath).toLowerCase();
        const isVideo = ['.mp4', '.mov', '.webm'].includes(ext);

        if (!isVideo) {
            return { success: false, error: 'TikTok only supports video files (mp4, mov, webm).' };
        }

        try {
            tiktokLog.info(`[PUBLISH] Publishing video: ${videoPath}`);

            // Step 1: Initialize upload
            const uploadInit = await initVideoUpload(accessToken, videoPath, null, text);
            const publishId = uploadInit.publish_id;
            const uploadUrl = uploadInit.upload_url;

            if (!publishId || !uploadUrl) {
                return { success: false, error: 'TikTok did not return upload URL or publish ID.' };
            }

            // Step 2: Upload video to TikTok CDN
            await uploadVideoToTikTok(uploadUrl, videoPath);

            // Step 3: Wait for processing/upload to complete
            const finalStatus = await waitForUploadComplete(accessToken, publishId);
            tiktokLog.info(`[PUBLISH] TikTok upload complete: status=${finalStatus.status}`);

            if (finalStatus.status === 'PUBLISH_COMPLETE') {
                return {
                    success: true,
                    postId: publishId,
                };
            } else {
                return {
                    success: false,
                    error: `TikTok upload ended with status: ${finalStatus.status}`,
                };
            }
        } catch (err) {
            tiktokLog.error(`[PUBLISH] Failed: ${err.message}`);
            return { success: false, error: mapTikTokError(err.message) };
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
        // TikTok doesn't have a logout endpoint, just clear local session
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
            images: false,
            video: true,
            maxChars: 2200,
        };
    },
};

export default TikTokService;
