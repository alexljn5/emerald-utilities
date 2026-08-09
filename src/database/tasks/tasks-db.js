/**
 * Tasks Database — Shared PostgreSQL Pool with JSON Fallback
 *
 * Connection model:
 *   1. Use the shared Emerald PostgreSQL pool (db-pool.js) as primary.
 *   2. If PostgreSQL is unreachable, fall back to JSON file storage.
 *   3. No independent Tasks PostgreSQL container.
 *   4. No second database.
 *
 * IMPORTANT: Connection state is NOT permanently cached.
 * Each operation re-checks pool health to avoid poisoning the
 * application into permanent "local mode" after a transient failure.
 *
 * The shared pool handles connection precedence:
 *   - Environment variables (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD)
 *   - config.json -> database.{host,port,database,user,password}
 *   - Hardcoded safe defaults
 */

import { pool, checkDbHealth } from '../db-pool.js';
import {
    getJsonNotes, getJsonNoteById, createJsonNote, updateJsonNote, deleteJsonNote,
    getJsonTasks, getJsonTaskById, createJsonTask, updateJsonTask, deleteJsonTask,
    getJsonPendingReminders, markJsonReminderHandled
} from './tasks-json-store.js';

// ---------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------

// NOTE: We do NOT cache a persistent "useJsonFallback" flag.
// A transient failure must not permanently poison the application.
// Each call to getTasksPool() re-checks health (with short cache).

let lastHealthCheck = null;
let lastHealthCheckTime = 0;
const HEALTH_CACHE_TTL_MS = 5000; // Cache health for 5s max

/**
 * Check if we are currently operating in JSON fallback mode.
 * This is a snapshot, not a persistent state.
 */
export function isUsingJsonFallback() {
    const health = lastHealthCheck;
    if (!health) return false;
    return !health.ok;
}

/**
 * Get the current connection mode: 'database' | 'offline-json' | 'degraded'
 */
export function getConnectionMode() {
    const health = lastHealthCheck;
    if (!health) return 'database'; // Assume database until checked
    if (!health.ok) return 'offline-json';
    return 'database';
}

/**
 * Get the shared PostgreSQL pool.
 * Returns the pool if available, null if we must use JSON fallback.
 *
 * CRITICAL: This function ALWAYS re-checks health (with short cache).
 * A transient first failure must not permanently disable the pool.
 */
export async function getTasksPool() {
    const now = Date.now();

    // Re-check health if cache expired or never checked
    if (!lastHealthCheck || (now - lastHealthCheckTime) > HEALTH_CACHE_TTL_MS) {
        try {
            lastHealthCheck = await checkDbHealth();
            lastHealthCheckTime = now;
        } catch (err) {
            // Health check itself threw — treat as unavailable
            lastHealthCheck = {
                ok: false,
                host: 'unknown',
                port: 0,
                database: 'unknown',
                error: err.message,
            };
            lastHealthCheckTime = now;
        }
    }

    if (!lastHealthCheck.ok) {
        // Only log occasionally to avoid spam
        if (!lastHealthCheck._logged) {
            console.warn(`[Tasks DB] PostgreSQL unreachable (host=${lastHealthCheck.host}:${lastHealthCheck.port}, db=${lastHealthCheck.database}, error=${lastHealthCheck.error}). Falling back to JSON.`);
            lastHealthCheck._logged = true;
        }
        return null;
    }

    // Clear logged flag when healthy
    if (lastHealthCheck._logged) {
        lastHealthCheck._logged = false;
        console.log('[Tasks DB] PostgreSQL recovered. Resuming database mode.');
    }

    return pool;
}

/**
 * Close the pool (app shutdown).
 */
export async function closeTasksPool() {
    lastHealthCheck = null;
    lastHealthCheckTime = 0;
    // Note: we do NOT end the shared pool here; other modules may use it.
}

/**
 * Force a health check and update cached state.
 */
export async function refreshConnectionState() {
    try {
        lastHealthCheck = await checkDbHealth();
    } catch (err) {
        lastHealthCheck = {
            ok: false,
            host: 'unknown',
            port: 0,
            database: 'unknown',
            error: err.message,
        };
    }
    lastHealthCheckTime = Date.now();
    return getConnectionMode();
}
