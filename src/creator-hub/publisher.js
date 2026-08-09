// src/creator-hub/publisher.js
// Simple publish orchestrator.
// Publishes a post to multiple platforms, continuing on failure.

import { getPlatformService, getPlatform } from './services/platforms.js';
import { getAccountById, updateAccountStatus, decryptCredentials, addPublishHistoryEntry, getPostById, loadPublishHistory } from './storage.js';
import { ACCOUNT_STATUS } from '../globals.js';
import { createPublishSummary } from './models.js';
import { translateError, translateNetworkError } from './services/errorTranslator.js';
import { processMediaBatch } from './utils/mediaHandler.js';
import { publisherLog } from './utils/creatorHubLogger.js';

/**
 * Validates a publish request before attempting to publish.
 * Checks account status, content validity, and media requirements.
 *
 * @param {import('./models.js').PlatformAccount} account
 * @param {import('./models.js').Post} post
 * @param {string} text - The text to publish (may be platform override)
 * @returns {{ valid: boolean, error?: string }}
 */
export function validatePublishRequest(account, post, text) {
    // Check account is connected
    if (account.status !== ACCOUNT_STATUS.CONNECTED) {
        return { valid: false, error: `Account is ${account.status}` };
    }

    // Check text is not empty
    if (!text || text.trim().length === 0) {
        return { valid: false, error: 'Post text is empty' };
    }

    // Get platform capabilities
    const platformMeta = getPlatform(account.platform);
    const capabilities = account.capabilities || platformMeta?.capabilities || { text: true, images: false, video: false, maxChars: 0 };

    // Check text capability
    if (!capabilities.text) {
        return { valid: false, error: 'Platform does not support text posts' };
    }

    // Check character limit
    if (capabilities.maxChars > 0 && text.length > capabilities.maxChars) {
        return { valid: false, error: `Text exceeds ${capabilities.maxChars} character limit (${text.length} chars)` };
    }

    // Check media requirements
    const hasMedia = post.media && post.media.length > 0;
    const service = getPlatformService(account.platform);
    const supportsMedia = service.supportsMedia();

    if (hasMedia && !supportsMedia) {
        return { valid: false, error: 'Platform does not support media attachments' };
    }

    // Check image/video capabilities
    if (hasMedia) {
        const hasImages = post.media.some(m => m.type && m.type.startsWith('image/'));
        const hasVideo = post.media.some(m => m.type && m.type.startsWith('video/'));

        if (hasImages && !capabilities.images) {
            return { valid: false, error: 'Platform does not support image attachments' };
        }
        if (hasVideo && !capabilities.video) {
            return { valid: false, error: 'Platform does not support video attachments' };
        }
    }

    return { valid: true };
}

/**
 * Gets the effective text for a target, using override if available.
 * @param {import('./models.js').Post} post
 * @param {import('./models.js').PostTarget} target
 * @returns {string}
 */
export function getTargetText(post, target) {
    return target.override?.message || post.message;
}

/**
 * Gets the effective media for a target, using override if available.
 * @param {import('./models.js').Post} post
 * @param {import('./models.js').PostTarget} target
 * @returns {string[]}
 */
export function getTargetMedia(post, target) {
    return target.override?.media || post.media;
}

/**
 * Gets the effective tags for a target, using override if available.
 * @param {import('./models.js').Post} post
 * @param {import('./models.js').PostTarget} target
 * @returns {string[]}
 */
export function getTargetTags(post, target) {
    return target.override?.tags || post.tags;
}

/**
 * Publishes a post to all target platforms.
 * Continues even if one platform fails.
 *
 * @param {import('./models.js').Post} post
 * @returns {Promise<import('./models.js').PublishSummary>}
 */
export async function publishPost(post) {
    const startedAt = new Date().toISOString();
    const results = [];

    publisherLog.info(`publishPost started: postId=${post.id}, targets=${post.targets.length}, media=${post.media?.length || 0}`);

    for (const target of post.targets) {
        publisherLog.info(`Processing target: accountId=${target.accountId}, platform=${target.platform}, enabled=${target.enabled}`);

        // Skip disabled targets
        if (!target.enabled) {
            publisherLog.info(`Skipping disabled target: ${target.accountId}`);
            continue;
        }

        const account = await getAccountById(target.accountId);
        if (!account) {
            publisherLog.error(`Account not found: ${target.accountId}`);
            const entry = {
                id: `pub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                postId: post.id,
                accountId: target.accountId,
                platform: target.platform || 'unknown',
                text: post.message,
                media: post.media,
                status: 'skipped',
                startedAt,
                finishedAt: new Date().toISOString(),
                durationMs: 0,
                errorMessage: 'Account not found'
            };
            await addPublishHistoryEntry(entry);
            results.push({
                platform: target.platform || 'unknown',
                accountId: target.accountId,
                success: false,
                error: 'Account not found'
            });
            continue;
        }

        if (account.status !== ACCOUNT_STATUS.CONNECTED) {
            publisherLog.warn(`Account not connected: ${target.accountId} (status: ${account.status})`);
            const entry = {
                id: `pub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                postId: post.id,
                accountId: target.accountId,
                platform: account.platform,
                text: post.message,
                media: post.media,
                status: 'skipped',
                startedAt,
                finishedAt: new Date().toISOString(),
                durationMs: 0,
                errorMessage: `Account is ${account.status}`
            };
            await addPublishHistoryEntry(entry);
            results.push({
                platform: account.platform,
                accountId: target.accountId,
                success: false,
                error: `Account is ${account.status}`
            });
            continue;
        }

        try {
            publisherLog.info(`Starting publish for target: ${target.accountId}@${account.platform}`);
            const decryptedCredentials = decryptCredentials(account.encryptedCredentials);
            const service = getPlatformService(account.platform);

            // Get per-platform override text, or use base text
            const text = getTargetText(post, target);
            const media = getTargetMedia(post, target);
            publisherLog.info(`Effective text length: ${text?.length || 0}, media count: ${media?.length || 0}`);

            // Validate publish request
            const validation = validatePublishRequest(account, post, text);
            publisherLog.info(`Validation result: valid=${validation.valid}, error=${validation.error || 'none'}`);
            if (!validation.valid) {
                const entry = {
                    id: `pub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    postId: post.id,
                    accountId: target.accountId,
                    platform: account.platform,
                    text: post.message,
                    media: post.media,
                    status: 'skipped',
                    startedAt,
                    finishedAt: new Date().toISOString(),
                    durationMs: 0,
                    errorMessage: validation.error
                };
                await addPublishHistoryEntry(entry);
                results.push({
                    platform: account.platform,
                    accountId: target.accountId,
                    success: false,
                    error: validation.error
                });
                continue;
            }

            // Test connection first
            publisherLog.info(`Testing connection for ${target.accountId}@${account.platform}...`);
            const connectionValid = await service.testConnection({ ...account, credentials: decryptedCredentials });
            publisherLog.info(`Connection test result: valid=${connectionValid.valid}, error=${connectionValid.error || 'none'}`);
            if (!connectionValid.valid) {
                // Update account status to error
                try {
                    await updateAccountStatus(target.accountId, ACCOUNT_STATUS.ERROR);
                } catch {
                    // Ignore status update errors
                }
                const entry = {
                    id: `pub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    postId: post.id,
                    accountId: target.accountId,
                    platform: account.platform,
                    text: post.message,
                    media: post.media,
                    status: 'failed',
                    startedAt,
                    finishedAt: new Date().toISOString(),
                    durationMs: 0,
                    errorMessage: connectionValid.error || 'Connection invalid'
                };
                await addPublishHistoryEntry(entry);
                results.push({
                    platform: account.platform,
                    accountId: target.accountId,
                    success: false,
                    error: connectionValid.error || 'Connection invalid'
                });
                continue;
            }

            // Pass file paths directly to the service's publish method.
            // The service handles uploadBlob() internally for each platform,
            // returning full blob objects for embed creation.
            // This follows the pipeline: Media selected → Read file → uploadBlob() → blob object → embed.images[] → createRecord()
            let mediaFilePaths = [];
            if (service.supportsMedia() && media.length > 0) {
                publisherLog.info(`Passing ${media.length} media files for ${target.accountId}@${account.platform}...`);
                // Extract file paths from media objects
                mediaFilePaths = media.map(m => typeof m === 'string' ? m : m.path).filter(Boolean);
                publisherLog.info(`Media file paths: ${JSON.stringify(mediaFilePaths)}`);
            } else if (media.length > 0 && !service.supportsMedia()) {
                publisherLog.warn(`Platform ${account.platform} does not support media. ${media.length} file(s) will be ignored.`);
            }

            // Publish the post — service.publish() handles the entire upload→embed→post flow
            publisherLog.info(`Calling service.publish for ${target.accountId}@${account.platform} with ${mediaFilePaths.length} media files`);
            const publishResult = await service.publish({ ...account, credentials: decryptedCredentials }, post, text, mediaFilePaths);
            publisherLog.info(`Publish result: success=${publishResult.success}, postId=${publishResult.postId || 'none'}, error=${publishResult.error || 'none'}`);
            const finishedAt = new Date().toISOString();
            const durationMs = new Date(finishedAt) - new Date(startedAt);

            const entry = {
                id: `pub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                postId: post.id,
                accountId: target.accountId,
                platform: account.platform,
                text: post.message,
                media: post.media,
                status: publishResult.success ? 'success' : 'failed',
                startedAt,
                finishedAt,
                durationMs,
                externalPostId: publishResult.postId,
                externalUrl: publishResult.externalUrl || (publishResult.success ? `https://x.com/i/status/${publishResult.postId}` : null),
                errorMessage: publishResult.error || null
            };
            await addPublishHistoryEntry(entry);

            let translatedError = publishResult.error;
            if (publishResult.error) {
                const statusMatch = publishResult.error.match(/HTTP (\d+)/);
                const statusCode = statusMatch ? statusMatch[1] : null;
                if (statusCode) {
                    const translated = translateError(statusCode, publishResult.error);
                    translatedError = translated.message;
                } else {
                    const networkError = translateNetworkError(publishResult.error);
                    translatedError = networkError.message;
                }
            }

            results.push({
                platform: account.platform,
                accountId: target.accountId,
                success: publishResult.success,
                postId: publishResult.postId,
                error: translatedError
            });
        } catch (err) {
            publisherLog.error(`Publish exception for ${target.accountId}@${account.platform}: ${err.message}`);
            publisherLog.error(`Stack: ${err.stack}`);
            const finishedAt = new Date().toISOString();
            const durationMs = new Date(finishedAt) - new Date(startedAt);
            const statusMatch = err.message.match(/HTTP (\d+)/);
            const statusCode = statusMatch ? statusMatch[1] : null;
            let translatedError = err.message || 'Unknown error';
            if (statusCode) {
                const translated = translateError(statusCode, err.message);
                translatedError = translated.message;
            } else {
                const networkError = translateNetworkError(err.message);
                translatedError = networkError.message;
            }
            const entry = {
                id: `pub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                postId: post.id,
                accountId: target.accountId,
                platform: account.platform,
                text: post.message,
                media: post.media,
                status: 'failed',
                startedAt,
                finishedAt,
                durationMs,
                errorMessage: translatedError
            };
            await addPublishHistoryEntry(entry);

            results.push({
                platform: account.platform,
                accountId: target.accountId,
                success: false,
                error: translatedError
            });
        }
    }

    const finishedAt = new Date().toISOString();
    return createPublishSummary({
        postId: post.id,
        results,
        startedAt,
        finishedAt
    });
}

/**
 * Retry a single failed publish entry.
 * @param {string} historyEntryId - The ID of the failed publish history entry
 * @returns {Promise<{ success: boolean, error?: string, postId?: string }>}
 */
export async function retryPublish(historyEntryId) {
    const history = await loadPublishHistory();
    const entry = history.find(e => e.id === historyEntryId);

    if (!entry) {
        return { success: false, error: 'Publish history entry not found' };
    }

    if (entry.status === 'success') {
        return { success: false, error: 'This entry was already successful' };
    }

    const post = await getPostById(entry.postId);
    if (!post) {
        return { success: false, error: 'Original post not found' };
    }

    const account = await getAccountById(entry.accountId);
    if (!account) {
        return { success: false, error: 'Account not found' };
    }

    if (account.status !== ACCOUNT_STATUS.CONNECTED) {
        return { success: false, error: `Account is ${account.status}` };
    }

    // Find the target for this account
    const target = post.targets.find(t => t.accountId === entry.accountId);
    if (!target) {
        return { success: false, error: 'Target not found in post' };
    }

    try {
        const decryptedCredentials = decryptCredentials(account.encryptedCredentials);
        const service = getPlatformService(account.platform);

        // Get per-platform override text, or use base text
        const text = getTargetText(post, target);

        // Validate publish request
        const validation = validatePublishRequest(account, post, text);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }

        // Test connection first
        const connectionValid = await service.testConnection({ ...account, credentials: decryptedCredentials });
        if (!connectionValid.valid) {
            try {
                await updateAccountStatus(account.id, ACCOUNT_STATUS.ERROR);
            } catch {
                // Ignore status update errors
            }
            return { success: false, error: connectionValid.error || 'Connection invalid' };
        }

        // Upload media if supported and media exists
        let mediaPaths = [];
        const media = getTargetMedia(post, target);
        if (service.supportsMedia() && media.length > 0) {
            const uploadResults = await processMediaBatch(account, media, account.platform);
            for (const result of uploadResults) {
                if (result.success && result.mediaId) {
                    mediaPaths.push(result.mediaId);
                }
            }
        }

        // Publish the post
        const publishResult = await service.publish({ ...account, credentials: decryptedCredentials }, post, text, mediaPaths);

        // Create a new history entry for the retry
        const startedAt = new Date().toISOString();
        const finishedAt = new Date().toISOString();
        const durationMs = new Date(finishedAt) - new Date(startedAt);

        const newEntry = {
            id: `pub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            postId: post.id,
            accountId: account.id,
            platform: account.platform,
            text: post.message,
            media: post.media,
            status: publishResult.success ? 'success' : 'failed',
            startedAt,
            finishedAt,
            durationMs,
            externalPostId: publishResult.postId,
            externalUrl: publishResult.success ? `https://x.com/i/status/${publishResult.postId}` : null,
            errorMessage: publishResult.error || null
        };
        await addPublishHistoryEntry(newEntry);

        if (publishResult.success) {
            return { success: true, postId: publishResult.postId };
        } else {
            const statusMatch = publishResult.error.match(/HTTP (\d+)/);
            const statusCode = statusMatch ? statusMatch[1] : null;
            if (statusCode) {
                const translated = translateError(statusCode, publishResult.error);
                return { success: false, error: translated.message };
            }
            const networkError = translateNetworkError(publishResult.error);
            return { success: false, error: networkError.message };
        }
    } catch (err) {
        const finishedAt = new Date().toISOString();
        const durationMs = new Date(finishedAt) - new Date(startedAt);
        const statusMatch = err.message.match(/HTTP (\d+)/);
        const statusCode = statusMatch ? statusMatch[1] : null;
        let translatedError = err.message || 'Unknown error';
        if (statusCode) {
            const translated = translateError(statusCode, err.message);
            translatedError = translated.message;
        } else {
            const networkError = translateNetworkError(err.message);
            translatedError = networkError.message;
        }
        const entry = {
            id: `pub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            postId: entry.postId,
            accountId: entry.accountId,
            platform: entry.platform,
            text: entry.text,
            media: entry.media,
            status: 'failed',
            startedAt: new Date().toISOString(),
            finishedAt,
            durationMs,
            errorMessage: translatedError
        };
        await addPublishHistoryEntry(entry);

        return { success: false, error: translatedError };
    }
}
