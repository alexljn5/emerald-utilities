// src/bots/bot-discovery.js
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

// Known homelab hosts to scan
const KNOWN_HOSTS = [
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
const SSH_OPTS = ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'BatchMode=yes'];

function getSshConfig() {
    const config = readBotConfig();
    return {
        host: config.sshHost || '',
        user: config.sshUser || 'alexljn5',
        port: config.sshPort || '22',
        key: config.sshKey || path.join(process.env.USERPROFILE || process.env.HOME, '.ssh', 'id_ed25519')
    };
}

function sshCommand(host, user, port, key, localCmd) {
    const ssh = ['ssh', ...SSH_OPTS, '-p', port, '-i', key, `${user}@${host}`, localCmd];
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
    } catch {
        return { status: 1, stdout: '', stderr: 'SSH command failed' };
    }
}

function canSsh(host, user, port, key) {
    const result = runSshCommand(host, user, port, key, 'echo ok', { timeout: 5000 });
    return result.status === 0 && result.stdout.trim() === 'ok';
}

// ==================== DOCKER DISCOVERY ====================
function discoverDockerContainers(host, user, port, key) {
    const bots = [];
    try {
        // List all containers (running and stopped)
        const result = runSshCommand(host, user, port, key, 'docker ps -a --format "{{.Names}}|{{.Status}}|{{.Image}}"', { timeout: 15000 });
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
        const result = runSshCommand(host, user, port, key, 'screen -list', { timeout: 10000 });
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
        const result = runSshCommand(host, user, port, key, 'ps aux | grep -E "node.*bot|node.*infbot|node.*discord" | grep -v grep', { timeout: 10000 });
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
export async function discoverBots() {
    const sshConfig = getSshConfig();
    const allBots = [];

    // Scan known hosts in parallel
    const hostPromises = KNOWN_HOSTS.map(async (host) => {
        try {
            return await scanHost(host, sshConfig.user, sshConfig.port, sshConfig.key);
        } catch {
            return [];
        }
    });

    const hostResults = await Promise.all(hostPromises);
    for (const hostBots of hostResults) {
        allBots.push(...hostBots);
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
