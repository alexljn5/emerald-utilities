// src/containers/bot-discovery.js
// Discovers bots on the local network and remote hosts using internal tools.
// Supports Docker containers, GNU Screen sessions, and Node.js processes.

import { execSync, spawn, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== CONFIG ====================
const BOT_CONFIG_PATH = path.join(__dirname, 'bot-config.json');

function readBotConfig() {
    try {
        if (fs.existsSync(BOT_CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(BOT_CONFIG_PATH, 'utf8'));
        }
    } catch {
        // ignore
    }
    return {};
}

// Primary homelab host via Tailscale MagicDNS.
// This replaces the old IP-based KNOWN_HOSTS scanning that caused lag.
// Tailscale is an OS-level networking layer — we simply use the MagicDNS
// hostname and let the operating system resolve it however it is reachable.
const TAILSCALE_HOST = process.env.BOT_TAILSCALE_HOST || 'infhub-server';

// Known homelab hosts to scan. The Tailscale MagicDNS hostname is always
// tried first; LAN IPs are kept only as a fallback for environments where
// Tailscale is not active. To disable LAN fallback entirely, set
// BOT_TAILSCALE_HOST_ONLY=true.
const KNOWN_HOSTS = process.env.BOT_TAILSCALE_HOST_ONLY === 'true'
    ? [TAILSCALE_HOST]
    : [
        TAILSCALE_HOST,
        '192.168.2.27',
        '192.168.1.100',
        '192.168.1.50',
        '192.168.1.10',
        '192.168.0.100'
    ];

// Common bot container/session names to look for
const BOT_NAMES = ['infbot', 'emerald-bot', 'discord-bot', 'bot'];

// Common ports bots might run on
const BOT_PORTS = [3000, 3001, 8080, 8888, 9000];

// ==================== SSH HELPERS ====================
// BatchMode=yes prevents interactive password/passphrase prompts.
// If your key is passphrase-protected, start ssh-agent and add the key
// before launching the app: `eval $(ssh-agent) && ssh-add ~/.ssh/id_ed25519`
const SSH_OPTS = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'BatchMode=yes',
    '-o', 'AddKeysToAgent=yes',
    '-o', 'IdentitiesOnly=yes'
];

function resolveSshKey(configuredKey) {
    // If the configured key is a Windows path (C:\...) on Linux/macOS,
    // or a Unix path (~/.ssh/...) on Windows, fall back to the platform default.
    const platformDefault = path.join(process.env.USERPROFILE || process.env.HOME, '.ssh', 'id_ed25519');
    const isWindows = process.platform === 'win32';
    const keyLooksWindows = /^[A-Za-z]:[\\/]/.test(configuredKey);
    const keyLooksUnix = configuredKey.startsWith('/');

    if (isWindows && keyLooksUnix) return platformDefault;
    if (!isWindows && keyLooksWindows) return platformDefault;
    return configuredKey || platformDefault;
}

function getSshConfig() {
    const config = readBotConfig();
    return {
        host: config.sshHost || '',
        user: config.sshUser || 'emerald-user',
        port: config.sshPort || '22',
        key: resolveSshKey(config.sshKey || '')
    };
}

function sshCommand(host, user, port, key, localCmd) {
    // Prepend a full PATH export — the remote server's default PATH may be
    // broken (e.g. only /usr/share/archcraft/scripts), causing "command not
    // found" for docker, screen, etc.
    const remoteCmd = `export PATH=/usr/local/sbin:/usr/local/bin:/usr/bin:/usr/sbin:/usr/lib/docker:/bin:/sbin && ${localCmd}`;
    const ssh = ['ssh', ...SSH_OPTS, '-p', port, '-i', key, `${user}@${host}`, remoteCmd];
    return ssh;
}

function runSshCommand(host, user, port, key, cmd, options = {}) {
    const sshCmd = sshCommand(host, user, port, key, cmd);
    try {
        return spawnSync('ssh', sshCmd.slice(1), {
            encoding: 'utf8',
            stdio: options.stdio || 'pipe',
            timeout: options.timeout || 10000,
            ...options
        });
    } catch (err) {
        return { status: 1, stdout: '', stderr: String(err?.message || err || 'SSH command failed') };
    }
}

function canSsh(host, user, port, key) {
    const result = runSshCommand(host, user, port, key, 'echo ok', { timeout: 3000 });
    return result.status === 0 && result.stdout.trim() === 'ok';
}

/**
 * Test SSH connectivity to a host and return a detailed result.
 * Used by the dashboard to diagnose connection issues.
 * @returns {{ ok: boolean, host: string, error?: string, stderr?: string }}
 */
export function testSshConnection(host, user, port, key) {
    const result = runSshCommand(host, user, port, key, 'echo ok', { timeout: 5000 });
    if (result.status === 0 && result.stdout.trim() === 'ok') {
        return { ok: true, host };
    }
    return {
        ok: false,
        host,
        error: result.stderr?.trim() || `SSH exited with code ${result.status}`,
        stderr: result.stderr?.trim() || ''
    };
}

// ==================== DOCKER DISCOVERY ====================
function discoverDockerContainers(host, user, port, key) {
    const bots = [];
    try {
        // List all containers (running and stopped)
        const result = runSshCommand(host, user, port, key, 'docker ps -a --format "{{.Names}}|{{.Status}}|{{.Image}}"', { timeout: 8000 });
        if (result.status !== 0) return bots;

        const lines = result.stdout.trim().split('\n').filter(line => line.trim());
        for (const line of lines) {
            const parts = line.split('|');
            const name = parts[0] || '';
            const status = parts[1] || '';
            const image = parts[2] || '';

            // Check if this looks like a bot container
            const isBot = BOT_NAMES.some(botName => name.toLowerCase().includes(botName));
            if (isBot) {
                const isRunning = status.toLowerCase().startsWith('up');
                bots.push({
                    id: `docker-${host}-${name}`,
                    name: name,
                    type: 'docker',
                    host: host,
                    status: isRunning ? 'running' : 'stopped',
                    isRunning: isRunning,
                    details: {
                        image: image,
                        status: status,
                        containerName: name
                    }
                });
            }
        }
    } catch {
        // ignore
    }
    return bots;
}

// ==================== SCREEN DISCOVERY ====================
function discoverScreenSessions(host, user, port, key) {
    const bots = [];
    try {
        const result = runSshCommand(host, user, port, key, 'screen -list', { timeout: 5000 });
        if (result.status !== 0) return bots;

        const output = result.stdout;
        for (const botName of BOT_NAMES) {
            if (output.includes(`\t${botName}\t`)) {
                bots.push({
                    id: `screen-${host}-${botName}`,
                    name: botName,
                    type: 'screen',
                    host: host,
                    status: 'running',
                    isRunning: true,
                    details: {
                        session: botName
                    }
                });
            }
        }
    } catch {
        // ignore
    }
    return bots;
}

// ==================== PROCESS DISCOVERY ====================
function discoverBotProcesses(host, user, port, key) {
    const bots = [];
    try {
        // Check for Node.js processes that might be bots
        const result = runSshCommand(host, user, port, key, 'ps aux | grep -E "node.*bot|node.*infbot|node.*discord" | grep -v grep', { timeout: 5000 });
        if (result.status !== 0) return bots;

        const lines = result.stdout.trim().split('\n').filter(line => line.trim());
        for (const line of lines) {
            const parts = line.split(/\s+/);
            const pid = parts[1] || '';
            const command = parts.slice(10).join(' ') || '';

            bots.push({
                id: `process-${host}-${pid}`,
                name: `bot-process-${pid}`,
                type: 'process',
                host: host,
                status: 'running',
                isRunning: true,
                details: {
                    pid: pid,
                    command: command
                }
            });
        }
    } catch {
        // ignore
    }
    return bots;
}

// ==================== NETWORK SCAN ====================
async function scanHost(host, user, port, key) {
    const bots = [];

    // Check if host is reachable via SSH
    if (!canSsh(host, user, port, key)) {
        return bots;
    }

    // Discover bots via different methods
    bots.push(...discoverDockerContainers(host, user, port, key));
    bots.push(...discoverScreenSessions(host, user, port, key));
    bots.push(...discoverBotProcesses(host, user, port, key));

    return bots;
}

// ==================== PUBLIC API ====================

/**
 * Discover bots from remote hosts. Uses Tailscale (infhub-server) first with short timeouts to prevent lag.
 * @returns {Promise<DiscoveredBot[]>}
 */
export async function discoverBots() {
    const sshConfig = getSshConfig();
    const allBots = [];

    // Scan known hosts in parallel with short timeouts to prevent lag
    const hostPromises = KNOWN_HOSTS.map(async (host) => {
        try {
            return await scanHost(host, sshConfig.user, sshConfig.port, sshConfig.key);
        } catch {
            return [];
        }
    });

    const hostResults = await Promise.allSettled(hostPromises);
    for (const result of hostResults) {
        if (result.status === 'fulfilled') {
            allBots.push(...result.value);
        }
    }

    // Also check local Docker if available
    try {
        const localDocker = discoverLocalDocker();
        allBots.push(...localDocker);
    } catch {
        // ignore
    }

    return allBots;
}

/**
 * Discover ALL Docker containers from the homelab server via Tailscale.
 * Connects to infhub-server (Tailscale MagicDNS) and lists all containers.
 * This is the primary method for the Container Viewer - it does NOT create containers,
 * it only reads the Docker state from the remote server.
 * @returns {Promise<RemoteContainer[]>}
 */
export async function discoverRemoteContainers() {
    const sshConfig = getSshConfig();
    const allContainers = [];
    const errors = [];

    // Try Tailscale MagicDNS first, then fall back to LAN IP
    const hostsToTry = [TAILSCALE_HOST, '192.168.2.27'];
    if (process.env.BOT_TAILSCALE_HOST_ONLY === 'true') {
        hostsToTry.pop(); // remove LAN fallback
    }

    for (const host of hostsToTry) {
        try {
            const result = runSshCommand(
                host,
                sshConfig.user,
                sshConfig.port,
                sshConfig.key,
                'docker ps -a --format "{{.ID}}|{{.Names}}|{{.Status}}|{{.Image}}|{{.Ports}}|{{.CreatedAt}}"',
                { timeout: 8000 }
            );

            if (result.status === 0 && result.stdout.trim()) {
                const containers = result.stdout.trim().split('\n').map(line => {
                    const parts = line.split('|');
                    const status = parts[2] || '';
                    const isRunning = status.toLowerCase().startsWith('up') && !status.toLowerCase().includes('exited');
                    return {
                        id: parts[0] || '',
                        name: parts[1] || '',
                        status: isRunning ? 'running' : (status.toLowerCase().includes('exited') ? 'exited' : 'unknown'),
                        image: parts[3] || '',
                        ports: parts[4] || '',
                        createdAt: parts[5] || '',
                        host: host,
                    };
                }).filter(c => c.name);

                if (containers.length > 0) {
                    allContainers.push(...containers);
                }
            } else {
                errors.push({
                    host,
                    error: result.stderr?.trim() || `SSH exited with code ${result.status}`
                });
            }
        } catch (err) {
            errors.push({
                host,
                error: String(err?.message || err || 'SSH command failed')
            });
        }
    }

    // Also check local Docker if available (no SSH needed)
    try {
        const localContainers = discoverLocalContainers();
        allContainers.push(...localContainers);
    } catch (err) {
        errors.push({ host: 'localhost', error: String(err?.message || err || 'Local Docker failed') });
    }

    return { containers: allContainers, errors };
}

function discoverLocalDocker() {
    const bots = [];
    try {
        const result = spawnSync('docker', ['ps', '-a', '--format', '{{.Names}}|{{.Status}}|{{.Image}}'], {
            encoding: 'utf8',
            stdio: 'pipe',
            timeout: 10000
        });

        if (result.status !== 0) return bots;

        const lines = result.stdout.trim().split('\n').filter(line => line.trim());
        for (const line of lines) {
            const parts = line.split('|');
            const name = parts[0] || '';
            const status = parts[1] || '';
            const image = parts[2] || '';

            const isBot = BOT_NAMES.some(botName => name.toLowerCase().includes(botName));
            if (isBot) {
                const isRunning = status.toLowerCase().startsWith('up');
                bots.push({
                    id: `docker-local-${name}`,
                    name: name,
                    type: 'docker',
                    host: 'localhost',
                    status: isRunning ? 'running' : 'stopped',
                    isRunning: isRunning,
                    details: {
                        image: image,
                        status: status,
                        containerName: name
                    }
                });
            }
        }
    } catch {
        // ignore
    }
    return bots;
}

/**
 * Discover ALL Docker containers on the local machine (not just bot-named ones).
 * Used by the Container Viewer to show all containers, not just bots.
 * @returns {RemoteContainer[]}
 */
function discoverLocalContainers() {
    const containers = [];
    try {
        const result = spawnSync('docker', ['ps', '-a', '--format', '{{.ID}}|{{.Names}}|{{.Status}}|{{.Image}}|{{.Ports}}|{{.CreatedAt}}'], {
            encoding: 'utf8',
            stdio: 'pipe',
            timeout: 10000
        });

        if (result.status !== 0) return containers;

        const lines = result.stdout.trim().split('\n').filter(line => line.trim());
        for (const line of lines) {
            const parts = line.split('|');
            const status = parts[2] || '';
            const isRunning = status.toLowerCase().startsWith('up') && !status.toLowerCase().includes('exited');
            containers.push({
                id: parts[0] || '',
                name: parts[1] || '',
                status: isRunning ? 'running' : (status.toLowerCase().includes('exited') ? 'exited' : 'unknown'),
                image: parts[3] || '',
                ports: parts[4] || '',
                createdAt: parts[5] || '',
                host: 'localhost',
            });
        }
    } catch {
        // ignore
    }
    return containers;
}

export function getKnownHosts() {
    return [...KNOWN_HOSTS];
}

export function addKnownHost(host) {
    if (!KNOWN_HOSTS.includes(host)) {
        KNOWN_HOSTS.push(host);
    }
}

export function removeKnownHost(host) {
    const index = KNOWN_HOSTS.indexOf(host);
    if (index > -1) {
        KNOWN_HOSTS.splice(index, 1);
    }
}
