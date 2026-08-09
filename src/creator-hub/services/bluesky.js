// src/creator-hub/services/bluesky.js
// Bluesky (AT Protocol) platform service.
// Implements the PlatformService interface.

import { PlatformService } from './base.js';
import { translateError, translateNetworkError } from './errorTranslator.js';
import { createLogger } from '../utils/creatorHubLogger.js';
import { invoke } from '../../utils/electronApi.js';

const blueskyLog = createLogger('BLUESKY');

const BSKY_API = 'https://bsky.social/xrpc';

/**
 * Create a session with Bluesky.
 * @param {string} identifier - Bluesky handle or DID
 * @param {string} password - App password
 * @returns {Promise<{ did: string, handle: string, accessJwt: string, refreshJwt: string }>}
 */
async function createSession(identifier, password) {
    blueskyLog.info('Creating session...');
    const response = await fetch(`${BSKY_API}/com.atproto.server.createSession`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            identifier,
            password
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    return response.json();
}

/**
 * Get MIME type from file extension.
 * @param {string} filePath
 * @returns {string}
 */
function getMimeType(filePath) {
    // Extract extension without importing 'path' (not available in renderer)
    const lastDot = filePath.lastIndexOf('.');
    const ext = lastDot >= 0 ? filePath.slice(lastDot).toLowerCase() : '';
    const mimeTypes = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime',
        '.avi': 'video/x-msvideo'
    };
    return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Read a file and return its contents as a Uint8Array.
 * Works in both main process (Node.js fs) and renderer process (IPC).
 *
 * @param {string} filePath - Absolute path to the file
 * @returns {Promise<Uint8Array>}
 */
async function readFileAsUint8Array(filePath) {
    try {
        // Main process: use Node.js fs directly
        const fs = await import('fs');
        const data = fs.readFileSync(filePath);
        return new Uint8Array(data);
    } catch (err) {
        // Renderer process: read via IPC (fallback)
        const result = await invoke('creator-hub:read-file', { filePath });
        if (!result.ok) {
            throw new Error(result.error || `Failed to read file: ${filePath}`);
        }
        const binaryString = atob(result.data);
        const buffer = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            buffer[i] = binaryString.charCodeAt(i);
        }
        return buffer;
    }
}

/**
 * Upload a blob (image) to Bluesky.
 * Sends raw binary with the correct Content-Type header.
 * The AT Protocol expects the raw file bytes in the request body,
 * NOT multipart/form-data.
 *
 * @param {string} accessJwt
 * @param {string} filePath - Filesystem path to the image file
 * @returns {Promise<{ blob: { ref: { link: string }, mimeType: string, size: number } }>}
 */
async function uploadBlob(accessJwt, filePath) {
    blueskyLog.info('Uploading image...');

    // Read file - works in both main process (fs) and renderer (IPC)
    const fileBuffer = await readFileAsUint8Array(filePath);

    const mimeType = getMimeType(filePath);

    // AT Protocol expects raw binary in request body, not FormData
    // Using FormData strips the Authorization header in some environments
    const response = await fetch(`${BSKY_API}/com.atproto.repo.uploadBlob`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessJwt}`,
            'Content-Type': mimeType
        },
        body: fileBuffer
    });

    if (!response.ok) {
        const errorText = await response.text();
        blueskyLog.error('Image upload failed');
        throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const blobResult = await response.json();

    blueskyLog.info(`Blob uploaded
    mime=${blobResult.blob.mimeType}
    size=${blobResult.blob.size}
    cid=${blobResult.blob.ref.link}`);

    return blobResult;
}

/**
 * Create a post record on Bluesky.
 * @param {string} accessJwt
 * @param {string} did
 * @param {string} text
 * @param {Array} [embeds] - Array of blob objects (full blob from uploadBlob response)
 * @returns {Promise<string>} - The URI of the created record
 */
async function createPost(accessJwt, did, text, embeds = []) {
    const now = new Date().toISOString();

    blueskyLog.info(`Creating embed
    images=${embeds.length}`);

    const record = {
        text,
        createdAt: now,
        $type: 'app.bsky.feed.post'
    };

    if (embeds.length > 0) {
        // Use the FULL blob object returned by uploadBlob, not just the ref
        record.embed = {
            $type: 'app.bsky.embed.images',
            images: embeds.map(e => ({
                alt: e.alt || 'Uploaded image',
                image: e.blob
            }))
        };
    }

    blueskyLog.info('Publishing post...');

    const response = await fetch(`${BSKY_API}/com.atproto.repo.createRecord`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessJwt}`
        },
        body: JSON.stringify({
            repo: did,
            collection: 'app.bsky.feed.post',
            record
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    return data.uri;
}

/**
 * Get profile information.
 * @param {string} accessJwt
 * @param {string} actor - Handle or DID
 * @returns {Promise<{ did: string, handle: string }>}
 */
async function getProfile(accessJwt, actor) {
    const response = await fetch(`${BSKY_API}/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`, {
        headers: {
            'Authorization': `Bearer ${accessJwt}`
        }
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    return {
        did: data.did,
        handle: data.handle
    };
}

export const BlueskyService = {
    /**
     * Connect to Bluesky with credentials.
     * @param {{ identifier: string, password: string }} credentials
     * @returns {{ success: boolean, error?: string, username?: string, did?: string, accessJwt?: string, refreshJwt?: string }}
     */
    async connect(credentials) {
        try {
            if (!credentials.identifier || !credentials.password) {
                return { success: false, error: 'Identifier and password are required' };
            }

            const session = await createSession(credentials.identifier, credentials.password);
            return {
                success: true,
                username: session.handle,
                did: session.did,
                accessJwt: session.accessJwt,
                refreshJwt: session.refreshJwt
            };
        } catch (err) {
            const statusMatch = err.message.match(/HTTP (\d+)/);
            const statusCode = statusMatch ? statusMatch[1] : null;
            if (statusCode) {
                const translated = translateError(statusCode, err.message);
                return { success: false, error: translated.message };
            }
            const networkError = translateNetworkError(err.message);
            return { success: false, error: networkError.message };
        }
    },

    /**
     * Test if the Bluesky connection is still valid.
     * @param {{ credentials: { identifier: string, password: string, accessJwt?: string, did?: string, handle?: string } }} account
     * @returns {{ valid: boolean, error?: string, username?: string, displayName?: string }}
     */
    async testConnection(account) {
        try {
            const credentials = account.credentials || {};
            let accessJwt = credentials.accessJwt;
            let did = credentials.did;
            let handle = credentials.handle;

            // If we don't have a session, create one
            if (!accessJwt || !did) {
                if (!credentials.identifier || !credentials.password) {
                    return { valid: false, error: 'Missing credentials' };
                }
                const session = await createSession(credentials.identifier, credentials.password);
                accessJwt = session.accessJwt;
                did = session.did;
                handle = session.handle;
            }

            // Verify by getting profile
            const profile = await getProfile(accessJwt, did || handle);
            return {
                valid: true,
                username: profile.handle,
                displayName: profile.handle
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

    /**
     * Publish a post to Bluesky.
     * @param {{ credentials: { identifier: string, password: string, accessJwt?: string, did?: string, handle?: string } }} account
     * @param {import('../models.js').Post} post
     * @param {string} text
     * @param {string[]} [mediaPaths]
     * @returns {{ success: boolean, postId?: string, error?: string }}
     */
    async publish(account, post, text, mediaPaths = []) {
        try {
            const credentials = account.credentials || {};
            let accessJwt = credentials.accessJwt;
            let did = credentials.did;

            blueskyLog.info(`publish called: account=${account.id}, platform=${account.platform}, textLength=${text?.length || 0}, mediaPaths=${JSON.stringify(mediaPaths)}`);

            // If we don't have a session, create one
            if (!accessJwt || !did) {
                blueskyLog.warn('No accessJwt/did, creating session...');
                if (!credentials.identifier || !credentials.password) {
                    blueskyLog.error('Missing credentials for session creation');
                    return { success: false, error: 'Missing credentials' };
                }
                const session = await createSession(credentials.identifier, credentials.password);
                accessJwt = session.accessJwt;
                did = session.did;
                blueskyLog.info(`Session created: did=${did}`);
            }

            // Upload images if provided
            const embeds = [];
            if (mediaPaths.length > 0) {
                blueskyLog.info(`Uploading ${mediaPaths.length} images...`);
                for (const mediaPath of mediaPaths) {
                    try {
                        blueskyLog.info(`[MEDIA] Uploading: path=${mediaPath}`);
                        const blobResult = await uploadBlob(accessJwt, mediaPath);
                        blueskyLog.info(`[MEDIA] Blob uploaded: cid=${blobResult.blob.ref.link}`);
                        embeds.push({
                            blob: blobResult.blob,
                            mimeType: blobResult.blob.mimeType,
                            size: blobResult.blob.size
                        });
                    } catch (uploadErr) {
                        blueskyLog.error(`[MEDIA] Upload failed: ${uploadErr.message}`);
                        // Continue with other images even if one fails
                    }
                }
                blueskyLog.info(`Uploaded ${embeds.length}/${mediaPaths.length} images successfully`);
            }

            // Create the post
            blueskyLog.info(`[BLUESKY] Creating post: textLength=${text?.length || 0}, images=${embeds.length}`);
            const uri = await createPost(accessJwt, did, text, embeds);
            blueskyLog.info(`[BLUESKY] Published: uri=${uri}`);

            // Extract the post ID from the URI (format: at://did/app.bsky.feed.post/rkey)
            const rkey = uri.split('/').pop();
            const postUrl = `https://bsky.app/profile/${credentials.handle || did}/post/${rkey}`;

            return {
                success: true,
                postId: rkey,
                externalUrl: postUrl
            };
        } catch (err) {
            blueskyLog.error(`Publish failed: ${err.message}`);
            const statusMatch = err.message.match(/HTTP (\d+)/);
            const statusCode = statusMatch ? statusMatch[1] : null;
            if (statusCode) {
                const translated = translateError(statusCode, err.message);
                return { success: false, error: translated.message };
            }
            const networkError = translateNetworkError(err.message);
            return { success: false, error: networkError.message };
        }
    },

    /**
     * Upload a single media file.
     * Called by processMediaBatch in the publisher.
     * @param {Object} account
     * @param {string} mediaPath
     * @returns {{ success: boolean, mediaId?: string, error?: string }}
     */
    async uploadMedia(account, mediaPath) {
        try {
            const credentials = account.credentials || {};
            let accessJwt = credentials.accessJwt;

            if (!accessJwt) {
                if (!credentials.identifier || !credentials.password) {
                    return { success: false, error: 'Missing credentials' };
                }
                const session = await createSession(credentials.identifier, credentials.password);
                accessJwt = session.accessJwt;
            }

            blueskyLog.info(`[MEDIA] Uploading: path=${mediaPath}`);
            const blobResult = await uploadBlob(accessJwt, mediaPath);
            blueskyLog.info(`[MEDIA] Blob uploaded: cid=${blobResult.blob.ref.link}`);

            return {
                success: true,
                mediaId: blobResult.blob.ref.link
            };
        } catch (err) {
            blueskyLog.error(`[MEDIA] Upload failed: ${err.message}`);
            return { success: false, error: err.message };
        }
    },

    /**
     * Disconnect from Bluesky.
     * @param {{ credentials: { identifier: string, password: string } }} account
     * @returns {{ success: boolean, error?: string }}
     */
    async disconnect(account) {
        // Bluesky doesn't have a logout endpoint, just clear local session
        return { success: true };
    },

    /**
     * Whether this platform supports media uploads.
     * @returns {boolean}
     */
    supportsMedia() {
        return true;
    },

    /**
     * Get platform capabilities.
     * @returns {{ text: boolean, images: boolean, video: boolean, maxChars: number }}
     */
    getCapabilities() {
        return {
            text: true,
            images: true,
            video: false,
            maxChars: 300
        };
    }
};

export default BlueskyService;
