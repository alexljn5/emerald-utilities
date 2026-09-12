/**
 * Network Persistence Service
 *
 * Provides real-time PostgreSQL persistence for network packet events.
 * Uses the existing network_packet_events table.
 *
 * Features:
 * - Real-time INSERT on packet capture
 * - Bounded local queue for connection failures
 * - Auto-reconnect and flush on recovery
 * - No second database, no JSON fallback as primary store
 *
 * All operations use the shared db-pool.js.
 */

import { pool, checkDbHealth } from './db-pool.js';
import { dbLog } from '../utils/logger.js';

// ============================================================
// Configuration
// ============================================================

const MAX_QUEUE_SIZE = parseInt(process.env.NETWORK_QUEUE_MAX || '5000', 10);
const FLUSH_BATCH_SIZE = parseInt(process.env.NETWORK_FLUSH_BATCH || '50', 10);
const FLUSH_INTERVAL_MS = parseInt(process.env.NETWORK_FLUSH_INTERVAL_MS || '2000', 10);

// ============================================================
// State
// ============================================================

let queue = [];
let isFlushing = false;
let flushTimer = null;
let dbAvailable = true;
let lastError = null;

// ============================================================
// Health Check
// ============================================================

async function checkDb() {
    try {
        const health = await checkDbHealth();
        if (health.ok) {
            if (!dbAvailable) {
                dbLog.info('Network persistence: PostgreSQL recovered');
            }
            dbAvailable = true;
            lastError = null;
            return true;
        } else {
            if (dbAvailable) {
                dbLog.warn(`Network persistence: PostgreSQL unavailable (${health.error})`);
            }
            dbAvailable = false;
            lastError = health.error;
            return false;
        }
    } catch (err) {
        if (dbAvailable) {
            dbLog.warn(`Network persistence: PostgreSQL check failed (${err.message})`);
        }
        dbAvailable = false;
        lastError = err.message;
        return false;
    }
}

// ============================================================
// Queue Management
// ============================================================

/**
 * Enqueue a packet event for persistence.
 * If database is available, flush immediately.
 * If not, queue for later.
 */
export async function enqueuePacket(event) {
    // Normalize event
    const normalized = {
        captured_at: event.captured_at ? new Date(event.captured_at) : new Date(),
        source: event.source || 'tcpdump',
        interface_name: event.interface_name || event.interface || 'any',
        direction: event.direction || null,
        protocol: event.protocol || null,
        transport_protocol: event.transport_protocol || event.transport || null,
        source_ip: event.source_ip || null,
        destination_ip: event.destination_ip || null,
        source_port: event.source_port || null,
        destination_port: event.destination_port || null,
        packet_length: event.packet_length || event.length || null,
        is_blacklisted: event.is_blacklisted || false,
        severity: event.severity || 'none',
        payload: event.payload || event,
    };

    if (dbAvailable) {
        // Try immediate insert
        try {
            await insertPacket(normalized);
            return { persisted: true, queued: false };
        } catch (err) {
            dbLog.warn(`Network persistence: immediate insert failed (${err.message}), queuing`);
            dbAvailable = false;
            lastError = err.message;
        }
    }

    // Queue for later
    if (queue.length >= MAX_QUEUE_SIZE) {
        // Drop oldest events to prevent memory exhaustion
        const dropped = queue.splice(0, FLUSH_BATCH_SIZE);
        dbLog.warn(`Network persistence: queue full (${MAX_QUEUE_SIZE}), dropped ${dropped.length} events`);
    }

    queue.push(normalized);
    scheduleFlush();

    return { persisted: false, queued: true, queueSize: queue.length };
}

/**
 * Insert a single packet event into PostgreSQL.
 */
async function insertPacket(event) {
    const sql = `
        INSERT INTO network_packet_events
            (captured_at, source, interface_name, direction, protocol,
             transport_protocol, source_ip, destination_ip,
             source_port, destination_port, packet_length,
             is_blacklisted, severity, payload)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING id
    `;

    const params = [
        event.captured_at,
        event.source,
        event.interface_name,
        event.direction,
        event.protocol,
        event.transport_protocol,
        event.source_ip,
        event.destination_ip,
        event.source_port,
        event.destination_port,
        event.packet_length,
        event.is_blacklisted,
        event.severity,
        event.payload,
    ];

    const result = await pool.query(sql, params);
    return result.rows[0].id;
}

/**
 * Batch insert packet events.
 */
async function insertPacketBatch(events) {
    if (!events || events.length === 0) return [];

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const sql = `
            INSERT INTO network_packet_events
                (captured_at, source, interface_name, direction, protocol,
                 transport_protocol, source_ip, destination_ip,
                 source_port, destination_port, packet_length,
                 is_blacklisted, severity, payload)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING id
        `;

        const ids = [];
        for (const event of events) {
            const params = [
                event.captured_at,
                event.source,
                event.interface_name,
                event.direction,
                event.protocol,
                event.transport_protocol,
                event.source_ip,
                event.destination_ip,
                event.source_port,
                event.destination_port,
                event.packet_length,
                event.is_blacklisted,
                event.severity,
                event.payload,
            ];

            const result = await client.query(sql, params);
            ids.push(result.rows[0].id);
        }

        await client.query('COMMIT');
        return ids;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// ============================================================
// Flush Scheduler
// ============================================================

function scheduleFlush() {
    if (flushTimer) return;

    flushTimer = setTimeout(async () => {
        flushTimer = null;
        if (!isFlushing && queue.length > 0) {
            await flushQueue();
        }
        // Reschedule if there are still items
        if (queue.length > 0) {
            scheduleFlush();
        }
    }, FLUSH_INTERVAL_MS);
}

/**
 * Flush queued events to PostgreSQL.
 */
export async function flushQueue() {
    if (isFlushing || queue.length === 0) return;

    isFlushing = true;
    const available = await checkDb();

    if (!available) {
        isFlushing = false;
        return;
    }

    const batch = queue.splice(0, FLUSH_BATCH_SIZE);
    if (batch.length === 0) {
        isFlushing = false;
        return;
    }

    try {
        await insertPacketBatch(batch);
        dbLog.info(`Network persistence: flushed ${batch.length} events (${queue.length} remaining)`);
    } catch (err) {
        dbLog.error(`Network persistence: flush failed (${err.message}), re-queuing ${batch.length} events`);
        // Put events back at the front of the queue
        queue.unshift(...batch);
        dbAvailable = false;
        lastError = err.message;
    } finally {
        isFlushing = false;
    }
}

// ============================================================
// Status & Recovery
// ============================================================

/**
 * Get current persistence status.
 */
export function getPersistenceStatus() {
    return {
        mode: dbAvailable ? 'database' : 'recovery',
        dbAvailable,
        lastError,
        queueSize: queue.length,
        maxQueueSize: MAX_QUEUE_SIZE,
        isFlushing,
    };
}

/**
 * Force a health check and attempt recovery.
 */
export async function recover() {
    const available = await checkDb();
    if (available && queue.length > 0) {
        dbLog.info(`Network persistence: recovering, flushing ${queue.length} queued events`);
        await flushQueue();
    }
    return getPersistenceStatus();
}

/**
 * Clear the queue without persisting (emergency use only).
 */
export function clearQueue() {
    const cleared = queue.length;
    queue = [];
    return cleared;
}

// ============================================================
// Direct Database Queries (for UI/debugging)
// ============================================================

export async function getRecentPackets(limit = 100, offset = 0, filters = {}) {
    const p = await ensureDb();
    let sql = `
        SELECT id, captured_at, source, interface_name, direction,
               protocol, transport_protocol, source_ip, destination_ip,
               source_port, destination_port, packet_length,
               is_blacklisted, severity, payload
        FROM network_packet_events
        WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (filters.is_blacklisted !== undefined) {
        sql += ` AND is_blacklisted = $${paramIndex++}`;
        params.push(filters.is_blacklisted);
    }

    if (filters.protocol) {
        sql += ` AND protocol = $${paramIndex++}`;
        params.push(filters.protocol);
    }

    if (filters.source_ip) {
        sql += ` AND source_ip = $${paramIndex++}`;
        params.push(filters.source_ip);
    }

    if (filters.destination_ip) {
        sql += ` AND destination_ip = $${paramIndex++}`;
        params.push(filters.destination_ip);
    }

    if (filters.start_time) {
        sql += ` AND captured_at >= $${paramIndex++}`;
        params.push(new Date(filters.start_time));
    }

    if (filters.end_time) {
        sql += ` AND captured_at < $${paramIndex++}`;
        params.push(new Date(filters.end_time));
    }

    sql += ` ORDER BY captured_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(limit, offset);

    const result = await p.query(sql, params);
    return result.rows;
}

export async function getPacketCount() {
    const p = await ensureDb();
    const result = await p.query('SELECT COUNT(*)::int AS count FROM network_packet_events');
    return result.rows[0].count;
}
