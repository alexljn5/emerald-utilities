// src/creator-hub/services/tiktok.js
// TikTok Content Posting API service stub.

import { PlatformService } from './base.js';

export const TikTokService = {
    ...PlatformService,

    supportsMedia() {
        return true;
    },

    connect(credentials) {
        if (!credentials.accessToken) {
            return { success: false, error: 'Missing access token' };
        }
        if (!credentials.openId) {
            return { success: false, error: 'Missing Open ID' };
        }
        return { success: true, username: credentials.username || 'unknown' };
    },

    testConnection(account) {
        const credentials = account.credentials || {};
        if (!credentials.accessToken) {
            return { valid: false, error: 'Missing access token' };
        }
        return { valid: true };
    },

    publish(account, post, text, mediaPaths = []) {
        return {
            success: false,
            error: 'Not implemented: publish to TikTok'
        };
    },

    disconnect(account) {
        return { success: true };
    }
};
