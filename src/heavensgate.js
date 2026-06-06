const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, screen } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { existsSync } = require('fs');
const { execSync } = require('child_process');

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
let nextScriptLogId = 1;

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

// ==================== GET SCRIPT COMMAND (Fixed) ====================
function getScriptCommand(file, scriptPath) {
    const ext = file.split('.').pop().toLowerCase();

    switch (ext) {
        case 'js':
            return { command: 'node', args: [scriptPath] };
        case 'sh':
            return { command: 'bash', args: [scriptPath] };
        case 'bat':
            return { command: 'cmd.exe', args: ['/c', scriptPath] };
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
function startScript(file, scriptPath, options = {}) {
    const commandInfo = getScriptCommand(file, scriptPath);
    if (!commandInfo) {
        pushScriptLog('Unsupported script type or missing AutoHotkey.');
        return { ok: false, running: false };
    }

    const isWindows = process.platform === 'win32';
    const hidden = options.hidden ?? false;

    let child;

    if (hidden && isWindows) {
        // === AGGRESSIVE HIDDEN MODE FOR WINDOWS ===
        // Use 'start' command to truly hide the console window
        const quotedAhk = `"${commandInfo.command}"`;
        const quotedScript = `"${scriptPath}"`;

        child = spawn('cmd.exe', ['/c', 'start', '/b', '/min', quotedAhk, quotedScript], {
            detached: true,
            windowsHide: true,
            stdio: 'ignore'
        });
    } else {
        // Normal visible mode
        const command = isWindows && commandInfo.command.includes(' ')
            ? `"${commandInfo.command}"`
            : commandInfo.command;

        child = spawn(command, commandInfo.args, {
            shell: isWindows,
            windowsVerbatimArguments: true,
            cwd: path.dirname(scriptPath)
        });
    }

    if (!hidden) {
        scriptRunners.set(file, child);
        setScriptRunning(file, true);
    }

    pushScriptLog(`Started ${file}${hidden ? ' (hidden)' : ''}`);

    if (!hidden) {
        if (child.stdout) child.stdout.on('data', data => logProcessOutput(data));
        if (child.stderr) child.stderr.on('data', data => logProcessOutput(data, 'ERR: '));

        child.on('error', err => pushScriptLog(`${file} error: ${err.message}`));
        child.on('exit', (code, signal) => {
            if (!scriptRunners.has(file)) return;
            pushScriptLog(`${file} exited (${signal || code})`);
            scriptRunners.delete(file);
            setScriptRunning(file, false);
        });
    }

    return { ok: true, running: !hidden };
}

function startCronScript(file, scriptPath, intervalMs, options = {}) {
    const commandInfo = getScriptCommand(file, scriptPath);
    if (!commandInfo) {
        pushScriptLog('Unsupported type for cron');
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

    const timer = setInterval(() => {
        const spawnOptions = { shell: isWindows };
        if (options.hidden) {
            if (isWindows) {
                spawnOptions.detached = true;
                spawnOptions.windowsHide = true;
                spawnOptions.stdio = 'ignore';
            } else {
                spawnOptions.detached = true;
                spawnOptions.stdio = 'ignore';
            }
        }
        const child = spawn(command, commandInfo.args, spawnOptions);
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
                allowRendererProcessReuse: false,
                webgl: false,
            },
            show: false   // ← Never show automatically
        });

        if (PRODUCTION) {
            mainWindow.setMenu(null);
        }

        const indexPath = path.join(__dirname, 'index.html');
        mainWindow.loadFile(indexPath).catch(err => {
            console.error('Failed to load index.html:', err);
        });

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
ipcMain.on('log', (event, message) => {
    console.log('Renderer log:', message);
});

ipcMain.handle('run-script', async (event, { file, scriptPath, hidden }) => {
    return startScript(file, scriptPath, { hidden });
});

ipcMain.handle('stop-script', (event, { file }) => {
    const child = scriptRunners.get(file);
    if (!child) {
        return { ok: false, reason: 'not running' };
    }

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

    return { ok: true };
});

ipcMain.handle('start-cron-script', async (event, { file, scriptPath, intervalMs, hidden }) => {
    return startCronScript(file, scriptPath, intervalMs, { hidden });
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

ipcMain.handle('get-script-log-history', (event, maxLines = MAX_SCRIPT_LOG_LINES) => {
    return scriptLogHistory.slice(-maxLines);
});

ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select Scripts Directory'
    });
    return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('select-file', async (event, options = {}) => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;

    const result = await dialog.showOpenDialog(win, {
        title: options.title || 'Select File',
        filters: options.filters || [{ name: 'All Files', extensions: ['*'] }],
        properties: options.properties || ['openFile']
    });

    return result;
});

ipcMain.handle('get-user-data-path', () => app.getPath('userData'));

ipcMain.handle('get-ahk-path', async () => {
    try {
        const configPath = path.join(app.getPath('userData'), 'config.json');
        if (existsSync(configPath)) {
            const config = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
            return config.ahkPath || null;
        }
    } catch (e) {
        // Ignore errors
    }
    return null;
});

ipcMain.handle('set-ahk-path', async (event, ahkPath) => {
    try {
        const configPath = path.join(app.getPath('userData'), 'config.json');
        let config = { scripts: [], customScriptsPath: null, ahkPath: null };
        if (existsSync(configPath)) {
            config = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
        }
        config.ahkPath = ahkPath;
        require('fs').writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        console.log(`[AHK] Path updated to: ${ahkPath || 'auto-detect'}`);
        return { ok: true };
    } catch (e) {
        console.error('[AHK] Failed to save path:', e);
        return { ok: false, error: e.message };
    }
});

module.exports = {
    PRODUCTION
};
