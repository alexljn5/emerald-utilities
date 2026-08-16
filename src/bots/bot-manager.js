// src/bots/bot-manager.js
// Main-process module that manages Discord bots.
// Supports multiple modes:
//   - 'docker'  : bot runs in a Docker container (local or remote via SSH)
//   - 'screen'  : bot runs in a GNU Screen session
//   - 'script'  : bot runs as a detached Node.js process (abstract, auto-detects scripts)

import { execSync, spawn, spawnSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dns from 'dns';
import { promisify } from 'util';
import net from 'net';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const resolveMx = promisify(dns.resolveMx);
const resolve4 = promisify(dns.resolve4);

// ==================== CONFIG ====================
const CONFIG_PATH = path.join(__dirname, 'bot-config.json');

export function readBotConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        }
    } catch {
        // ignore
    }
    return { autoStart: true };
}

export function writeBotConfig(config) {
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
    const sshConfig = getCurrentSshConfig();
    return {
        host: sshConfig.host,
        user: sshConfig.user,
        port: sshConfig.port,
        key: sshConfig.key
    };
}

export function setSshConfig(host, user, port, key) {
    const config = readBotConfig();
    config.sshHost = host;
    config.sshUser = user;
    config.sshPort = port;
    config.sshKey = key;
    writeBotConfig(config);
    sshReachable = null; // reset reachability cache when config changes
    return getSshConfig();
}

// ==================== HOMELAB AUTO-DETECTION ====================
// Tries to automatically detect the homelab IP by checking common hostnames
// and local network ranges. Returns the detected host or null.

const HOMELAB_CANDIDATES = [
    // mDNS / local hostnames
    'alexljn5.local',
    'homelab.local',
    'infhub.local',
    'emerald.local',
    // Common local IPs (user's known homelab IP)
    '192.168.2.27',
    '192.168.1.100',
    '192.168.1.50',
    '192.168.1.10',
    '192.168.0.100',
    '10.0.0.100',
];

async function checkHostReachable(host, port = 22, timeoutMs = 2000) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let resolved = false;

        socket.setTimeout(timeoutMs);
        socket.connect(port, host, () => {
            if (!resolved) {
                resolved = true;
                socket.destroy();
                resolve(true);
            }
        });

        socket.on('error', () => {
            if (!resolved) {
                resolved = true;
                socket.destroy();
                resolve(false);
            }
        });

        socket.on('timeout', () => {
            if (!resolved) {
                resolved = true;
                socket.destroy();
                resolve(false);
            }
        });
    });
}

export async function detectHomelab() {
    // If already configured, return the existing config
    const existingConfig = getSshConfigFromFile();
    if (existingConfig.host) {
        // Verify the existing host is still reachable
        const reachable = await checkHostReachable(existingConfig.host, parseInt(existingConfig.port) || 22);
        if (reachable) {
            return { detected: false, host: existingConfig.host, reason: 'already-configured' };
        }
        addBotLog(`Configured homelab ${existingConfig.host} is not reachable, scanning for alternatives...`, 'system');
    }

    // Try each candidate
    for (const candidate of HOMELAB_CANDIDATES) {
        try {
            addBotLog(`Checking homelab candidate: ${candidate}...`, 'system');
            const reachable = await checkHostReachable(candidate, 22, 1500);
            if (reachable) {
                addBotLog(`Homelab detected at ${candidate}`, 'system');
                return { detected: true, host: candidate, reason: 'detected' };
            }
        } catch {
            // ignore and try next
        }
    }

    // Try mDNS resolution for user's hostname
    try {
        const localHostname = os.hostname();
        const mdnsHost = `${localHostname}.local`;
        const reachable = await checkHostReachable(mdnsHost, 22, 1500);
        if (reachable) {
            addBotLog(`Homelab detected via mDNS: ${mdnsHost}`, 'system');
            return { detected: true, host: mdnsHost, reason: 'mdns' };
        }
    } catch {
        // ignore
    }

    addBotLog('No homelab detected on the network', 'system');
    return { detected: false, host: null, reason: 'not-found' };
}

export async function autoDetectAndConnectHomelab() {
    const detection = await detectHomelab();
    if (detection.host) {
        const config = readBotConfig();
        const sshUser = config.sshUser || process.env.BOT_SSH_USER || 'alexljn5';
        const sshPort = config.sshPort || process.env.BOT_SSH_PORT || '22';
        const sshKey = config.sshKey || path.join(process.env.USERPROFILE || process.env.HOME, '.ssh', 'id_ed25519');

        setSshConfig(detection.host, sshUser, sshPort, sshKey);
        addBotLog(`Auto-configured SSH: ${sshUser}@${detection.host}:${sshPort}`, 'system');
        return { ok: true, host: detection.host, reason: detection.reason };
    }

    return { ok: false, error: 'No homelab detected', reason: detection.reason };
}

// ==================== CONFIGURATION ====================
// Read mode from bot-config.json first, then env var, then fall back to 'script'.
// IMPORTANT: BOT_MODE is read dynamically each time via getBotMode() to pick up
// UI changes without restarting the app.
export function getBotMode() {
    const config = readBotConfig();
    return config.mode || process.env.BOT_MODE || 'script';
}

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
// scriptRemote is computed dynamically via isRemote() to pick up config changes

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

let sshReachable = null; // null = unknown, true = reachable, false = not reachable

function isRemote() {
    // Read dynamically to pick up config changes from the UI
    const config = readBotConfig();
    // Only treat as remote if SSH is configured AND we know it's reachable (or haven't checked yet)
    if (!config.sshHost) return false;
    if (sshReachable === false) return false; // known to be unreachable
    return true; // configured and either reachable or unknown
}

function setSshReachable(reachable) {
    sshReachable = reachable;
}

function getCurrentSshConfig() {
    const config = readBotConfig();
    return {
        host: config.sshHost || process.env.BOT_SSH_HOST || '',
        user: config.sshUser || process.env.BOT_SSH_USER || 'alexljn5',
        port: config.sshPort || process.env.BOT_SSH_PORT || '22',
        key: config.sshKey || process.env.BOT_SSH_KEY || path.join(process.env.USERPROFILE || process.env.HOME, '.ssh', 'id_ed25519')
    };
}

// Use Windows built-in OpenSSH client to avoid Git for Windows ssh.exe popup
const WINDOWS_SSH = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';

function getSshBinary() {
    if (process.platform === 'win32') {
        // Use full path to Windows OpenSSH to bypass Git for Windows ssh.exe
        return WINDOWS_SSH;
    }
    return 'ssh';
}

function sshCommand(localCmd) {
    if (!isRemote()) return localCmd;
    const sshConfig = getCurrentSshConfig();
    // Use NUL on Windows instead of /dev/null
    const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const sshOpts = [
        '-o', 'StrictHostKeyChecking=no',
        '-o', `UserKnownHostsFile=${nullDevice}`,
        '-o', 'ConnectTimeout=5',          // fail fast if host is unreachable
        '-o', 'ServerAliveInterval=5',     // send keepalive every 5s
        '-o', 'ServerAliveCountMax=2'      // give up after 2 missed keepalives
    ];
    const ssh = [getSshBinary(), ...sshOpts, '-p', sshConfig.port, '-i', sshConfig.key, `${sshConfig.user}@${sshConfig.host}`, localCmd];
    return ssh;
}

function runSshCommand(cmd, options = {}) {
    if (!isRemote()) {
        return execSync(cmd, { encoding: 'utf8', stdio: options.stdio || 'pipe', shell: false, ...options });
    }
    const sshCmd = sshCommand(cmd);
    // execSync expects a string, not an array. Use execFileSync for array args.
    return execFileSync(getSshBinary(), sshCmd.slice(1), { encoding: 'utf8', stdio: options.stdio || 'pipe', ...options });
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
        const child = spawn(getSshBinary(), sshCmd.slice(1), { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
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
const BOT_DEBUG = process.env.BOT_DEBUG === 'true';

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

    // Debug logging
    if (BOT_DEBUG) {
        const prefix = type === 'error' ? '[BotDebug:ERROR]' : '[BotDebug]';
        console.log(`${prefix} ${message}`);
    }

    return entry;
}

export function setLogBroadcast(callback) {
    logBroadcast = callback;
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
            // screen -list outputs: "PID.sessionname" or "\tPID.sessionname\t"
            // Be more precise: match the session name as a complete word
            const regex = new RegExp(`\\b${SCREEN_SESSION}\\b`);
            return regex.test(output);
        } catch {
            return false;
        }
    }
    try {
        const output = execSync('screen -list', { encoding: 'utf8', stdio: 'pipe' });
        // screen -list outputs: "PID.sessionname" or "\tPID.sessionname\t"
        // Be more precise: match the session name as a complete word
        const regex = new RegExp(`\\b${SCREEN_SESSION}\\b`);
        return regex.test(output);
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
    const mode = getBotMode();
    if (mode !== 'docker') {
        return { ok: false, error: `Build is only supported in docker mode (current: ${mode})` };
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
    const mode = getBotMode();
    addBotLog(`Starting bot in ${mode} mode...`, 'system');

    if (mode === 'docker') {
        return startBotDocker();
    } else if (mode === 'screen') {
        return await startBotScreen();
    } else if (mode === 'script') {
        return await startBotScript();
    } else {
        const errorMsg = `Unknown bot mode: ${mode}`;
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

        if (isRemote()) {
            // Remote execution via SSH
            if (!fs.existsSync(entryPath)) {
                throw new Error(`Bot entry point not found on remote: ${entryPath}`);
            }
            const cmd = `cd ${SCRIPT_BOT_DIR} && ${SCRIPT_START_CMD}`;
            runSshCommand(`screen -dmS ${SCREEN_SESSION} bash -c "${cmd}; exec bash"`, { stdio: 'ignore' });
            await new Promise(resolve => setTimeout(resolve, 1500));
            const sshConfig = getCurrentSshConfig();
            botStatus = 'running';
            addBotLog(`Remote script started via SSH on ${sshConfig.host}`, 'system');
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
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Check if process is still alive
            try {
                process.kill(scriptPid, 0); // signal 0 checks if process exists
                botStatus = 'running';
                addBotLog('Bot script process is running', 'system');
                streamScriptLogs();
                return { ok: true, status: botStatus };
            } catch {
                // Process may have already exited - check if it was a crash
                addBotLog('Script process exited during startup check', 'error');
                throw new Error('Script process exited during startup. Check bot-entry.js for errors.');
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

        // If session already exists, just attach to it
        if (screenSessionExists()) {
            addBotLog('Screen session already exists, attaching', 'system');
            botStatus = 'running';
            streamScreenLogs();
            return { ok: true, status: botStatus, alreadyRunning: true };
        }

        // Kill any stale session that might not be detected
        try {
            if (isRemote()) {
                runSshCommand(`screen -S ${SCREEN_SESSION} -X kill`, { stdio: 'ignore' });
            } else {
                execSync(`screen -S ${SCREEN_SESSION} -X kill`, { stdio: 'ignore' });
            }
        } catch {
            // ignore - session might not exist
        }
        await new Promise(resolve => setTimeout(resolve, 500));

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
            execSync(`screen -D -m -S ${SCREEN_SESSION} bash -c "${cmd}; exec bash"`, { stdio: 'ignore' });
        }

        // Wait a moment for the session to initialize
        await new Promise(resolve => setTimeout(resolve, 1500));

        if (screenSessionExists()) {
            const sshConfig = getCurrentSshConfig();
            botStatus = 'running';
            addBotLog(`Screen session '${SCREEN_SESSION}' started`, 'system');
            addBotLog(isRemote() ? `SSH: ${sshConfig.user}@${sshConfig.host}` : `Attach with: screen -r ${SCREEN_SESSION}`, 'system');
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

    const mode = getBotMode();
    addBotLog(`Stopping bot (mode: ${mode})...`, 'system');

    try {
        if (mode === 'docker') {
            runDockerCommand(['stop', DOCKER_CONTAINER], { stdio: 'ignore' });
        } else if (mode === 'screen') {
            if (screenSessionExists()) {
                if (isRemote()) {
                    runSshCommand(`screen -S ${SCREEN_SESSION} -X kill`, { stdio: 'ignore' });
                } else {
                    execSync(`screen -S ${SCREEN_SESSION} -X kill`, { stdio: 'ignore' });
                }
            }
        } else if (mode === 'script') {
            if (isRemote()) {
                if (screenSessionExists()) {
                    runSshCommand(`screen -S ${SCREEN_SESSION} -X kill`, { stdio: 'ignore' });
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
    const mode = getBotMode();
    addBotLog(`Restarting bot (mode: ${mode})...`, 'system');

    try {
        if (mode === 'docker') {
            runDockerCommand(['restart', DOCKER_CONTAINER], { stdio: 'ignore' });
            botStatus = 'running';
            addBotLog('Bot container restarted', 'system');
            streamDockerLogs();
        } else if (mode === 'screen') {
            // Always try to kill existing session first (ignore errors if none exists)
            try {
                if (isRemote()) {
                    runSshCommand(`screen -S ${SCREEN_SESSION} -X kill`, { stdio: 'ignore' });
                } else {
                    execSync(`screen -S ${SCREEN_SESSION} -X kill`, { stdio: 'ignore' });
                }
            } catch {
                // ignore - session might not exist
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (isRemote()) {
                const cmd = `cd ${SCREEN_BOT_DIR} && ${SCREEN_START_CMD}`;
                runSshCommand(`screen -D -m -S ${SCREEN_SESSION} bash -c "${cmd}; exec bash"`, { stdio: 'ignore' });
            } else {
                const cmd = `cd ${SCREEN_BOT_DIR} && ${SCREEN_START_CMD}`;
                execSync(`screen -D -m -S ${SCREEN_SESSION} bash -c "${cmd}; exec bash"`, { stdio: 'ignore' });
            }
            await new Promise(resolve => setTimeout(resolve, 1500));
            // Verify the session actually started
            if (screenSessionExists()) {
                botStatus = 'running';
                addBotLog(`Screen session '${SCREEN_SESSION}' restarted`, 'system');
                streamScreenLogs();
            } else {
                throw new Error('Screen session failed to start after restart');
            }
        } else if (mode === 'script') {
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

export async function getBotStatus() {
    const mode = getBotMode();
    if (mode === 'docker') {
        return await getDockerStatus();
    } else if (mode === 'screen') {
        return getScreenStatus();
    } else if (mode === 'script') {
        return getScriptStatus();
    }

    return {
        status: 'error',
        isRunning: false,
        error: `Unknown bot mode: ${mode}`,
        logCount: botLogs.length
    };
}

async function getDockerStatus() {
    try {
        const result = await runDockerCommandAsync([
            'ps', '-a',
            '--filter', `name=${DOCKER_CONTAINER}`,
            '--format', '{{.Names}}|{{.Status}}|{{.Image}}'
        ]);
        const output = result.stdout;

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
        if (isRemote()) {
            // For remote script mode, check via screen session (since we use screen for remote)
            const exists = screenSessionExists();
            return {
                status: exists ? 'running' : 'stopped',
                isRunning: exists,
                error: botError,
                logCount: botLogs.length,
                screenSession: SCREEN_SESSION,
                remote: true,
                sshHost: getCurrentSshConfig().host
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

export async function getBotLogs(limit = 100) {
    const mode = getBotMode();
    if (mode === 'docker') {
        return await getDockerLogs(limit);
    } else if (mode === 'screen') {
        return getScreenLogs(limit);
    } else if (mode === 'script') {
        if (isRemote()) {
            return getScreenLogs(limit); // remote script uses screen for logs
        }
        return getScriptLogs(limit);
    }

    return { logs: [], total: 0, hasMore: false, error: `Unknown bot mode: ${mode}` };
}

async function getDockerLogs(limit = 100) {
    try {
        const result = await runDockerCommandAsync(['logs', '--tail', String(limit), DOCKER_CONTAINER]);
        const output = result.stdout;

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
function withTimeout(promise, ms, fallback) {
    let timeoutId;
    const timeoutPromise = new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve(fallback), ms);
    });
    return Promise.race([
        promise.then((result) => {
            clearTimeout(timeoutId);
            return result;
        }),
        timeoutPromise
    ]);
}

export async function autoStartBot() {
    try {
        const mode = getBotMode();
        if (mode === 'docker') {
            // If SSH is configured, try to auto-connect to homelab first (with timeout to avoid blocking)
            const sshConfig = getSshConfigFromFile();
            if (sshConfig.host) {
                console.log(`[BotManager] Docker mode with SSH host (${sshConfig.host}), attempting remote start...`);
                try {
                    const testResult = await withTimeout(
                        runSshCommandAsync('echo "homelab-reachable"'),
                        5000,
                        { ok: false, error: 'SSH check timed out' }
                    );
                    if (testResult?.stdout?.includes('homelab-reachable')) {
                        console.log('[BotManager] Homelab is reachable, starting Docker bot remotely');
                        setSshReachable(true);
                        const remoteResult = await startBot();
                        if (remoteResult.ok) {
                            console.log('[BotManager] Auto-connected to homelab Docker');
                            return remoteResult;
                        }
                    } else {
                        console.log('[BotManager] Homelab SSH check failed, falling back to local Docker');
                        setSshReachable(false);
                    }
                } catch (err) {
                    console.log('[BotManager] Homelab not reachable, falling back to local Docker:', err.message);
                    setSshReachable(false);
                }
            }

            console.log('[BotManager] Checking local Docker availability...');
            try {
                if (!dockerAvailable()) {
                    console.log('[BotManager] Docker not available, skipping auto-start');
                    return { ok: false, error: 'Docker not available. Install Docker Desktop or configure SSH for homelab.' };
                }
                console.log('[BotManager] Local Docker is available');

                const status = getBotStatus();
                console.log('[BotManager] Docker status check complete:', status.status, status.isRunning);
                if (status.isRunning) {
                    console.log('[BotManager] Bot container already running');
                    streamDockerLogs();
                    return { ok: true, status: 'running', alreadyRunning: true };
                }

                console.log('[BotManager] Starting bot via local Docker...');
                try {
                    const result = await startBot();
                    if (result.ok) {
                        console.log('[BotManager] Auto-start initiated');
                    } else {
                        console.log('[BotManager] Auto-start skipped:', result.error);
                    }
                    return result;
                } catch (err) {
                    console.log('[BotManager] Local Docker start failed:', err.message);
                    return { ok: false, error: `Local Docker start failed: ${err.message}` };
                }
            } catch (err) {
                console.error('[BotManager] Local Docker fallback crashed:', err);
                return { ok: false, error: `Local Docker fallback crashed: ${err.message}` };
            }

        } else if (mode === 'screen') {
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

            // If SSH is configured, try to auto-connect to homelab
            const sshConfig = getSshConfigFromFile();
            if (sshConfig.host) {
                console.log(`[BotManager] SSH host configured (${sshConfig.host}), attempting auto-connect...`);
                try {
                    const testResult = runSshCommand('echo "homelab-reachable"', { stdio: 'pipe' });
                    if (testResult.includes('homelab-reachable')) {
                        console.log('[BotManager] Homelab is reachable, starting bot remotely');
                        const remoteResult = await startBot();
                        if (remoteResult.ok) {
                            console.log('[BotManager] Auto-connected to homelab');
                            return remoteResult;
                        }
                    } else {
                        console.log('[BotManager] Homelab SSH check failed, staying in local mode');
                    }
                } catch (err) {
                    console.log('[BotManager] Homelab not reachable:', err.message);
                }
            }

            const result = await startBot();
            if (result.ok) {
                console.log('[BotManager] Auto-start initiated');
            } else {
                console.log('[BotManager] Auto-start skipped:', result.error);
            }
            return result;

        } else if (mode === 'script') {
            if (!scriptAvailable()) {
                console.log('[BotManager] Node.js not available, skipping auto-start');
                return { ok: false, error: 'Node.js not available' };
            }

            const status = getBotStatus();
            if (status.isRunning) {
                console.log('[BotManager] Bot script already running');
                if (isRemote()) {
                    streamScreenLogs();
                } else {
                    streamScriptLogs();
                }
                return { ok: true, status: 'running', alreadyRunning: true };
            }

            // If SSH is configured, try to auto-connect to homelab
            const sshConfig = getSshConfigFromFile();
            if (sshConfig.host) {
                console.log(`[BotManager] SSH host configured (${sshConfig.host}), attempting auto-connect...`);
                try {
                    const testResult = runSshCommand('echo "homelab-reachable"', { stdio: 'pipe' });
                    if (testResult.includes('homelab-reachable')) {
                        console.log('[BotManager] Homelab is reachable, starting bot remotely');
                        const remoteResult = await startBot();
                        if (remoteResult.ok) {
                            console.log('[BotManager] Auto-connected to homelab');
                            return remoteResult;
                        }
                    } else {
                        console.log('[BotManager] Homelab SSH check failed, staying in local mode');
                    }
                } catch (err) {
                    console.log('[BotManager] Homelab not reachable:', err.message);
                }
            }

            const result = await startBot();
            if (result.ok) {
                console.log('[BotManager] Auto-start initiated');
            } else {
                console.log('[BotManager] Auto-start skipped:', result.error);
            }
            return result;
        }

        return { ok: false, error: `Unknown bot mode: ${mode}` };
    } catch (err) {
        console.error('[BotManager] autoStartBot crashed:', err);
        return { ok: false, error: `Auto-start crashed: ${err.message}` };
    }
}

// ==================== BUILD HELPER ====================
export function getBuildInstructions() {
    const mode = getBotMode();
    if (mode === 'docker') {
        if (isRemote()) {
            const sshConfig = getCurrentSshConfig();
            const sshPrefix = `ssh -p ${sshConfig.port} -i ${sshConfig.key} ${sshConfig.user}@${sshConfig.host}`;
            return {
                mode: 'docker',
                image: DOCKER_IMAGE,
                container: DOCKER_CONTAINER,
                dockerfile: path.join(DOCKER_BOT_DIR, 'Dockerfile'),
                remote: true,
                sshHost: sshConfig.host,
                sshUser: sshConfig.user,
                buildCommand: `${sshPrefix} "cd ${DOCKER_BOT_DIR} && docker build -t ${DOCKER_IMAGE} ."`,
                runCommand: `${sshPrefix} "docker run -d --name ${DOCKER_CONTAINER} --restart unless-stopped --env-file ${ENV_FILE} ${DOCKER_IMAGE}"`,
                stopCommand: `${sshPrefix} "docker stop ${DOCKER_CONTAINER}"`,
                startCommand: `${sshPrefix} "docker start ${DOCKER_CONTAINER}"`,
                logsCommand: `${sshPrefix} "docker logs -f ${DOCKER_CONTAINER}"`,
                removeCommand: `${sshPrefix} "docker rm -f ${DOCKER_CONTAINER}"`
            };
        }
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
    } else if (mode === 'screen') {
        if (isRemote()) {
            const sshConfig = getCurrentSshConfig();
            return {
                mode: 'screen',
                session: SCREEN_SESSION,
                botDir: SCREEN_BOT_DIR,
                entry: SCREEN_ENTRY,
                remote: true,
                sshHost: sshConfig.host,
                sshUser: sshConfig.user,
                startCommand: `ssh -p ${sshConfig.port} -i ${sshConfig.key} ${sshConfig.user}@${sshConfig.host} "cd ${SCREEN_BOT_DIR} && ${SCREEN_START_CMD}"`,
                stopCommand: `ssh -p ${sshConfig.port} -i ${sshConfig.key} ${sshConfig.user}@${sshConfig.host} "screen -S ${SCREEN_SESSION} -X quit"`,
                attachCommand: `ssh -p ${sshConfig.port} -i ${sshConfig.key} ${sshConfig.user}@${sshConfig.host} "screen -r ${SCREEN_SESSION}"`,
                logsCommand: `ssh -p ${sshConfig.port} -i ${sshConfig.key} ${sshConfig.user}@${sshConfig.host} "screen -S ${SCREEN_SESSION} -X hardcopy /tmp/infbot-screen-hardcopy.txt && cat /tmp/infbot-screen-hardcopy.txt"`
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
    } else if (mode === 'script') {
        if (isRemote()) {
            const sshConfig = getCurrentSshConfig();
            return {
                mode: 'script',
                remote: true,
                sshHost: sshConfig.host,
                sshUser: sshConfig.user,
                botDir: SCRIPT_BOT_DIR,
                entry: SCRIPT_ENTRY,
                startCommand: `ssh -p ${sshConfig.port} -i ${sshConfig.key} ${sshConfig.user}@${sshConfig.host} "cd ${SCRIPT_BOT_DIR} && ${SCRIPT_START_CMD}"`,
                stopCommand: `ssh -p ${sshConfig.port} -i ${sshConfig.key} ${sshConfig.user}@${sshConfig.host} "screen -S ${SCREEN_SESSION} -X quit"`,
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

    return { mode: getBotMode(), error: 'Unknown mode' };
}

// ==================== COMMAND SENDING ====================
export function sendBotCommand(command) {
    if (!command || typeof command !== 'string') {
        return { ok: false, error: 'Command must be a non-empty string' };
    }

    const mode = getBotMode();
    if (mode === 'screen') {
        return sendScreenCommand(command);
    } else if (mode === 'script') {
        return sendScriptCommand(command);
    } else if (mode === 'docker') {
        return sendDockerCommand(command);
    }

    return { ok: false, error: `Unknown bot mode: ${mode}` };
}

function sendScreenCommand(command) {
    try {
        if (isRemote()) {
            // Remote: send command via SSH to screen session
            const escaped = command.replace(/"/g, '\\"').replace(/\$/g, '\\$');
            runSshCommand(`screen -S ${SCREEN_SESSION} -X stuff "${escaped}\\n"`, { stdio: 'ignore' });
        } else {
            // Local: send command to screen session
            const escaped = command.replace(/"/g, '\\"').replace(/\$/g, '\\$');
            execSync(`screen -S ${SCREEN_SESSION} -X stuff "${escaped}\\n"`, { stdio: 'ignore' });
        }
        addBotLog(`[CMD] ${command}`, 'system');
        return { ok: true };
    } catch (err) {
        const errorMsg = `Failed to send command: ${err.message}`;
        addBotLog(errorMsg, 'error');
        return { ok: false, error: errorMsg };
    }
}

function sendScriptCommand(command) {
    try {
        if (isRemote()) {
            // Remote script: use screen session via SSH
            const escaped = command.replace(/"/g, '\\"').replace(/\$/g, '\\$');
            runSshCommand(`screen -S ${SCREEN_SESSION} -X stuff "${escaped}\\n"`, { stdio: 'ignore' });
        } else if (scriptProcess && !scriptProcess.killed && scriptProcess.stdin) {
            // Local script: write to process stdin
            scriptProcess.stdin.write(command + '\n');
        } else {
            return { ok: false, error: 'Bot process is not running or does not accept input' };
        }
        addBotLog(`[CMD] ${command}`, 'system');
        return { ok: true };
    } catch (err) {
        const errorMsg = `Failed to send command: ${err.message}`;
        addBotLog(errorMsg, 'error');
        return { ok: false, error: errorMsg };
    }
}

function sendDockerCommand(command) {
    try {
        // For Docker, we can exec into the container
        const escaped = command.replace(/"/g, '\\"').replace(/\$/g, '\\$');
        runDockerCommand(['exec', DOCKER_CONTAINER, 'sh', '-c', command], { stdio: 'ignore' });
        addBotLog(`[CMD] ${command}`, 'system');
        return { ok: true };
    } catch (err) {
        const errorMsg = `Failed to send command: ${err.message}`;
        addBotLog(errorMsg, 'error');
        return { ok: false, error: errorMsg };
    }
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
