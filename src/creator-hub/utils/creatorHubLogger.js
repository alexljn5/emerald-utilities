// src/creator-hub/utils/creatorHubLogger.js
// Creator Hub logging system.
// Separates developer logs from user activity logs.
// Supports log levels: debug, info, warn, error.

const LOG_LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
};

let currentLogLevel = LOG_LEVELS.info;
let logHistory = [];
const MAX_LOG_HISTORY = 100;

/**
 * Set the minimum log level to display.
 * @param {'debug' | 'info' | 'warn' | 'error'} level
 */
export function setLogLevel(level) {
    currentLogLevel = LOG_LEVELS[level] || LOG_LEVELS.info;
}

/**
 * Get the current log level.
 * @returns {string}
 */
export function getLogLevel() {
    return Object.keys(LOG_LEVELS).find(key => LOG_LEVELS[key] === currentLogLevel) || 'info';
}

/**
 * Get log history for UI display.
 * @returns {Array<{ level: string, message: string, timestamp: string }>}
 */
export function getLogHistory() {
    return [...logHistory];
}

/**
 * Clear log history.
 */
export function clearLogHistory() {
    logHistory = [];
}

function addToHistory(level, message) {
    logHistory.push({
        level,
        message,
        timestamp: new Date().toISOString()
    });
    if (logHistory.length > MAX_LOG_HISTORY) {
        logHistory.shift();
    }
}

/**
 * Create a logger for a specific Creator Hub subsystem.
 * @param {string} subsystem e.g. 'ACCOUNTS', 'PUBLISHER', 'COMPOSER', 'IPC'
 * @returns {Logger}
 */
export function createLogger(subsystem = 'CREATOR-HUB') {
    const prefix = `[${subsystem}]`;

    return {
        debug(...args) {
            if (currentLogLevel > LOG_LEVELS.debug) return;
            const message = args.map(String).join(' ');
            console.log(`${prefix} DEBUG: ${message}`);
            addToHistory('debug', `${prefix} ${message}`);
        },

        info(...args) {
            if (currentLogLevel > LOG_LEVELS.info) return;
            const message = args.map(String).join(' ');
            console.log(`${prefix} ${message}`);
            addToHistory('info', `${prefix} ${message}`);
        },

        warn(...args) {
            if (currentLogLevel > LOG_LEVELS.warn) return;
            const message = args.map(String).join(' ');
            console.warn(`${prefix} WARN: ${message}`);
            addToHistory('warn', `${prefix} ${message}`);
        },

        error(...args) {
            if (currentLogLevel > LOG_LEVELS.error) return;
            const message = args.map(String).join(' ');
            console.error(`${prefix} ERROR: ${message}`);
            addToHistory('error', `${prefix} ${message}`);
        }
    };
}

// Convenience pre-bound loggers for Creator Hub subsystems.
export const accountsLog = createLogger('ACCOUNTS');
export const publisherLog = createLogger('PUBLISHER');
export const composerLog = createLogger('COMPOSER');
export const ipcLog = createLogger('IPC');
export const historyLog = createLogger('HISTORY');

export default createLogger;
