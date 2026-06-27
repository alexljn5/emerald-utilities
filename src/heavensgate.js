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
    const numericPid = Number(pid);
    if (!Number.isFinite(numericPid)) return false;

    try {
        if (process.platform === 'win32') {
            execSync(`taskkill /F /T /PID ${numericPid}`, { stdio: 'ignore' });
            return true;
        }

        try {
            process.kill(-numericPid, 'SIGTERM');
            return true;
        } catch {
            process.kill(numericPid, 'SIGTERM');
            return true;
        }
    } catch {
        return false;
    }
}

function killChildProcess(child, label = 'child process') {
    if (!child || child.killed) return false;

    pushScriptLog(`Stopping ${label}...`);
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();

    if (child.pid) {
        killProcessTree(child.pid);
    } else {
        child.kill('SIGTERM');
    }

    return true;
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
const DEFAULT_UI_CONFIG = Object.freeze({
    minimizeAtStartup: true,
    hideOnMinimize: true,
    hideOnClose: true,
    showDashboardTopBar: true,
    showDashboardTerminal: true,
    showDashboardNetworkOutput: true,
    compactDashboard: false,
    weatherCity: 'Amsterdam'
});
let nextScriptLogId = 1;
let networkCaptureProcess = null;
let currentWindowUi = null;

function getDefaultUiConfig() {
    return { ...DEFAULT_UI_CONFIG };
}

function normalizeBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}

function normalizeUiConfig(ui = {}) {
    const fallback = getDefaultUiConfig();

    return {
        minimizeAtStartup: normalizeBoolean(ui?.minimizeAtStartup, fallback.minimizeAtStartup),
        hideOnMinimize: normalizeBoolean(ui?.hideOnMinimize, fallback.hideOnMinimize),
        hideOnClose: normalizeBoolean(ui?.hideOnClose, fallback.hideOnClose),
        showDashboardTopBar: normalizeBoolean(ui?.showDashboardTopBar, fallback.showDashboardTopBar),
        showDashboardTerminal: normalizeBoolean(ui?.showDashboardTerminal, fallback.showDashboardTerminal),
        showDashboardNetworkOutput: normalizeBoolean(ui?.showDashboardNetworkOutput, fallback.showDashboardNetworkOutput),
        compactDashboard: normalizeBoolean(ui?.compactDashboard, fallback.compactDashboard),
        weatherCity: typeof ui?.weatherCity === 'string' && ui.weatherCity.trim()
            ? ui.weatherCity.trim()
            : fallback.weatherCity
    };
}

function getDefaultConfig() {
    return { scripts: [], customScriptsPath: null, ahkPath: null, ui: getDefaultUiConfig() };
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
        const config = JSON.parse(await fsPromises.readFile(configPath, 'utf8'));
        config.ui = normalizeUiConfig(config?.ui);
        return config;
    } catch (err) {
        console.error('[Config] Failed to read config:', err.message);
        return getDefaultConfig();
    }
}

function readConfigSync() {
    try {
        const configPath = getConfigPath();
        if (!existsSync(configPath)) return getDefaultConfig();
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config.ui = normalizeUiConfig(config?.ui);
        return config;
    } catch (err) {
        console.error('[Config] Failed to synchronously read config:', err.message);
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
                : (config?.ahkPath || null),
            ui: normalizeUiConfig(config?.ui)
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
    const captureCommand = getNetworkCaptureCommand(scriptPath, normalizedIface, extraArgs);
    const proc = spawn(
        captureCommand.command,
        captureCommand.args,
        { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    proc.stdin.end(captureCommand.stdin);
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

function getNetworkCaptureCommand(scriptPath, iface = 'any', extraArgs = []) {
    const stdin = fs.readFileSync(scriptPath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    if (process.platform === 'win32') {
        return {
            command: 'wsl',
            args: ['bash', '-s', iface, ...extraArgs],
            stdin
        };
    }

    return {
        command: 'bash',
        args: ['-s', iface, ...extraArgs],
        stdin
    };
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

    scriptRunners.delete(file);
    setScriptRunning(file, false);
    killChildProcess(child, file);

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

    if (job.currentChild) {
        killChildProcess(job.currentChild, `${file} cron process`);
    }

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
        const previousChild = cronJobs.get(file)?.currentChild;
        if (previousChild && !previousChild.killed) {
            pushScriptLog(`[CRON] Stopping previous ${file} process before next run`);
            killChildProcess(previousChild, `${file} previous cron process`);
        }

        const child = spawn(command, commandInfo.args, {
            shell: commandInfo.useShell !== false && isWindows,
            windowsVerbatimArguments: true,
            cwd
        });

        cronJobs.set(file, { timer, intervalMs, scriptPath, currentChild: child });
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
            const job = cronJobs.get(file);
            if (job?.currentChild === child) {
                job.currentChild = null;
            }
            pushScriptLog(`[CRON] ${file} finished (${signal || code})`);
        });
    }, intervalMs);

    cronJobs.set(file, { timer, intervalMs, scriptPath });
    setScriptRunning(file, true);
    pushScriptLog(`Cron job started for ${file} (every ${intervalMs}ms)`);

    return { ok: true };
}

async function createWindow() {
    try {
        const config = await readConfig();
        const ui = normalizeUiConfig(config?.ui);
        currentWindowUi = ui;
        const shouldShowAtStartup = !ui.minimizeAtStartup;
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
                webviewTag: true,
            },
            show: false
        });

        if (PRODUCTION) {
            mainWindow.setMenu(null);
        }

        const showMainWindow = () => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            mainWindow.show();
            mainWindow.focus();
        };

        mainWindow.once('ready-to-show', () => {
            if (shouldShowAtStartup) {
                showMainWindow();
            }
        });

        mainWindow.webContents.once('did-finish-load', () => {
            if (shouldShowAtStartup && !mainWindow.isVisible()) {
                showMainWindow();
            }
        });

        const devServerUrl = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173';
        const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

        if (isDev) {
            await mainWindow.loadURL(devServerUrl).catch(err => {
                console.error('Failed to load Vite dev server:', err);
            });
        } else {
            const indexPath = path.join(app.getAppPath(), 'dist', 'index.html');
            await mainWindow.loadFile(indexPath).catch(err => {
                console.error('Failed to load dist/index.html:', err);
            });
        }

        mainWindow.on('close', (event) => {
            const activeUi = normalizeUiConfig(readConfigSync()?.ui);
            if (!app.isQuitting && activeUi.hideOnClose) {
                event.preventDefault();
                if (!mainWindow.isDestroyed()) {
                    mainWindow.hide();
                }
            }
        });

        mainWindow.on('minimize', () => {
            const activeUi = normalizeUiConfig(readConfigSync()?.ui);
            if (activeUi.hideOnMinimize && !mainWindow.isDestroyed()) {
                mainWindow.hide();
            }
        });
    } catch (err) {
        console.error('Error creating window:', err);
    }
}

function applyWindowUi(ui) {
    currentWindowUi = normalizeUiConfig(ui);
}

function showMainWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
    }
}

function createTray() {
    try {
        const iconPath = path.join(__dirname, '../img/favicons/favicon.png');
        tray = new Tray(iconPath);

        const contextMenu = Menu.buildFromTemplate([
            { label: 'Show App', click: showMainWindow },
            {
                label: 'Quit',
                click: () => {
                    app.isQuitting = true;
                    if (tray && !tray.isDestroyed()) {
                        tray.destroy();
                    }
                    app.quit();
                }
            }
        ]);

        if (!tray.isDestroyed()) {
            tray.setToolTip('Emerald Utilities');
            tray.setContextMenu(contextMenu);
            tray.on('click', showMainWindow);
        }
    } catch (err) {
        console.error('Error setting up tray:', err);
    }
}

app.whenReady().then(async () => {
    await createWindow();
    createTray();
    console.log("[Emerald] Running in background (tray only)");
});

app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        await createWindow();
    } else {
        showMainWindow();
    }
});

app.on('window-all-closed', () => {
    if (process.platform === 'darwin') return;

    const activeUi = normalizeUiConfig(readConfigSync()?.ui);
    if (!activeUi.hideOnClose) {
        app.quit();
    }
});

app.on('before-quit', () => {
    const captureProcess = networkCaptureProcess;
    if (captureProcess) {
        networkCaptureProcess = null;
        killChildProcess(captureProcess, 'network capture');
    }

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
    normalizeUiConfig,
    getScriptsDir,
    getDefaultScriptsDir,
    ensureConfigEntries,
    sanitizeScriptFile,
    sanitizeNetworkLogFile,
    getNetworkLogFolder,
    NETWORK_LOG_FOLDERS,
    getNetworkCaptureScriptPath,
    normalizeNetworkCaptureOptions,
    getNetworkCaptureCommand,
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
    broadcast,
    broadcastNetworkLog,
    writePacket,
    getNetworkCaptureProcess: () => networkCaptureProcess,
    setNetworkCaptureProcess: (value) => {
        networkCaptureProcess = value;
    },
    applyWindowUi,
    getDialogParentWindow: () => mainWindow
});

export { PRODUCTION };