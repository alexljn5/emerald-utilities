/**
 * Shared Database Pool
 * Used by all RAG modules to avoid pool conflicts.
 *
 * Connection precedence (highest wins):
 *   1. Environment variables (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD)
 *   2. config.json  ->  database.{host,port,database,user,password}
 *   3. Hardcoded safe defaults
 *
 * This lets the same codebase point at:
 *   - a LOCAL database in development      (DB_HOST=127.0.0.1)
 *   - the headless server in production    (DB_HOST=192.168.2.27)
 * simply by editing .env, without touching config.json.
 */
import { Pool } from 'pg';
import { config as loadDotenv } from 'dotenv';
import fsPromises from 'fs/promises';
import { readFileSync } from 'fs';
import { resolveDatabasePath, resolveEnvPath } from '../utils/pathResolver.js';
import { dbLog as log } from '../utils/logger.js';

// safeStorage is only available in Electron main process.
// In Node.js CLI contexts, fall back to .env for secrets.
let safeStorage = null;
try {
    const electron = await import('electron');
    safeStorage = electron.safeStorage;
} catch {
    // Not in Electron — safeStorage stays null, .env fallback will be used
}

// ---------------------------------------------------------------------
// Load .env first so process.env is populated before we read config.
// Single source of truth: src/.env (dev) / <resources>/.env (prod).
// ---------------------------------------------------------------------
// override:true so our .env WINS over any pre-existing machine env var
// (e.g. a system OLLAMA_HOST=localhost or stray PG* vars).
const envPath = resolveEnvPath();
loadDotenv({ path: envPath, override: true });

// Load configuration from JSON file (defaults / non-secret structure)
const configPath = resolveDatabasePath('config.json');
let config;
try {
    const raw = await fsPromises.readFile(configPath, 'utf8');
    config = JSON.parse(raw);
} catch (err) {
    log.error('load-config', err, `Ensure config.json exists at ${configPath}`);
    throw new Error(`Configuration file not found at ${configPath}`);
}

// Decrypt sensitive values if safeStorage is available
function decryptIfNeeded(value) {
    if (typeof value !== 'string' || !value.startsWith('encrypted:')) {
        return value;
    }
    if (!safeStorage || !safeStorage.isEncryptionAvailable || !safeStorage.isEncryptionAvailable()) {
        log.warn('safeStorage unavailable; using .env fallback for secrets');
        return null; // Signal to fall back to .env
    }
    try {
        const base64 = value.slice('encrypted:'.length);
        const buffer = Buffer.from(base64, 'base64');
        return safeStorage.decryptString(buffer);
    } catch (err) {
        log.error('decrypt-secret', err, 'Falling back to .env value');
        return null; // Signal to fall back to .env
    }
}

function decryptConfig(configObj) {
    if (!configObj || typeof configObj !== 'object') return configObj;
    const decrypted = { ...configObj };
    for (const key of Object.keys(decrypted)) {
        if (typeof decrypted[key] === 'string') {
            const result = decryptIfNeeded(decrypted[key]);
            if (result === null) {
                // Fallback to .env for this field
                decrypted[key] = loadEnvValue(key);
            } else {
                decrypted[key] = result;
            }
        } else if (typeof decrypted[key] === 'object' && decrypted[key] !== null) {
            decrypted[key] = decryptConfig(decrypted[key]);
        }
    }
    return decrypted;
}

// Simple .env parser fallback (used when a secret cannot be decrypted)
function loadEnvValue(key) {
    try {
        const raw = readFileSync(envPath, 'utf8');
        const lines = raw.split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIndex = trimmed.indexOf('=');
            if (eqIndex === -1) continue;
            const envKey = trimmed.slice(0, eqIndex).trim();
            const envValue = trimmed.slice(eqIndex + 1).trim();
            if (envKey === key) {
                return envValue;
            }
        }
    } catch (err) {
        log.error('load-env-fallback', err, `Could not read ${key} from .env`);
    }
    return undefined;
}

config = decryptConfig(config);

const dbConfig = config.database || {};

// ---------------------------------------------------------------------
// Resolve final connection settings: ENV overrides config.json.
// ---------------------------------------------------------------------
const resolved = {
    host: process.env.DB_HOST || dbConfig.host || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || dbConfig.port || '5432', 10),
    database: process.env.DB_NAME || dbConfig.database || 'emerald_utilities',
    user: process.env.DB_USER || dbConfig.user || 'alexljn5',
    password: process.env.DB_PASSWORD || dbConfig.password || '',
};

if (!resolved.password) {
    log.warn('No database password resolved from env or config. Connection may fail.');
}

// Log where we are connecting (never log the password).
log.info(`DB target: postgres://${resolved.user}@${resolved.host}:${resolved.port}/${resolved.database}`);

// Shared pool instance. connectionTimeoutMillis makes the app fail fast
// (instead of hanging) when the DB host is unreachable, so unrelated
// modules/UI can continue.
const pool = new Pool({
    host: resolved.host,
    port: resolved.port,
    database: resolved.database,
    user: resolved.user,
    password: resolved.password,
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT_MS || '5000', 10),
    idleTimeoutMillis: 30000,
    max: parseInt(process.env.DB_POOL_MAX || '10', 10),
});

// Never let an idle-client error crash the process; log and continue.
pool.on('error', (err) => {
    log.error('pool', err, 'Idle client error; pool will recover on next query');
});

const KNOWN_SERVER_CODES = new Set(['57P01', '57P02', '08000', '08003', '08006', '53300', '57P03']);

/**
 * Classify a pg/pool connection failure so diagnostics can distinguish:
 *   - container down          (ECONNREFUSED / ETIMEDOUT / ENOTFOUND)
 *   - wrong host / port       (ENOTFOUND, ECONNREFUSED on the LAN)
 *   - authentication failure  (28P01 / password authentication failed)
 *   - database does not exist (3D000)
 *   - schema / migration      (42P01 undefined table, 42P07 duplicate table/index)
 *   - query failure           (anything else raised during a query)
 *   - timeout                 (ETIMEDOUT / 53300 too many connections)
 *
 * Returns a stable `kind` plus a human-readable reason. Never logs passwords.
 */
function classifyDbError(err) {
    const message = String((err && err.message) || err || '');
    const code = String((err && err.code) || (err && err.cause && err.cause.code) || '').trim();
    const combined = `${message} ${code}`;

    if (/password authentication failed|28P01/i.test(combined)) {
        return { kind: 'auth', reason: 'Authentication failed for the configured database user (wrong password or role privileges).' };
    }
    if (/database ".+" does not exist|3D000/i.test(combined)) {
        return { kind: 'db-missing', reason: 'The configured database does not exist on the target server.' };
    }
    if (/duplicate (key value|table|index|schema)|42701|42710|42P07/i.test(combined)) {
        return { kind: 'schema-duplicate', reason: 'Schema conflict: a duplicate table/index/constraint was attempted (migrations own the schema).' };
    }
    if (/relation ".+" does not exist|undefined_table|42P01/i.test(combined)) {
        return { kind: 'schema-missing', reason: 'A required table is missing (schema/migrations not applied).' };
    }
    if (/ENOTFOUND/.test(combined)) {
        return { kind: 'host', reason: 'Could not resolve the configured database host.' };
    }
    if (/ECONNREFUSED/.test(combined)) {
        return { kind: 'tcp', reason: 'Connection refused — the PostgreSQL container/service may be down, or the host/port is wrong.' };
    }
    if (/ECONNRESET/.test(combined)) {
        return { kind: 'tcp', reason: 'Connection reset by the server.' };
    }
    if (/ETIMEDOUT|timeout|53300/.test(combined)) {
        return { kind: 'timeout', reason: 'Connection timed out — server may be unreachable over the LAN or overloaded.' };
    }
    if (KNOWN_SERVER_CODES.has(code)) {
        return { kind: 'server', reason: 'PostgreSQL server error (server is up but not accepting connections).' };
    }
    return { kind: 'query', reason: 'Database query failed.' };
}

/**
 * Lightweight health check for graceful degradation.
 * Returns { ok, host, port, database, user, kind?, reason? } and NEVER throws,
 * so callers can show "database unavailable" without crashing unrelated features.
 * Never logs the password.
 */
export async function checkDbHealth() {
    const info = {
        host: resolved.host,
        port: resolved.port,
        database: resolved.database,
        user: resolved.user,
    };
    let client;
    try {
        client = await pool.connect();
        await client.query('SELECT 1');
        return { ok: true, ...info, kind: 'ok', reason: 'Connected' };
    } catch (err) {
        const { kind, reason } = classifyDbError(err);
        log.error(
            'health-check',
            err,
            `DB target=${info.user}@${info.host}:${info.port}/${info.database} | kind=${kind} | ${reason}`
        );
        return { ok: false, ...info, kind, reason, error: err.message };
    } finally {
        if (client) client.release();
    }
}

// Export sanitized connection info (no password) for diagnostics
export const connectionInfo = {
    host: resolved.host,
    port: resolved.port,
    database: resolved.database,
    user: resolved.user,
};

export { pool };
