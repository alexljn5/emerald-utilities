const { app, BrowserWindow, Tray, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

// ==================== GLOBAL FLAGS ====================
const PRODUCTION = false;   // Change to false for development

// ==================== WINDOW CREATION ====================
let tray = null;
let mainWindow = null;
const scriptRunners = new Map();
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
    const text = data.toString().replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
    if (!text) return;

    for (const line of text.split('\n')) {
        pushScriptLog(`${prefix}${line}`);
    }
}

function setScriptRunning(file, isRunning) {
    broadcast('script-running-changed', { file, isRunning });
}

function stopScript(file) {
    const child = scriptRunners.get(file);
    if (!child) return false;

    child.kill();
    return true;
}

function getScriptCommand(file, scriptPath) {
    const ext = file.split('.').pop();

    switch (ext) {
        case 'js':
            return { command: 'node', args: [scriptPath] };
        case 'sh':
            return { command: 'bash', args: [scriptPath] };
        case 'bat':
            return { command: 'cmd.exe', args: ['/c', scriptPath] };
        case 'exe':
            return { command: scriptPath, args: [] };
        default:
            return null;
    }
}

function startScript(file, scriptPath) {
    const commandInfo = getScriptCommand(file, scriptPath);
    if (!commandInfo) {
        pushScriptLog('Unsupported type');
        return { ok: false, running: false };
    }

    const isWindows = process.platform === 'win32';
    const child = spawn(commandInfo.command, commandInfo.args, { shell: isWindows });
    scriptRunners.set(file, child);
    setScriptRunning(file, true);
    pushScriptLog(`Started ${file}`);

    child.stdout.on('data', data => logProcessOutput(data));
    child.stderr.on('data', data => logProcessOutput(data, 'ERR: '));
    child.on('error', err => {
        pushScriptLog(`${file} error: ${err.message}`);
    });
    child.on('exit', code => {
        pushScriptLog(`${file} exited (${code})`);
        scriptRunners.delete(file);
        setScriptRunning(file, false);
    });

    return { ok: true, running: true };
}

function createWindow() {
    try {
        mainWindow = new BrowserWindow({
            width: 1280,
            height: 720,
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
});

// IPC Handlers
ipcMain.on('log', (event, message) => {
    console.log('Renderer log:', message);
});

ipcMain.handle('run-script', async (event, { file, scriptPath, startOnly = false }) => {
    if (scriptRunners.has(file)) {
        if (startOnly) {
            return { ok: true, running: true };
        }

        stopScript(file);
        pushScriptLog(`Stopping ${file}`);
        return { ok: true, running: false };
    }

    return startScript(file, scriptPath);
});

ipcMain.handle('get-running-scripts', () => Array.from(scriptRunners.keys()));

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

ipcMain.handle('get-user-data-path', () => app.getPath('userData'));

module.exports = {
    PRODUCTION
};
