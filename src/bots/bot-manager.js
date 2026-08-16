// src/bots/bot-manager.js
// Main-process module that manages the infbot Discord bot via Docker.
// The bot runs in a Docker container so it survives app/PC restarts.

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== CONFIGURATION ====================
const BOT_DIR = __dirname; // src/bots/
const DOCKER_IMAGE = 'infbot';
const DOCKER_CONTAINER = 'infbot';
const ENV_FILE = path.join(__dirname, '..', '..', 'src', '.env'); // src/.env

// ==================== STATE ====================
let botStatus = 'stopped'; // 'stopped' | 'starting' | 'running' | 'error'
let botError = null;
let botLogs = [];
const MAX_BOT_LOGS = 500;
let logBroadcast = null;

// ==================== DOCKER HELPERS ====================
function dockerAvailable() {
    try {
        execSync('docker --version', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function runDockerCommand(args, options = {}) {
    if (!dockerAvailable()) {
        throw new Error('Docker is not installed or not available');
    }

    const fullArgs = ['docker', ...args];
    const result = execSync(fullArgs.join(' '), {
        encoding: 'utf8',
        stdio: options.stdio || 'pipe',
        cwd: BOT_DIR,
        ...options
    });

    return result;
}

function runDockerCommandAsync(args, onStdout, onStderr) {
    if (!dockerAvailable()) {
        throw new Error('Docker is not installed or not available');
    }

    return new Promise((resolve, reject) => {
        const child = spawn('docker', args, {
            cwd: BOT_DIR,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        if (onStdout) {
            child.stdout.on('data', (data) => {
                const text = data.toString();
                stdout += text;
                onStdout(text);
            });
        }

        if (onStderr) {
            child.stderr.on('data', (data) => {
                const text = data.toString();
                stderr += text;
                onStderr(text);
            });
        }

        child.on('close', (code) => {
            if (code === 0) {
                resolve({ ok: true, stdout, stderr });
            } else {
                reject(new Error(stderr || `Docker command failed with code ${code}`));
            }
        });

        child.on('error', (err) => {
            reject(err);
        });
    });
}

// ==================== LOGGING ====================
function addBotLog(message, type = 'stdout') {
    const entry = {
        id: `bot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: new Date().toISOString(),
        message: String(message).trim(),
        type
    };

    botLogs.push(entry);
    if (botLogs.length > MAX_BOT_LOGS) {
        botLogs.splice(0, botLogs.length - MAX_BOT_LOGS);
    }

    if (logBroadcast) {
        logBroadcast(entry);
    }

    return entry;
}

function setLogBroadcast(callback) {
    logBroadcast = callback;
}

// ==================== CONTAINER MANAGEMENT ====================
export function buildBotImage() {
    try {
        addBotLog('Building infbot Docker image...', 'system');
        const output = runDockerCommand(['build', '-t', DOCKER_IMAGE, '.']);
        addBotLog('Docker image built successfully', 'system');
        return { ok: true, output };
    } catch (err) {
        const errorMsg = `Failed to build Docker image: ${err.message}`;
        botError = errorMsg;
        addBotLog(errorMsg, 'error');
        return { ok: false, error: errorMsg };
    }
}

export function startBot() {
    if (botStatus === 'starting' || botStatus === 'running') {
        return { ok: false, error: 'Bot is already running or starting', status: botStatus };
    }

    botStatus = 'starting';
    botError = null;
    addBotLog('Starting infbot Docker container...', 'system');

    try {
        // Check if container exists but is stopped
        const existsResult = runDockerCommand(['ps', '-a', '--filter', `name=${DOCKER_CONTAINER}`, '--format', '{{.Names}}']);
        const containerExists = existsResult.trim() === DOCKER_CONTAINER;

        if (containerExists) {
            // Start existing container
            runDockerCommand(['start', DOCKER_CONTAINER]);
            addBotLog('Started existing container', 'system');
        } else {
            // Run new container with restart policy
            const envFileArg = `--env-file=${ENV_FILE}`;
            runDockerCommand([
                'run', '-d',
                '--name', DOCKER_CONTAINER,
                '--restart', 'unless-stopped',
                envFileArg,
                DOCKER_IMAGE
            ]);
            addBotLog('Created and started new container', 'system');
        }

        botStatus = 'running';
        addBotLog('Bot container is running', 'system');

        // Start log streaming
        streamBotLogs();

        return { ok: true, status: botStatus };

    } catch (err) {
        const errorMsg = `Failed to start bot container: ${err.message}`;
        botError = errorMsg;
        botStatus = 'error';
        addBotLog(errorMsg, 'error');
        return { ok: false, error: errorMsg, status: botStatus };
    }
}

export function stopBot() {
    if (botStatus === 'stopped') {
        return { ok: true, alreadyStopped: true, status: botStatus };
    }

    addBotLog('Stopping infbot Docker container...', 'system');

    try {
        runDockerCommand(['stop', DOCKER_CONTAINER], { stdio: 'ignore' });
        botStatus = 'stopped';
        addBotLog('Bot container stopped', 'system');
        return { ok: true, status: botStatus };
    } catch (err) {
        const errorMsg = `Failed to stop bot container: ${err.message}`;
        addBotLog(errorMsg, 'error');
        return { ok: false, error: errorMsg };
    }
}

export function restartBot() {
    addBotLog('Restarting infbot Docker container...', 'system');

    try {
        runDockerCommand(['restart', DOCKER_CONTAINER], { stdio: 'ignore' });
        botStatus = 'running';
        addBotLog('Bot container restarted', 'system');
        streamBotLogs();
        return { ok: true, status: botStatus };
    } catch (err) {
        const errorMsg = `Failed to restart bot container: ${err.message}`;
        botError = errorMsg;
        botStatus = 'error';
        addBotLog(errorMsg, 'error');
        return { ok: false, error: errorMsg };
    }
}

export function getBotStatus() {
    try {
        const output = runDockerCommand([
            'ps', '-a',
            '--filter', `name=${DOCKER_CONTAINER}`,
            '--format', '{{.Names}}|{{.Status}}|{{.Image}}'
        ], { stdio: 'pipe' });

        const lines = output.trim().split('\n').filter(line => line.trim());
        const containerLine = lines.find(line => line.startsWith(DOCKER_CONTAINER));

        if (!containerLine) {
            return {
                status: 'stopped',
                isRunning: false,
                error: null,
                logCount: botLogs.length
            };
        }

        const parts = containerLine.split('|');
        const statusText = parts[1] || '';
        const isRunning = statusText.toLowerCase().startsWith('up');

        return {
            status: isRunning ? 'running' : 'stopped',
            isRunning,
            error: botError,
            logCount: botLogs.length,
            dockerStatus: statusText
        };
    } catch (err) {
        return {
            status: 'error',
            isRunning: false,
            error: err.message,
            logCount: botLogs.length
        };
    }
}

export function getBotLogs(limit = 100) {
    try {
        const output = runDockerCommand(['logs', '--tail', String(limit), DOCKER_CONTAINER], {
            stdio: 'pipe'
        });

        const lines = output.split('\n').filter(line => line.trim());
        const parsedLogs = lines.map((line, index) => {
            // Docker logs format: 2026-01-01T00:00:00.000000000Z message
            const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s+(.*)$/);
            if (match) {
                return {
                    id: `bot-docker-${index}`,
                    timestamp: match[1],
                    message: match[2],
                    type: match[2].startsWith('ERR') || match[2].includes('error') || match[2].includes('Error') ? 'stderr' : 'stdout'
                };
            }
            return {
                id: `bot-docker-${index}`,
                timestamp: new Date().toISOString(),
                message: line,
                type: 'stdout'
            };
        });

        return {
            logs: parsedLogs,
            total: parsedLogs.length,
            hasMore: false
        };
    } catch (err) {
        return {
            logs: [],
            total: 0,
            hasMore: false,
            error: err.message
        };
    }
}

export function clearBotLogs() {
    botLogs = [];
    return { ok: true };
}

// ==================== LOG STREAMING ====================
let logStreamChild = null;

function streamBotLogs() {
    if (logStreamChild) {
        logStreamChild.kill();
    }

    try {
        logStreamChild = spawn('docker', ['logs', '--follow', '--tail', '0', DOCKER_CONTAINER], {
            cwd: BOT_DIR,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        logStreamChild.stdout.on('data', (data) => {
            for (const line of data.toString().split('\n')) {
                if (line.trim()) {
                    addBotLog(line, 'stdout');
                }
            }
        });

        logStreamChild.stderr.on('data', (data) => {
            for (const line of data.toString().split('\n')) {
                if (line.trim()) {
                    addBotLog(line, 'stderr');
                }
            }
        });

        logStreamChild.on('error', (err) => {
            addBotLog(`Log stream error: ${err.message}`, 'error');
        });

        logStreamChild.on('exit', () => {
            logStreamChild = null;
        });
    } catch (err) {
        addBotLog(`Failed to start log stream: ${err.message}`, 'error');
    }
}

// ==================== AUTO-START ====================
export function autoStartBot() {
    // Check if Docker is available
    if (!dockerAvailable()) {
        console.log('[BotManager] Docker not available, skipping auto-start');
        return { ok: false, error: 'Docker not available' };
    }

    // Check if container is already running
    const status = getBotStatus();
    if (status.isRunning) {
        console.log('[BotManager] Bot container already running');
        streamBotLogs();
        return { ok: true, status: 'running', alreadyRunning: true };
    }

    // Start the bot
    const result = startBot();
    if (result.ok) {
        console.log('[BotManager] Auto-start initiated');
    } else {
        console.log('[BotManager] Auto-start skipped:', result.error);
    }
    return result;
}

// ==================== BUILD HELPER ====================
export function getBuildInstructions() {
    return {
        image: DOCKER_IMAGE,
        container: DOCKER_CONTAINER,
        dockerfile: path.join(BOT_DIR, 'Dockerfile'),
        buildCommand: `docker build -t ${DOCKER_IMAGE} ${BOT_DIR}`,
        runCommand: `docker run -d --name ${DOCKER_CONTAINER} --restart unless-stopped --env-file ${ENV_FILE} ${DOCKER_IMAGE}`,
        stopCommand: `docker stop ${DOCKER_CONTAINER}`,
        startCommand: `docker start ${DOCKER_CONTAINER}`,
        logsCommand: `docker logs -f ${DOCKER_CONTAINER}`,
        removeCommand: `docker rm -f ${DOCKER_CONTAINER}`
    };
}

// ==================== CLEANUP ====================
export function cleanup() {
    if (logStreamChild) {
        try {
            logStreamChild.kill();
        } catch {
            // ignore
        }
        logStreamChild = null;
    }
    botStatus = 'stopped';
    botLogs = [];
    botError = null;
}

export { setLogBroadcast };
