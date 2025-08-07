const { app, BrowserWindow, Tray, Menu, ipcMain, dialog } = require('electron');
const path = require('path');

app.disableHardwareAcceleration(); // Disable hardware acceleration for performance since it doesn't intend to use GPU rendering I believe lol.

let tray = null;
let mainWindow = null;

function createWindow() {
    try {
        mainWindow = new BrowserWindow({
            width: 800,
            height: 600,
            webPreferences: {
                contextIsolation: false,
                nodeIntegration: true,
                allowRendererProcessReuse: false,
                webgl: false,
            },
            show: false
        });

        // Load the index.html file
        const indexPath = path.join(__dirname, 'index.html');
        mainWindow.loadFile(indexPath).catch(err => {
            console.error('Failed to load index.html:', err);
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
        // Don't quit on macOS, keep tray active
    }
});

// IPC for logging from renderer
ipcMain.on('log', (event, message) => {
    console.log('Renderer log:', message);
});

// IPC for custom scripts directory
ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select Scripts Directory'
    });
    return result.canceled ? null : result.filePaths[0];
});

// IPC for getting userData path
ipcMain.handle('get-user-data-path', () => app.getPath('userData'));