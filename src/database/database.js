/**
 * Emerald Utilities — Clean Database Abstraction Boundary
 * ------------------------------------------------------------------
 * This module is the SINGLE, STABLE interface between Emerald application
 * logic and PostgreSQL.
 *
 * Architectural intent:
 *
 *   Emerald application logic
 *          │
 *          ▼
 *   database.*  (this module)
 *          │
 *          ▼
 *   PostgreSQL (via db-pool.js)
 *
 * The application MUST depend on this abstraction, NOT on:
 *   - Tailscale / WireGuard / any VPN
 *   - a specific network topology
 *   - a specific hostname or IP
 *   - any infrastructure-specific code
 *
 * The actual endpoint is supplied purely through configuration
 * (environment variables → config.json → safe defaults).
 *
 * From Emerald's perspective, PostgreSQL is just another configurable
 * database endpoint. It does not matter whether `infhub-server` is
 * reachable through Tailscale, LAN, localhost, or another network.
 *
 * NEVER add Tailscale-specific logic here. If you need a "tailscale"
 * branch, you are solving the wrong problem — the configuration layer
 * already abstracted the network away.
 */

import { pool, checkDbHealth, connectionInfo } from './db-pool.js';
import { dbLog as log } from '../utils/logger.js';

/**
 * Connect to the configured database.
 *
 * This is a thin wrapper around the shared pool. It does NOT start,
 * stop, or configure any networking layer — that is the operating
 * system's job.
 *
 * @returns {Promise<Pool>} The shared pg Pool.
 */
export async function connect() {
    return pool;
}

/**
 * Execute a SQL query against the configured database.
 *
 * @param {string} text - SQL parameterised query
 * @param {Array} params - Query parameters
 * @returns {Promise<Object>} pg QueryResult
 */
export async function query(text, params) {
    return pool.query(text, params);
}

/**
 * Run a comprehensive health check against the configured database.
 *
 * Reports:
 *   - host, port, database name, user (NEVER the password)
 *   - connection status
 *   - PostgreSQL version
 *   - pgvector availability
 *
 * This is safe to call from any context (UI, CLI, startup). It NEVER
 * throws and NEVER logs secrets.
 *
 * @returns {Promise<Object>} Health report
 */
export async function healthCheck() {
    return checkDbHealth();
}

/**
 * Get sanitized connection information for diagnostics.
 * NEVER includes the password.
 *
 * @returns {Object} { host, port, database, user }
 */
export function getConnectionInfo() {
    return { ...connectionInfo };
}

/**
 * Close the shared pool (application shutdown only).
 * Other modules may still hold references; this is intentional — the
 * pool is shared and only fully torn down at process exit.
 */
export async function disconnect() {
    // The shared pool is managed centrally. Closing here is a no-op
    // sentinel so callers have a documented shutdown hook.
    log.info('Database disconnect requested (shared pool managed centrally).');
}

/**
 * Run a simple ping to confirm the server is accepting connections.
 * Used by preflight checks. Does NOT gather version metadata.
 *
 * @returns {Promise<boolean>}
 */
export async function ping() {
    const health = await checkDbHealth();
    return health.ok === true;
}

// Re-export the pool for callers that need direct access (e.g. RAG
// modules that perform bulk operations). This keeps the abstraction
// boundary thin without forcing every consumer through query().
export { pool };