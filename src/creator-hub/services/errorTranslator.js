// src/creator-hub/services/errorTranslator.js
// Translates raw API error codes into human-readable messages.
// Never exposes raw API error bodies to the renderer.

export function translateError(statusCode, rawMessage) {
    if (!statusCode && !rawMessage) {
        return { code: 'unknown', message: 'An unknown error occurred.' };
    }

    const code = String(statusCode || 'unknown');

    switch (code) {
        case '400':
            return {
                code: 'bad_request',
                message: 'Invalid request. Check the request format and parameters.'
            };
        case '401':
            return {
                code: 'auth_failed',
                message: 'Authentication failed. Credentials were rejected by the platform.'
            };
        case '402':
            return {
                code: 'payment_required',
                message: 'Payment required. This platform feature requires a paid tier.'
            };
        case '403':
            return {
                code: 'permission_denied',
                message: 'Permission denied. The account lacks the required permissions for this action.'
            };
        case '404':
            return {
                code: 'not_found',
                message: 'Resource not found. The requested endpoint or resource does not exist.'
            };
        case '405':
            return {
                code: 'method_not_allowed',
                message: 'Method not allowed. The HTTP method is not supported for this endpoint.'
            };
        case '408':
            return {
                code: 'timeout',
                message: 'Request timed out. The platform took too long to respond.'
            };
        case '413':
            return {
                code: 'payload_too_large',
                message: 'Payload too large. Reduce media size or text length.'
            };
        case '415':
            return {
                code: 'unsupported_media',
                message: 'Unsupported media type. Check the file format.'
            };
        case '429':
            return {
                code: 'rate_limited',
                message: 'Rate limit reached. Try again later.'
            };
        case '500':
            return {
                code: 'server_error',
                message: 'Platform server error. Try again later.'
            };
        case '502':
            return {
                code: 'bad_gateway',
                message: 'Platform gateway error. Try again later.'
            };
        case '503':
            return {
                code: 'service_unavailable',
                message: 'Platform service unavailable. Try again later.'
            };
        default:
            if (rawMessage) {
                return {
                    code: code === 'unknown' ? 'unknown' : code,
                    message: rawMessage
                };
            }
            return {
                code: code === 'unknown' ? 'unknown' : code,
                message: `HTTP ${code} error.`
            };
    }
}

export function translateNetworkError(error) {
    if (!error) {
        return { code: 'network_unknown', message: 'A network error occurred.' };
    }

    const message = String(error);

    if (message.includes('ENOTFOUND') || message.includes('getaddrinfo')) {
        return {
            code: 'dns_failure',
            message: 'Could not resolve the platform hostname. Check your DNS or network connection.'
        };
    }
    if (message.includes('ECONNREFUSED')) {
        return {
            code: 'connection_refused',
            message: 'Connection refused. The platform is not accepting connections.'
        };
    }
    if (message.includes('ETIMEDOUT') || message.includes('ESOCKETTIMEDOUT')) {
        return {
            code: 'timeout',
            message: 'Connection timed out. Check your network connection.'
        };
    }
    if (message.includes('ECONNRESET')) {
        return {
            code: 'connection_reset',
            message: 'Connection was reset. The platform closed the connection unexpectedly.'
        };
    }
    if (message.includes('EAI_AGAIN')) {
        return {
            code: 'dns_temp_failure',
            message: 'Temporary DNS failure. Try again in a moment.'
        };
    }
    if (message.includes('CERT')) {
        return {
            code: 'ssl_error',
            message: 'SSL/TLS certificate error. The platform certificate is invalid or untrusted.'
        };
    }

    return {
        code: 'network_unknown',
        message: message || 'A network error occurred.'
    };
}
