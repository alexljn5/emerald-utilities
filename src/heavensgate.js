import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, screen, safeStorage, Notification, nativeImage } from 'electron';
import path from 'path';
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import { existsSync } from 'fs';
import fsPromises from 'fs/promises';
import { fileURLToPath } from 'url';
import { parseTcpdumpArgs } from './core/tcpdumpArgs.js';
import { ArchiveScheduler } from './core/archiveScheduler.js';
import { writePacket } from './core/networkFileWriter.js';
import { registerIpcHandlers } from './utils/ipcHandlers.js';
import { registerXScraperIpcHandlers } from './utils/xscraperIpcHandlers.js';
import { startWorker as startXScraperForwardWorker, getStatus as getXScraperForwardStatus } from './database/xscraper-forwarder.js';
import { registerCreatorHubIpc } from './creator-hub/ipc.js';
import { registerEnvIpc } from './utils/envIpc.js';
import { resolvePath, resolveInternalScriptsPath } from './utils/pathResolver.js';
import { registerBotIpcHandlers } from './bots/bot-ipc.js';
import { autoStartBot, cleanup as cleanupBot, getAutoStartEnabled } from './bots/bot-manager.js';
import { default as databaseService } from './database/wrath.js';
import { recover as recoverNetworkPersistence } from './database/network-persistence.js';
import { ENABLE_DEVTOOLS, ENABLE_INAPP_NOTIFICATIONS, AI_MODE, DATABASE_MODE, LOCAL_AI_ENABLED } from './globals.js';
import { registerDeepLinkHandler } from './creator-hub/oauth.js';
import { getAumid } from './utils/osNotifier.js';
import {
    getPendingReminders,
    markReminderHandled,
    getTasks,
    getSubtasks,
} from './database/tasks/tasks-service.js';
import {
    sendTaskNotification,
    sendDebugNotification,
    NOTIFICATION_TYPE,
} from './utils/notificationService.js';
import {
    NOTIFICATION_POLICY,
    shouldNotifyTask,
    recordNotification,
} from './utils/notificationPolicy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== WINDOWS APP USER MODEL ID ====================
// Must be set BEFORE any windows are created so Windows can associate
// toast notifications, taskbar grouping, and jump lists with this identity.
// The AUMID is a stable application identifier (never an executable path).
//
// IMPORTANT: Windows Toast notifications require the AUMID passed to the
// notifier, the AUMID set here, and the AUMID attached to a registered Start
// Menu shortcut to ALL be IDENTICAL. We derive it from getAumid() (shared with
// osNotifier.js), which resolves to:
//   dev  → com.alexljn5.emeraldutilities.dev
//   prod → com.alexljn5.emeraldutilities
// This keeps the ENTIRE identity chain (Electron AUMID == shortcut AUMID ==
// notifier AppID) internally consistent per packaged state — never "AUMID A/B/C".
const APP_AUMID = getAumid();
if (process.platform === 'win32') {
    app.setAppUserModelId(APP_AUMID);
    console.log(`[Emerald] AppUserModelId set to ${APP_AUMID} (packaged=${app.isPackaged})`);
    console.log(`[Emerald] Windows notification env: platform=win32 isPackaged=${app.isPackaged} execPath=${process.execPath}`);
    console.log(`[Emerald] Windows notification env: aumid=${APP_AUMID} (shortcut will register this exact ID)`);
}

// ==================== DEVTOOLS FLAG ====================
// Imported from globals.js above

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
    weatherCity: 'Amsterdam',
    autoSaveChat: true,
    showDevTools: ENABLE_DEVTOOLS,
    showInAppNotifications: ENABLE_INAPP_NOTIFICATIONS
});
let nextScriptLogId = 1;
let networkCaptureProcess = null;
let databaseProcess = null;
let currentWindowUi = null;
let archiveScheduler = null;

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
            : fallback.weatherCity,
        autoSaveChat: normalizeBoolean(ui?.autoSaveChat, fallback.autoSaveChat),
        showDevTools: normalizeBoolean(ui?.showDevTools, fallback.showDevTools),
        showInAppNotifications: normalizeBoolean(ui?.showInAppNotifications, fallback.showInAppNotifications)
    };
}

function getDefaultConfig() {
    return { scripts: [], customScriptsPath: null, ahkPath: null, ui: getDefaultUiConfig() };
}

// ==================== SAFE STORAGE ====================
const SENSITIVE_KEYS = new Set([
    'password',
    'apiKey',
    'api_key',
    'secret',
    'token',
    'GROK_API_KEY',
    'OPENAI_API_KEY',
    'POSTGRES_PASSWORD'
]);

function isSensitiveKey(key) {
    return SENSITIVE_KEYS.has(key);
}

function encryptSecret(text) {
    if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('OS-level encryption is not available. Cannot encrypt secrets.');
    }
    const encrypted = safeStorage.encryptString(text);
    return `encrypted:${Buffer.from(encrypted).toString('base64')}`;
}

function decryptSecret(encryptedBase64) {
    if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('OS-level encryption is not available. Cannot decrypt secrets.');
    }
    if (typeof encryptedBase64 !== 'string' || !encryptedBase64.startsWith('encrypted:')) {
        return encryptedBase64;
    }
    const base64 = encryptedBase64.slice('encrypted:'.length);
    const buffer = Buffer.from(base64, 'base64');
    return safeStorage.decryptString(buffer);
}

function decryptConfig(config) {
    if (!config || typeof config !== 'object') return config;

    const decrypted = { ...config };
    for (const key of Object.keys(decrypted)) {
        if (isSensitiveKey(key) && typeof decrypted[key] === 'string') {
            try {
                decrypted[key] = decryptSecret(decrypted[key]);
            } catch (err) {
                console.error(`[Config] Failed to decrypt ${key}:`, err.message);
            }
        } else if (typeof decrypted[key] === 'object' && decrypted[key] !== null) {
            decrypted[key] = decryptConfig(decrypted[key]);
        }
    }
    return decrypted;
}

function encryptConfig(config) {
    if (!config || typeof config !== 'object') return config;

    if (!safeStorage.isEncryptionAvailable()) {
        console.warn('[Config] safeStorage is not available. Sensitive values will be stored in plaintext.');
        return config;
    }

    const encrypted = { ...config };
    for (const key of Object.keys(encrypted)) {
        if (isSensitiveKey(key) && typeof encrypted[key] === 'string' && encrypted[key] !== '') {
            try {
                encrypted[key] = encryptSecret(encrypted[key]);
            } catch (err) {
                console.error(`[Config] Failed to encrypt ${key}:`, err.message);
            }
        } else if (typeof encrypted[key] === 'object' && encrypted[key] !== null) {
            encrypted[key] = encryptConfig(encrypted[key]);
        }
    }
    return encrypted;
}

function getConfigPath() {
    const explicitConfigPath = process.env.EMERALD_CONFIG_PATH;

    if (explicitConfigPath) {
        return path.isAbsolute(explicitConfigPath)
            ? explicitConfigPath
            : resolvePath(explicitConfigPath);
    }

    // AppImage mounts the app resources as read-only, so never write config into resources.
    // Persist config into userData on packaged Linux/macOS and Windows.
    if (app.isPackaged) {
        return path.join(app.getPath('userData'), 'scripts', 'config.json');
    }

    return resolvePath('scripts/config.json');
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

        if (safeStorage.isEncryptionAvailable()) {
            return decryptConfig(config);
        }

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

    // Handle both array and object formats
    const scriptsArray = Array.isArray(scripts) ? scripts : (scripts ? Object.values(scripts) : []);
    const fallbackArray = Array.isArray(fallbackScripts) ? fallbackScripts : (fallbackScripts ? Object.values(fallbackScripts) : []);

    for (const script of scriptsArray) {
        const normalizedScript = normalizeScriptEntry(script);
        if (!normalizedScript || seen.has(normalizedScript.file)) continue;

        seen.add(normalizedScript.file);
        normalized.push(normalizedScript);
    }

    for (const fallback of fallbackArray) {
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
        const existingScripts = baseConfig?.scripts ? (Array.isArray(baseConfig.scripts) ? baseConfig.scripts : Object.values(baseConfig.scripts)) : [];
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

        const configToWrite = safeStorage.isEncryptionAvailable()
            ? encryptConfig(cleanConfig)
            : cleanConfig;

        await fsPromises.writeFile(getConfigPath(), JSON.stringify(configToWrite, null, 2), 'utf8');
        return cleanConfig;
    });
}

function getDefaultScriptsDir() {
    const devPath = path.join(app.getAppPath(), 'scripts');
    const resPath = resolvePath('scripts');

    if (existsSync(devPath)) return devPath;
    if (existsSync(resPath)) return resPath;

    return devPath;
}

function looksLikeWindowsPath(p) {
    return typeof p === 'string' && /^[A-Za-z]:\\/.test(p.trim());
}

function getScriptsDir(config) {
    const custom = config?.customScriptsPath;

    // On non-Windows platforms, ignore persisted Windows paths.
    if (process.platform !== 'win32' && looksLikeWindowsPath(custom)) {
        console.warn(`[Scripts] Ignoring Windows customScriptsPath on ${process.platform}: ${custom}`);
        return getDefaultScriptsDir();
    }

    return custom || getDefaultScriptsDir();
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

function notifyArchive(payload) {
    broadcast('archive-notification', {
        id: `toast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: new Date().toISOString(),
        ...payload
    });
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

function getDatabaseScriptPath(scriptName) {
    return resolveInternalScriptsPath(scriptName);
}

function getDatabaseDir() {
    // Derive database directory relative to internal-scripts:
    // src/internal-scripts/ -> src/database/
    // process.resourcesPath/internal-scripts/ -> process.resourcesPath/database/
    const scriptDir = resolveInternalScriptsPath();
    return path.join(path.dirname(scriptDir), 'database');
}

function getDatabaseCommand(scriptPath, dbDir) {
    const wslDbDir = toWslPath(dbDir);

    if (process.platform === 'win32') {
        // On Windows, run the script inside WSL via `wsl bash -s`
        const stdin = fs.readFileSync(scriptPath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        return {
            command: 'wsl',
            args: ['bash', '-s', wslDbDir],
            stdin
        };
    }

    // On Linux/macOS, run directly
    return {
        command: 'bash',
        args: [scriptPath, dbDir],
        stdin: null
    };
}

async function runDatabaseUtilityScript(scriptName, logPrefix, extraArgs = []) {
    const scriptPath = getDatabaseScriptPath(scriptName);
    if (!existsSync(scriptPath)) {
        throw new Error(`${scriptName} not found: ${scriptPath}`);
    }

    const dbDir = getDatabaseDir();
    const wslDbDir = toWslPath(dbDir);

    return new Promise((resolve, reject) => {
        const proc = spawn('wsl', ['bash', scriptPath, wslDbDir, ...extraArgs], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
            const text = data.toString();
            stdout += text;
            pushScriptLog(`[${logPrefix}] ${text.trim()}`);
        });

        proc.stderr.on('data', (data) => {
            const text = data.toString();
            stderr += text;
            pushScriptLog(`[${logPrefix}] ${text.trim()}`);
        });

        proc.on('close', (code) => {
            if (code === 0) {
                resolve({ ok: true, output: stdout });
            } else {
                reject(new Error(stderr || `${scriptName} failed with code ${code}`));
            }
        });

        proc.on('error', reject);
    });
}

async function runArchiveSchedulerAction(action) {
    if (action === 'backup') {
        return runDatabaseUtilityScript('volume-backup.sh', 'Archive-Backup');
    }

    if (action === 'verify') {
        return runDatabaseUtilityScript('volume-verify.sh', 'Archive-Verify');
    }

    if (action === 'metadata-sync') {
        await databaseService.healthCheck();
        const stats = await databaseService.getStats();
        await databaseService.setMeta('archive_scheduler_last_metadata_sync', {
            syncedAt: new Date().toISOString(),
            stats
        });
        return { ok: true, stats };
    }

    throw new Error(`Unsupported archive scheduler action: ${action}`);
}

export async function startDatabase() {
    if (databaseProcess) {
        console.log('[DB] Database process already running');
        return;
    }

    const scriptPath = getDatabaseScriptPath('db-start.sh');
    const dbDir = getDatabaseDir();
    const { command, args, stdin } = getDatabaseCommand(scriptPath, dbDir);

    console.log(`[DB] Starting database... Script: ${scriptPath}, Dir: ${toWslPath(dbDir)}`);

    return new Promise((resolve, reject) => {
        const proc = spawn(
            command,
            args,
            { stdio: ['pipe', 'pipe', 'pipe'] }
        );

        if (stdin) {
            proc.stdin.end(stdin);
        }

        proc.stdout.setEncoding('utf8');
        proc.stderr.setEncoding('utf8');

        proc.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            for (const line of lines) {
                if (line.trim()) {
                    console.log(`[DB] ${line.trim()}`);
                    pushScriptLog(`[DB] ${line.trim()}`);
                }
            }
        });

        proc.stderr.on('data', (data) => {
            const lines = data.toString().split('\n');
            for (const line of lines) {
                if (line.trim()) {
                    console.error(`[DB ERROR] ${line.trim()}`);
                    pushScriptLog(`[DB ERROR] ${line.trim()}`);
                }
            }
        });

        proc.on('close', (code) => {
            console.log(`[DB] Database script exited with code ${code}`);
            databaseProcess = null;
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Database script exited with code ${code}`));
            }
        });

        proc.on('error', (err) => {
            console.error('[DB] Failed to start database script:', err.message);
            pushScriptLog(`[DB] Failed to start: ${err.message}`);
            databaseProcess = null;
            reject(err);
        });

        databaseProcess = proc;
        console.log('[DB] Database start initiated');
    });
}

export async function stopDatabase() {
    const proc = databaseProcess;
    if (!proc) {
        console.log('[DB] No database process to stop');
        return;
    }

    databaseProcess = null;
    console.log('[DB] Stopping database...');

    // Run the stop script
    const scriptPath = getDatabaseScriptPath('db-stop.sh');
    const dbDir = getDatabaseDir();
    const { command, args, stdin } = getDatabaseCommand(scriptPath, dbDir);

    try {
        const stopProc = spawn(command, args, {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        if (stdin) {
            stopProc.stdin.end(stdin);
        }

        stopProc.stdout.setEncoding('utf8');
        stopProc.stderr.setEncoding('utf8');

        stopProc.stdout.on('data', (data) => {
            console.log(`[DB] ${data.toString().trim()}`);
        });

        stopProc.stderr.on('data', (data) => {
            console.error(`[DB ERROR] ${data.toString().trim()}`);
        });

        await new Promise((resolve, reject) => {
            stopProc.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`Stop script exited with code ${code}`));
            });
            stopProc.on('error', reject);
            setTimeout(resolve, 10000); // Timeout after 10s
        });
    } catch (err) {
        console.error('[DB] Error stopping database:', err.message);
    }

    // Kill the start script process if still running
    killChildProcess(proc, 'database');
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
    return resolveInternalScriptsPath('network-capture.sh');
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
    // Guard against an existing main window. If createWindow() is ever called
    // twice, the second call would overwrite `mainWindow` and orphan the first
    // (still-alive) window, producing a duplicate. Bail out early instead.
    if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('[Emerald] Window already exists, reusing it');
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
        return;
    }

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
            // Use the app favicon so the window/taskbar shows the rabbit icon
            // instead of the generic Electron default (Windows/Linux).
            // On Windows, .ico is required for proper taskbar rendering.
            icon: process.platform === 'win32'
                ? path.join(__dirname, '../img/favicons/favicon.ico')
                : path.join(__dirname, '../img/favicons/favicon.png'),
            webPreferences: {
                contextIsolation: false,
                nodeIntegration: true,
                preload: path.join(__dirname, 'preload.js'),
                allowRendererProcessReuse: false,
                webgl: false,
                webviewTag: true,
                devTools: true,
            },
            show: false
        });

        // Disable default Electron app menu (File/Edit/View/Window/Help)
        // so production doesn't show the standard menu bar.
        Menu.setApplicationMenu(null);


        if (app.isPackaged) {
            mainWindow.setMenu(null);
        }

        const showMainWindow = () => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            mainWindow.show();
            mainWindow.focus();
        };

        // Handles devtools timing safely and breaks it out of the hidden/minimized main window frame
        mainWindow.once('ready-to-show', () => {
            if (currentWindowUi?.showDevTools) {
                mainWindow.webContents.openDevTools({ mode: 'detach' });
            }

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
            // FIX: Step out of dist-electron/ and target the sibling dist/ folder
            const indexPath = path.join(__dirname, '../dist/index.html');
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

// On Windows, toasts are only shown by the OS if the AppUserModelID (AUMID)
// has a matching Start Menu / Desktop shortcut registered with the shell.
// The AUMID (from getAumid()) is consistent across the whole identity chain:
//   Electron AUMID == shortcut AUMID == notifier AppID
// In production, Electron Builder creates the proper shortcut automatically
// (target = Emerald Utilities.exe, no args needed).
//
// In dev (unpackaged) the target is electron.exe, which is NOT itself the app.
// We must pass the project/app path as an argument so the shortcut actually
// launches Emerald Utilities — otherwise the .lnk is a dead launcher and
// Windows won't reliably associate toasts with this application identity.
function registerAumidShortcut() {
    if (process.platform !== 'win32') {
        return;
    }

    const AUMID = APP_AUMID;
    const target = process.execPath; // electron.exe (dev) or the packaged exe (prod)
    const startMenuDir = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const shortcutPath = path.join(startMenuDir, 'Emerald Utilities.lnk');

    // In dev, electron.exe needs the app path as an argument to actually launch
    // the application. In prod the packaged executable is self-contained.
    const targetArgs = app.isPackaged ? '' : path.join(process.cwd(), '.');

    // Ensure the Start Menu Programs directory exists.
    if (!existsSync(startMenuDir)) {
        fs.mkdirSync(startMenuDir, { recursive: true });
    }

    // AUMID must be attached to a real shortcut (IPropertyStore) for Windows to
    // allow toasts from an unpackaged app. WScript.Shell cannot do this, so we
    // delegate to a dedicated PowerShell script that uses the shell32 API.
    let scriptPath;
    try {
        scriptPath = resolveInternalScriptsPath('register-aumid-shortcut.ps1');
    } catch {
        scriptPath = path.join(__dirname, '../internal-scripts/register-aumid-shortcut.ps1');
    }
    if (!existsSync(scriptPath)) {
        console.warn('[Emerald] register-aumid-shortcut.ps1 not found, skipping AUMID shortcut registration');
        return;
    }

    const iconLocation = process.platform === 'win32'
        ? path.join(__dirname, '../img/favicons/favicon.ico')
        : path.join(__dirname, '../img/favicons/favicon.png');

    return new Promise((resolve) => {
        const args = [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', scriptPath,
            '-ShortcutPath', shortcutPath,
            '-Target', target,
            '-IconLocation', iconLocation,
            '-Aumid', AUMID,
        ];
        // Only pass -TargetArgs in dev (non-empty). In production the shortcut
        // targets the packaged exe directly and needs no arguments.
        if (targetArgs) {
            args.push('-TargetArgs', targetArgs);
        }

        const child = spawn('powershell.exe', args, { windowsHide: true, cwd: path.dirname(scriptPath) });

        child.on('close', (code) => {
            if (code === 0) {
                console.log(`[Emerald] AUMID shortcut registered: ${shortcutPath} -> ${AUMID}`);
            } else {
                console.warn(`[Emerald] AUMID shortcut registration failed with code ${code}`);
            }
            resolve();
        });
        child.on('error', (err) => {
            console.error('[Emerald] AUMID shortcut process error:', err.message);
            resolve();
        });
    });
}


function createTray() {
    try {
        if (process.platform === 'win32') {
            const iconPath = path.join(__dirname, '../img/favicons/favicon.ico');
            tray = new Tray(iconPath);
        } else {
            const iconPath = resolvePath('img/favicons/favicon.png');
            console.log(`[Emerald] Loading tray icon from: ${iconPath}`);

            if (!existsSync(iconPath)) {
                console.error(`[Emerald] Tray icon not found at: ${iconPath}`);
            }

            const image = nativeImage.createFromPath(iconPath);
            if (!image.isEmpty()) {
                // Resize to standard tray icon size for Linux desktop environments
                const trayIcon = image.resize({ width: 16, height: 16 });
                console.log(`[Emerald] Tray icon loaded and resized successfully`);
                tray = new Tray(trayIcon);
            } else {
                console.error(`[Emerald] Failed to load tray icon from: ${iconPath}`);
                tray = new Tray(iconPath);
            }
        }

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

// Register the emerald:// custom protocol for OAuth deep links
app.setAsDefaultProtocolClient('emerald');

// Handle deep-link callbacks from the OAuth flow
// macOS: app.on('open-url')
// Windows/Linux: process.argv on startup + app.on('second-instance')
function handleDeepLink(url) {
    if (!url || typeof url !== 'string') return;
    if (!url.startsWith('emerald://')) return;
    console.log(`[Emerald] Deep link received: ${url}`);
    registerDeepLinkHandler(url);
    // Show the main window so the user knows the OAuth flow completed
    showMainWindow();
}

// macOS — fired when the app is already running and a protocol link is clicked
app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
});

// Windows/Linux — fired when a second instance is launched (e.g. protocol link clicked while app is running)
app.on('second-instance', (event, argv, workingDirectory) => {
    const deepLink = argv.find(arg => typeof arg === 'string' && arg.startsWith('emerald://'));
    if (deepLink) {
        handleDeepLink(deepLink);
    }
    showMainWindow();
});

// Windows/Linux — check command-line args on first launch (app launched via protocol link)
const startupDeepLink = process.argv.find(arg => typeof arg === 'string' && arg.startsWith('emerald://'));
if (startupDeepLink) {
    console.log(`[Emerald] Startup deep link: ${startupDeepLink}`);
    // Store it — registerDeepLinkHandler will queue it until the OAuth flow starts
    registerDeepLinkHandler(startupDeepLink);
}

// ==================== TASK NOTIFICATION SCHEDULER ====================
// Main-process scheduler that checks for due/reminder tasks and sends
// Windows toast notifications. Works whether the app window is open,
// minimized to tray, or running in background.

let taskNotificationSchedulerInterval = null;

function startTaskNotificationScheduler() {
    if (taskNotificationSchedulerInterval) return;

    // Check immediately on startup for any missed notifications
    checkTaskNotifications();

    // Then check every 60 seconds
    taskNotificationSchedulerInterval = setInterval(checkTaskNotifications, 60000);
    console.log('[Emerald] Task notification scheduler started (60s interval)');
}

function stopTaskNotificationScheduler() {
    if (taskNotificationSchedulerInterval) {
        clearInterval(taskNotificationSchedulerInterval);
        taskNotificationSchedulerInterval = null;
        console.log('[Emerald] Task notification scheduler stopped');
    }
}

async function checkTaskNotifications() {
    try {
        // Track which tasks already got a notification this cycle to prevent
        // multiple notification types for the same task.
        const notifiedThisCycle = new Set();
        // Track subtask notifications separately to avoid spamming
        const notifiedSubtasksThisCycle = new Set();

        // 1) Check for pending reminders (reminder_time reached)
        //    Reminders have the highest priority — if a reminder fires, skip
        //    due-date and priority notifications for the same task.
        const reminders = await getPendingReminders();
        for (const reminder of reminders) {
            if (notifiedThisCycle.has(reminder.id)) continue;

            // Policy check
            const policyCheck = shouldNotifyTask(reminder);
            if (!policyCheck.shouldNotify) {
                console.log(`[TaskNotifications] Reminder skipped for task ${reminder.id}: ${policyCheck.reason}`);
                continue;
            }

            const result = await sendTaskNotification(reminder, NOTIFICATION_TYPE.REMINDER);
            if (result.ok) {
                await markReminderHandled(reminder.id);
                notifiedThisCycle.add(reminder.id);
                recordNotification(reminder.id);
                console.log(`[TaskNotifications] Reminder sent for task ${reminder.id}: ${reminder.title}`);
            } else if (result.state === 'duplicate' || result.state === 'cooldown' || result.state === 'policy') {
                // Already notified, in cooldown, or blocked by policy — skip
            } else {
                console.warn(`[TaskNotifications] Reminder notification failed for task ${reminder.id}:`, result.error);
            }
        }

        // 2) Check for overdue tasks (due_date reached)
        //    Only send if the task didn't already get a reminder this cycle.
        const tasks = await getTasks();
        const now = new Date().toISOString();
        for (const task of tasks) {
            if (task.completed || task.archived) continue;
            if (notifiedThisCycle.has(task.id)) continue;
            if (!task.due_time) continue;

            const dueDate = new Date(task.due_time);
            const nowDate = new Date(now);

            // Send due-date notification if task is due
            if (dueDate <= nowDate) {
                // Policy check
                const policyCheck = shouldNotifyTask(task);
                if (!policyCheck.shouldNotify) {
                    console.log(`[TaskNotifications] Due-date skipped for task ${task.id}: ${policyCheck.reason}`);
                    continue;
                }

                const result = await sendTaskNotification(task, NOTIFICATION_TYPE.DUE_DATE);
                if (result.ok) {
                    notifiedThisCycle.add(task.id);
                    recordNotification(task.id);
                    console.log(`[TaskNotifications] Due-date notification sent for task ${task.id}: ${task.title}`);
                } else if (result.state !== 'duplicate' && result.state !== 'cooldown' && result.state !== 'policy') {
                    console.warn(`[TaskNotifications] Due-date notification failed for task ${task.id}:`, result.error);
                }
                continue;
            }

            // 3) Send priority notification for high-priority tasks
            // that are due within 1 hour or already overdue.
            // Only send if the task didn't already get a reminder or due-date notification.
            if (notifiedThisCycle.has(task.id)) continue;
            if (task.priority === 'red' || task.priority === 'orange') {
                const oneHourMs = 60 * 60 * 1000;
                const diff = dueDate.getTime() - nowDate.getTime();
                if (diff <= oneHourMs) {
                    // Policy check
                    const policyCheck = shouldNotifyTask(task);
                    if (!policyCheck.shouldNotify) {
                        console.log(`[TaskNotifications] Priority skipped for task ${task.id}: ${policyCheck.reason}`);
                        continue;
                    }

                    const result = await sendTaskNotification(task, NOTIFICATION_TYPE.PRIORITY);
                    if (result.ok) {
                        notifiedThisCycle.add(task.id);
                        recordNotification(task.id);
                        console.log(`[TaskNotifications] Priority notification sent for task ${task.id}: ${task.title}`);
                    } else if (result.state !== 'duplicate' && result.state !== 'cooldown' && result.state !== 'policy') {
                        console.warn(`[TaskNotifications] Priority notification failed for task ${task.id}:`, result.error);
                    }
                }
            }
        }

        // 4) Check subtask deadlines
        //    Notify about subtask due dates and reminders independently of the parent task.
        //    Legacy tasks without subtasks are unaffected (getSubtasks returns []).
        const oneHourMs = 60 * 60 * 1000;
        for (const task of tasks) {
            if (task.completed || task.archived) continue;
            const subtasks = await getSubtasks(task.id);
            if (!subtasks.length) continue;

            const nowDate = new Date(now);
            for (const subtask of subtasks) {
                if (subtask.completed) continue;
                const subtaskKey = `${task.id}:${subtask.id}`;
                if (notifiedSubtasksThisCycle.has(subtaskKey)) continue;

                // Check subtask reminder
                if (subtask.reminder_time) {
                    const reminderDate = new Date(subtask.reminder_time);
                    if (reminderDate <= nowDate) {
                        const policyCheck = shouldNotifyTask(task);
                        if (policyCheck.shouldNotify) {
                            const result = await sendTaskNotification(task, NOTIFICATION_TYPE.REMINDER, {}, subtask);
                            if (result.ok) {
                                notifiedSubtasksThisCycle.add(subtaskKey);
                                recordNotification(task.id);
                                console.log(`[TaskNotifications] Subtask reminder sent for task ${task.id}: ${subtask.title}`);
                            }
                        }
                        continue;
                    }
                }

                // Check subtask due date
                if (subtask.due_time) {
                    const subtaskDueDate = new Date(subtask.due_time);
                    if (subtaskDueDate <= nowDate) {
                        // Overdue subtask
                        const policyCheck = shouldNotifyTask(task);
                        if (policyCheck.shouldNotify) {
                            const result = await sendTaskNotification(task, NOTIFICATION_TYPE.SUBTASK_DUE, {}, subtask);
                            if (result.ok) {
                                notifiedSubtasksThisCycle.add(subtaskKey);
                                recordNotification(task.id);
                                console.log(`[TaskNotifications] Subtask due notification sent for task ${task.id}: ${subtask.title}`);
                            }
                        }
                    } else if (!notifiedThisCycle.has(task.id) && (task.priority === 'red' || task.priority === 'orange')) {
                        // High-priority subtask due within 1 hour
                        const diff = subtaskDueDate.getTime() - nowDate.getTime();
                        if (diff <= oneHourMs) {
                            const policyCheck = shouldNotifyTask(task);
                            if (policyCheck.shouldNotify) {
                                const result = await sendTaskNotification(task, NOTIFICATION_TYPE.PRIORITY, {}, subtask);
                                if (result.ok) {
                                    notifiedSubtasksThisCycle.add(subtaskKey);
                                    recordNotification(task.id);
                                    console.log(`[TaskNotifications] Subtask priority notification sent for task ${task.id}: ${subtask.title}`);
                                }
                            }
                        }
                    }
                }
            }
        }
    } catch (err) {
        console.error('[TaskNotifications] Scheduler error:', err.message);
    }
}

app.whenReady().then(async () => {
    // On Windows, ensure a Start Menu shortcut with the AUMID exists so
    // Windows allows toast banners even in dev (no installer).
    if (process.platform === 'win32') {
        try {
            await registerAumidShortcut();
        } catch (err) {
            console.error('[Emerald] AUMID shortcut registration failed:', err);
        }
    }

    // ==================== DEPLOYMENT MODE DIAGNOSTICS ====================
    console.log(`[Emerald] AI_MODE=${AI_MODE}`);
    console.log(`[Emerald] DATABASE_MODE=${DATABASE_MODE}`);
    console.log(`[Emerald] LOCAL_AI_ENABLED=${LOCAL_AI_ENABLED}`);

    if (DATABASE_MODE === 'remote') {
        console.log('[Emerald] Remote database mode: skipping local PostgreSQL bootstrap.');
        console.log('[Emerald] Remote database target: 192.168.2.27:5432/emerald_utilities');
    } else {
        console.log('[Emerald] Local database mode: starting local PostgreSQL via db-start.sh');
    }

    if (AI_MODE === 'remote') {
        console.log('[Emerald] Remote AI mode: using homelab AI provider.');
    } else {
        console.log('[Emerald] Local AI mode: using local AI infrastructure.');
    }

    if (LOCAL_AI_ENABLED) {
        console.log('[Emerald] Local AI backend: ENABLED (Ollama/local models will be used)');
    } else {
        console.log('[Emerald] Local AI backend: DISABLED (remote AI provider only)');
    }

    // ==================== DATABASE STARTUP ====================
    // Only start local PostgreSQL when DATABASE_MODE=local.
    // In remote mode, the homelab owns the PostgreSQL lifecycle.
    if (DATABASE_MODE === 'local') {
        console.log("[Emerald] Database service loaded");

        try {
            await startDatabase();
            console.log("[Emerald] Database started successfully");
        } catch (err) {
            console.error("[Emerald] Failed to start database:", err.message);
            pushScriptLog(`[DB] Failed to auto-start: ${err.message}`);
        }
    } else {
        console.log("[Emerald] Skipping local PostgreSQL bootstrap (DATABASE_MODE=remote)");
    }

    // Recover network persistence (flush any queued events from previous session)
    try {
        const recoveryResult = await recoverNetworkPersistence();
        if (recoveryResult.queueSize > 0) {
            console.log(`[Emerald] Network persistence: flushed ${recoveryResult.queueSize} queued events`);
        }
    } catch (err) {
        console.warn('[Emerald] Network persistence recovery failed:', err.message);
    }

    // Register IPC handlers BEFORE creating the window so the renderer
    // can safely invoke handlers on first load without race conditions.
    registerIpcHandlers({
        app,
        ipcMain,
        dialog,
        Notification,
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
        startDatabase,
        stopDatabase,
        databaseService,
        archiveScheduler,
        notifyArchive,
        applyWindowUi,
        getDialogParentWindow: () => mainWindow,
        toWslPath
    });

    // ==================== WINDOW CREATION ====================
    // Create window AFTER IPC handlers are registered so the renderer
    // can safely invoke handlers on first load.
    await createWindow();
    createTray();

    archiveScheduler = new ArchiveScheduler({
        storagePath: path.join(app.getPath('userData'), 'archive', 'schedule.json'),
        fsPromises,
        runAction: runArchiveSchedulerAction,
        notify: notifyArchive
    });
    await archiveScheduler.start();

    // Start task notification scheduler (main-process, works in tray/background)
    startTaskNotificationScheduler();

    registerXScraperIpcHandlers({
        ipcMain,
        app,
        getDialogParentWindow: () => mainWindow,
        pushScriptLog
    });

    // ==================== XSCRAPER FORWARD WORKER (AUTO-START) ====================
    // The durable batch worker is a MAIN-PROCESS singleton. It is started here
    // at app startup so newly scraped SQLite messages are forwarded to
    // PostgreSQL automatically, regardless of whether the Internet page is
    // mounted (the page is the UI; the worker is the pipeline). Starting it
    // twice is a no-op — `startWorker` is guarded by an internal singleton flag.
    try {
        const workerStatus = startXScraperForwardWorker();
        console.log(`[XScraper] Forward worker auto-started (success=${workerStatus.success}${workerStatus.alreadyRunning ? ', already running' : ''}, interval=${workerStatus.intervalMs}ms)`);
        if (workerStatus.success) {
            pushScriptLog(`[XScraper] Forward worker running (interval ${Math.round(workerStatus.intervalMs / 1000)}s)`);
        }
    } catch (err) {
        console.error('[XScraper] Failed to auto-start forward worker:', err.message);
        pushScriptLog(`[XScraper] Forward worker auto-start failed: ${err.message}`);
    }

    // Register Creator Hub IPC handlers
    registerCreatorHubIpc(ipcMain);

    // Register Environment Configuration IPC handlers
    registerEnvIpc();

    // Register Bot IPC handlers
    registerBotIpcHandlers(ipcMain, broadcast);

    // Auto-start infbot if enabled in config
    try {
        if (getAutoStartEnabled()) {
            autoStartBot();
            console.log('[Emerald] INFBOT auto-start initiated');
        } else {
            console.log('[Emerald] INFBOT auto-start disabled in config');
        }
    } catch (err) {
        console.error('[Emerald] INFBOT auto-start failed:', err.message);
    }

    // DevTools toggle handler
    ipcMain.handle('devtools:toggle', async (_event, show) => {
        if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'No main window' };
        try {
            if (show) {
                mainWindow.webContents.openDevTools({ mode: 'detach' });
            } else {
                mainWindow.webContents.closeDevTools();
            }
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

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

app.on('before-quit', async () => {
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

    archiveScheduler?.stop();
    stopTaskNotificationScheduler();

    // Stop PostgreSQL database
    try {
        await stopDatabase();
        console.log("[Emerald] Database stopped");
    } catch (err) {
        console.error("[Emerald] Error stopping database:", err.message);
    }

    // Cleanup bot process
    try {
        cleanupBot();
        console.log("[Emerald] INFBOT cleaned up");
    } catch (err) {
        console.error("[Emerald] Error cleaning up INFBOT:", err.message);
    }
});
