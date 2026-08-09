// src/creator-hub/services/itch.js
// itch.io devlog service stub.

import { PlatformService } from './base.js';

export const ItchService = {
    ...PlatformService,

    supportsMedia() {
        return true;
    },

    connect(credentials) {
        if (!credentials.apiKey) {
            return { success: false, error: 'Missing API key' };
        }
        return { success: true, username: credentials.username || 'unknown' };
    },

    testConnection(account) {
        const credentials = account.credentials || {};
        if (!credentials.apiKey) {
            return { valid: false, error: 'Missing API key' };
        }
        return { valid: true };
    },

    publish(account, post, text, mediaPaths = []) {
        return {
            success: false,
            error: 'Not implemented: publish to itch.io devlog'
        };
    },

    disconnect(account) {
        return { success: true };
    }
};
