const { app, BrowserWindow, Tray, Menu, ipcMain } = require('electron');
const path = require('path');

let tray = null;
let mainWindow = null;

function createWindow() {
    try {
        mainWindow = new BrowserWindow({
            width: 800,
            height: 600,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
            },
            show: false
        });

        // Load the index.html file
        const indexPath = path.join(__dirname, 'index.html');
        mainWindow.loadFile(indexPath).catch(err => {
            console.error('Failed to load index.html:', err);
        });

        // Show window when ready
        mainWindow.once('ready-to-show', () => {
            mainWindow.show();
        });

        // Handle window close (hide to tray instead of closing)
        mainWindow.on('close', (event) => {
            if (!app.isQuitting) {
                event.preventDefault();
                mainWindow.hide();
            }
            return false;
        });

        // Handle minimize (hide to tray)
        mainWindow.on('minimize', () => {
            mainWindow.hide();
        });
    } catch (err) {
        console.error('Error creating window:', err);
    }
}

function createTray() {
    try {
        const iconPath = path.join(__dirname, '../img/placeholder.png');
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
        // Don't quit on macOS, keep tray active
    }
});

// IPC for logging from renderer
ipcMain.on('log', (event, message) => {
    console.log('Renderer log:', message);
});