import path from 'path';

let electronApp = null;
try {
    const mod = await import('electron');
    electronApp = mod.app;
} catch {
    // Not in Electron context
}

/**
 * Resolve a path relative to the app's resources root (production)
 * or the current working directory (development).
 *
 * Use this for files that are copied via extraResources to the root of
 * process.resourcesPath (e.g. scripts/, img/, fonts/).
 *
 * @param {string} relativePath - Path relative to the resources root / project root
 * @returns {string} Absolute path
 */
export function resolvePath(relativePath) {
    if (electronApp && electronApp.isPackaged && process.resourcesPath) {
        return path.join(process.resourcesPath, relativePath);
    }
    return path.join(process.cwd(), relativePath);
}

/**
 * Resolve the path to the single, canonical .env file.
 *
 * This is the ONE source of truth for all environment variables in the app.
 *
 * Development:  src/.env
 * Production:   process.resourcesPath/.env
 *
 * @returns {string} Absolute path to the .env file
 */
export function resolveEnvPath() {
    if (electronApp && electronApp.isPackaged && process.resourcesPath) {
        return path.join(process.resourcesPath, '.env');
    }
    return path.join(process.cwd(), 'src', '.env');
}

/**
 * Resolve a path inside the database directory.
 *
 * Development:  src/database/<segments>
 * Production:   process.resourcesPath/database/<segments>
 *
 * @param {...string} segments - Path segments relative to the database directory
 * @returns {string} Absolute path
 */
export function resolveDatabasePath(...segments) {
    if (electronApp && electronApp.isPackaged && process.resourcesPath) {
        return path.join(process.resourcesPath, 'database', ...segments);
    }
    return path.join(process.cwd(), 'src', 'database', ...segments);
}

/**
 * Resolve a path inside the internal-scripts directory.
 *
 * Development:  src/internal-scripts/<segments>
 * Production:   process.resourcesPath/internal-scripts/<segments>
 *
 * @param {...string} segments - Path segments relative to the internal-scripts directory
 * @returns {string} Absolute path
 */
export function resolveInternalScriptsPath(...segments) {
    if (electronApp && electronApp.isPackaged && process.resourcesPath) {
        return path.join(process.resourcesPath, 'internal-scripts', ...segments);
    }
    return path.join(process.cwd(), 'src', 'internal-scripts', ...segments);
}
