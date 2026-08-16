// src/bots/bot-manager.js
// Main-process module that manages Discord bots.
// Supports multiple modes:
//   - 'docker'  : bot runs in a Docker container
//   - 'screen'  : bot runs in a GNU Screen session
//   - 'script'  : bot runs as a detached Node.js process (abstract, auto-detects scripts)

import { execSync, spawn, spawnSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== CONFIG ====================
const CONFIG_PATH = path.join(__dirname, 'bot-config.json');

function readBotConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        }
    } catch {
        // ignore
    }
    return { autoStart: true };
}

function writeBotConfig(config) {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    } catch {
        // ignore
    }
}

export function getAutoStartEnabled() {
    return readBotConfig().autoStart !== false;
}

export function setAutoStartEnabled(enabled) {
    const config = readBotConfig();
    config.autoStart = enabled;
    writeBotConfig(config);
}

export function getSshConfig() {
    return {
        host: SSH_HOST,
        user: SSH_USER,
        port: SSH_PORT,
        key: SSH_KEY
    };
}

export function setSshConfig(host, user, port, key) {
    const config = readBotConfig();
    config.sshHost = host;
    config.sshUser = user;
    config.sshPort = port;
    config.sshKey = key;
    writeBotConfig(config);
    return getSshConfig();
}

// ==================== CONFIGURATION ====================
// Set BOT_MODE via environment variable or fall back to 'script' (most abstract).
// Available modes: 'docker', 'screen', 'script'
const BOT_MODE = process.env.BOT_MODE || 'script';

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

// Script config (abstract mode - auto-detects and runs bot scripts)
// Use process.cwd() so it works both in dev and in the built Electron app
const SCRIPT_BOT_DIR = process.env.BOT_SCRIPT_DIR || path.join(process.cwd(), 'src', 'bots', 'infbot-src');
const SCRIPT_ENTRY = process.env.BOT_SCRIPT_ENTRY || 'bot-entry.js';
const SCRIPT_START_CMD = `node ${SCRIPT_ENTRY}`;
let scriptProcess = null;
let scriptPid = null;
let scriptRemote = isRemote(); // script mode can also run remotely via SSH

// SSH remote host config (for managing bot on homelab from Windows)
// Read from bot-config.json with env var fallbacks
function getSshConfigFromFile() {
    const config = readBotConfig();
    return {
        host: config.sshHost || process.env.BOT_SSH_HOST || '',
        user: config.sshUser || process.env.BOT_SSH_USER || 'alexljn5',
        port: config.sshPort || process.env.BOT_SSH_PORT || '22',
        key: config.sshKey || process.env.BOT_SSH_KEY || path.join(process.env.USERPROFILE || process.env.HOME, '.ssh', 'id_ed25519')
    };
}

const SSH_CONFIG = getSshConfigFromFile();
const SSH_HOST = SSH_CONFIG.host;
const SSH_USER = SSH_CONFIG.user;
const SSH_PORT = SSH_CONFIG.port;
const SSH_KEY = SSH_CONFIG.key;
const SSH_OPTS = ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null'];

function isRemote() {
    return Boolean(SSH_HOST);
}

function sshCommand(localCmd) {
    if (!isRemote()) return localCmd;
    const ssh = ['ssh', ...SSH_OPTS, '-p', SSH_PORT, '-i', SSH_KEY, `${SSH_USER}@${SSH_HOST}`, localCmd];
    return ssh;
}

function runSshCommand(cmd, options = {}) {
    if (!isRemote()) {
        return execSync(cmd, { encoding: 'utf8', stdio: options.stdio || 'pipe', shell: false, ...options });
    }
    const sshCmd = sshCommand(cmd);
    // execSync expects a string, not an array. Use execFileSync for array args.
    return execFileSync('ssh', sshCmd.slice(1), { encoding: 'utf8', stdio: options.stdio || 'pipe', ...options });
}

function runSshCommandAsync(cmd, onStdout, onStderr) {
    if (!isRemote()) {
        return new Promise((resolve, reject) => {
            const child = spawn(cmd, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            if (onStdout) child.stdout.on('data', (data) => { const text = data.toString(); stdout += text; onStdout(text); });
            if (onStderr) child.stderr.on('data', (data) => { const text = data.toString(); stderr += text; onStderr(text); });
            child.on('close', (code) => code === 0 ? resolve({ ok: true, stdout, stderr }) : reject(new Error(stderr || `Command failed with code ${code}`)));
            child.on('error', reject);
        });
    }
    const sshCmd = sshCommand(cmd);
    return new Promise((resolve, reject) => {
        const child = spawn('ssh', sshCmd.slice(1), { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        if (onStdout) child.stdout.on('data', (data) => { const text = data.toString(); stdout += text; onStdout(text); });
        if (onStderr) child.stderr.on('data', (data) => { const text = data.toString(); stderr += text; onStderr(text); });
        child.on('close', (code) => code === 0 ? resolve({ ok: true, stdout, stderr }) : reject(new Error(stderr || `SSH command failed with code ${code}`)));
        child.on('error', reject);
    });
}

// ==================== SCRIPT MODE HELPERS ====================
function scriptAvailable() {
    try {
        execSync('node --version', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

export function detectBotScripts(dir = SCRIPT_BOT_DIR) {
    const scripts = [];
    try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            if (file.endsWith('.js') && file !== 'bot-manager.js' && file !== 'bot-ipc.js') {
                scripts.push(file);
            }
        }
        // Check for package.json main entry
        const pkgPath = path.join(dir, 'package.json');
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                if (pkg.main) {
                    scripts.unshift(pkg.main); // prioritize package.json main
                }
            } catch {
                // ignore
            }
        }
    } catch {
        // ignore
    }
    return scripts;
}

function streamScriptLogs() {
    if (logStreamChild) {
        logStreamChild.kill();
    }

    if (!scriptProcess || !scriptProcess.stdout) {
        addBotLog('No script process to stream logs from', 'error');
        return;
    }

    try {
        scriptProcess.stdout.on('data', (data) => {
            for (const line of data.toString().split('\n')) {
                if (line.trim()) {
                    addBotLog(line, 'stdout');
                }
            }
        });

        scriptProcess.stderr.on('data', (data) => {
            for (const line of data.toString().split('\n')) {
                if (line.trim()) {
                    addBotLog(line, 'stderr');
                }
            }
        });

        scriptProcess.on('error', (err) => {
            addBotLog(`Script process error: ${err.message}`, 'error');
        });

        scriptProcess.on('exit', (code, signal) => {
            addBotLog(`Script process exited with code ${code}, signal ${signal}`, 'system');
            scriptProcess = null;
            scriptPid = null;
            if (botStatus === 'running') {
                botStatus = 'stopped';
            }
        });
    } catch (err) {
        addBotLog(`Failed to stream script logs: ${err.message}`, 'error');
    }
}

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
    if (isRemote()) {
        // For remote, we just need SSH access; Docker runs on the remote host
        return true;
    }
    try {
        execSync('docker --version', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function runDockerCommand(args, options = {}) {
    if (isRemote()) {
        const dockerArgs = ['docker', ...args].join(' ');
        const result = runSshCommand(dockerArgs, { ...options, cwd: undefined });
        return result;
    }

    if (!dockerAvailable()) {
        throw new Error('Docker is not installed or not available');
    }

    const result = spawnSync('docker', args, {
        encoding: 'utf8',
        stdio: options.stdio || 'pipe',
        cwd: DOCKER_BOT_DIR,
        ...options
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(result.stderr?.toString()?.trim() || `Docker command failed with code ${result.status}`);
    }

    return result.stdout?.toString() ?? '';
}

function runDockerCommandAsync(args, onStdout, onStderr) {
    if (isRemote()) {
        const dockerArgs = ['docker', ...args];
        return runSshCommandAsync(dockerArgs.join(' '), onStdout, onStderr);
    }

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
        if (isRemote()) {
            // For remote, poll logs periodically via SSH
            logStreamChild = setInterval(async () => {
                try {
                    const output = runDockerCommand(['logs', '--tail', '50', DOCKER_CONTAINER]);
                    const lines = output.split('\n').filter(line => line.trim());
                    for (const line of lines) {
                        addBotLog(line, 'stdout');
                    }
                } catch {
                    // ignore poll errors
                }
            }, 2000);
            return;
        }

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
    if (isRemote()) {
        // For remote, we just need SSH access; screen runs on the remote host
        return true;
    }
    try {
        execSync('screen --version', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function screenSessionExists() {
    if (isRemote()) {
        try {
            const output = runSshCommand('screen -list');
            return output.includes(`\t${SCREEN_SESSION}\t`);
        } catch {
            return false;
        }
    }
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
        if (isRemote()) {
            // For remote, poll screen hardcopy via SSH periodically
            logStreamChild = setInterval(async () => {
                try {
                    const hardcopyPath = '/tmp/infbot-screen-hardcopy.txt';
                    runSshCommand(`screen -S ${SCREEN_SESSION} -X hardcopy ${hardcopyPath}`);
                    const content = runSshCommand(`cat ${hardcopyPath}`);
                    const lines = content.split('\n');
                    for (const line of lines) {
                        if (line.trim()) {
                            addBotLog(line, 'stdout');
                        }
                    }
                } catch {
                    // ignore poll errors
                }
            }, 2000);
            return;
        }

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
    } else if (BOT_MODE === 'script') {
        return await startBotScript();
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

async function startBotScript() {
    addBotLog('Starting bot as script process...', 'system');

    try {
        if (!scriptAvailable()) {
            throw new Error('Node.js is not installed or not available');
        }

        // Check if already running
        if (scriptProcess && !scriptProcess.killed) {
            addBotLog('Script process already running', 'system');
            botStatus = 'running';
            return { ok: true, status: botStatus, alreadyRunning: true };
        }

        const entryPath = path.join(SCRIPT_BOT_DIR, SCRIPT_ENTRY);

        if (scriptRemote) {
            // Remote execution via SSH
            if (!fs.existsSync(entryPath)) {
                throw new Error(`Bot entry point not found on remote: ${entryPath}`);
            }
            const cmd = `cd ${SCRIPT_BOT_DIR} && ${SCRIPT_START_CMD}`;
            runSshCommand(`screen -dmS ${SCREEN_SESSION} bash -c "${cmd}; exec bash"`, { stdio: 'ignore' });
            await new Promise(resolve => setTimeout(resolve, 1500));
            botStatus = 'running';
            addBotLog(`Remote script started via SSH on ${SSH_HOST}`, 'system');
            streamScreenLogs(); // reuse screen log streaming for remote
            return { ok: true, status: botStatus };
        } else {
            // Local execution
            if (!fs.existsSync(entryPath)) {
                throw new Error(`Bot entry point not found: ${entryPath}`);
            }

            // Spawn the bot process detached so it survives app restarts
            scriptProcess = spawn('node', [SCRIPT_ENTRY], {
                cwd: SCRIPT_BOT_DIR,
                detached: true,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env }
            });

            scriptPid = scriptProcess.pid;
            addBotLog(`Script process started with PID ${scriptPid}`, 'system');

            // Unref so the child can outlive the parent
            scriptProcess.unref();

            // Wait a moment for the process to initialize
            await new Promise(resolve => setTimeout(resolve, 1500));

            // Check if process is still alive
            try {
                process.kill(scriptPid, 0); // signal 0 checks if process exists
                botStatus = 'running';
                addBotLog('Bot script process is running', 'system');
                streamScriptLogs();
                return { ok: true, status: botStatus };
            } catch {
                throw new Error('Script process exited immediately');
            }
        }

    } catch (err) {
        const errorMsg = `Failed to start bot script: ${err.message}`;
        botError = errorMsg;
        botStatus = 'error';
        addBotLog(errorMsg, 'error');
        scriptProcess = null;
        scriptPid = null;
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

        if (isRemote()) {
            const cmd = `cd ${SCREEN_BOT_DIR} && ${SCREEN_START_CMD}`;
            runSshCommand(`screen -dmS ${SCREEN_SESSION} bash -c "${cmd}; exec bash"`, { stdio: 'ignore' });
        } else {
            if (!fs.existsSync(SCREEN_BOT_DIR)) {
                throw new Error(`Bot directory not found: ${SCREEN_BOT_DIR}`);
            }

            const entryPath = path.join(SCREEN_BOT_DIR, SCREEN_ENTRY);
            if (!fs.existsSync(entryPath)) {
                throw new Error(`Bot entry point not found: ${entryPath}`);
            }

            const cmd = `cd ${SCREEN_BOT_DIR} && ${SCREEN_START_CMD}`;
            execSync(`screen -dmS ${SCREEN_SESSION} bash -c "${cmd}; exec bash"`, { stdio: 'ignore' });
        }

        // Wait a moment for the session to initialize
        await new Promise(resolve => setTimeout(resolve, 1500));

        if (screenSessionExists()) {
            botStatus = 'running';
            addBotLog(`Screen session '${SCREEN_SESSION}' started`, 'system');
            addBotLog(isRemote() ? `SSH: ${SSH_USER}@${SSH_HOST}` : `Attach with: screen -r ${SCREEN_SESSION}`, 'system');
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

    addBotLog('Stopping bot...', 'system');

    try {
        if (BOT_MODE === 'docker') {
            runDockerCommand(['stop', DOCKER_CONTAINER], { stdio: 'ignore' });
        } else if (BOT_MODE === 'screen') {
            if (screenSessionExists()) {
                if (isRemote()) {
                    runSshCommand(`screen -S ${SCREEN_SESSION} -X quit`, { stdio: 'ignore' });
                } else {
                    execSync(`screen -S ${SCREEN_SESSION} -X quit`, { stdio: 'ignore' });
                }
            }
        } else if (BOT_MODE === 'script') {
            if (scriptRemote) {
                if (screenSessionExists()) {
                    runSshCommand(`screen -S ${SCREEN_SESSION} -X quit`, { stdio: 'ignore' });
                }
            } else if (scriptProcess && !scriptProcess.killed) {
                scriptProcess.kill('SIGTERM');
                scriptProcess = null;
                scriptPid = null;
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
    addBotLog('Restarting bot...', 'system');

    try {
        if (BOT_MODE === 'docker') {
            runDockerCommand(['restart', DOCKER_CONTAINER], { stdio: 'ignore' });
            botStatus = 'running';
            addBotLog('Bot container restarted', 'system');
            streamDockerLogs();
        } else if (BOT_MODE === 'screen') {
            // Stop then start
            if (screenSessionExists()) {
                if (isRemote()) {
                    runSshCommand(`screen -S ${SCREEN_SESSION} -X quit`, { stdio: 'ignore' });
                } else {
                    execSync(`screen -S ${SCREEN_SESSION} -X quit`, { stdio: 'ignore' });
                }
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (isRemote()) {
                const cmd = `cd ${SCREEN_BOT_DIR} && ${SCREEN_START_CMD}`;
                runSshCommand(`screen -dmS ${SCREEN_SESSION} bash -c "${cmd}; exec bash"`, { stdio: 'ignore' });
            } else {
                const cmd = `cd ${SCREEN_BOT_DIR} && ${SCREEN_START_CMD}`;
                execSync(`screen -dmS ${SCREEN_SESSION} bash -c "${cmd}; exec bash"`, { stdio: 'ignore' });
            }
            await new Promise(resolve => setTimeout(resolve, 1500));
            botStatus = 'running';
            addBotLog(`Screen session '${SCREEN_SESSION}' restarted`, 'system');
            streamScreenLogs();
        } else if (BOT_MODE === 'script') {
            // Kill existing process
            if (scriptProcess && !scriptProcess.killed) {
                scriptProcess.kill('SIGTERM');
                scriptProcess = null;
                scriptPid = null;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
            const result = await startBotScript();
            if (result.ok) {
                botStatus = 'running';
                addBotLog('Bot script restarted', 'system');
                streamScriptLogs();
            } else {
                throw new Error(result.error);
            }
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
    } else if (BOT_MODE === 'script') {
        return getScriptStatus();
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

function getScriptStatus() {
    try {
        if (scriptRemote) {
            // For remote script mode, check via screen session (since we use screen for remote)
            const exists = screenSessionExists();
            return {
                status: exists ? 'running' : 'stopped',
                isRunning: exists,
                error: botError,
                logCount: botLogs.length,
                screenSession: SCREEN_SESSION,
                remote: true,
                sshHost: SSH_HOST
            };
        }

        const isAlive = scriptProcess && !scriptProcess.killed;
        // Also check via PID if we have one
        let pidAlive = false;
        if (scriptPid) {
            try {
                process.kill(scriptPid, 0);
                pidAlive = true;
            } catch {
                pidAlive = false;
            }
        }
        const isRunning = isAlive || pidAlive;
        return {
            status: isRunning ? 'running' : 'stopped',
            isRunning,
            error: botError,
            logCount: botLogs.length,
            scriptPid: scriptPid || null,
            entryPoint: SCRIPT_ENTRY,
            availableScripts: detectBotScripts()
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
    } else if (BOT_MODE === 'script') {
        if (scriptRemote) {
            return getScreenLogs(limit); // remote script uses screen for logs
        }
        return getScriptLogs(limit);
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

function getScriptLogs(limit = 100) {
    // For script mode, logs are already captured in botLogs via streamScriptLogs
    const logs = botLogs.slice(-limit).map((entry, index) => ({
        id: `bot-script-${index}`,
        timestamp: entry.timestamp,
        message: entry.message,
        type: entry.type
    }));

    return {
        logs,
        total: botLogs.length,
        hasMore: botLogs.length > limit
    };
}

function getScreenLogs(limit = 100) {
    try {
        const hardcopyPath = '/tmp/infbot-screen-hardcopy.txt';
        if (isRemote()) {
            runSshCommand(`screen -S ${SCREEN_SESSION} -X hardcopy ${hardcopyPath}`, { stdio: 'ignore' });
            const content = runSshCommand(`cat ${hardcopyPath}`);
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
        }

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

    } else if (BOT_MODE === 'script') {
        if (!scriptAvailable()) {
            console.log('[BotManager] Node.js not available, skipping auto-start');
            return { ok: false, error: 'Node.js not available' };
        }

        const status = getBotStatus();
        if (status.isRunning) {
            console.log('[BotManager] Bot script already running');
            if (scriptRemote) {
                streamScreenLogs();
            } else {
                streamScriptLogs();
            }
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
        if (isRemote()) {
            return {
                mode: 'screen',
                session: SCREEN_SESSION,
                botDir: SCREEN_BOT_DIR,
                entry: SCREEN_ENTRY,
                remote: true,
                sshHost: SSH_HOST,
                sshUser: SSH_USER,
                startCommand: `ssh -p ${SSH_PORT} -i ${SSH_KEY} ${SSH_USER}@${SSH_HOST} "cd ${SCREEN_BOT_DIR} && ${SCREEN_START_CMD}"`,
                stopCommand: `ssh -p ${SSH_PORT} -i ${SSH_KEY} ${SSH_USER}@${SSH_HOST} "screen -S ${SCREEN_SESSION} -X quit"`,
                attachCommand: `ssh -p ${SSH_PORT} -i ${SSH_KEY} ${SSH_USER}@${SSH_HOST} "screen -r ${SCREEN_SESSION}"`,
                logsCommand: `ssh -p ${SSH_PORT} -i ${SSH_KEY} ${SSH_USER}@${SSH_HOST} "screen -S ${SCREEN_SESSION} -X hardcopy /tmp/infbot-screen-hardcopy.txt && cat /tmp/infbot-screen-hardcopy.txt"`
            };
        }
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
    } else if (BOT_MODE === 'script') {
        if (scriptRemote) {
            return {
                mode: 'script',
                remote: true,
                sshHost: SSH_HOST,
                sshUser: SSH_USER,
                botDir: SCRIPT_BOT_DIR,
                entry: SCRIPT_ENTRY,
                startCommand: `ssh -p ${SSH_PORT} -i ${SSH_KEY} ${SSH_USER}@${SSH_HOST} "cd ${SCRIPT_BOT_DIR} && ${SCRIPT_START_CMD}"`,
                stopCommand: `ssh -p ${SSH_PORT} -i ${SSH_KEY} ${SSH_USER}@${SSH_HOST} "screen -S ${SCREEN_SESSION} -X quit"`,
                logsCommand: `Logs streamed in-app via SSH`
            };
        }
        return {
            mode: 'script',
            botDir: SCRIPT_BOT_DIR,
            entry: SCRIPT_ENTRY,
            startCommand: `cd ${SCRIPT_BOT_DIR} && ${SCRIPT_START_CMD}`,
            stopCommand: `kill ${scriptPid || '<PID>'}`,
            logsCommand: `Logs streamed in-app`,
            availableScripts: detectBotScripts()
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
    if (scriptProcess && !scriptProcess.killed) {
        try {
            scriptProcess.kill('SIGTERM');
        } catch {
            // ignore
        }
        scriptProcess = null;
        scriptPid = null;
    }
    botStatus = 'stopped';
    botLogs = [];
    botError = null;
}
