// src/utils/envConfig.js
// Centralised environment configuration manager (main process only).
// Loads secrets from multiple sources with strict priority:
//   1. User-imported production .env file (stored in app data)
//   2. Project .env (development fallback)
//   3. System environment variables
//
// Secrets are NEVER sent to the renderer process — only validation status and
// masked key names are exposed.

import { app } from 'electron';
import fs from 'fs';
import path from 'path';

// ─── Schema ──────────────────────────────────────────────────────────────────

/**
 * Known environment variable definitions.
 * key   – the env var name
 * label – human-friendly label for UI
 * provider – which integration this belongs to
 * type  – 'secret' (masked) or 'public' (shown plainly)
 * required – whether this is considered required for the provider to function
 */
const VARIABLE_SCHEMA = [
    // ── Instagram ────────────────────────────────────────────────
    { key: 'INSTAGRAM_APP_ID', label: 'Instagram App ID', provider: 'Instagram', type: 'public', required: true },
    { key: 'INSTAGRAM_APP_SECRET', label: 'Instagram App Secret', provider: 'Instagram', type: 'secret', required: true },
    { key: 'INSTAGRAM_REDIRECT_URI', label: 'Instagram Redirect URI', provider: 'Instagram', type: 'public', required: true },

    // ── Threads ──────────────────────────────────────────────────
    { key: 'THREADS_APP_ID', label: 'Threads App ID', provider: 'Threads', type: 'public', required: true },
    { key: 'THREADS_APP_SECRET', label: 'Threads App Secret', provider: 'Threads', type: 'secret', required: true },
    { key: 'THREADS_REDIRECT_URI', label: 'Threads Redirect URI', provider: 'Threads', type: 'public', required: true },

    // ── Bluesky ──────────────────────────────────────────────────
    { key: 'BLUESKY_USERNAME', label: 'Bluesky Handle', provider: 'Bluesky', type: 'public', required: false },
    { key: 'BLUESKY_APP_PASSWORD', label: 'Bluesky App Password', provider: 'Bluesky', type: 'secret', required: true },

    // ── Database ─────────────────────────────────────────────────
    { key: 'DB_HOST', label: 'Database Host', provider: 'Database', type: 'public', required: false },
    { key: 'DB_PORT', label: 'Database Port', provider: 'Database', type: 'public', required: false },
    { key: 'DB_USER', label: 'Database User', provider: 'Database', type: 'public', required: false },
    { key: 'DB_PASSWORD', label: 'Database Password', provider: 'Database', type: 'secret', required: false },
    { key: 'DB_DATABASE', label: 'Database Name', provider: 'Database', type: 'public', required: false },

    // ── X / Twitter ──────────────────────────────────────────────
    { key: 'X_API_KEY', label: 'X API Key', provider: 'X/Twitter', type: 'secret', required: false },
    { key: 'X_API_SECRET', label: 'X API Secret', provider: 'X/Twitter', type: 'secret', required: false },
    { key: 'X_BEARER_TOKEN', label: 'X Bearer Token', provider: 'X/Twitter', type: 'secret', required: false },

    // ── Portfolio ────────────────────────────────────────────────
    { key: 'EODHD_API', label: 'EODHD API Key', provider: 'Portfolio', type: 'secret', required: false },
];

// ── State ────────────────────────────────────────────────────────────────────

/** Parsed key→value map of all discovered env vars */
let parsedEnvironment = {};

/** Where the current env was loaded from: 'imported' | 'development' | 'system' | 'none' */
let currentSource = 'none';

/** Full path to the imported .env file, if any */
let importedFilePath = null;

/** Path inside app data where we copy imported .env for persistence */
function importedStoragePath() {
    return path.join(app.getPath('userData'), 'config', 'imported.env');
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse a .env file string into a plain object.
 * Supports comments (#), quoted values, and blank lines.
 */
function parseEnvFile(content) {
    const env = {};
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) continue;
        const key = line.slice(0, eqIdx).trim();
        let value = line.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key) env[key] = value;
    }
    return env;
}

// ── Loading ──────────────────────────────────────────────────────────────────

/**
 * Load environment from all available sources with priority.
 * This is called at startup and whenever the user imports a new .env.
 * Also sets process.env for backward compatibility with services that
 * read from process.env at runtime (Instagram, etc.).
 *
 * @returns {{ source: string, variables: number, missing: string[] }}
 */
export function loadEnvironment() {
    const loaded = {};
    let source = 'none';

    // 1. Try imported .env from app data
    const storedPath = importedStoragePath();
    if (fs.existsSync(storedPath)) {
        try {
            const content = fs.readFileSync(storedPath, 'utf8');
            Object.assign(loaded, parseEnvFile(content));
            source = 'imported';
            importedFilePath = storedPath;
        } catch (err) {
            console.error('[EnvConfig] Failed to read imported env:', err.message);
        }
    }

    // 2. Try project .env (dev fallback) — only if nothing imported yet
    if (source === 'none') {
        const candidates = [
            path.join(app.getAppPath(), '.env'),
            path.join(app.getAppPath(), 'src', '.env'),
            path.join(process.cwd(), '.env'),
            path.join(process.cwd(), 'src', '.env'),
        ];
        for (const envPath of candidates) {
            try {
                if (fs.existsSync(envPath)) {
                    const content = fs.readFileSync(envPath, 'utf8');
                    Object.assign(loaded, parseEnvFile(content));
                    source = 'development';
                    importedFilePath = envPath;
                    break;
                }
            } catch { /* ignore unreadable */ }
        }
    }

    // 3. System environment variables (lowest priority — fills gaps)
    for (const def of VARIABLE_SCHEMA) {
        if (!loaded[def.key] && process.env[def.key]) {
            loaded[def.key] = process.env[def.key];
            if (source === 'none') source = 'system';
        }
    }

    parsedEnvironment = loaded;
    currentSource = source;

    // 4. Set process.env for backward compatibility with services that
    //    read from process.env at runtime (Instagram OAuth flow, etc.)
    for (const [key, value] of Object.entries(loaded)) {
        if (!process.env[key]) {
            process.env[key] = value;
        }
    }

    const missing = getMissingVariables();
    return { source, variables: Object.keys(loaded).length, missing };
}

/**
 * Reload env vars (called after manual import).
 */
export function reloadEnvironment() {
    return loadEnvironment();
}

// ── Accessors ────────────────────────────────────────────────────────────────

/**
 * Get a single environment variable.
 * @param {string} key
 * @returns {string|undefined}
 */
export function getEnv(key) {
    return parsedEnvironment[key];
}

/**
 * Get all currently loaded env vars (key → value).
 * NEVER pass this to the renderer — it would leak secrets.
 */
export function getAllEnv() {
    return { ...parsedEnvironment };
}

/**
 * Get the current source description for UI display.
 */
export function getEnvSource() {
    return currentSource;
}

/**
 * Get the imported file path (or null).
 */
export function getImportedFilePath() {
    return importedFilePath;
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Return a list of variable keys that are required but missing.
 * @returns {string[]}
 */
export function getMissingVariables() {
    return VARIABLE_SCHEMA
        .filter(def => def.required && !parsedEnvironment[def.key])
        .map(def => def.key);
}

/**
 * Return per-provider status objects for UI display.
 * @returns {Array<{ provider: string, configured: boolean, missing: string[] }>}
 */
export function getProviderStatus() {
    const providerMap = {};
    for (const def of VARIABLE_SCHEMA) {
        if (!providerMap[def.provider]) {
            providerMap[def.provider] = { provider: def.provider, configured: true, missing: [] };
        }
        if (def.required && !parsedEnvironment[def.key]) {
            providerMap[def.provider].configured = false;
            providerMap[def.provider].missing.push(def.key);
        }
    }
    return Object.values(providerMap);
}

/**
 * Get masked variable info for UI display (values never included).
 * @returns {Array<{ key: string, label: string, provider: string, present: boolean, type: string }>}
 */
export function getVariableStatus() {
    return VARIABLE_SCHEMA.map(def => ({
        key: def.key,
        label: def.label,
        provider: def.provider,
        type: def.type,
        present: Boolean(parsedEnvironment[def.key]),
    }));
}

// ── Import / Export ──────────────────────────────────────────────────────────

/**
 * Import a .env file from a user-selected path.
 * Copies it into app data for persistence across restarts.
 *
 * @param {string} filePath — full path to the .env file to import
 * @returns {{ ok: boolean, error?: string }}
 */
export function importEnvFile(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) {
            return { ok: false, error: 'File not found' };
        }

        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = parseEnvFile(content);

        if (Object.keys(parsed).length === 0) {
            return { ok: false, error: 'No valid environment variables found in file' };
        }

        // Copy to persistent storage
        const dest = importedStoragePath();
        const destDir = path.dirname(dest);
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }
        fs.copyFileSync(filePath, dest);

        // Reload
        loadEnvironment();

        return { ok: true, variables: Object.keys(parsed).length };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Clear imported environment — reverts to dev/system sources.
 */
export function clearImportedEnv() {
    const dest = importedStoragePath();
    try {
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
    } catch { /* ignore */ }
    importedFilePath = null;
    loadEnvironment();
}

/**
 * Validate the current env and return a detailed report.
 */
export function validateEnvironment() {
    const missing = getMissingVariables();
    const providerStatus = getProviderStatus();
    const available = VARIABLE_SCHEMA.filter(def => Boolean(parsedEnvironment[def.key])).length;
    const total = VARIABLE_SCHEMA.length;

    return {
        ok: missing.length === 0,
        source: currentSource,
        available,
        total,
        missing,
        missingCount: missing.length,
        providers: providerStatus,
        filePath: importedFilePath,
    };
}

// ── Provider helpers ─────────────────────────────────────────────────────────

/**
 * Check if a specific provider is fully configured.
 * @param {string} providerName — e.g. 'Instagram', 'Bluesky'
 * @returns {boolean}
 */
export function isProviderConfigured(providerName) {
    const defs = VARIABLE_SCHEMA.filter(d => d.provider === providerName && d.required);
    return defs.every(d => Boolean(parsedEnvironment[d.key]));
}

/**
 * Get all configured provider names.
 * @returns {string[]}
 */
export function getConfiguredProviders() {
    const providers = [...new Set(VARIABLE_SCHEMA.map(d => d.provider))];
    return providers.filter(p => isProviderConfigured(p));
}

// ── Startup ──────────────────────────────────────────────────────────────────

// Auto-load on import
loadEnvironment();
