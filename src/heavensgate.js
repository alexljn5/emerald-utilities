import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, screen } from 'electron';
import path from 'path';
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import { existsSync } from 'fs';
import fsPromises from 'fs/promises';
import { fileURLToPath } from 'url';
import { parseTcpdumpArgs } from './core/tcpdumpArgs.js';
import { writePacket } from './core/networkFileWriter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function commandExists(command) {
    try {
        if (process.platform === 'win32') {
            execSync(`where ${command}`, { stdio: 'ignore' });
        } else {
            execSync(`which ${command}`, { stdio: 'ignore' });
        }
        return true;
    } catch {
        return false;
    }
}

// ==================== GLOBAL FLAGS ====================
const PRODUCTION = true;   // Change to false for development

// ==================== PROCESS KILLING HELPERS ====================
function killProcessTree(pid) {
    if (process.platform === 'win32') {
        // On Windows, use taskkill to kill the process tree
        try {
            spawn('taskkill', ['/F', '/T', '/PID', pid]);
        } catch (e) {
            // Fallback to regular kill
            try { process.kill(pid); } catch { }
        }
    } else {
        // On Unix, kill the process group
        try {
            process.kill(-pid, 'SIGTERM');
        } catch (e) {
            // Process may already be dead or not in a group
            try { process.kill(pid, 'SIGTERM'); } catch { }
        }
    }
}

// ==================== WINDOW CREATION ====================
let tray = null;
let mainWindow = null;
const scriptRunners = new Map();
const cronJobs = new Map();
const scriptLogHistory = [];
const MAX_SCRIPT_LOG_LINES = 500;
const SCRIPT_LOG_SESSION_ID = Date.now().toString(36);
const NETWORK_LOG_DIR = path.join(process.cwd(), 'src/logs/logs-network');
const NETWORK_LOG_FOLDERS = new Set(['ALL', 'FILTERED']);
let nextScriptLogId = 1;
let networkCaptureProcess = null;

function getDefaultConfig() {
    return { scripts: [], customScriptsPath: null, ahkPath: null };
}

function getConfigPath() {
    return path.join(app.getPath('userData'), 'config.json');
}

async function readConfig() {
    try {
        const configPath = getConfigPath();
        if (!existsSync(configPath)) {
            const config = getDefaultConfig();
            await fsPromises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
            return config;
        }

        return JSON.parse(await fsPromises.readFile(configPath, 'utf8'));
    } catch {
        return getDefaultConfig();
    }
}

async function writeConfig(config) {
    const cleanConfig = {
        scripts: Array.isArray(config.scripts) ? config.scripts : [],
        customScriptsPath: config.customScriptsPath || null,
        ahkPath: config.ahkPath || null
    };

    await fsPromises.writeFile(getConfigPath(), JSON.stringify(cleanConfig, null, 2), 'utf8');
    return cleanConfig;
}

function getDefaultScriptsDir() {
    const devPath = path.join(app.getAppPath(), 'scripts');
    const resPath = path.join(process.resourcesPath || '', 'scripts');

    if (existsSync(devPath)) return devPath;
    if (existsSync(resPath)) return resPath;

    return devPath;
}

function getScriptsDir(config) {
    return config?.customScriptsPath || getDefaultScriptsDir();
}

function getNetworkLogFolder(folder = 'ALL') {
    const safeFolder = NETWORK_LOG_FOLDERS.has(folder) ? folder : 'ALL';
    return path.join(NETWORK_LOG_DIR, safeFolder);
}

function sanitizeNetworkLogFile(file) {
    if (!file || typeof file !== 'string') return null;
    const normalized = file.replace(/\\/g, '/');
    if (normalized.includes('/') || normalized.includes('..')) return null;
    if (!/\.(json|jsonl|txt)$/i.test(normalized)) return null;
    return normalized;
}

function sanitizeScriptFile(file) {
    if (!file || typeof file !== 'string') return null;

    const normalized = file.replace(/\\/g, '/');
    if (normalized.includes('/') || normalized.includes('..')) return null;
    if (!/\.(js|sh|bat|exe|ahk|ps1)$/i.test(normalized)) return null;

    return normalized;
}

async function ensureConfigEntries(config, files) {
    let changed = false;

    for (const file of files) {
        if (!config.scripts.find((script) => script.file === file)) {
            config.scripts.push({
                file,
                type: file.match(/\.(js|sh|bat|exe|ahk|ps1)$/i)?.[1]?.toLowerCase() ?? 'unknown',
                autoRun: false,
                cronEnabled: false,
                cronInterval: 0,
                displayName: `Run ${file}`
            });
            changed = true;
        } else {
            const scriptConfig = config.scripts.find((script) => script.file === file);
            if (!Object.prototype.hasOwnProperty.call(scriptConfig, 'cronEnabled')) {
                scriptConfig.cronEnabled = false;
                changed = true;
            }
            if (!Object.prototype.hasOwnProperty.call(scriptConfig, 'cronInterval')) {
                scriptConfig.cronInterval = 0;
                changed = true;
            }
        }
    }

    if (changed) {
        await writeConfig(config);
    }

    return changed;
}

function broadcast(channel, ...args) {
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
            win.webContents.send(channel, ...args);
        }
    }
}

function pushScriptLog(message) {
    const entry = { id: `${SCRIPT_LOG_SESSION_ID}-${nextScriptLogId++}`, message };
    scriptLogHistory.push(entry);
    if (scriptLogHistory.length > MAX_SCRIPT_LOG_LINES) {
        scriptLogHistory.splice(0, scriptLogHistory.length - MAX_SCRIPT_LOG_LINES);
    }
    console.log('Script log:', message);
    broadcast('script-log', entry);
}
function toWslPath(windowsPath) {
    const normalized = windowsPath.replace(/\\/g, '/');
    const driveMatch = normalized.match(/^([A-Za-z]):\/(.*)$/);

    if (driveMatch) {
        return `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2]}`;
    }

    return normalized;
}

export function startCapture(iface = 'any', tcpdumpArgs = []) {
    const { iface: normalizedIface, extraArgs } = normalizeNetworkCaptureOptions({ iface, tcpdumpArgs });
    const scriptPath = getNetworkCaptureScriptPath();
    const proc = spawn(
        process.platform === 'win32' ? 'wsl' : 'bash',
        getNetworkCaptureSpawnArgs(scriptPath, normalizedIface, extraArgs),
        { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    proc.stdout.setEncoding('utf8');

    proc.stdout.on('data', (chunk) => {
        const lines = chunk.toString().split('\n');

        for (const line of lines) {
            if (!line.trim()) continue;

            const packet = {
                ts: new Date().toISOString(),
                raw: line.trim(),
                source: 'tcpdump',
                interface: normalizedIface
            };

            writePacket(packet);
        }
    });

    proc.stderr.on('data', (err) => {
        console.error('[tcpdump error]', err.toString());
    });

    return proc;
}

function normalizeNetworkCaptureOptions(options = {}) {
    const iface = String(options?.iface ?? options?.interface ?? 'any').trim() || 'any';
    let extraArgs;

    try {
        extraArgs = parseTcpdumpArgs(options?.tcpdumpArgs ?? options?.args ?? []);
    } catch (err) {
        throw new Error(`Invalid tcpdump arguments: ${err.message}`);
    }

    extraArgs = extraArgs
        .map((arg) => String(arg).trim())
        .filter((arg) => arg.length > 0);

    return { iface, extraArgs };
}

function getNetworkCaptureSpawnArgs(scriptPath, iface = 'any', extraArgs = []) {
    if (process.platform === 'win32') {
        return ['bash', toWslPath(scriptPath), iface, ...extraArgs];
    }

    return [scriptPath, iface, ...extraArgs];
}

function getNetworkCaptureScriptPath() {
    if (app.isPackaged && process.resourcesPath) {
        return path.join(process.resourcesPath, 'internal-scripts', 'network-capture.sh');
    }

    return path.join(__dirname, 'internal-scripts', 'network-capture.sh');
}

function broadcastNetworkLog(line) {
    const trimmed = String(line || '').trimEnd();
    if (!trimmed) return;

    broadcast('network-log', trimmed);
}

function logProcessOutput(data, prefix = '') {
    let text = data.toString()
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .trimEnd();

    // Clean ANSI escape codes and weird box characters
    text = text.replace(/\u001B\[[0-9;]*[a-zA-Z]/g, '')   // ANSI codes
        .replace(/[\u2500-\u257F]/g, '-')           // Box drawing
        .replace(/[^\x20-\x7E\n]/g, '');            // Keep only printable ASCII + newline

    if (!text) return;

    for (const line of text.split('\n')) {
        if (line.trim()) {
            pushScriptLog(`${prefix}${line}`);
        }
    }
}

function setScriptRunning(file, isRunning) {
    broadcast('script-running-changed', { file, isRunning });
}

function stopScript(file) {
    const child = scriptRunners.get(file);
    if (!child) return false;

    pushScriptLog(`Stopping ${file}...`);

    // Immediately destroy streams to prevent further output
    child.stdout?.destroy();
    child.stderr?.destroy();

    // Remove from map immediately to prevent duplicate exit handling
    scriptRunners.delete(file);
    setScriptRunning(file, false);

    // Kill the process (and its tree on Windows)
    if (child.pid) {
        killProcessTree(child.pid);
    } else {
        child.kill();
    }

    // Log when process actually exits (one-time handler)
    child.once('exit', (code, signal) => {
        pushScriptLog(`${file} stopped (${signal || code})`);
    });

    return true;
}

function stopCronJob(file) {
    const job = cronJobs.get(file);
    if (!job) return false;

    pushScriptLog(`Stopping cron job for ${file}...`);
    clearInterval(job.timer);
    cronJobs.delete(file);
    setScriptRunning(file, false);
    pushScriptLog(`Cron job stopped for ${file}`);
    return true;
}

// ==================== AUTO HOTKEY DETECTION ====================
function getAhkConfigPath() {
    return path.join(app.getPath('userData'), 'config.json');
}

function getConfiguredAhkPath() {
    try {
        const configPath = getAhkConfigPath();
        if (existsSync(configPath)) {
            const config = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
            if (config.ahkPath && existsSync(config.ahkPath)) {
                console.log(`[AHK] Using configured path: ${config.ahkPath}`);
                return config.ahkPath;
            }
        }
    } catch (e) {
        // Ignore config read errors, fall back to auto-detect
    }
    return null;
}

function findAutoHotkey() {
    // First check if user has configured a custom path
    const configuredPath = getConfiguredAhkPath();
    if (configuredPath) {
        return configuredPath;
    }

    const commonPaths = [
        'C:\\Program Files\\AutoHotkey\\AutoHotkey.exe',
        'C:\\Program Files (x86)\\AutoHotkey\\AutoHotkey.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs\\AutoHotkey\\AutoHotkey.exe'),
        path.join(process.env.ProgramFiles || '', 'AutoHotkey\\AutoHotkey.exe'),
        path.join(process.env['ProgramFiles(x86)'] || '', 'AutoHotkey\\AutoHotkey.exe'),
    ];

    for (const p of commonPaths) {
        if (existsSync(p)) {
            console.log(`[AHK] Found at: ${p}`);
            return p;
        }
    }

    if (commandExists('AutoHotkey.exe')) {
        console.log('[AHK] Found in PATH');
        return 'AutoHotkey.exe';
    }

    console.warn('[AHK] AutoHotkey.exe not found');
    return null;
}

function findPowerShell() {
    if (process.platform === 'win32') {
        if (commandExists('powershell.exe')) {
            console.log('[PowerShell] Found powershell.exe in PATH');
            return 'powershell.exe';
        }

        const windowsPowerShellPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        if (existsSync(windowsPowerShellPath)) {
            console.log(`[PowerShell] Found at: ${windowsPowerShellPath}`);
            return windowsPowerShellPath;
        }

        console.warn('[PowerShell] powershell.exe not found');
        return null;
    }

    if (commandExists('pwsh')) {
        console.log('[PowerShell] Found pwsh in PATH');
        return 'pwsh';
    }

    console.warn('[PowerShell] pwsh not found');
    return null;
}

// ==================== GET SCRIPT COMMAND (Fixed) ====================
function getScriptCommand(file, scriptPath) {
    const ext = file.split('.').pop().toLowerCase();

    switch (ext) {
        case 'js':
            return { command: 'node', args: [scriptPath] };
        case 'sh': {
            if (process.platform === 'win32') {
                // === WINDOWS: Use WSL ===
                let wslPath = scriptPath.replace(/\\/g, '/');
                const driveMatch = wslPath.match(/^([A-Za-z]):\/(.*)$/);
                if (driveMatch) {
                    wslPath = `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2]}`;
                }

                return {
                    command: 'wsl',
                    args: ['bash', wslPath],
                    useShell: false
                };
            } else {
                // === Linux / macOS: Use native bash ===
                return {
                    command: 'bash',
                    args: [scriptPath],
                    useShell: false
                };
            }
        }
        case 'bat':
            return { command: 'cmd.exe', args: ['/c', scriptPath] };
        case 'ps1': {
            const powershellPath = findPowerShell();
            if (!powershellPath) {
                pushScriptLog(process.platform === 'win32'
                    ? 'PowerShell not found. Please install Windows PowerShell.'
                    : 'PowerShell Core (pwsh) not found. Please install PowerShell.');
                return null;
            }

            return {
                command: powershellPath,
                args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
                useShell: process.platform === 'win32'
            };
        }
        case 'exe':
            return { command: scriptPath, args: [] };
        case 'ahk': {
            const ahkPath = findAutoHotkey();
            if (!ahkPath) {
                pushScriptLog('AutoHotkey.exe not found. Please install AutoHotkey.');
                return null;
            }
            return { command: ahkPath, args: [scriptPath] };
        }
        default:
            return null;
    }
}

// ==================== START SCRIPT (CRITICAL FIX) ====================
function startScript(file, scriptPath) {
    const commandInfo = getScriptCommand(file, scriptPath);
    if (!commandInfo) {
        pushScriptLog('Unsupported script type or missing runtime.');
        return { ok: false, running: false };
    }

    const isWindows = process.platform === 'win32';

    // Quote the command if it contains spaces (required when shell: true on Windows)
    const command = isWindows && commandInfo.command.includes(' ')
        ? `"${commandInfo.command}"`
        : commandInfo.command;

    // Convert cwd to forward slashes on Windows for bash compatibility
    const cwd = isWindows ? path.dirname(scriptPath).replace(/\\/g, '/') : path.dirname(scriptPath);

    const child = spawn(command, commandInfo.args, {
        shell: commandInfo.useShell !== false && isWindows,
        windowsVerbatimArguments: true,   // Important for paths with spaces
        cwd: cwd     // Run from script's directory
    });

    scriptRunners.set(file, child);
    setScriptRunning(file, true);
    pushScriptLog(`Started ${file}`);

    if (child.stdout) child.stdout.on('data', data => logProcessOutput(data));
    if (child.stderr) child.stderr.on('data', data => logProcessOutput(data, 'ERR: '));

    child.on('error', err => pushScriptLog(`${file} error: ${err.message}`));
    child.on('exit', (code, signal) => {
        if (!scriptRunners.has(file)) return;
        pushScriptLog(`${file} exited (${signal || code})`);
        scriptRunners.delete(file);
        setScriptRunning(file, false);
    });

    return { ok: true, running: true };
}

function startCronScript(file, scriptPath, intervalMs) {
    const commandInfo = getScriptCommand(file, scriptPath);
    if (!commandInfo) {
        pushScriptLog('Unsupported type or missing runtime for cron');
        return { ok: false };
    }

    // Stop any existing cron job for this file
    if (cronJobs.has(file)) {
        stopCronJob(file);
    }

    const isWindows = process.platform === 'win32';

    // Quote the command if it contains spaces (required when shell: true on Windows)
    const command = isWindows && commandInfo.command.includes(' ')
        ? `"${commandInfo.command}"`
        : commandInfo.command;

    const cwd = isWindows ? path.dirname(scriptPath).replace(/\\/g, '/') : path.dirname(scriptPath);

    const timer = setInterval(() => {
        const child = spawn(command, commandInfo.args, {
            shell: commandInfo.useShell !== false && isWindows,
            windowsVerbatimArguments: true,
            cwd
        });
        pushScriptLog(`[CRON] Running ${file}`);

        if (child.stdout) {
            child.stdout.on('data', data => logProcessOutput(data, '[CRON] '));
        }
        if (child.stderr) {
            child.stderr.on('data', data => logProcessOutput(data, '[CRON ERR] '));
        }
        child.on('error', err => {
            pushScriptLog(`[CRON] ${file} error: ${err.message}`);
        });
        child.on('exit', (code, signal) => {
            pushScriptLog(`[CRON] ${file} finished (${signal || code})`);
        });
    }, intervalMs);

    cronJobs.set(file, { timer, intervalMs, scriptPath });
    setScriptRunning(file, true);
    pushScriptLog(`Cron job started for ${file} (every ${intervalMs}ms)`);

    return { ok: true };
}

function createWindow() {
    try {
        const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
        const width = Math.min(1280, Math.floor(screenWidth * 0.85));
        const height = Math.min(720, Math.floor(screenHeight * 0.85));

        mainWindow = new BrowserWindow({
            width,
            height,
            webPreferences: {
                contextIsolation: false,
                nodeIntegration: true,
                preload: path.join(__dirname, 'preload.js'),
                allowRendererProcessReuse: false,
                webgl: false,
            },
            show: false   // ← Never show automatically
        });

        if (PRODUCTION) {
            mainWindow.setMenu(null);
        }

        const devServerUrl = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173';
        const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

        if (isDev) {
            mainWindow.loadURL(devServerUrl).catch(err => {
                console.error('Failed to load Vite dev server:', err);
            });
        } else {
            const indexPath = path.join(app.getAppPath(), 'dist', 'index.html');
            mainWindow.loadFile(indexPath).catch(err => {
                console.error('Failed to load dist/index.html:', err);
            });
        }

        mainWindow.on('close', (event) => {
            if (!app.isQuitting) {
                event.preventDefault();
                mainWindow.hide();
            }
        });

        mainWindow.on('minimize', () => {
            mainWindow.hide();
        });
    } catch (err) {
        console.error('Error creating window:', err);
    }
}

function createTray() {
    try {
        const iconPath = path.join(__dirname, '../img/favicons/favicon.png');
        tray = new Tray(iconPath);

        const contextMenu = Menu.buildFromTemplate([
            { label: 'Show App', click: () => mainWindow?.show() },
            {
                label: 'Quit',
                click: () => {
                    app.isQuitting = true;
                    app.quit();
                }
            }
        ]);

        tray.setToolTip('Emerald Utilities');
        tray.setContextMenu(contextMenu);
        tray.on('click', () => mainWindow?.show());
    } catch (err) {
        console.error('Error setting up tray:', err);
    }
}

app.whenReady().then(() => {
    createWindow();   // creates window in background
    createTray();     // tray only
    console.log("[Emerald] Running in background (tray only)");
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        // Keep running in tray
    }
});

app.on('before-quit', () => {
    for (const file of Array.from(scriptRunners.keys())) {
        stopScript(file);
    }
    for (const file of Array.from(cronJobs.keys())) {
        stopCronJob(file);
    }
});

// IPC Handlers
ipcMain.on('log', (message) => {
    console.log('Renderer log:', message);
});

ipcMain.handle('log', async (_, msg) => {
    console.log('[renderer log]', msg);
});

ipcMain.handle('write-startup-log', async (_event, message) => {
    try {
        const logPath = path.join(app.getPath('userData'), 'emerald_startup.log');
        const timestamp = new Date().toISOString();
        await fsPromises.appendFile(logPath, `[${timestamp}] ${message}\n`, 'utf8');
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('network-start-capture', async (_event, options = {}) => {
    if (networkCaptureProcess) {
        return { ok: true, alreadyRunning: true };
    }

    const scriptPath = getNetworkCaptureScriptPath();
    if (!existsSync(scriptPath)) {
        const error = `Network capture script not found: ${scriptPath}`;
        pushScriptLog(`[Network] ${error}`);
        return { ok: false, error };
    }

    let iface = 'any';
    let extraArgs = [];

    try {
        const normalized = normalizeNetworkCaptureOptions(options);
        iface = normalized.iface;
        extraArgs = normalized.extraArgs;
    } catch (err) {
        pushScriptLog(`[Network] ${err.message}`);
        return { ok: false, error: err.message };
    }

    try {
        if (process.platform === 'win32') {
            if (!commandExists('wsl')) {
                const error = 'WSL is not installed or unavailable.';
                pushScriptLog(`[Network] ${error}`);
                return { ok: false, error };
            }
        }

        const spawnArgs = getNetworkCaptureSpawnArgs(scriptPath, iface, extraArgs);
        networkCaptureProcess = spawn(
            process.platform === 'win32' ? 'wsl' : 'bash',
            spawnArgs,
            { stdio: ['ignore', 'pipe', 'pipe'] }
        );

        pushScriptLog(`[Network] Started capture on interface: ${iface}${extraArgs.length ? ` with args: ${extraArgs.join(' ')}` : ''}`);

        networkCaptureProcess.stdout.on('data', (data) => {
            const lines = data.toString().split(/\r?\n/);
            for (const line of lines) {
                if (line.trim()) {
                    const packet = {
                        ts: new Date().toISOString(),
                        raw: line.trim(),
                        source: 'tcpdump',
                        interface: iface
                    };
                    writePacket(packet);
                    broadcastNetworkLog(line);
                }
            }
        });

        networkCaptureProcess.stderr.on('data', (data) => {
            broadcastNetworkLog(process.platform === 'win32' ? `WSL ERR: ${data.toString().trim()}` : data.toString().trim());
        });

        networkCaptureProcess.on('error', (err) => {
            networkCaptureProcess = null;
            pushScriptLog(`[Network] Capture error: ${err.message}`);
        });

        networkCaptureProcess.on('exit', (code) => {
            networkCaptureProcess = null;
            pushScriptLog(`[Network] Capture stopped (code ${code})`);
        });

        return { ok: true, iface, extraArgs };
    } catch (err) {
        networkCaptureProcess = null;
        pushScriptLog(`[Network] Failed to start: ${err.message}`);
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('network-stop-capture', () => {
    const process = networkCaptureProcess;

    if (!process) {
        return { ok: true, alreadyStopped: true };
    }

    networkCaptureProcess = null;
    pushScriptLog('[Network] Capture stopped by user');

    if (process.pid) {
        killProcessTree(process.pid);
    } else {
        process.kill('SIGTERM');
    }

    return { ok: true };
});

ipcMain.handle('run-script', async (_event, { file }) => {
    const safeFile = sanitizeScriptFile(file);
    if (!safeFile) return { ok: false, error: 'Invalid script file' };

    const config = await readConfig();
    const scriptPath = path.join(getScriptsDir(config), safeFile);
    return startScript(safeFile, scriptPath);
});

ipcMain.handle('stop-script', (event, { file }) => {
    return stopScript(file);
});

ipcMain.handle('start-cron-script', async (_event, { file, intervalMs }) => {
    const safeFile = sanitizeScriptFile(file);
    if (!safeFile) return { ok: false, error: 'Invalid script file' };

    const config = await readConfig();
    const scriptPath = path.join(getScriptsDir(config), safeFile);
    return startCronScript(safeFile, scriptPath, intervalMs);
});

ipcMain.handle('stop-cron-script', (event, { file }) => {
    return stopCronJob(file);
});

ipcMain.handle('get-running-scripts', () => Array.from(scriptRunners.keys()));

ipcMain.handle('get-cron-scripts', () => {
    const result = [];
    for (const [file, job] of cronJobs.entries()) {
        result.push({ file, intervalMs: job.intervalMs });
    }
    return result;
});

ipcMain.handle('get-script-log-history', (_event, maxLines = MAX_SCRIPT_LOG_LINES) => {
    return scriptLogHistory.slice(-maxLines);
});

ipcMain.handle('network-logs:list', async (_event, { folder = 'ALL' } = {}) => {
    try {
        const safeFolder = NETWORK_LOG_FOLDERS.has(folder) ? folder : 'ALL';
        const logFolder = getNetworkLogFolder(safeFolder);
        await fsPromises.mkdir(logFolder, { recursive: true });

        const files = (await fsPromises.readdir(logFolder))
            .filter((file) => /\.(json|jsonl|txt)$/i.test(file))
            .sort((a, b) => b.localeCompare(a));

        return { ok: true, folder: safeFolder, files, dir: logFolder };
    } catch (err) {
        console.error('[Network Logs] List error:', err);
        return { ok: false, error: err.message, files: [] };
    }
});

ipcMain.handle('network-logs:read', async (_event, { folder = 'ALL', file } = {}) => {
    try {
        const safeFolder = NETWORK_LOG_FOLDERS.has(folder) ? folder : 'ALL';
        const safeFile = sanitizeNetworkLogFile(file);
        if (!safeFile) return { ok: false, error: 'Invalid network log file' };

        const content = await fsPromises.readFile(path.join(getNetworkLogFolder(safeFolder), safeFile), 'utf8');
        return { ok: true, folder: safeFolder, file: safeFile, content };
    } catch (err) {
        console.error('[Network Logs] Read error:', err);
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select Scripts Directory'
    });
    return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('select-file', async (_event, options = {}) => {
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: options.title || 'Select File',
            filters: options.filters || [],
            properties: options.properties || ['openFile']
        });
        return result;
    } catch (err) {
        console.error('File select error:', err);
        return { canceled: true };
    }
});

ipcMain.handle('get-user-data-path', () => app.getPath('userData'));

ipcMain.handle('scripts:list', async () => {
    try {
        const config = await readConfig();
        const scriptsDir = getScriptsDir(config);

        if (!existsSync(scriptsDir)) {
            await fsPromises.mkdir(scriptsDir, { recursive: true });
        }

        const files = (await fsPromises.readdir(scriptsDir))
            .filter((file) => /\.(js|sh|bat|exe|ahk|ps1)$/i.test(file))
            .sort((a, b) => a.localeCompare(b));

        await ensureConfigEntries(config, files);
        return { files, config: await readConfig(), scriptsDir };
    } catch (err) {
        pushScriptLog(`[Scripts] List error: ${err.message}`);
        return { files: [], config: await readConfig(), scriptsDir: getDefaultScriptsDir() };
    }
});

ipcMain.handle('scripts:read', async (_event, { file }) => {
    try {
        const safeFile = sanitizeScriptFile(file);
        if (!safeFile) return { ok: false, error: 'Invalid script file' };
        if (safeFile.toLowerCase().endsWith('.exe')) return { ok: false, error: 'Cannot view binary file' };

        const config = await readConfig();
        const content = await fsPromises.readFile(path.join(getScriptsDir(config), safeFile), 'utf8');
        return { ok: true, content };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('scripts:write', async (_event, { file, content }) => {
    try {
        const safeFile = sanitizeScriptFile(file);
        if (!safeFile) return { ok: false, error: 'Invalid script file' };
        if (safeFile.toLowerCase().endsWith('.exe')) return { ok: false, error: 'Cannot write binary file' };

        const config = await readConfig();
        await fsPromises.writeFile(path.join(getScriptsDir(config), safeFile), String(content || ''), 'utf8');
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('scripts:set-directory', async (_event, { customScriptsPath }) => {
    try {
        const config = await readConfig();
        config.customScriptsPath = customScriptsPath || null;
        const savedConfig = await writeConfig(config);
        return { ok: true, config: savedConfig };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('scripts:dependency-exists', async (_event, { file }) => {
    try {
        const config = await readConfig();
        return existsSync(path.join(getScriptsDir(config), sanitizeScriptFile(file) || file));
    } catch {
        return false;
    }
});

ipcMain.handle('config:save', async (_event, { config }) => {
    try {
        const savedConfig = await writeConfig(config);
        return { ok: true, config: savedConfig };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('get-ahk-path', async () => {
    const config = await readConfig();
    return config.ahkPath || null;
});

ipcMain.handle('set-ahk-path', async (_event, ahkPath) => {
    try {
        const config = await readConfig();
        config.ahkPath = ahkPath || null;
        await writeConfig(config);
        console.log(`[AHK] Path updated to: ${ahkPath || 'auto-detect'}`);
        return { ok: true };
    } catch (err) {
        console.error('[AHK] Failed to save path:', err);
        return { ok: false, error: err.message };
    }
});

export { PRODUCTION };