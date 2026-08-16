// src/bots/bot-ipc.js
// IPC handlers for bot control from the renderer process.
// Registers handlers on the provided ipcMain instance.

import {
    startBot,
    stopBot,
    restartBot,
    getBotStatus,
    getBotLogs,
    clearBotLogs,
    setLogBroadcast,
    buildBotImage,
    getBuildInstructions
} from './bot-manager.js';

export function registerBotIpcHandlers(ipcMain, broadcast) {
    // Set up log broadcasting to renderer
    setLogBroadcast((logEntry) => {
        if (broadcast) {
            broadcast('bot-log', logEntry);
        }
    });

    // ==================== BOT CONTROL ====================

    ipcMain.handle('bot:start', async () => {
        try {
            const result = startBot();
            return result;
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('bot:stop', async () => {
        try {
            const result = stopBot();
            return result;
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('bot:restart', async () => {
        try {
            const result = restartBot();
            return result;
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('bot:build', async () => {
        try {
            const result = buildBotImage();
            return result;
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // ==================== BOT STATUS ====================

    ipcMain.handle('bot:status', async () => {
        try {
            return getBotStatus();
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // ==================== BOT LOGS ====================

    ipcMain.handle('bot:logs', async (_event, limit = 100) => {
        try {
            return getBotLogs(limit);
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('bot:logs:clear', async () => {
        try {
            return clearBotLogs();
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // ==================== BOT INFO ====================

    ipcMain.handle('bot:info', async () => {
        const instructions = getBuildInstructions();
        return {
            name: 'INFBOT',
            description: 'Discord bot for the INFHUB Discord server',
            version: '1.0.0',
            runtime: 'Docker',
            image: DOCKER_IMAGE,
            container: DOCKER_CONTAINER,
            instructions,
            commands: [
                { name: '.help', description: 'Show all available commands' },
                { name: '.cream', description: 'Random Cream the Rabbit image' },
                { name: '.big', description: 'Random Big the Cat image' },
                { name: '.rouge', description: 'Random Rouge the Bat image' },
                { name: '.sonic', description: 'Random Sonic the Hedgehog image' },
                { name: '.metal', description: 'Random Metal Sonic image' },
                { name: '.neometal', description: 'Random Neo Metal Sonic image' },
                { name: '.amy', description: 'Random Amy Rose image' },
                { name: '.tails', description: 'Random Tails the Fox image' },
                { name: '.sonicexe', description: 'Random Sonic.EXE image' },
                { name: '.cat', description: 'Random ASCII cat' },
                { name: '.reverse', description: 'Reverse text' },
                { name: '.zalgo', description: 'Zalgo text generator' },
                { name: '.talk', description: 'Start a chat thread with Cream AI' },
                { name: '.agony', description: 'Generate unsettling text' },
                { name: '.game', description: 'Simple player actions game' }
            ],
            features: [
                'Cream AI Chat (HuggingFace)',
                'Character Image Fetching',
                'Simple RPG Game System',
                'Random Popups',
                'Error Logging',
                'Docker container (survives restarts)'
            ]
        };
    });
}
