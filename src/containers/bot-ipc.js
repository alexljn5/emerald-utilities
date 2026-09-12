// src/containers/bot-ipc.js
// IPC handlers for bot control from the renderer process.
// Supports both single-bot (legacy) and multi-bot operations.

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
    botRegistry,
    discoverBots,
    discoverRemoteContainers,
    getKnownHosts,
    addKnownHost,
    removeKnownHost
} from './bot-manager.js';

const PRIMARY_BOT_ID = 'infbot';

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

    // ==================== BOT CONTROL (Multi-bot) ====================

    ipcMain.handle('bot:start', async (_event, botId = PRIMARY_BOT_ID) => {
        try {
            const result = await botRegistry.startBot(botId);
            return result;
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('bot:stop', async (_event, botId = PRIMARY_BOT_ID) => {
        try {
            const result = botRegistry.stopBot(botId);
            return result;
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('bot:restart', async (_event, botId = PRIMARY_BOT_ID) => {
        try {
            const result = await botRegistry.restartBot(botId);
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

    ipcMain.handle('bot:setMode', async (_event, mode, botId = PRIMARY_BOT_ID) => {
        if (mode === 'docker' || mode === 'screen' || mode === 'script') {
            const bot = botRegistry.getBot(botId);
            if (bot) {
                bot.mode = mode;
                botRegistry.saveRegistry();
                return { ok: true, mode, message: `Mode set to ${mode} for ${bot.name}.` };
            }
            return { ok: false, error: 'Bot not found' };
        }
        return { ok: false, error: `Invalid mode: ${mode}. Use 'docker', 'screen', or 'script'.` };
    });

    // ==================== BOT STATUS (Multi-bot) ====================

    ipcMain.handle('bot:status', async (_event, botId = PRIMARY_BOT_ID) => {
        try {
            return botRegistry.getBotStatus(botId);
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('bot:statusAll', async () => {
        try {
            const statuses = botRegistry.getAllStatuses();
            const bots = botRegistry.getAllBots().map(bot => ({
                id: bot.id,
                name: bot.name,
                type: bot.type,
                host: bot.host,
                mode: bot.mode,
                ...bot.getStatus()
            }));
            return { ok: true, bots, statuses };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // ==================== BOT LOGS (Multi-bot) ====================

    ipcMain.handle('bot:logs', async (_event, botId = PRIMARY_BOT_ID, limit = 100) => {
        try {
            return botRegistry.getBotLogs(botId, limit);
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('bot:logs:clear', async (_event, botId = PRIMARY_BOT_ID) => {
        try {
            return botRegistry.clearBotLogs(botId);
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // ==================== BOT AUTO-START ====================

    ipcMain.handle('bot:getAutoStart', async () => {
        return { enabled: botRegistry.getAutoStartEnabled() };
    });

    ipcMain.handle('bot:setAutoStart', async (_event, enabled) => {
        botRegistry.setAutoStartEnabled(enabled);
        return { ok: true, enabled };
    });

    // ==================== BOT DISCOVERY ====================

    ipcMain.handle('bot:discover', async () => {
        // Run discovery in background and stream results via broadcast
        try {
            const discoverAndStream = async () => {
                const sshConfig = getSshConfig();
                const { discoverBots } = await import('./bot-discovery.js');
                const newBots = await discoverBots();

                for (const botInfo of newBots) {
                    const existing = botRegistry.findBotByHostAndName(botInfo.host, botInfo.name);
                    if (!existing) {
                        const bot = botRegistry.registerBot({
                            id: botInfo.id,
                            name: botInfo.name,
                            type: botInfo.type,
                            mode: botInfo.type === 'docker' ? 'docker' : botInfo.type === 'screen' ? 'screen' : 'script',
                            host: botInfo.host,
                            status: botInfo.status,
                            ...botInfo.details
                        });
                        if (broadcast) {
                            broadcast('bot-discovered', bot.toJSON());
                        }
                    }
                }

                if (broadcast) {
                    broadcast('bot-discovery-complete', {
                        totalBots: botRegistry.getAllBots().length
                    });
                }
            };

            discoverAndStream().catch(err => {
                if (broadcast) {
                    broadcast('bot-discovery-error', { error: err.message });
                }
            });

            return { ok: true, message: 'Discovery started in background' };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('bot:list', async () => {
        try {
            const bots = botRegistry.getAllBots().map(bot => bot.toJSON());
            return { ok: true, bots };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('bot:add', async (_event, config) => {
        try {
            const bot = botRegistry.registerBot(config);
            return { ok: true, bot: bot.toJSON() };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('bot:remove', async (_event, botId) => {
        try {
            botRegistry.unregisterBot(botId);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('bot:getKnownHosts', async () => {
        return { hosts: getKnownHosts() };
    });

    ipcMain.handle('bot:addKnownHost', async (_event, host) => {
        addKnownHost(host);
        return { ok: true, hosts: getKnownHosts() };
    });

    ipcMain.handle('bot:removeKnownHost', async (_event, host) => {
        removeKnownHost(host);
        return { ok: true, hosts: getKnownHosts() };
    });

    // ==================== BOT INFO ====================

    ipcMain.handle('bot:info', async () => {
        const bot = botRegistry.getBot('infbot');
        const mode = bot ? bot.mode : getBotMode();
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

    // ==================== CONTAINER VIEWING BRIDGE ====================
    // Lists all Docker containers from the homelab server via Tailscale.
    // Connects to infhub-server (Tailscale MagicDNS) and runs `docker ps -a`
    // to show ALL containers (running and stopped). Does NOT create containers.

    ipcMain.handle('container:list-active', async () => {
        try {
            const result = await discoverRemoteContainers();
            const activeContainers = result.containers.filter(c => c.status === 'running');
            return {
                ok: true,
                containers: activeContainers,
                total: activeContainers.length,
                errors: result.errors,
                error: result.errors.length > 0 ? result.errors.map(e => `${e.host}: ${e.error}`).join('; ') : null
            };
        } catch (err) {
            return { ok: false, error: err.message, containers: [], total: 0, errors: [{ host: 'unknown', error: err.message }] };
        }
    });

    ipcMain.handle('container:list-all', async () => {
        try {
            const result = await discoverRemoteContainers();
            return {
                ok: true,
                containers: result.containers,
                total: result.containers.length,
                errors: result.errors,
                error: result.errors.length > 0 ? result.errors.map(e => `${e.host}: ${e.error}`).join('; ') : null
            };
        } catch (err) {
            return { ok: false, error: err.message, containers: [], total: 0, errors: [{ host: 'unknown', error: err.message }] };
        }
    });

    // Test SSH connectivity to the configured host
    ipcMain.handle('container:test-ssh', async () => {
        try {
            const { testSshConnection } = await import('./bot-discovery.js');
            const sshConfig = getSshConfig();
            if (!sshConfig.host) {
                return { ok: false, error: 'No SSH host configured. Set it in Settings → Bot SSH Config.' };
            }
            const result = testSshConnection(sshConfig.host, sshConfig.user, sshConfig.port, sshConfig.key);
            return result;
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });
}
