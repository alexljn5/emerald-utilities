// src/creator-hub/services/twitter.js
// X / Twitter API service.
// Supports both OAuth 2.0 PKCE (browser flow) and OAuth 1.0a (API key/secret + access token/secret).

import { PlatformService } from './base.js';
import { startOAuthFlow, generateState, generateCodeVerifier, generateCodeChallenge } from '../oauth.js';
import { oauth1Request } from './oauth1.js';
import { translateError, translateNetworkError } from './errorTranslator.js';

// OAuth 2.0 PKCE configuration (for browser-based authentication)
const X_CLIENT_ID = process.env.X_CLIENT_ID || '';
const X_REDIRECT_URI = process.env.X_REDIRECT_URI || 'http://localhost:3000/callback';
const X_AUTH_URL = 'https://twitter.com/i/oauth2/authorize';
const X_TOKEN_URL = 'https://api.twitter.com/2/oauth2/token';
const X_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access'];

export const TwitterService = {
    ...PlatformService,

    supportsMedia() {
        return true;
    },

    /**
     * Initiate OAuth 2.0 PKCE flow for X/Twitter.
     * Opens a browser window for user authorization.
     * @param {Object} params
     * @param {string} [params.username] - Optional username hint
     * @returns {{ success: boolean, error?: string }}
     */
    async authenticate(params = {}) {
        if (!X_CLIENT_ID) {
            return { success: false, error: 'X_CLIENT_ID not configured. Set in environment variables.' };
        }

        try {
            const state = generateState();
            const codeVerifier = generateCodeVerifier();
            const codeChallenge = await generateCodeChallenge(codeVerifier);

            const authUrl = new URL(X_AUTH_URL);
            authUrl.searchParams.set('response_type', 'code');
            authUrl.searchParams.set('client_id', X_CLIENT_ID);
            authUrl.searchParams.set('redirect_uri', X_REDIRECT_URI);
            authUrl.searchParams.set('scope', X_SCOPES.join(' '));
            authUrl.searchParams.set('state', state);
            authUrl.searchParams.set('code_challenge', codeChallenge);
            authUrl.searchParams.set('code_challenge_method', 'S256');

            const result = await startOAuthFlow({
                authUrl: authUrl.toString(),
                callbackUrl: X_REDIRECT_URI
            });

            if (!result) {
                return { success: false, error: 'OAuth flow was cancelled' };
            }

            // Exchange code for tokens
            const tokenResponse = await fetch(X_TOKEN_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    client_id: X_CLIENT_ID,
                    redirect_uri: X_REDIRECT_URI,
                    code: result.code,
                    code_verifier: codeVerifier
                })
            });

            if (!tokenResponse.ok) {
                const errorText = await tokenResponse.text();
                return { success: false, error: `Token exchange failed: ${errorText}` };
            }

            const tokenData = await tokenResponse.json();

            // Get user info
            const userResponse = await fetch('https://api.twitter.com/2/users/me', {
                headers: {
                    'Authorization': `Bearer ${tokenData.access_token}`
                }
            });

            let username = params.username || 'unknown';
            if (userResponse.ok) {
                const userData = await userResponse.json();
                username = userData.data?.username || username;
            }

            return {
                success: true,
                username,
                credentials: {
                    accessToken: tokenData.access_token,
                    refreshToken: tokenData.refresh_token,
                    expiresAt: tokenData.expires_in ? Date.now() + (tokenData.expires_in * 1000) : null
                }
            };
        } catch (err) {
            return { success: false, error: err.message || 'OAuth flow failed' };
        }
    },

    connect(credentials) {
        // Support both OAuth 2.0 and OAuth 1.0a credentials
        const hasOAuth2 = credentials.accessToken && !credentials.apiKey;
        const hasOAuth1 = credentials.apiKey && credentials.apiSecret && credentials.accessToken && credentials.accessTokenSecret;

        if (!hasOAuth2 && !hasOAuth1) {
            if (credentials.apiKey && !credentials.accessToken) {
                return { success: false, error: 'Missing access token' };
            }
            if (!credentials.apiKey && !credentials.accessToken) {
                return { success: false, error: 'Missing credentials. Provide either OAuth 2.0 access token or OAuth 1.0a API key + access token.' };
            }
        }
        return { success: true, username: credentials.username || 'unknown' };
    },

    async testConnection(account) {
        const credentials = account.credentials || {};
        const hasOAuth2 = credentials.accessToken && !credentials.apiKey;
        const hasOAuth1 = credentials.apiKey && credentials.apiSecret && credentials.accessToken && credentials.accessTokenSecret;

        if (!hasOAuth2 && !hasOAuth1) {
            if (credentials.apiKey && !credentials.accessToken) {
                return { valid: false, error: 'Missing access token' };
            }
            return { valid: false, error: 'Missing credentials. Provide either OAuth 2.0 access token or OAuth 1.0a API key + access token.' };
        }

        if (hasOAuth1) {
            try {
                const responseText = await oauth1Request(
                    'GET',
                    'https://api.twitter.com/2/users/me',
                    credentials.apiKey,
                    credentials.apiSecret,
                    credentials.accessToken,
                    credentials.accessTokenSecret
                );

                const userData = JSON.parse(responseText);
                return {
                    valid: true,
                    username: userData.data?.username,
                    displayName: userData.data?.name
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
        }

        // OAuth 2.0 placeholder
        return { valid: false, error: 'OAuth 2.0 not yet implemented for testConnection' };
    },

    async publish(account, post, text, mediaPaths = []) {
        const credentials = account.credentials || {};

        if (!credentials.apiKey || !credentials.apiSecret || !credentials.accessToken || !credentials.accessTokenSecret) {
            return { success: false, error: 'Missing OAuth 1.0a credentials' };
        }

        try {
            const responseText = await oauth1Request(
                'POST',
                'https://api.twitter.com/2/tweets',
                credentials.apiKey,
                credentials.apiSecret,
                credentials.accessToken,
                credentials.accessTokenSecret,
                {},
                { text }
            );

            const responseData = JSON.parse(responseText);
            return {
                success: true,
                postId: responseData.data?.id
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

    disconnect(account) {
        return { success: true };
    },

    /**
     * Get platform capabilities.
     * @returns {{ text: boolean, images: boolean, video: boolean, maxChars: number }}
     */
    getCapabilities() {
        return {
            text: true,
            images: true,
            video: true,
            maxChars: 280
        };
    }
};
