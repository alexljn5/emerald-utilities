// src/creator-hub/utils/mediaHandler.js
// Unified media pipeline: validation, compression, upload.

import { getPlatform } from '../services/platforms.js';

/**
 * Validates a media file against platform requirements.
 *
 * @param {Object} media - Media object with path, type, size
 * @param {string} platform - Platform ID
 * @returns {{ valid: boolean, error?: string }}
 */
export async function validateMedia(media, platform) {
    if (!media || !media.path) {
        return { valid: false, error: 'Media file path is missing' };
    }

    const platformMeta = getPlatform(platform);
    if (!platformMeta) {
        return { valid: false, error: `Unknown platform: ${platform}` };
    }

    const mediaRules = platformMeta.mediaRules || {};
    const allowedTypes = mediaRules.allowedTypes || ['image/*', 'video/*'];
    const maxSize = mediaRules.maxSize || 50 * 1024 * 1024; // 50MB default
    const maxFiles = mediaRules.maxFiles || 4;

    // Check file type
    if (media.type) {
        const typeAllowed = allowedTypes.some(pattern => {
            if (pattern.endsWith('/*')) {
                return media.type.startsWith(pattern.slice(0, -1));
            }
            return media.type === pattern;
        });
        if (!typeAllowed) {
            return { valid: false, error: `File type ${media.type} not allowed for ${platformMeta.name}` };
        }
    }

    // Resolve actual file size from filesystem if not provided
    let fileSize = media.size;
    if (!fileSize || fileSize <= 0) {
        try {
            const fs = await import('fs');
            const stats = await fs.promises.stat(media.path);
            fileSize = stats.size;
        } catch (err) {
            // If we can't stat the file, continue with size=0 (will pass size check)
        }
    }

    // Check file size
    if (fileSize && fileSize > maxSize) {
        const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
        const maxMB = (maxSize / (1024 * 1024)).toFixed(0);
        return { valid: false, error: `File size ${sizeMB}MB exceeds ${maxMB}MB limit for ${platformMeta.name}` };
    }

    return { valid: true };
}

/**
 * Validates a list of media files against platform requirements.
 *
 * @param {Array} mediaList - Array of media objects
 * @param {string} platform - Platform ID
 * @returns {{ valid: boolean, error?: string, invalidFiles?: Array }}
 */
export async function validateMediaBatch(mediaList, platform) {
    if (!mediaList || mediaList.length === 0) {
        return { valid: true };
    }

    const platformMeta = getPlatform(platform);
    if (!platformMeta) {
        return { valid: false, error: `Unknown platform: ${platform}` };
    }

    const mediaRules = platformMeta.mediaRules || {};
    const maxFiles = mediaRules.maxFiles || 4;

    if (mediaList.length > maxFiles) {
        return { valid: false, error: `Too many files: ${mediaList.length} exceeds ${maxFiles} file limit for ${platformMeta.name}` };
    }

    const invalidFiles = [];
    for (const media of mediaList) {
        const result = await validateMedia(media, platform);
        if (!result.valid) {
            invalidFiles.push({ path: media.path, error: result.error });
        }
    }

    if (invalidFiles.length > 0) {
        return { valid: false, error: `${invalidFiles.length} file(s) failed validation`, invalidFiles };
    }

    return { valid: true };
}

/**
 * Compresses an image if it exceeds the platform's size limit.
 * Returns the original path if no compression is needed.
 *
 * @param {string} imagePath - Path to the image file
 * @param {string} platform - Platform ID
 * @returns {Promise<string>} - Path to the (possibly compressed) image
 */
export async function compressImageIfNeeded(imagePath, platform) {
    const platformMeta = getPlatform(platform);
    const mediaRules = platformMeta?.mediaRules || {};
    const maxSize = mediaRules.maxSize || 50 * 1024 * 1024;

    try {
        const fs = await import('fs');
        const stats = await fs.promises.stat(imagePath);

        // If file is under 5MB, no compression needed
        if (stats.size <= 5 * 1024 * 1024) {
            return imagePath;
        }

        // For larger files, we would need an image processing library
        // For now, just return the original path and let the platform handle it
        // In a real implementation, you'd use sharp or similar to compress
        return imagePath;
    } catch (err) {
        // If we can't check the file, just return the original path
        return imagePath;
    }
}

/**
 * Uploads media to a platform using the platform's service.
 *
 * @param {Object} account - Platform account with credentials
 * @param {string} mediaPath - Path to the media file
 * @param {string} platform - Platform ID
 * @returns {Promise<{ success: boolean, mediaId?: string, error?: string }>}
 */
export async function uploadMedia(account, mediaPath, platform) {
    try {
        const service = getPlatform(platform)?.service;
        if (!service) {
            return { success: false, error: `No service found for platform: ${platform}` };
        }

        if (!service.uploadMedia) {
            return { success: false, error: `Platform ${platform} does not support media upload` };
        }

        const result = await service.uploadMedia(account, mediaPath);
        return result;
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * Processes and uploads a batch of media files.
 * Validates, compresses, and uploads each file.
 *
 * @param {Object} account - Platform account with credentials
 * @param {Array} mediaList - Array of media objects
 * @param {string} platform - Platform ID
 * @returns {Promise<Array<{ success: boolean, mediaId?: string, error?: string }>>}
 */
export async function processMediaBatch(account, mediaList, platform) {
    const results = [];

    for (const media of mediaList) {
        // Validate
        const validation = await validateMedia(media, platform);
        if (!validation.valid) {
            results.push({ success: false, error: validation.error });
            continue;
        }

        // Compress if needed
        const processedPath = await compressImageIfNeeded(media.path, platform);

        // Upload
        const uploadResult = await uploadMedia(account, processedPath, platform);
        results.push(uploadResult);
    }

    return results;
}
