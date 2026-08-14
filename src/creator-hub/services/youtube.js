// src/creator-hub/services/youtube.js
// YouTube Data API service.
// Uses Google OAuth 2.0 and the YouTube Data API v3 for video uploads.
//
// OAuth scopes required:
//   https://www.googleapis.com/auth/youtube.upload
//
// Env vars:
//   YOUTUBE_CLIENT_ID     — Google OAuth client ID
//   YOUTUBE_CLIENT_SECRET — Google OAuth client secret
//   YOUTUBE_REDIRECT_URI  — OAuth redirect URI

import { PlatformService } from './base.js';
import { startOAuthFlow, generateState, generateCodeVerifier, generateCodeChallenge } from '../oauth.js';
import { createLogger } from '../utils/creatorHubLogger.js';
import { translateError, translateNetworkError } from './errorTranslator.js';

const youtubeLog = createLogger('YOUTUBE');

// ── Constants ───────────────────────────────────────────────────────────────

const YOUTUBE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const YOUTUBE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];

const YOUTUBE_UPLOAD_CHUNK_SIZE = 256 * 1024; // 256KB chunks for resumable upload

// ── Environment helpers ─────────────────────────────────────────────────────

function getEnv() {
    return {
        clientId: process.env.YOUTUBE_CLIENT_ID || '',
        clientSecret: process.env.YOUTUBE_CLIENT_SECRET || '',
        redirectUri: process.env.YOUTUBE_REDIRECT_URI || '',
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

async function exchangeCodeForToken(code, codeVerifier, { clientId, clientSecret, redirectUri }) {
    youtubeLog.debug(`[AUTH] Exchanging authorization code for token`);

    const response = await fetch(YOUTUBE_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            client_id: clientId,
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
    youtubeLog.debug(`[AUTH] Token exchange response keys: ${Object.keys(data).join(', ')}`);
    return data;
}

async function refreshAccessToken(refreshToken, { clientId, clientSecret }) {
    const response = await fetch(YOUTUBE_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
        }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Token refresh failed (HTTP ${response.status}): ${text}`);
    }

    return response.json();
}

// ── YouTube API helpers ─────────────────────────────────────────────────────

async function getYouTubeChannel(accessToken) {
    const response = await fetch(
        `${YOUTUBE_API_BASE}/channels?part=id,snippet,contentDetails&mine=true`,
        {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
            },
        }
    );

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to fetch YouTube channel (HTTP ${response.status}): ${text}`);
    }

    const data = await response.json();
    if (data.error) {
        throw new Error(`YouTube API error: ${data.error.message || JSON.stringify(data.error)}`);
    }

    const channel = data.items?.[0];
    if (!channel) {
        throw new Error('No YouTube channel found for this account.');
    }

    return channel;
}

async function initResumableUpload(accessToken, videoPath, title, description, tags, privacyStatus) {
    const fs = await import('fs');
    const stats = await fs.promises.stat(videoPath);
    const fileSize = stats.size;
    const mimeType = await getMimeType(videoPath);

    const metadata = {
        snippet: {
            title: title || 'Untitled Video',
            description: description || '',
            tags: tags || [],
            categoryId: '22', // People & Blogs
        },
        status: {
            privacyStatus: privacyStatus || 'private', // Default to private for safety
            selfDeclaredMadeForKids: false,
        },
    };

    youtubeLog.info(`[PUBLISH] Initializing resumable upload: size=${fileSize}, type=${mimeType}`);

    // Initiate resumable upload session
    const initResponse = await fetch(
        `${YOUTUBE_API_BASE}/videos?uploadType=resumable&part=snippet,status`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json; charset=UTF-8',
                'X-Upload-Content-Type': mimeType,
                'X-Upload-Content-Length': String(fileSize),
            },
            body: JSON.stringify(metadata),
        }
    );

    if (!initResponse.ok) {
        const text = await response.text();
        throw new Error(`Upload init failed (HTTP ${initResponse.status}): ${text}`);
    }

    const uploadUrl = initResponse.headers.get('Location');
    if (!uploadUrl) {
        throw new Error('YouTube did not return an upload URL.');
    }

    youtubeLog.info(`[PUBLISH] Resumable upload session created: ${uploadUrl.slice(0, 80)}...`);
    return { uploadUrl, fileSize, mimeType };
}

async function uploadVideoChunked(uploadUrl, videoPath, fileSize, mimeType) {
    const buffer = await readFileBuffer(videoPath);
    const chunkSize = YOUTUBE_UPLOAD_CHUNK_SIZE;
    const totalChunks = Math.ceil(fileSize / chunkSize);

    youtubeLog.info(`[PUBLISH] Uploading video in ${totalChunks} chunks of ${chunkSize} bytes`);

    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        const start = chunkIndex * chunkSize;
        const end = Math.min(start + chunkSize, fileSize);
        const chunk = buffer.slice(start, end);
        const contentRange = `bytes ${start}-${end - 1}/${fileSize}`;

        youtubeLog.info(`[PUBLISH] Uploading chunk ${chunkIndex + 1}/${totalChunks}: ${contentRange}`);

        const response = await fetch(uploadUrl, {
            method: 'PUT',
            headers: {
                'Content-Type': mimeType,
                'Content-Length': String(chunk.length),
                'Content-Range': contentRange,
            },
            body: chunk,
        });

        if (response.status === 308) {
            // Resume incomplete — continue to next chunk
            const range = response.headers.get('Range');
            youtubeLog.info(`[PUBLISH] Chunk ${chunkIndex + 1} accepted, Range: ${range}`);
            continue;
        }

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Chunk upload failed (HTTP ${response.status}): ${text}`);
        }

        // Upload complete
        const data = await response.json();
        youtubeLog.info(`[PUBLISH] Upload complete: videoId=${data.id}`);
        return data;
    }

    // If we get here, all chunks were sent but we didn't get a final response
    // Check status
    const statusResponse = await fetch(uploadUrl, { method: 'PUT' });
    if (statusResponse.ok) {
        return await statusResponse.json();
    }

    throw new Error('Upload completed but no final response received from YouTube.');
}

async function uploadThumbnail(accessToken, videoId, thumbnailPath) {
    const buffer = await readFileBuffer(thumbnailPath);
    const mimeType = await getMimeType(thumbnailPath);

    youtubeLog.info(`[PUBLISH] Uploading thumbnail for video ${videoId}`);

    const response = await fetch(
        `${YOUTUBE_API_BASE}/thumbnails/set?videoId=${encodeURIComponent(videoId)}`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': mimeType,
            },
            body: buffer,
        }
    );

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Thumbnail upload failed (HTTP ${response.status}): ${text}`);
    }

    const data = await response.json();
    youtubeLog.info(`[PUBLISH] Thumbnail uploaded: ${data.items?.[0]?.default?.url || 'success'}`);
    return data;
}

// ── Error mapping ──────────────────────────────────────────────────────────

function mapYouTubeError(errorMessage) {
    const msg = errorMessage.toLowerCase();

    if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid token') || msg.includes('expired')) {
        return 'YouTube connection expired. Reconnect your account.';
    }
    if (msg.includes('403') || msg.includes('permission')) {
        return 'YouTube permissions are incomplete. Reconnect with upload permissions.';
    }
    if (msg.includes('400') && (msg.includes('video') || msg.includes('file'))) {
        return `Invalid video file. ${errorMessage}`;
    }
    if (msg.includes('rate limit') || msg.includes('too many')) {
        return 'YouTube API rate limit exceeded. Please wait a few minutes and try again.';
    }
    if (msg.includes('quota')) {
        return 'YouTube API quota exceeded. Please wait or request more quota.';
    }

    return `Publish failed: ${errorMessage}`;
}

// ── Service implementation ──────────────────────────────────────────────────

export const YouTubeService = {
    ...PlatformService,

    // ══════════════════════════════════════════════════════════════════════════
    // AUTHENTICATION
    // ══════════════════════════════════════════════════════════════════════════

    async authenticate(params = {}) {
        const env = getEnv();
        if (!env.clientId || !env.clientSecret) {
            youtubeLog.error('[AUTH] Missing YOUTUBE_CLIENT_ID or YOUTUBE_CLIENT_SECRET in environment');
            return {
                success: false,
                error: 'YouTube API credentials not configured. Add YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET to your .env file.',
            };
        }

        if (!env.redirectUri) {
            youtubeLog.error('[AUTH] YOUTUBE_REDIRECT_URI is not set in environment');
            return {
                success: false,
                error: 'YOUTUBE_REDIRECT_URI is not configured. Set it in your .env file.',
            };
        }

        try {
            const state = generateState();
            const codeVerifier = generateCodeVerifier();
            const codeChallenge = await generateCodeChallenge(codeVerifier);

            const authUrl = new URL(YOUTUBE_AUTH_URL);
            authUrl.searchParams.set('client_id', env.clientId);
            authUrl.searchParams.set('redirect_uri', env.redirectUri);
            authUrl.searchParams.set('response_type', 'code');
            authUrl.searchParams.set('scope', YOUTUBE_SCOPES.join(' '));
            authUrl.searchParams.set('state', state);
            authUrl.searchParams.set('code_challenge', codeChallenge);
            authUrl.searchParams.set('code_challenge_method', 'S256');
            authUrl.searchParams.set('access_type', 'offline');
            authUrl.searchParams.set('prompt', 'consent');

            youtubeLog.info('[AUTH] ============================================');
            youtubeLog.info(`[AUTH] Redirect URI: ${env.redirectUri}`);
            youtubeLog.info(`[AUTH] Authorization URL: ${authUrl.toString()}`);
            youtubeLog.info('[AUTH] ============================================');

            const result = await startOAuthFlow({
                authUrl: authUrl.toString(),
                callbackUrl: env.redirectUri,
                timeout: 120000,
            });

            if (!result) {
                return { success: false, error: 'OAuth flow was cancelled' };
            }

            youtubeLog.info('[AUTH] Authorization code received, exchanging for token...');

            const tokenData = await exchangeCodeForToken(result.code, codeVerifier, {
                clientId: env.clientId,
                clientSecret: env.clientSecret,
                redirectUri: env.redirectUri,
            });

            const accessToken = tokenData.access_token;
            const refreshToken = tokenData.refresh_token;
            const expiresIn = tokenData.expires_in || 3600;
            const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

            youtubeLog.info(`[AUTH] Access token obtained`);

            // Get channel info
            const channel = await getYouTubeChannel(accessToken);
            youtubeLog.info(`[AUTH] Found YouTube channel: ${channel.snippet?.title || 'unknown'}`);

            return {
                success: true,
                credentials: {
                    accessToken,
                    refreshToken,
                    expiresAt,
                    channelId: channel.id,
                    channelTitle: channel.snippet?.title,
                },
                username: channel.snippet?.title || 'YouTube Channel',
            };
        } catch (err) {
            youtubeLog.error(`[AUTH] Authentication failed: ${err.message}`);
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
                return { success: false, error: 'YouTube requires an access token.' };
            }

            const channel = await getYouTubeChannel(credentials.accessToken);
            return {
                success: true,
                username: channel.snippet?.title || credentials.username || 'YouTube Channel',
            };
        } catch (err) {
            return { success: false, error: `YouTube connection error: ${err.message}` };
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
                            clientId: env.clientId,
                            clientSecret: env.clientSecret,
                        });
                        accessToken = refreshed.access_token;
                        youtubeLog.info('[CONNECT] Token refreshed successfully');
                    } catch (refreshErr) {
                        youtubeLog.warn(`[CONNECT] Token refresh failed: ${refreshErr.message}`);
                    }
                }
            }

            const channel = await getYouTubeChannel(accessToken);

            if (credentials.expiresAt) {
                const expiresAtDate = new Date(credentials.expiresAt);
                const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);
                if (expiresAtDate < oneHourFromNow) {
                    youtubeLog.warn(`[CONNECT] Token expires soon: ${credentials.expiresAt}`);
                }
            }

            return {
                valid: true,
                username: channel.snippet?.title || credentials.username,
                displayName: channel.snippet?.title,
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

        youtubeLog.debug(`[PUBLISH] Account lookup: id=${account.id}, username=${credentials.username || 'unknown'}`);

        if (!accessToken) {
            return { success: false, error: 'YouTube connection expired. Reconnect.' };
        }

        // Try to refresh token if needed
        if (credentials.expiresAt) {
            const expiresAtDate = new Date(credentials.expiresAt);
            if (expiresAtDate < new Date() && credentials.refreshToken) {
                try {
                    const env = getEnv();
                    const refreshed = await refreshAccessToken(credentials.refreshToken, {
                        clientId: env.clientId,
                        clientSecret: env.clientSecret,
                    });
                    accessToken = refreshed.access_token;
                    youtubeLog.info('[PUBLISH] Token refreshed for publishing');
                } catch (refreshErr) {
                    youtubeLog.warn(`[PUBLISH] Token refresh failed: ${refreshErr.message}`);
                }
            }
        }

        if (!mediaPaths || mediaPaths.length === 0) {
            return { success: false, error: 'YouTube posts require a video file.' };
        }

        const videoPath = mediaPaths[0];
        const path = await import('path');
        const ext = path.extname(videoPath).toLowerCase();
        const isVideo = ['.mp4', '.mov', '.webm'].includes(ext);

        if (!isVideo) {
            return { success: false, error: 'YouTube only supports video files (mp4, mov, webm).' };
        }

        try {
            youtubeLog.info(`[PUBLISH] Publishing video: ${videoPath}`);

            // Parse title from text (first line) or use default
            const lines = text.split('\n').filter(l => l.trim());
            const title = lines[0]?.slice(0, 100) || 'Untitled Video';
            const description = text || '';

            // Step 1: Initiate resumable upload
            const { uploadUrl, fileSize, mimeType } = await initResumableUpload(
                accessToken, videoPath, title, description, post.tags, null
            );

            // Step 2: Upload video in chunks
            const videoData = await uploadVideoChunked(uploadUrl, videoPath, fileSize, mimeType);
            const videoId = videoData.id;

            youtubeLog.info(`[PUBLISH] Video uploaded: videoId=${videoId}`);

            // Step 3: Upload thumbnail if available (first image in media)
            if (post.media && post.media.length > 1) {
                const firstImage = post.media.find(m => m.type && m.type.startsWith('image/'));
                if (firstImage && firstImage.path) {
                    try {
                        await uploadThumbnail(accessToken, videoId, firstImage.path);
                    } catch (thumbErr) {
                        youtubeLog.warn(`[PUBLISH] Thumbnail upload failed: ${thumbErr.message}`);
                    }
                }
            }

            return {
                success: true,
                postId: videoId,
                externalUrl: `https://www.youtube.com/watch?v=${videoId}`,
            };
        } catch (err) {
            youtubeLog.error(`[PUBLISH] Failed: ${err.message}`);
            return { success: false, error: mapYouTubeError(err.message) };
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
        // YouTube doesn't have a logout endpoint, just clear local session
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
            maxChars: 5000,
        };
    },
};

export default YouTubeService;
