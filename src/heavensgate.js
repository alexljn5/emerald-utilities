import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, screen } from 'electron';
import path from 'path';
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import { existsSync } from 'fs';
import fsPromises from 'fs/promises';
import { fileURLToPath } from 'url';
import { parseTcpdumpArgs } from './core/tcpdumpArgs.js';
import { writePacket } from './core/networkFileWriter.js';
import { registerIpcHandlers } from './utils/ipcHandlers.js';

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
    const explicitConfigPath = process.env.EMERALD_CONFIG_PATH;

    if (explicitConfigPath) {
        return path.isAbsolute(explicitConfigPath)
            ? explicitConfigPath
            : path.join(process.cwd(), explicitConfigPath);
    }

    return path.join(app.getPath('userData'), 'config.json');
}

async function readConfig() {
    try {
        const configPath = getConfigPath();

        if (!existsSync(configPath)) {
            const config = getDefaultConfig();
            await fsPromises.mkdir(path.dirname(configPath), { recursive: true });
            await fsPromises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
            console.log(`[Config] Using dev config: ${configPath}`);
            return config;
        }

        console.log(`[Config] Using config: ${configPath}`);
        return JSON.parse(await fsPromises.readFile(configPath, 'utf8'));
    } catch (err) {
        console.error('[Config] Failed to read config:', err.message);
        return getDefaultConfig();
    }
}

let configWritePromise = Promise.resolve();

function queueConfigWrite(writeFn) {
    const run = configWritePromise.then(writeFn, writeFn);
    configWritePromise = run.then(() => undefined, () => undefined);
    return run;
}

function inferScriptType(file) {
    return file.match(/\.(js|sh|bat|exe|ahk|ps1)$/i)?.[1]?.toLowerCase() ?? 'unknown';
}

function normalizeCronInterval(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
}

function createDefaultScriptConfig(file) {
    return {
        file,
        type: inferScriptType(file),
        autoRun: false,
        cronEnabled: false,
        cronInterval: 0,
        displayName: `Run ${file}`
    };
}

function normalizeScriptEntry(script, fallback = {}) {
    if (!script || typeof script !== 'object') return null;

    const file = typeof script.file === 'string' ? script.file.trim() : '';
    if (!file) return null;

    return {
        file,
        type: typeof script.type === 'string' && script.type ? script.type.toLowerCase() : (typeof fallback.type === 'string' && fallback.type ? fallback.type : inferScriptType(file)),
        autoRun: Boolean(script.autoRun ?? fallback.autoRun ?? false),
        cronEnabled: Boolean(script.cronEnabled ?? fallback.cronEnabled ?? false),
        cronInterval: normalizeCronInterval(script.cronInterval ?? fallback.cronInterval ?? 0),
        displayName: typeof script.displayName === 'string' && script.displayName.trim()
            ? script.displayName
            : (typeof fallback.displayName === 'string' && fallback.displayName ? fallback.displayName : `Run ${file}`)
    };
}

function normalizeScriptEntries(scripts, fallbackScripts = []) {
    const seen = new Set();
    const normalized = [];

    for (const script of Array.isArray(scripts) ? scripts : []) {
        const normalizedScript = normalizeScriptEntry(script);
        if (!normalizedScript || seen.has(normalizedScript.file)) continue;

        seen.add(normalizedScript.file);
        normalized.push(normalizedScript);
    }

    for (const fallback of Array.isArray(fallbackScripts) ? fallbackScripts : []) {
        const normalizedFallback = normalizeScriptEntry(fallback);
        if (!normalizedFallback || seen.has(normalizedFallback.file)) continue;

        seen.add(normalizedFallback.file);
        normalized.push(normalizedFallback);
    }

    return normalized;
}

function mergeScriptsPreservingExisting(incomingScripts, existingScripts) {
    const existingByFile = new Map();

    for (const script of normalizeScriptEntries(existingScripts)) {
        existingByFile.set(script.file, script);
    }

    for (const incoming of normalizeScriptEntries(incomingScripts)) {
        const existing = existingByFile.get(incoming.file);

        if (!existing) {
            existingByFile.set(incoming.file, incoming);
            continue;
        }

        existingByFile.set(incoming.file, {
            ...existing,
            file: incoming.file,
            type: existing.type || inferScriptType(incoming.file),
            cronEnabled: Object.prototype.hasOwnProperty.call(existing, 'cronEnabled') ? existing.cronEnabled : false,
            cronInterval: Object.prototype.hasOwnProperty.call(existing, 'cronInterval') ? existing.cronInterval : 0
        });
    }

    return Array.from(existingByFile.values());
}

async function writeConfig(config, options = {}) {
    return queueConfigWrite(async () => {
        const baseConfig = options.preserveExisting ? await readConfig() : null;
        const existingScripts = Array.isArray(baseConfig?.scripts) ? baseConfig.scripts : [];
        const fallbackScripts = options.preserveExistingScriptSettings || options.preserveMissingScripts ? existingScripts : [];
        const scripts = options.preserveExistingScriptSettings
            ? mergeScriptsPreservingExisting(config?.scripts, existingScripts)
            : normalizeScriptEntries(config?.scripts, fallbackScripts);

        const cleanConfig = {
            scripts,
            customScriptsPath: options.preserveTopLevel && config?.customScriptsPath == null
                ? (baseConfig?.customScriptsPath || null)
                : (config?.customScriptsPath || null),
            ahkPath: options.preserveTopLevel && config?.ahkPath == null
                ? (baseConfig?.ahkPath || null)
                : (config?.ahkPath || null)
        };

        await fsPromises.writeFile(getConfigPath(), JSON.stringify(cleanConfig, null, 2), 'utf8');
        return cleanConfig;
    });
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

async function ensureConfigEntries(files) {
    const config = await readConfig();
    config.scripts = normalizeScriptEntries(config.scripts);

    const scriptsByFile = new Map(config.scripts.map((script) => [script.file, script]));
    let changed = false;

    for (const file of files) {
        const scriptConfig = scriptsByFile.get(file);

        if (!scriptConfig) {
            scriptsByFile.set(file, createDefaultScriptConfig(file));
            changed = true;
            continue;
        }

        if (!Object.prototype.hasOwnProperty.call(scriptConfig, 'cronEnabled')) {
            scriptConfig.cronEnabled = false;
            changed = true;
        }

        if (!Object.prototype.hasOwnProperty.call(scriptConfig, 'cronInterval')) {
            scriptConfig.cronInterval = 0;
            changed = true;
        }
    }

    config.scripts = Array.from(scriptsByFile.values());

    if (changed) {
        await writeConfig(config, {
            preserveExisting: true,
            preserveExistingScriptSettings: true,
            preserveTopLevel: true
        });
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
    return getConfigPath();
}

function getConfiguredAhkPath() {
    try {
        const configPath = getAhkConfigPath();
        if (existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
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

registerIpcHandlers({
    app,
    ipcMain,
    dialog,
    fsPromises,
    existsSync,
    path,
    readConfig,
    writeConfig,
    getScriptsDir,
    getDefaultScriptsDir,
    ensureConfigEntries,
    sanitizeScriptFile,
    sanitizeNetworkLogFile,
    getNetworkLogFolder,
    NETWORK_LOG_FOLDERS,
    getNetworkCaptureScriptPath,
    normalizeNetworkCaptureOptions,
    getNetworkCaptureSpawnArgs,
    commandExists,
    spawn,
    killProcessTree,
    startScript,
    stopScript,
    startCronScript,
    stopCronJob,
    scriptRunners,
    cronJobs,
    scriptLogHistory,
    MAX_SCRIPT_LOG_LINES,
    pushScriptLog,
    broadcastNetworkLog,
    writePacket,
    getNetworkCaptureProcess: () => networkCaptureProcess,
    setNetworkCaptureProcess: (value) => {
        networkCaptureProcess = value;
    },
    getDialogParentWindow: () => mainWindow
});

export { PRODUCTION };