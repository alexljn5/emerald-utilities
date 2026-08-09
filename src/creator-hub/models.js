// src/creator-hub/models.js
// Simple data models for Creator Hub.
// No side effects, no I/O. Pure data structures and validation.

import { CREATOR_HUB, ACCOUNT_STATUS } from '../globals.js';

// ==================== PLATFORM ACCOUNT ====================

/**
 * @typedef {Object} AccountMetadata
 * @property {string} [lastSuccessfulPublish]
 * @property {string} [lastFailedPublish]
 * @property {number} totalPublished
 * @property {number} totalFailed
 */

/**
 * @typedef {Object} PlatformAccount
 * @property {string} id
 * @property {string} platform
 * @property {string} username
 * @property {string} displayName
 * @property {Object} capabilities
 * @property {string} status
 * @property {AccountMetadata} metadata
 * @property {string} createdAt
 * @property {string} lastUsed
 * @property {string} encryptedCredentials
 */

/**
 * Creates a validated PlatformAccount.
 * @param {Object} params
 * @param {string} params.id
 * @param {string} params.platform
 * @param {string} params.username
 * @param {string} [params.displayName='']
 * @param {Object} [params.capabilities={}]
 * @param {string} [params.status='disconnected']
 * @param {Object} [params.metadata={}]
 * @param {string} [params.createdAt]
 * @param {string} [params.lastUsed='']
 * @param {string} params.encryptedCredentials
 * @returns {PlatformAccount}
 */
export function createPlatformAccount({
    id,
    platform,
    username,
    displayName = '',
    capabilities = {},
    status = ACCOUNT_STATUS.DISCONNECTED,
    metadata = {},
    createdAt = new Date().toISOString(),
    lastUsed = '',
    encryptedCredentials
}) {
    const account = {
        id,
        platform,
        username,
        displayName,
        capabilities: {
            text: capabilities.text ?? true,
            images: capabilities.images ?? false,
            video: capabilities.video ?? false,
            maxChars: capabilities.maxChars ?? 0
        },
        status,
        metadata: {
            lastSuccessfulPublish: metadata.lastSuccessfulPublish || null,
            lastFailedPublish: metadata.lastFailedPublish || null,
            totalPublished: metadata.totalPublished || 0,
            totalFailed: metadata.totalFailed || 0
        },
        createdAt,
        lastUsed,
        encryptedCredentials
    };
    validatePlatformAccount(account);
    return account;
}

/**
 * Validates a PlatformAccount object.
 * @param {Partial<PlatformAccount>} account
 */
export function validatePlatformAccount(account) {
    if (!account.id || typeof account.id !== 'string') {
        throw new Error('Account id is required and must be a string');
    }
    if (!account.platform || typeof account.platform !== 'string') {
        throw new Error('Account platform is required and must be a string');
    }
    if (!CREATOR_HUB.SUPPORTED_PLATFORMS.includes(account.platform)) {
        throw new Error(`Unsupported platform: ${account.platform}`);
    }
    if (!account.username || typeof account.username !== 'string') {
        throw new Error('Account username is required and must be a string');
    }
    if (account.displayName !== undefined && typeof account.displayName !== 'string') {
        throw new Error('Account displayName must be a string');
    }
    if (account.capabilities && typeof account.capabilities !== 'object') {
        throw new Error('Account capabilities must be an object');
    }
    if (account.status && !Object.values(ACCOUNT_STATUS).includes(account.status)) {
        throw new Error(`Invalid account status: ${account.status}`);
    }
    if (account.metadata && typeof account.metadata !== 'object') {
        throw new Error('Account metadata must be an object');
    }
    if (account.createdAt && typeof account.createdAt !== 'string') {
        throw new Error('Account createdAt must be a string');
    }
    if (account.lastUsed !== undefined && typeof account.lastUsed !== 'string') {
        throw new Error('Account lastUsed must be a string');
    }
    if (!account.encryptedCredentials || typeof account.encryptedCredentials !== 'string') {
        throw new Error('Account encryptedCredentials is required and must be a string');
    }
}

// ==================== POST ====================

/**
 * @typedef {Object} PostTargetOverride
 * @property {string} [message]
 * @property {string[]} [tags]
 * @property {string[]} [media]
 */

/**
 * @typedef {Object} PostTarget
 * @property {string} accountId
 * @property {string} platform
 * @property {boolean} enabled
 * @property {PostTargetOverride} [override]
 */

/**
 * @typedef {Object} Post
 * @property {string} id
 * @property {string|null} title
 * @property {string} message
 * @property {string[]} media
 * @property {string[]} tags
 * @property {string|null} project
 * @property {string|null} category
 * @property {PostTarget[]} targets
 * @property {string} createdAt
 */

/**
 * Normalizes legacy targets (array of account IDs) to new format.
 * @param {string[]|PostTarget[]} targets
 * @param {Object} [overrides={}]
 * @returns {PostTarget[]}
 */
export function normalizeTargets(targets, overrides = {}) {
    if (!Array.isArray(targets)) {
        throw new Error('Post targets must be an array');
    }
    if (targets.length === 0) {
        return [];
    }

    // If already in new format, return as-is (preserve enabled value)
    if (typeof targets[0] === 'object' && targets[0].accountId) {
        return targets.map(t => ({
            accountId: t.accountId,
            platform: t.platform || '',
            enabled: t.enabled,
            override: t.override || {}
        }));
    }

    // Legacy format: array of account IDs
    // We need to look up platform info, but we don't have accounts here
    // Return minimal structure with empty platform (will be filled by caller)
    return targets.map(accountId => ({
        accountId,
        platform: '',
        enabled: true,
        override: {}
    }));
}

/**
 * Creates a validated Post.
 * @param {Object} params
 * @param {string} params.id
 * @param {string|null} [params.title=null]
 * @param {string} params.message
 * @param {string[]} [params.media=[]]
 * @param {string[]} [params.tags=[]]
 * @param {string|null} [params.project=null]
 * @param {string|null} [params.category=null]
 * @param {string[]|PostTarget[]} [params.targets=[]]
 * @param {Record<string, PostTargetOverride>} [params.overrides={}]
 * @param {string} [params.createdAt]
 * @returns {Post}
 */
export function createPost({
    id,
    title = null,
    message,
    media = [],
    tags = [],
    project = null,
    category = null,
    targets = [],
    overrides = {},
    createdAt = new Date().toISOString()
}) {
    const normalizedTargets = normalizeTargets(targets, overrides);
    validatePost({ id, title, message, media, tags, project, category, targets: normalizedTargets, overrides, createdAt });
    return { id, title, message, media, tags, project, category, targets: normalizedTargets, overrides, createdAt };
}

/**
 * Validates a Post object.
 * @param {Partial<Post>} post
 */
export function validatePost(post) {
    if (!post.id || typeof post.id !== 'string') {
        throw new Error('Post id is required and must be a string');
    }
    if (post.title !== null && post.title !== undefined && typeof post.title !== 'string') {
        throw new Error('Post title must be a string or null');
    }
    if (typeof post.message !== 'string') {
        throw new Error('Post message is required and must be a string');
    }
    if (!Array.isArray(post.media)) {
        throw new Error('Post media must be an array');
    }
    if (post.media.length > CREATOR_HUB.MAX_MEDIA_FILES) {
        throw new Error(`Post media exceeds maximum of ${CREATOR_HUB.MAX_MEDIA_FILES} files`);
    }
    if (!Array.isArray(post.tags)) {
        throw new Error('Post tags must be an array');
    }
    if (!Array.isArray(post.targets)) {
        throw new Error('Post targets must be an array');
    }
    // Validate each target
    for (const target of post.targets) {
        if (!target.accountId || typeof target.accountId !== 'string') {
            throw new Error('Each target must have an accountId string');
        }
        if (!target.platform || typeof target.platform !== 'string') {
            throw new Error('Each target must have a platform string');
        }
        if (typeof target.enabled !== 'boolean') {
            throw new Error('Each target must have an enabled boolean');
        }
        if (target.override && typeof target.override !== 'object') {
            throw new Error('Target override must be an object');
        }
    }
    if (typeof post.overrides !== 'object' || post.overrides === null) {
        throw new Error('Post overrides must be an object');
    }
    if (typeof post.createdAt !== 'string') {
        throw new Error('Post createdAt is required and must be a string');
    }
}

// ==================== PUBLISH RESULT ====================

/**
 * @typedef {Object} PublishResult
 * @property {string} platform
 * @property {string} accountId
 * @property {boolean} success
 * @property {string} [error]
 * @property {string} [postId]
 */

/**
 * @typedef {Object} PublishSummary
 * @property {string} postId
 * @property {PublishResult[]} results
 * @property {string} startedAt
 * @property {string} finishedAt
 */

export function createPublishSummary({ postId, results, startedAt, finishedAt }) {
    return { postId, results, startedAt, finishedAt };
}
