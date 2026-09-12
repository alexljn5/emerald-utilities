// src/containers/bot-registry.js
// Registry that manages multiple bot instances.
// Provides a unified interface for bot operations across all registered bots.

import { BotInstance } from './bot-instance.js';
import { discoverBots, getKnownHosts, addKnownHost, removeKnownHost } from './bot-discovery.js';
import { readBotConfig, writeBotConfig } from './bot-config.js';

const REGISTRY_PATH = new URL('.', import.meta.url).pathname + 'bot-registry.json';

class BotRegistry {
    constructor() {
        this.bots = new Map();
        this.logBroadcast = null;
        this.autoStartEnabled = true;
        this.loadRegistry();
    }

    // ==================== PERSISTENCE ====================
    loadRegistry() {
        try {
            const config = readBotConfig();
            this.autoStartEnabled = config.autoStart !== false;

            // Load saved bots from config
            if (config.bots && Array.isArray(config.bots)) {
                for (const botConfig of config.bots) {
                    this.registerBot(botConfig);
                }
            }

            // Always ensure the primary bot (INFBOT) exists
            if (!this.bots.has('infbot')) {
                this.registerBot({
                    id: 'infbot',
                    name: 'INFBOT',
                    type: 'docker',
                    mode: 'docker',
                    host: config.sshHost || '',
                    dockerImage: 'infbot',
                    dockerContainer: 'infbot',
                    screenSession: 'infbot',
                    screenBotDir: '/home/emerald-user/INFHUB/infbot',
                    scriptBotDir: new URL('.', import.meta.url).pathname + 'infbot-src',
                    scriptEntry: 'bot-entry.js',
                    sshConfig: config.sshHost ? {
                        host: config.sshHost,
                        user: config.sshUser || 'emerald-user',
                        port: config.sshPort || '22',
                        key: config.sshKey || ''
                    } : null
                });
            }

            // Auto-detect mode for all bots based on what's actually running
            this.autoDetectModes();
        } catch {
            // ignore
        }
    }

    autoDetectModes() {
        for (const bot of this.bots.values()) {
            const status = bot.getStatus();
            if (status.detectedMode && status.detectedMode !== bot.mode) {
                bot.mode = status.detectedMode;
            }
        }
        this.saveRegistry();
    }

    saveRegistry() {
        try {
            const config = readBotConfig();
            config.bots = Array.from(this.bots.values()).map(bot => bot.toJSON());
            config.autoStart = this.autoStartEnabled;
            writeBotConfig(config);
        } catch {
            // ignore
        }
    }

    // ==================== BOT MANAGEMENT ====================
    registerBot(config) {
        const bot = new BotInstance(config);
        bot.setLogBroadcast((entry) => {
            if (this.logBroadcast) {
                this.logBroadcast(entry);
            }
        });
        this.bots.set(bot.id, bot);
        this.saveRegistry();
        return bot;
    }

    unregisterBot(botId) {
        const bot = this.bots.get(botId);
        if (bot) {
            bot.cleanup();
            this.bots.delete(botId);
            this.saveRegistry();
        }
    }

    getBot(botId) {
        return this.bots.get(botId);
    }

    getAllBots() {
        return Array.from(this.bots.values());
    }

    getBotStatus(botId) {
        const bot = this.bots.get(botId);
        if (!bot) {
            return { status: 'error', isRunning: false, error: 'Bot not found', logCount: 0 };
        }
        return bot.getStatus();
    }

    getAllStatuses() {
        const statuses = {};
        for (const [id, bot] of this.bots) {
            statuses[id] = bot.getStatus();
        }
        return statuses;
    }

    // ==================== BOT CONTROL ====================
    async startBot(botId) {
        const bot = this.bots.get(botId);
        if (!bot) {
            return { ok: false, error: 'Bot not found' };
        }
        return await bot.start();
    }

    stopBot(botId) {
        const bot = this.bots.get(botId);
        if (!bot) {
            return { ok: false, error: 'Bot not found' };
        }
        return bot.stop();
    }

    async restartBot(botId) {
        const bot = this.bots.get(botId);
        if (!bot) {
            return { ok: false, error: 'Bot not found' };
        }
        return await bot.restart();
    }

    // ==================== LOGS ====================
    getBotLogs(botId, limit = 100) {
        const bot = this.bots.get(botId);
        if (!bot) {
            return { logs: [], total: 0, hasMore: false, error: 'Bot not found' };
        }
        return bot.getLogs(limit);
    }

    clearBotLogs(botId) {
        const bot = this.bots.get(botId);
        if (!bot) {
            return { ok: false, error: 'Bot not found' };
        }
        return bot.clearLogs();
    }

    // ==================== DISCOVERY ====================
    async discoverBots() {
        const discovered = await discoverBots();
        const newBots = [];

        for (const botInfo of discovered) {
            // Check if we already have this bot
            const existing = this.findBotByHostAndName(botInfo.host, botInfo.name);
            if (!existing) {
                const bot = this.registerBot({
                    id: botInfo.id,
                    name: botInfo.name,
                    type: botInfo.type,
                    mode: botInfo.type === 'docker' ? 'docker' : botInfo.type === 'screen' ? 'screen' : 'script',
                    host: botInfo.host,
                    status: botInfo.status,
                    ...botInfo.details
                });
                newBots.push(bot);
            }
        }

        return newBots;
    }

    findBotByHostAndName(host, name) {
        for (const bot of this.bots.values()) {
            if (bot.host === host && bot.name === name) {
                return bot;
            }
        }
        return null;
    }

    // ==================== AUTO-START ====================
    async autoStartBots() {
        if (!this.autoStartEnabled) {
            return [];
        }

        const results = [];
        for (const bot of this.bots.values()) {
            const status = bot.getStatus();
            if (!status.isRunning) {
                const result = await bot.start();
                results.push({ botId: bot.id, result });
            }
        }
        return results;
    }

    setAutoStartEnabled(enabled) {
        this.autoStartEnabled = enabled;
        this.saveRegistry();
    }

    getAutoStartEnabled() {
        return this.autoStartEnabled;
    }

    // ==================== LOG BROADCAST ====================
    setLogBroadcast(callback) {
        this.logBroadcast = callback;
        for (const bot of this.bots.values()) {
            bot.setLogBroadcast((entry) => {
                if (this.logBroadcast) {
                    this.logBroadcast(entry);
                }
            });
        }
    }

    // ==================== CLEANUP ====================
    cleanup() {
        for (const bot of this.bots.values()) {
            bot.cleanup();
        }
        this.bots.clear();
    }
}

// Singleton registry instance
export const botRegistry = new BotRegistry();
