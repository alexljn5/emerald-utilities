// src/creator-hub/oauth.js
// OAuth flow helper for platform authentication.
// Opens a BrowserWindow for user authorization and captures the callback.
// Main-process only.

let BrowserWindow = null;
let shell = null;

// Lazy-load Electron modules (only available in main process)
async function getElectronModules() {
    if (!BrowserWindow) {
        try {
            const electron = await import('electron');
            BrowserWindow = electron.BrowserWindow;
            shell = electron.shell;
        } catch {
            // Not in Electron environment (e.g., tests)
            return null;
        }
    }
    return { BrowserWindow, shell };
}

// Simple console logger for OAuth debug output
function oauthLog(...args) {
    console.log('[OAUTH]', ...args);
}

/**
 * Resolve the project root by walking up from this file.
 * Uses lazy Node.js imports so this file can be safely imported
 * in the renderer process (the functions that need Node.js are
 * only called from the main process).
 */
async function findProjectRoot() {
    const path = await import('path');
    const fs = await import('fs');

    let dir = path.dirname(new URL(import.meta.url).pathname);
    // On Windows, pathname starts with /C:/... so strip the leading slash
    if (dir.startsWith('/') && dir[2] === ':') {
        dir = dir.slice(1);
    }
    for (let i = 0; i < 10; i += 1) {
        if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return dir;
}

/**
 * Find mkcert-generated development certificates for localhost HTTPS.
 * Looks in src/oauth/certs/ relative to the project root.
 *
 * Expected files:
 *   - localhost.pem       (certificate)
 *   - localhost-key.pem   (private key)
 *
 * @returns {{ certPath: string, keyPath: string, certDir: string } | null}
 */
async function findDevCertificates() {
    const path = await import('path');
    const fs = await import('fs');

    const projectRoot = await findProjectRoot();
    const certDir = path.join(projectRoot, 'src', 'oauth', 'certs');
    const certPath = path.join(certDir, 'localhost.pem');
    const keyPath = path.join(certDir, 'localhost-key.pem');

    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        return { certPath, keyPath, certDir };
    }
    return null;
}

/**
 * Print instructions for generating mkcert certificates.
 */
async function printCertInstructions() {
    const path = await import('path');

    const certDir = path.join(await findProjectRoot(), 'src', 'oauth', 'certs');
    console.log('\n[OAUTH] ============================================');
    console.log('[OAUTH] Missing HTTPS development certificates.');
    console.log('[OAUTH] Meta requires HTTPS for OAuth redirect URIs.');
    console.log('[OAUTH]');
    console.log('[OAUTH] To generate certificates with mkcert:');
    console.log(`[OAUTH]   1. mkdir -p "${certDir}"`);
    console.log(`[OAUTH]   2. cd "${certDir}"`);
    console.log('[OAUTH]   3. mkcert localhost 127.0.0.1 ::1');
    console.log('[OAUTH]   4. Rename the generated files to:');
    console.log(`[OAUTH]      ${path.join(certDir, 'localhost.pem')}`);
    console.log(`[OAUTH]      ${path.join(certDir, 'localhost-key.pem')}`);
    console.log('[OAUTH] ============================================\n');
}

/**
 * Opens an OAuth authorization flow in a new BrowserWindow.
 * Waits for the redirect callback and returns the authorization code.
 *
 * @param {Object} params
 * @param {string} params.authUrl - The OAuth authorization URL
 * @param {string} params.callbackUrl - The expected callback URL pattern
 * @param {number} [params.timeout=120000] - Timeout in milliseconds
 * @returns {Promise<{ code: string, state?: string } | null>}
 */
export async function startOAuthFlow({ authUrl, callbackUrl, timeout = 120000 }) {
    const modules = await getElectronModules();
    if (!modules) {
        throw new Error('OAuth flow requires Electron main process');
    }

    const { BrowserWindow: BW } = modules;

    return new Promise((resolve, reject) => {
        const authWindow = new BW({
            width: 500,
            height: 700,
            show: true,
            alwaysOnTop: true,
            webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true
            }
        });

        let resolved = false;

        const cleanup = () => {
            if (!authWindow.isDestroyed()) {
                authWindow.close();
            }
        };

        const timeoutId = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                cleanup();
                reject(new Error('OAuth flow timed out'));
            }
        }, timeout);

        authWindow.webContents.on('will-redirect', (event, url) => {
            handleCallback(url);
        });

        authWindow.webContents.on('did-navigate', (event, url) => {
            handleCallback(url);
        });

        // Also handle new window opens (some OAuth providers open new windows)
        authWindow.webContents.setWindowOpenHandler(({ url }) => {
            handleCallback(url);
            return { action: 'deny' };
        });

        function handleCallback(url) {
            if (resolved) return;

            // Check if the URL matches our callback
            if (url.startsWith(callbackUrl)) {
                resolved = true;
                clearTimeout(timeoutId);

                try {
                    const urlObj = new URL(url);
                    const code = urlObj.searchParams.get('code');
                    const state = urlObj.searchParams.get('state');
                    const error = urlObj.searchParams.get('error');

                    cleanup();

                    if (error) {
                        reject(new Error(`OAuth error: ${error}`));
                        return;
                    }

                    if (!code) {
                        reject(new Error('No authorization code received'));
                        return;
                    }

                    resolve({ code, state: state || undefined });
                } catch (err) {
                    cleanup();
                    reject(err);
                }
            }
        }

        authWindow.on('closed', () => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timeoutId);
                reject(new Error('OAuth window was closed'));
            }
        });

        // Open the auth URL
        authWindow.loadURL(authUrl).catch(err => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timeoutId);
                cleanup();
                reject(err);
            }
        });
    });
}

/**
 * Starts a deep-link (custom protocol) OAuth flow.
 * Used for providers that redirect to a custom URI scheme
 * (e.g. emerald://instagram-callback) rather than localhost HTTP.
 *
 * The main process must call registerDeepLinkHandler() when a deep link
 * arrives (via app.on('open-url') on macOS or process.argv / second-instance
 * on Windows/Linux).
 *
 * @param {Object} params
 * @param {string} [params.callbackPath='/instagram-callback'] - Path portion of the deep link
 * @param {string} [params.expectedState] - OAuth state value to validate against
 * @param {number} [params.timeout=120000] - Timeout in milliseconds
 * @returns {Promise<{ code: string, state?: string }>}
 */
export async function startDeepLinkOAuthFlow({ callbackPath = '/instagram-callback', expectedState, timeout = 120000 } = {}) {
    return new Promise((resolve, reject) => {
        let resolved = false;

        const timeoutId = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                deepLinkCallbacks.delete(callbackPath);
                reject(new Error('OAuth flow timed out'));
            }
        }, timeout);

        // Check if a deep link already arrived before this flow started
        const pendingIndex = pendingDeepLinks.findIndex((stored) => {
            try {
                const storedUrl = new URL(stored);
                return storedUrl.pathname === callbackPath || stored.startsWith(`emerald://${callbackPath}`);
            } catch {
                return false;
            }
        });

        if (pendingIndex !== -1) {
            const url = pendingDeepLinks[pendingIndex];
            pendingDeepLinks.splice(pendingIndex, 1);
            clearTimeout(timeoutId);
            processDeepLink(url, callbackPath, expectedState, resolve, reject);
            return;
        }

        deepLinkCallbacks.set(callbackPath, { resolve, reject, timeoutId, expectedState });
        oauthLog(`Waiting for deep link callback: emerald://${callbackPath}`);
    });
}

/**
 * Called by the main process (heavensgate.js) when a deep link is received.
 * Matches the URL against any pending OAuth flow and resolves it.
 *
 * @param {string} url - The full deep link URL (e.g. emerald://instagram-callback?code=...)
 */
export function registerDeepLinkHandler(url) {
    oauthLog(`Received deep link: ${url}`);

    // Check for a matching pending flow
    for (const [callbackPath, callback] of deepLinkCallbacks) {
        try {
            const urlObj = new URL(url);
            if (urlObj.pathname === callbackPath || url.startsWith(`emerald://${callbackPath}`)) {
                clearTimeout(callback.timeoutId);
                deepLinkCallbacks.delete(callbackPath);
                processDeepLink(url, callbackPath, callback.expectedState, callback.resolve, callback.reject);
                return;
            }
        } catch {
            // ignore parse errors, keep looking
        }
    }

    // No matching flow yet — store for later
    pendingDeepLinks.push(url);
    oauthLog(`No active OAuth flow for this deep link, storing for later`);
}

/**
 * Parse a deep link URL, validate state, and resolve/reject the OAuth promise.
 */
function processDeepLink(url, callbackPath, expectedState, resolve, reject) {
    try {
        const urlObj = new URL(url);
        const code = urlObj.searchParams.get('code');
        const state = urlObj.searchParams.get('state');
        const error = urlObj.searchParams.get('error');

        oauthLog(`Processing deep link callback on ${callbackPath}, code=${code ? 'yes' : 'no'}, error=${error || 'none'}`);

        if (error) {
            reject(new Error(`OAuth error: ${error}`));
            return;
        }

        if (!code) {
            reject(new Error('No authorization code received'));
            return;
        }

        if (expectedState && state !== expectedState) {
            reject(new Error(`OAuth state mismatch: expected ${expectedState}, got ${state}`));
            return;
        }

        if (expectedState) {
            oauthLog('OAuth state validated');
        }

        resolve({ code, state: state || undefined });
    } catch (err) {
        reject(new Error(`Failed to process deep link: ${err.message}`));
    }
}

// Deep-link OAuth state
const deepLinkCallbacks = new Map();
const pendingDeepLinks = [];

/**
 * Generates a random state parameter for OAuth.
 * @returns {string}
 */
export function generateState() {
    return Math.random().toString(36).slice(2, 15) + Math.random().toString(36).slice(2, 15);
}

/**
 * Generates a PKCE code verifier.
 * @returns {string}
 */
export function generateCodeVerifier() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return btoa(String.fromCharCode(...array))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * Generates a PKCE code challenge from a verifier.
 * @returns {string}
 */
export async function generateCodeChallenge(verifier) {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(hash)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * Starts a localhost OAuth callback server.
 * Supports both HTTP and HTTPS. For HTTPS, uses mkcert-generated
 * development certificates from src/oauth/certs/.
 *
 * @param {Object} params
 * @param {number} [params.port=3541] - Local port to listen on
 * @param {string} [params.callbackPath='/instagram-callback'] - Path to intercept
 * @param {number} [params.timeout=120000] - Timeout in milliseconds
 * @param {string} [params.protocol='http:'] - 'http:' or 'https:'
 * @returns {Promise<{ code: string, state?: string }>}
 */
export async function startLocalhostOAuthFlow({ port = 3541, callbackPath = '/instagram-callback', timeout = 120000, protocol = 'http:' } = {}) {
    const http = await import('http');
    const https = await import('https');
    const url = await import('url');
    const fs = await import('fs');
    const path = await import('path');

    return new Promise((resolve, reject) => {
        let server = null;
        let resolved = false;

        const cleanup = () => {
            if (server) {
                try { server.close(); } catch { /* ignore */ }
                server = null;
            }
        };

        const timeoutId = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                cleanup();
                reject(new Error('OAuth flow timed out'));
            }
        }, timeout);

        const requestHandler = async (req, res) => {
            const parsedUrl = url.parse(req.url, true);

            if (parsedUrl.pathname === callbackPath) {
                const code = parsedUrl.query.code;
                const state = parsedUrl.query.state;
                const error = parsedUrl.query.error;

                oauthLog(`Callback received on ${callbackPath}, code=${code ? 'yes' : 'no'}, error=${error || 'none'}`);

                // Send response to browser
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<html><body><p>Authorization complete. You can close this window.</p><script>window.close()</script></body></html>');

                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeoutId);
                    cleanup();

                    if (error) {
                        reject(new Error(`OAuth error: ${error}`));
                        return;
                    }

                    if (!code) {
                        reject(new Error('No authorization code received'));
                        return;
                    }

                    resolve({ code, state: state || undefined });
                }
            } else {
                res.writeHead(404);
                res.end('Not found');
            }
        };

        if (protocol === 'https:') {
            // HTTPS mode — require mkcert certificates
            findDevCertificates().then(certs => {
                if (!certs) {
                    printCertInstructions().then(() => {
                        const errMsg = 'HTTPS OAuth callback requires mkcert development certificates in src/oauth/certs/. See instructions above.';
                        oauthLog(errMsg);
                        if (!resolved) {
                            resolved = true;
                            reject(new Error(errMsg));
                        }
                    }).catch(err => {
                        if (!resolved) {
                            resolved = true;
                            reject(new Error(`Failed to print cert instructions: ${err.message}`));
                        }
                    });
                    return;
                }

                let cert, key;
                try {
                    cert = fs.readFileSync(certs.certPath, 'utf8');
                    key = fs.readFileSync(certs.keyPath, 'utf8');
                } catch (readErr) {
                    const errMsg = `Failed to read HTTPS certificates: ${readErr.message}`;
                    oauthLog(errMsg);
                    if (!resolved) {
                        resolved = true;
                        reject(new Error(errMsg));
                    }
                    return;
                }

                server = https.createServer({ key, cert }, requestHandler);
                oauthLog('[INSTAGRAM] HTTPS OAuth callback server starting...');
                setupServerListeners();
            }).catch(err => {
                oauthLog(`Failed to find dev certificates: ${err.message}`);
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeoutId);
                    cleanup();
                    reject(new Error(`Failed to start OAuth callback server: ${err.message}`));
                }
            });
        } else {
            // HTTP mode (legacy/fallback)
            server = http.createServer(requestHandler);
            oauthLog('[INSTAGRAM] HTTP OAuth callback server starting...');
            setupServerListeners();
        }

        function setupServerListeners() {
            server.on('error', (err) => {
                oauthLog(`Callback server error: ${err.message}`);
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeoutId);
                    cleanup();
                    reject(new Error(`Failed to start OAuth callback server: ${err.message}`));
                }
            });

            server.listen(port, '127.0.0.1', () => {
                const scheme = protocol === 'https:' ? 'https' : 'http';
                oauthLog(`[OAUTH] Listening on ${scheme}://localhost:${port}${callbackPath}`);
            });
        }
    });
}
