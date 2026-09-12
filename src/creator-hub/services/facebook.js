// src/creator-hub/services/facebook.js
// Facebook Graph API service stub.

import { PlatformService } from './base.js';

export const FacebookService = {
    ...PlatformService,

    supportsMedia() {
        return true;
    },

    connect(credentials) {
        if (!credentials.accessToken) {
            return { success: false, error: 'Missing access token' };
        }
        if (!credentials.pageId) {
            return { success: false, error: 'Missing page ID' };
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
            error: 'Not implemented: publish to Facebook'
        };
    },

    disconnect(account) {
        return { success: true };
    }
};
