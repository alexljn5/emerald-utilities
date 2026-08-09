// src/creator-hub/services/base.js
// Base platform service interface.
// Each platform service implements these methods.

/**
 * @typedef {Object} ServiceContext
 * @property {import('../models.js').PlatformAccount} account
 * @property {import('../models.js').Post} post
 * @property {string} text - The text to publish (may be overridden per-platform)
 */

/**
 * Base platform service contract.
 * All platform services must implement these methods.
 */
export const PlatformService = {
    /**
     * Connect to the platform with provided credentials.
     * @param {Record<string, unknown>} credentials
     * @returns {{ success: boolean, error?: string, username?: string }}
     */
    connect(credentials) {
        throw new Error('connect() not implemented');
    },

    /**
     * Test if the account connection is still valid.
     * @param {import('../models.js').PlatformAccount} account
     * @returns {{ valid: boolean, error?: string }}
     */
    testConnection(account) {
        throw new Error('testConnection() not implemented');
    },

    /**
     * Publish a post to this platform.
     * @param {import('../models.js').PlatformAccount} account
     * @param {import('../models.js').Post} post
     * @param {string} text - The text to publish (may include per-platform overrides)
     * @param {string[]} [mediaPaths]
     * @returns {{ success: boolean, postId?: string, error?: string }}
     */
    publish(account, post, text, mediaPaths = []) {
        throw new Error('publish() not implemented');
    },

    /**
     * Disconnect the account from this platform.
     * @param {import('../models.js').PlatformAccount} account
     * @returns {{ success: boolean, error?: string }}
     */
    disconnect(account) {
        throw new Error('disconnect() not implemented');
    },

    /**
     * Whether this platform supports media uploads.
     * @returns {boolean}
     */
    supportsMedia() {
        return false;
    },

    /**
     * Get platform capabilities.
     * @returns {{ text: boolean, images: boolean, video: boolean, maxChars: number }}
     */
    getCapabilities() {
        return {
            text: true,
            images: false,
            video: false,
            maxChars: 0
        };
    },

    /**
     * Authenticate via OAuth or browser flow.
     * Override in services that support OAuth.
     * @param {Object} params
     * @param {string} [params.username]
     * @returns {{ success: boolean, error?: string, credentials?: Record<string, unknown>, username?: string }}
     */
    authenticate(params = {}) {
        return {
            success: false,
            error: 'OAuth authentication is not supported for this platform. Use manual credential entry.'
        };
    }
};
