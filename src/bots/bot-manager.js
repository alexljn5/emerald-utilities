// src/bots/bot-manager.js
// Main-process module that manages the infbot Discord bot.
// Supports two modes:
//   - 'docker'  : bot runs in a Docker container (default for dev/Windows)
//   - 'screen'  : bot runs in a GNU Screen session (default for homelab)

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== CONFIGURATION ====================
// Set BOT_MODE via environment variable or fall back to 'screen' on Linux, 'docker' elsewhere.
const isLinux = process.platform === 'linux';
const BOT_MODE = process.env.BOT_MODE || (isLinux ? 'screen' : 'docker');

// Docker config
const DOCKER_IMAGE = 'infbot';
const DOCKER_CONTAINER = 'infbot';
const DOCKER_BOT_DIR = __dirname; // src/bots/infbot-src/
const ENV_FILE = path.join(__dirname, '..', '..', 'src', '.env'); // src/.env

// Screen config (homelab)
// Default to the user's existing homelab path; override with BOT_SCREEN_DIR env var.
const SCREEN_SESSION = process.env.BOT_SCREEN_SESSION || 'infbot';
const SCREEN_BOT_DIR = process.env.BOT_SCREEN_DIR || '/home/alexljn5/INFHUB/infbot';
const SCREEN_ENTRY = process.env.BOT_SCREEN_ENTRY || 'src/bot-entry.js';
const SCREEN_START_CMD = `node ${SCREEN_ENTRY}`;

// ==================== STATE ====================
let botStatus = 'stopped'; // 'stopped' | 'starting' | 'running' | 'error'
let botError = null;
let botLogs = [];
const MAX_BOT_LOGS = 500;
let logBroadcast = null;

// ==================== HELPERS ====================
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

export function setLogBroadcast(callback) {
    logBroadcast = callback;
}

export function getBotMode() {
    return BOT_MODE;
}

// ==================== DOCKER IMPLEMENTATION ====================
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
    const result = execSync(fullArgs, {
        encoding: 'utf8',
        stdio: options.stdio || 'pipe',
        cwd: DOCKER_BOT_DIR,
        shell: false,
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
            cwd: DOCKER_BOT_DIR,
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

function streamDockerLogs() {
    if (logStreamChild) {
        logStreamChild.kill();
    }

    try {
        logStreamChild = spawn('docker', ['logs', '--follow', '--tail', '0', DOCKER_CONTAINER], {
            cwd: DOCKER_BOT_DIR,
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

// ==================== SCREEN IMPLEMENTATION ====================
function screenAvailable() {
    try {
        execSync('screen --version', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function screenSessionExists() {
    try {
        const output = execSync('screen -list', { encoding: 'utf8', stdio: 'pipe' });
        return output.includes(`\t${SCREEN_SESSION}\t`);
    } catch {
        return false;
    }
}

function streamScreenLogs() {
    if (logStreamChild) {
        logStreamChild.kill();
    }

    try {
        // Use screen hardcopy to capture the scrollback buffer periodically.
        const hardcopyPath = '/tmp/infbot-screen-hardcopy.txt';
        logStreamChild = spawn('screen', ['-S', SCREEN_SESSION, '-X', 'hardcopy', hardcopyPath]);

        logStreamChild.on('error', (err) => {
            addBotLog(`Log stream error: ${err.message}`, 'error');
        });

        logStreamChild.on('exit', () => {
            logStreamChild = null;
            try {
                if (fs.existsSync(hardcopyPath)) {
                    const content = fs.readFileSync(hardcopyPath, 'utf8');
                    const lines = content.split('\n');
                    for (const line of lines) {
                        if (line.trim()) {
                            addBotLog(line, 'stdout');
                        }
                    }
                }
            } catch {
                // ignore read errors
            }
        });
    } catch (err) {
        addBotLog(`Failed to start log stream: ${err.message}`, 'error');
    }
}

// ==================== PUBLIC API (MODE-AGNOSTIC) ====================
export function buildBotImage() {
    if (BOT_MODE !== 'docker') {
        return { ok: false, error: `Build is only supported in docker mode (current: ${BOT_MODE})` };
    }

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

export async function startBot() {
    if (botStatus === 'starting' || botStatus === 'running') {
        return { ok: false, error: 'Bot is already running or starting', status: botStatus };
    }

    botStatus = 'starting';
    botError = null;

    if (BOT_MODE === 'docker') {
        return startBotDocker();
    } else if (BOT_MODE === 'screen') {
        return await startBotScreen();
    } else {
        const errorMsg = `Unknown bot mode: ${BOT_MODE}`;
        botError = errorMsg;
        botStatus = 'error';
        addBotLog(errorMsg, 'error');
        return { ok: false, error: errorMsg, status: botStatus };
    }
}

function startBotDocker() {
    addBotLog('Starting infbot Docker container...', 'system');

    try {
        const existsResult = runDockerCommand(['ps', '-a', '--filter', `name=${DOCKER_CONTAINER}`, '--format', '{{.Names}}']);
        const containerExists = existsResult.trim() === DOCKER_CONTAINER;

        if (containerExists) {
            runDockerCommand(['start', DOCKER_CONTAINER]);
            addBotLog('Started existing container', 'system');
        } else {
            // Check if image exists; if not, build it first
            const imageExists = runDockerCommand(['images', '--format', '{{.Repository}}:{{.Tag}}', DOCKER_IMAGE]).trim();
            if (!imageExists) {
                addBotLog('Image not found, building...', 'system');
                const buildResult = buildBotImage();
                if (!buildResult.ok) {
                    return buildResult;
                }
            }

            const envFileArg = `--env-file=${ENV_FILE}`;
            runDockerCommand([
                'run', '-d',
                '--name', DOCKER_CONTAINER,
                '--restart', 'no',
                envFileArg,
                DOCKER_IMAGE
            ]);
            addBotLog('Created and started new container', 'system');
        }

        botStatus = 'running';
        addBotLog('Bot container is running', 'system');
        streamDockerLogs();

        return { ok: true, status: botStatus };

    } catch (err) {
        const errorMsg = `Failed to start bot container: ${err.message}`;
        botError = errorMsg;
        botStatus = 'error';
        addBotLog(errorMsg, 'error');
        return { ok: false, error: errorMsg, status: botStatus };
    }
}

async function startBotScreen() {
    addBotLog(`Starting infbot in screen session '${SCREEN_SESSION}'...`, 'system');

    try {
        if (!screenAvailable()) {
            throw new Error('GNU Screen is not installed or not available');
        }

        if (screenSessionExists()) {
            addBotLog('Screen session already exists', 'system');
            botStatus = 'running';
            streamScreenLogs();
            return { ok: true, status: botStatus, alreadyRunning: true };
        }

        if (!fs.existsSync(SCREEN_BOT_DIR)) {
            throw new Error(`Bot directory not found: ${SCREEN_BOT_DIR}`);
        }

        const entryPath = path.join(SCREEN_BOT_DIR, SCREEN_ENTRY);
        if (!fs.existsSync(entryPath)) {
            throw new Error(`Bot entry point not found: ${entryPath}`);
        }

        const cmd = `cd ${SCREEN_BOT_DIR} && ${SCREEN_START_CMD}`;
        execSync(`screen -dmS ${SCREEN_SESSION} bash -c "${cmd}; exec bash"`, { stdio: 'ignore' });

        // Wait a moment for the session to initialize
        await new Promise(resolve => setTimeout(resolve, 1500));

        if (screenSessionExists()) {
            botStatus = 'running';
            addBotLog(`Screen session '${SCREEN_SESSION}' started`, 'system');
            addBotLog(`Attach with: screen -r ${SCREEN_SESSION}`, 'system');
            streamScreenLogs();
            return { ok: true, status: botStatus };
        } else {
            throw new Error('Screen session failed to start');
        }

    } catch (err) {
        const errorMsg = `Failed to start bot in screen: ${err.message}`;
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

    addBotLog('Stopping infbot...', 'system');

    try {
        if (BOT_MODE === 'docker') {
            runDockerCommand(['stop', DOCKER_CONTAINER], { stdio: 'ignore' });
        } else if (BOT_MODE === 'screen') {
            if (screenSessionExists()) {
                execSync(`screen -S ${SCREEN_SESSION} -X quit`, { stdio: 'ignore' });
            }
        }

        botStatus = 'stopped';
        addBotLog('Bot stopped', 'system');
        return { ok: true, status: botStatus };
    } catch (err) {
        const errorMsg = `Failed to stop bot: ${err.message}`;
        addBotLog(errorMsg, 'error');
        return { ok: false, error: errorMsg };
    }
}

export async function restartBot() {
    addBotLog('Restarting infbot...', 'system');

    try {
        if (BOT_MODE === 'docker') {
            runDockerCommand(['restart', DOCKER_CONTAINER], { stdio: 'ignore' });
            botStatus = 'running';
            addBotLog('Bot container restarted', 'system');
            streamDockerLogs();
        } else if (BOT_MODE === 'screen') {
            // Stop then start
            if (screenSessionExists()) {
                execSync(`screen -S ${SCREEN_SESSION} -X quit`, { stdio: 'ignore' });
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
            const cmd = `cd ${SCREEN_BOT_DIR} && ${SCREEN_START_CMD}`;
            execSync(`screen -dmS ${SCREEN_SESSION} bash -c "${cmd}; exec bash"`, { stdio: 'ignore' });
            await new Promise(resolve => setTimeout(resolve, 1500));
            botStatus = 'running';
            addBotLog(`Screen session '${SCREEN_SESSION}' restarted`, 'system');
            streamScreenLogs();
        }

        return { ok: true, status: botStatus };
    } catch (err) {
        const errorMsg = `Failed to restart bot: ${err.message}`;
        botError = errorMsg;
        botStatus = 'error';
        addBotLog(errorMsg, 'error');
        return { ok: false, error: errorMsg };
    }
}

export function getBotStatus() {
    if (BOT_MODE === 'docker') {
        return getDockerStatus();
    } else if (BOT_MODE === 'screen') {
        return getScreenStatus();
    }

    return {
        status: 'error',
        isRunning: false,
        error: `Unknown bot mode: ${BOT_MODE}`,
        logCount: botLogs.length
    };
}

function getDockerStatus() {
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

function getScreenStatus() {
    try {
        const exists = screenSessionExists();
        return {
            status: exists ? 'running' : 'stopped',
            isRunning: exists,
            error: botError,
            logCount: botLogs.length,
            screenSession: SCREEN_SESSION
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
    if (BOT_MODE === 'docker') {
        return getDockerLogs(limit);
    } else if (BOT_MODE === 'screen') {
        return getScreenLogs(limit);
    }

    return { logs: [], total: 0, hasMore: false, error: `Unknown bot mode: ${BOT_MODE}` };
}

function getDockerLogs(limit = 100) {
    try {
        const output = runDockerCommand(['logs', '--tail', String(limit), DOCKER_CONTAINER], {
            stdio: 'pipe'
        });

        const lines = output.split('\n').filter(line => line.trim());
        const parsedLogs = lines.map((line, index) => {
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

function getScreenLogs(limit = 100) {
    try {
        const hardcopyPath = '/tmp/infbot-screen-hardcopy.txt';
        execSync(`screen -S ${SCREEN_SESSION} -X hardcopy ${hardcopyPath}`, { stdio: 'ignore' });

        if (!fs.existsSync(hardcopyPath)) {
            return { logs: [], total: 0, hasMore: false };
        }

        const content = fs.readFileSync(hardcopyPath, 'utf8');
        const lines = content.split('\n').filter(line => line.trim()).slice(-limit);

        const parsedLogs = lines.map((line, index) => ({
            id: `bot-screen-${index}`,
            timestamp: new Date().toISOString(),
            message: line,
            type: 'stdout'
        }));

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

// ==================== AUTO-START ====================
export async function autoStartBot() {
    if (BOT_MODE === 'docker') {
        if (!dockerAvailable()) {
            console.log('[BotManager] Docker not available, skipping auto-start');
            return { ok: false, error: 'Docker not available' };
        }

        const status = getBotStatus();
        if (status.isRunning) {
            console.log('[BotManager] Bot container already running');
            streamDockerLogs();
            return { ok: true, status: 'running', alreadyRunning: true };
        }

        const result = await startBot();
        if (result.ok) {
            console.log('[BotManager] Auto-start initiated');
        } else {
            console.log('[BotManager] Auto-start skipped:', result.error);
        }
        return result;

    } else if (BOT_MODE === 'screen') {
        if (!screenAvailable()) {
            console.log('[BotManager] Screen not available, skipping auto-start');
            return { ok: false, error: 'Screen not available' };
        }

        const status = getBotStatus();
        if (status.isRunning) {
            console.log('[BotManager] Bot screen session already running');
            streamScreenLogs();
            return { ok: true, status: 'running', alreadyRunning: true };
        }

        const result = await startBot();
        if (result.ok) {
            console.log('[BotManager] Auto-start initiated');
        } else {
            console.log('[BotManager] Auto-start skipped:', result.error);
        }
        return result;
    }

    return { ok: false, error: `Unknown bot mode: ${BOT_MODE}` };
}

// ==================== BUILD HELPER ====================
export function getBuildInstructions() {
    if (BOT_MODE === 'docker') {
        return {
            mode: 'docker',
            image: DOCKER_IMAGE,
            container: DOCKER_CONTAINER,
            dockerfile: path.join(DOCKER_BOT_DIR, 'Dockerfile'),
            buildCommand: `docker build -t ${DOCKER_IMAGE} ${DOCKER_BOT_DIR}`,
            runCommand: `docker run -d --name ${DOCKER_CONTAINER} --restart unless-stopped --env-file ${ENV_FILE} ${DOCKER_IMAGE}`,
            stopCommand: `docker stop ${DOCKER_CONTAINER}`,
            startCommand: `docker start ${DOCKER_CONTAINER}`,
            logsCommand: `docker logs -f ${DOCKER_CONTAINER}`,
            removeCommand: `docker rm -f ${DOCKER_CONTAINER}`
        };
    } else if (BOT_MODE === 'screen') {
        return {
            mode: 'screen',
            session: SCREEN_SESSION,
            botDir: SCREEN_BOT_DIR,
            entry: SCREEN_ENTRY,
            startCommand: `screen -dmS ${SCREEN_SESSION} bash -c "cd ${SCREEN_BOT_DIR} && ${SCREEN_START_CMD}; exec bash"`,
            stopCommand: `screen -S ${SCREEN_SESSION} -X quit`,
            attachCommand: `screen -r ${SCREEN_SESSION}`,
            logsCommand: `screen -S ${SCREEN_SESSION} -X hardcopy /tmp/infbot-screen-hardcopy.txt && cat /tmp/infbot-screen-hardcopy.txt`
        };
    }

    return { mode: BOT_MODE, error: 'Unknown mode' };
}

// ==================== CLEANUP ====================
let logStreamChild = null;

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
