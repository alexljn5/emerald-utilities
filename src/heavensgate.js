
// src/heavensgate.js
if (typeof process !== 'undefined' && process.type === 'renderer') {
    console.error('heavensgate.js should not be required from renderer!');
    throw new Error('heavensgate.js is main process only');
}

const { app, BrowserWindow, Tray, Menu, ipcMain, dialog } = require('electron');
const path = require('path');

// ==================== GLOBAL FLAGS ====================
const PRODUCTION = true;   // ← Change to false for development (menu bar visible)

// ==================== WINDOW CREATION ====================
let tray = null;
let mainWindow = null;

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
            show: false
        });

        // Hide default menu bar in production
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

        mainWindow.once('ready-to-show', () => {
            mainWindow.show();
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
            { label: 'Show App', click: () => mainWindow.show() },
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
        tray.on('click', () => mainWindow.show());
    } catch (err) {
        console.error('Error setting up tray:', err);
    }
}

app.whenReady().then(() => {
    createWindow();
    createTray();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        // Keep tray active
    }
});

// IPC Handlers
ipcMain.on('log', (event, message) => {
    console.log('Renderer log:', message);
});

ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select Scripts Directory'
    });
    return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('get-user-data-path', () => app.getPath('userData'));

// Export for globals.js
module.exports = {
    PRODUCTION
};