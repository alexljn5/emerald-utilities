// src/creator-hub/services/oauth1.js
// OAuth 1.0a request signing for X/Twitter API.
// No secrets are logged.

// ==================== ENCODING ====================

function percentEncode(str) {
    return encodeURIComponent(str)
        .replace(/\!/g, '%21')
        .replace(/\*/g, '%2A')
        .replace(/'/g, '%27')
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29');
}

// ==================== CORE OAUTH 1.0A ====================

export async function generateNonce() {
    const crypto = await import('crypto');
    return crypto.randomBytes(16).toString('base64').replace(/\+/g, '').replace(/\//g, '').replace(/=/g, '');
}

export function generateTimestamp() {
    return Math.floor(Date.now() / 1000).toString();
}

export function buildParameterString(params) {
    const sortedKeys = Object.keys(params).sort();
    return sortedKeys
        .map(key => `${percentEncode(key)}=${percentEncode(params[key])}`)
        .join('&');
}

export function buildSignatureBaseString(method, url, params) {
    const encodedUrl = percentEncode(url);
    const encodedParams = percentEncode(buildParameterString(params));
    return `${method.toUpperCase()}&${encodedUrl}&${encodedParams}`;
}

export function buildSigningKey(consumerSecret, tokenSecret) {
    return `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret || '')}`;
}

export async function signRequest(signingKey, signatureBaseString) {
    const crypto = await import('crypto');
    return crypto
        .createHmac('sha1', signingKey)
        .update(signatureBaseString)
        .digest('base64');
}

export function buildAuthorizationHeader(oauthParams) {
    const headerParams = Object.keys(oauthParams)
        .sort()
        .map(key => `${percentEncode(key)}="${percentEncode(oauthParams[key])}"`)
        .join(', ');
    return `OAuth ${headerParams}`;
}

// ==================== HIGH-LEVEL HELPERS ====================

export async function createOAuthParams(consumerKey, accessToken) {
    return {
        oauth_consumer_key: consumerKey,
        oauth_nonce: await generateNonce(),
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: generateTimestamp(),
        oauth_token: accessToken,
        oauth_version: '1.0'
    };
}

export async function createSignedHeader(method, url, consumerKey, consumerSecret, accessToken, accessTokenSecret, queryParams = {}) {
    const oauthParams = await createOAuthParams(consumerKey, accessToken);
    const allParams = { ...oauthParams, ...queryParams };

    const signatureBaseString = buildSignatureBaseString(method, url, allParams);
    const signingKey = buildSigningKey(consumerSecret, accessTokenSecret);
    const signature = await signRequest(signingKey, signatureBaseString);

    oauthParams.oauth_signature = signature;

    return buildAuthorizationHeader(oauthParams);
}

export async function oauth1Request(method, url, consumerKey, consumerSecret, accessToken, accessTokenSecret, queryParams = {}, body = null) {
    const authorization = await createSignedHeader(method, url, consumerKey, consumerSecret, accessToken, accessTokenSecret, queryParams);

    const urlObj = new URL(url);
    Object.entries(queryParams).forEach(([key, value]) => {
        urlObj.searchParams.set(key, value);
    });

    const headers = {
        Authorization: authorization
    };

    const fetchOptions = {
        method,
        headers
    };

    if (body !== null && body !== undefined) {
        headers['Content-Type'] = 'application/json';
        fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(urlObj.toString(), fetchOptions);
    const text = await response.text();

    if (!response.ok) {
        let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
        try {
            const errorJson = JSON.parse(text);
            if (errorJson.errors && errorJson.errors[0]?.message) {
                errorMessage = errorJson.errors[0].message;
            } else if (errorJson.error) {
                errorMessage = errorJson.error;
            }
        } catch {
            // Use default error message
        }
        throw new Error(errorMessage);
    }

    return text;
}
