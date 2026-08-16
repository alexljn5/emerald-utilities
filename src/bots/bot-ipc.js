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
    getBuildInstructions,
    getBotMode,
    getAutoStartEnabled,
    setAutoStartEnabled,
    getSshConfig,
    setSshConfig,
    detectBotScripts,
    sendBotCommand
} from './bot-manager.js';

export function registerBotIpcHandlers(ipcMain, broadcast) {
    // Set up log broadcasting to renderer
    setLogBroadcast((logEntry) => {
        if (broadcast) {
            broadcast('bot-log', logEntry);
        }
    });

    // ==================== BOT SSH CONFIG ====================

    ipcMain.handle('bot:getSshConfig', async () => {
        return getSshConfig();
    });

    ipcMain.handle('bot:setSshConfig', async (_event, config) => {
        const result = setSshConfig(config.host, config.user, config.port, config.key);
        return { ok: true, config: result };
    });

    // ==================== BOT CONTROL ====================

    ipcMain.handle('bot:start', async () => {
        try {
            const result = await startBot();
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
            const result = await restartBot();
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

    ipcMain.handle('bot:mode', async () => {
        return { mode: getBotMode() };
    });

    ipcMain.handle('bot:setMode', async (_event, mode) => {
        // Note: Mode change requires app restart to take effect
        // This just updates the environment variable for the current session
        if (mode === 'docker' || mode === 'screen' || mode === 'script') {
            process.env.BOT_MODE = mode;
            return { ok: true, mode, message: `Mode set to ${mode}. Restart the app to apply.` };
        }
        return { ok: false, error: `Invalid mode: ${mode}. Use 'docker', 'screen', or 'script'.` };
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

    // ==================== BOT AUTO-START ====================

    ipcMain.handle('bot:getAutoStart', async () => {
        return { enabled: getAutoStartEnabled() };
    });

    ipcMain.handle('bot:setAutoStart', async (_event, enabled) => {
        setAutoStartEnabled(enabled);
        return { ok: true, enabled };
    });

    // ==================== BOT INFO ====================

    ipcMain.handle('bot:info', async () => {
        const mode = getBotMode();
        const instructions = getBuildInstructions();
        const runtimeLabel = mode === 'docker' ? 'Docker Container' : mode === 'screen' ? 'GNU Screen Session' : 'Node.js Process';
        const survivalFeature = mode === 'docker' ? 'Docker container (survives restarts)' : mode === 'screen' ? 'GNU Screen session (survives restarts)' : 'Detached process (survives app restarts)';
        return {
            name: 'INFBOT',
            description: 'Discord bot for the INFHUB Discord server',
            version: '1.0.0',
            runtime: runtimeLabel,
            mode,
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
                survivalFeature
            ]
        };
    });

    // ==================== BOT SCRIPTS ====================

    ipcMain.handle('bot:detectScripts', async () => {
        try {
            const scripts = detectBotScripts();
            return { ok: true, scripts };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // ==================== BOT TERMINAL ====================

    ipcMain.handle('bot:sendCommand', async (_event, command) => {
        try {
            const result = sendBotCommand(command);
            return result;
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });
}
