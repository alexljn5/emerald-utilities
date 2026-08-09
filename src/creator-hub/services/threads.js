// src/creator-hub/services/threads.js
// Threads API service stub.

import { PlatformService } from './base.js';

export const ThreadsService = {
    ...PlatformService,

    supportsMedia() {
        return true;
    },

    connect(credentials) {
        if (!credentials.accessToken) {
            return { success: false, error: 'Missing access token' };
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
            error: 'Not implemented: publish to Threads'
        };
    },

    disconnect(account) {
        return { success: true };
    }
};
