// src/containers/bot-config.js
// Shared bot configuration read/write functions.
// Used by bot-manager.js and bot-registry.js to avoid circular dependencies.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATH = path.join(__dirname, 'bot-config.json');

export function readBotConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        }
    } catch {
        // ignore
    }
    return { autoStart: true };
}

export function writeBotConfig(config) {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    } catch {
        // ignore
    }
}
