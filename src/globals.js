// src/globals.js
// Single source of truth for application-wide flags, constants, and feature toggles.

export const APP_NAME = 'Emerald Utilities';
export const versionNumber = '0.1.6';

// ==================== FEATURE FLAGS ====================
// Toggle features on/off. Used by both main and renderer processes.
export const ENABLE_DEVTOOLS = false;
export const ENABLE_CREATOR_HUB = true;
export const ENABLE_NETWORK_MONITOR = true;
export const ENABLE_DATABASE = true;
export const ENABLE_AI = true;
export const ENABLE_SCRIPT_TOOL = true;
export const ENABLE_MOD_UPDATER = true;
export const ENABLE_PORTFOLIO = true;
export const ENABLE_INTERNET = true;
export const ENABLE_INAPP_NOTIFICATIONS = true;
export const ENABLE_BOTS = true;

// ==================== DEPLOYMENT MODES ====================
// AI_MODE and DATABASE_MODE are hardcoded here as the single source of truth.
// The application always uses remote (homelab) infrastructure.
// Local mode is no longer supported.

export const AI_MODE = 'remote';
export const DATABASE_MODE = 'remote';

export const isValidAiMode = (mode) => mode === 'remote' || mode === 'local';
export const isValidDatabaseMode = (mode) => mode === 'remote' || mode === 'local';

// ==================== LOCAL AI TOGGLE ====================
// Single global flag controlling whether the legacy local AI backend is
// initialised. This is the ONE switch — there is no separate configuration
// system for local AI anymore.
//
// Resolution precedence (highest wins):
//   1. process.env.EMERALD_LOCAL_AI  ('true' | 'false')
//   2. process.env.LOCAL_AI_ENABLED  ('true' | 'false')
//   3. src/database/config.json -> localAI.enabled  (default false)
//
// When DISABLED:
//   - the local AI backend is NOT initialised
//   - no local model calls / no local-AI persistence
//   - the app will not crash because the local backend is absent
// When ENABLED: the existing local AI implementation is used.
function parseBool(v) {
    if (v === undefined || v === null || v === '') return undefined;
    return String(v).toLowerCase() === 'true';
}

// Local AI is enabled only when explicitly requested via env var.
// The main process reconciles this against config.json -> localAI.enabled
// during startup (see heavensgate.js). Defaults to DISABLED.
const envLocalAi = parseBool(process.env.EMERALD_LOCAL_AI ?? process.env.LOCAL_AI_ENABLED);
export const LOCAL_AI_ENABLED = envLocalAi ?? false;

// ==================== ENVIRONMENT ====================
export const IS_DEV = !import.meta.env?.PROD;
export const IS_PACKAGED = import.meta.env?.PROD ?? false;

// ==================== CREATOR HUB FLAGS ====================
// Toggle features on/off. Used by both main and renderer processes.
export const CREATOR_HUB = Object.freeze({
    ENABLED: ENABLE_CREATOR_HUB,
    STORAGE_DIR: 'creator-hub-data',
    ACCOUNTS_FILE: 'accounts.json',
    POSTS_FILE: 'posts.json',
    PUBLISH_HISTORY_FILE: 'publish-history.json',
    MAX_MEDIA_FILES: 10,
    MAX_MEDIA_SIZE_MB: 50,
    SUPPORTED_PLATFORMS: [
        'x',
        'instagram',
        'tiktok',
        'itch',
        'facebook',
        'bluesky',
        'threads',
        'youtube'
    ],
    PUBLISH_RETRY_ATTEMPTS: 1,
    PUBLISH_TIMEOUT_MS: 30000
});

// ==================== ACCOUNT STATUS ====================
// Re-exported from models for renderer use
export const ACCOUNT_STATUS = Object.freeze({
    CONNECTED: 'connected',
    DISCONNECTED: 'disconnected',
    ERROR: 'error',
    PENDING: 'pending'
});

// ==================== CENTRAL FLAG HELPERS ====================
// Use these in internal code instead of scattering boolean checks everywhere.

export function isFeatureEnabled(feature) {
    return CREATOR_HUB[feature] === true;
}

export function isDevToolsEnabled() {
    return ENABLE_DEVTOOLS && IS_DEV;
}

export function isCreatorHubEnabled() {
    return ENABLE_CREATOR_HUB;
}

// ==================== RENDERER EXPOSURE ====================
// Expose to renderer / DOM (only when window exists)
if (typeof window !== 'undefined') {
    window.APP_NAME = APP_NAME;
    window.versionNumber = versionNumber;
    window.ENABLE_DEVTOOLS = ENABLE_DEVTOOLS;
    window.ENABLE_CREATOR_HUB = ENABLE_CREATOR_HUB;
    window.IS_DEV = IS_DEV;
    window.CREATOR_HUB = CREATOR_HUB;
}

if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        const versionDisplay = document.getElementById('versionDisplay');
        if (versionDisplay) {
            versionDisplay.textContent = `v${versionNumber}`;
        }
    });
}
