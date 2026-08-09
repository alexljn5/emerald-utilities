// src/services/cloudflareTunnel.js
// Cloudflare quick tunnel management for exposing local servers.
// Used by Instagram publisher to make local media available to Instagram Graph API.
// Main-process only — lazy-loads Node.js modules so this file can be safely
// imported in the renderer process.

const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g;

let tunnelProcess = null;
let tunnelUrl = null;
let tunnelResolve = null;
let tunnelReject = null;

async function getPath() {
    return await import('path');
}

async function getFileURLToPath() {
    const url = await import('url');
    return url.fileURLToPath;
}

/**
 * Sleep for the given number of milliseconds.
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Poll a URL until it returns a successful response.
 * Used to wait for Cloudflare tunnel readiness after the URL is detected.
 *
 * @param {string} url - The tunnel URL to poll
 * @param {number} [maxAttempts=30] - Maximum number of attempts (30 * 500ms = 15s)
 * @param {number} [intervalMs=500] - Milliseconds between attempts
 * @returns {Promise<void>}
 */
async function waitForTunnelReady(url, maxAttempts = 30, intervalMs = 500) {
    tunnelLog(`Waiting for tunnel readiness: ${url}`);

    for (let i = 0; i < maxAttempts; i++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);

            const response = await fetch(url, {
                method: 'GET',
                signal: controller.signal,
                redirect: 'follow',
            });
            clearTimeout(timeout);

            if (response.ok) {
                const elapsed = (i + 1) * intervalMs;
                tunnelLog(`Tunnel ready after ${elapsed}ms (attempt ${i + 1}/${maxAttempts})`);
                return;
            }

            tunnelLog(`[DEBUG] Tunnel not ready yet: HTTP ${response.status} (attempt ${i + 1}/${maxAttempts})`);
        } catch (err) {
            tunnelLog(`[DEBUG] Tunnel not ready yet: ${err.message} (attempt ${i + 1}/${maxAttempts})`);
        }

        await sleep(intervalMs);
    }

    throw new Error(
        `Cloudflare tunnel never became reachable at ${url} after ${maxAttempts * intervalMs}ms. ` +
        'The tunnel URL was detected but the edge connection was not established.'
    );
}

/**
 * Start a Cloudflare quick tunnel pointing to a local port.
 *
 * IMPORTANT: This function does NOT resolve when the URL first appears in
 * cloudflared's output. It waits until the tunnel is actually reachable
 * (HTTP 200 from the public URL) before resolving. This avoids a race
 * condition where Instagram's crawler hits the tunnel before Cloudflare
 * has registered the edge connection.
 *
 * @param {number} port - Local port to expose
 * @param {string} [binary='cloudflared'] - Path to cloudflared binary
 * @returns {Promise<string>} The public tunnel URL (e.g. https://xxxx.trycloudflare.com)
 */
export async function startTunnel(port, binary = 'cloudflared') {
    if (tunnelProcess) {
        throw new Error('Tunnel already running. Call stopTunnel() first.');
    }

    const path = await getPath();
    const fileURLToPath = await getFileURLToPath();
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const { spawn } = await import('child_process');

    return new Promise((resolve, reject) => {
        tunnelResolve = resolve;
        tunnelReject = reject;

        const args = ['tunnel', '--url', `http://127.0.0.1:${port}`];

        tunnelLog(`Starting Cloudflare tunnel: ${binary} ${args.join(' ')}`);

        tunnelProcess = spawn(binary, args, {
            cwd: __dirname,
            shell: process.platform === 'win32',
        });

        let stdoutBuffer = '';
        let stderrBuffer = '';
        let urlDetected = false;

        const tryDetectUrl = (buffer) => {
            const matches = buffer.match(TUNNEL_URL_REGEX);
            if (matches && matches.length > 0 && !tunnelUrl) {
                tunnelUrl = matches[matches.length - 1];
                urlDetected = true;
                tunnelLog(`Public URL detected: ${tunnelUrl}`);

                // Do NOT resolve here — wait for tunnel readiness
                // The URL appearing in logs does not mean the edge is connected yet
                waitForTunnelReady(tunnelUrl)
                    .then(() => {
                        tunnelLog(`Tunnel fully ready: ${tunnelUrl}`);
                        resolve(tunnelUrl);
                    })
                    .catch((err) => {
                        tunnelLog(`Tunnel readiness check failed: ${err.message}`);
                        cleanup();
                        reject(new Error(`Tunnel started but never became reachable: ${err.message}`));
                    });
            }
        };

        tunnelProcess.stdout.on('data', (data) => {
            const chunk = data.toString();
            stdoutBuffer += chunk;
            tryDetectUrl(stdoutBuffer);
        });

        tunnelProcess.stderr.on('data', (data) => {
            const chunk = data.toString();
            stderrBuffer += chunk;
            tunnelLog(`Tunnel stderr: ${chunk.trim()}`);
            tryDetectUrl(stderrBuffer);
        });

        tunnelProcess.on('error', (err) => {
            tunnelLog(`Tunnel spawn error: ${err.message}`);
            cleanup();
            reject(new Error(`Failed to start Cloudflare tunnel: ${err.message}`));
        });

        tunnelProcess.on('exit', (code, signal) => {
            tunnelLog(`Tunnel exited: code=${code}, signal=${signal}`);
            cleanup();
        });
    });
}

/**
 * Stop the running Cloudflare tunnel.
 */
export function stopTunnel() {
    if (tunnelProcess) {
        tunnelLog('Stopping Cloudflare tunnel...');
        tunnelProcess.kill('SIGTERM');
        cleanup();
    }
}

/**
 * Get the current tunnel URL if a tunnel is active.
 * @returns {string | null}
 */
export function getTunnelUrl() {
    return tunnelUrl;
}

/**
 * Check if a tunnel is currently running.
 * @returns {boolean}
 */
export function isTunnelRunning() {
    return tunnelProcess !== null && !tunnelProcess.killed;
}

function cleanup() {
    tunnelProcess = null;
    tunnelUrl = null;
    if (tunnelReject) {
        tunnelReject(new Error('Tunnel stopped unexpectedly'));
        tunnelReject = null;
        tunnelResolve = null;
    }
}

function tunnelLog(...args) {
    console.log('[CLOUDFLARE]', ...args);
}
