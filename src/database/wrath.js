/**
 * DATABASE SERVICE - PostgreSQL JSONB Storage Layer
 * Main-process-only database access for Emerald Utilities.
 *
 * This module provides:
 * - Packet event insertion (batch-safe)
 * - Threat indicator management
 * - Paged query helpers for the renderer
 * - JSONL import utilities
 * - Grok message and conversation storage
 *
 * SECURITY: This module MUST only run in the Electron main process.
 * Database credentials are never exposed to the renderer.
 *
 * Uses the shared db-pool.js for all database connections.
 * No separate pool is created here.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool, checkDbHealth } from './db-pool.js';
import { resolveEnvPath } from '../utils/pathResolver.js';
import { dbLog as log } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// Payload Size Helper
// ============================================================

const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1MB max payload size

/**
 * Safely serialize payload, truncating if too large
 * Returns a safe payload object for database storage
 */
function safePayload(obj) {
    try {
        const jsonStr = JSON.stringify(obj);
        if (jsonStr.length > MAX_PAYLOAD_SIZE) {
            console.warn(`[Database] Payload too large (${jsonStr.length} bytes), truncating`);
            // Store a truncated version with metadata about truncation
            const truncated = {
                _truncated: true,
                _originalSize: jsonStr.length,
                _truncatedAt: MAX_PAYLOAD_SIZE,
                content: obj.content || '',
                author: obj.author,
                id: obj.id,
                conversationId: obj.conversationId || obj.conversation_id,
            };
            return truncated;
        }
        return obj;
    } catch (err) {
        console.error('[Database] Failed to serialize payload:', err.message);
        return { _error: true, id: obj.id };
    }
}

// ============================================================
// Connection State
// ============================================================

let dbHealth = null; // cached health check result

/**
 * Get a client from the shared pool, with health check.
 * Returns null if database is unreachable.
 */
async function getHealthyClient() {
    const health = await checkDbHealth();
    dbHealth = health;
    if (!health.ok) {
        return null;
    }
    return pool.connect();
}

/**
 * Execute a query with health check fallback.
 */
async function safeQuery(text, params = []) {
    const client = await getHealthyClient();
    if (!client) {
        throw new Error('Database unavailable');
    }
    try {
        const result = await client.query(text, params);
        return result;
    } finally {
        client.release();
    }
}

// ============================================================
// Packet Events
// ============================================================

/**
 * Insert a single packet event
 */
async function insertPacketEvent(event) {
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
        event.captured_at ? new Date(event.captured_at) : new Date(),
        event.source || 'tcpdump',
        event.interface_name || event.interface || 'any',
        event.direction || null,
        event.protocol || null,
        event.transport_protocol || event.transport || null,
        event.source_ip || null,
        event.destination_ip || null,
        event.source_port || null,
        event.destination_port || null,
        event.packet_length || event.length || null,
        event.is_blacklisted || false,
        event.severity || 'none',
        event.payload || event,
    ];

    const result = await safeQuery(sql, params);
    return result.rows[0].id;
}

/**
 * Batch insert packet events (more efficient for high volume)
 */
async function insertPacketEventsBatch(events) {
    if (!events || events.length === 0) return [];

    const client = await getHealthyClient();
    if (!client) {
        throw new Error('Database unavailable');
    }

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
                event.captured_at ? new Date(event.captured_at) : new Date(),
                event.source || 'tcpdump',
                event.interface_name || event.interface || 'any',
                event.direction || null,
                event.protocol || null,
                event.transport_protocol || event.transport || null,
                event.source_ip || null,
                event.destination_ip || null,
                event.source_port || null,
                event.destination_port || null,
                event.packet_length || event.length || null,
                event.is_blacklisted || false,
                event.severity || 'none',
                event.payload || event,
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

/**
 * Get recent packet events with pagination
 */
async function getRecentPackets(limit = 100, offset = 0, filters = {}) {
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

    const result = await safeQuery(sql, params);
    return result.rows;
}

/**
 * Get packets involving a specific IP
 */
async function getPacketsByIP(ip, limit = 200, offset = 0) {
    const sql = `
        SELECT id, captured_at, source_ip, destination_ip,
               protocol, transport_protocol, severity, payload
        FROM network_packet_events
        WHERE source_ip = $1 OR destination_ip = $1
        ORDER BY captured_at DESC
        LIMIT $2 OFFSET $3
    `;
    const result = await safeQuery(sql, [ip, limit, offset]);
    return result.rows;
}

/**
 * Get protocol distribution for a time window
 */
async function getProtocolDistribution(startTime, endTime) {
    const sql = `
        SELECT protocol, transport_protocol, COUNT(*) AS packet_count
        FROM network_packet_events
        WHERE captured_at >= $1 AND captured_at < $2
        GROUP BY protocol, transport_protocol
        ORDER BY packet_count DESC
    `;
    const result = await safeQuery(sql, [new Date(startTime), new Date(endTime)]);
    return result.rows;
}

/**
 * Search inside JSONB payload
 */
async function searchPayloadJsonb(tag, limit = 100, offset = 0) {
    const sql = `
        SELECT id, captured_at, payload
        FROM network_packet_events
        WHERE payload -> 'tags' ? $1
        ORDER BY captured_at DESC
        LIMIT $2 OFFSET $3
    `;
    const result = await safeQuery(sql, [tag, limit, offset]);
    return result.rows;
}

// ============================================================
// Threat Indicators
// ============================================================

/**
 * Check if an IP is blacklisted
 */
async function isIPBlacklisted(ip) {
    const sql = `
        SELECT EXISTS (
            SELECT 1
            FROM threat_indicators
            WHERE active = TRUE
              AND ip_value >>= $1::inet
        ) AS is_blacklisted
    `;
    const result = await safeQuery(sql, [ip]);
    return result.rows[0].is_blacklisted;
}

/**
 * Add a threat indicator
 */
async function addThreatIndicator(indicator) {
    const sql = `
        INSERT INTO threat_indicators
            (indicator_type, value, ip_value, source_name, confidence, active, metadata)
        VALUES ($1, $2, $3::inet, $4, $5, $6, $7)
        ON CONFLICT (value) DO UPDATE SET
            active = EXCLUDED.active,
            confidence = EXCLUDED.confidence,
            last_seen_at = NOW()
        RETURNING id
    `;

    const params = [
        indicator.indicator_type || 'ipv4',
        indicator.value,
        indicator.value, // ip_value
        indicator.source_name || 'manual',
        indicator.confidence ?? 50,
        indicator.active ?? true,
        indicator.metadata || {},
    ];

    const result = await safeQuery(sql, params);
    return result.rows[0].id;
}

/**
 * Get all active threat indicators
 */
async function getActiveThreatIndicators() {
    const sql = `
        SELECT id, indicator_type, value, ip_value, source_name,
               confidence, active, first_seen_at, last_seen_at, metadata
        FROM threat_indicators
        WHERE active = TRUE
        ORDER BY last_seen_at DESC
    `;
    const result = await safeQuery(sql);
    return result.rows;
}

/**
 * Import threat indicators from array of IP strings
 */
async function importIPBlacklist(ipList, sourceName = 'local-blacklist') {
    const client = await getHealthyClient();
    if (!client) {
        throw new Error('Database unavailable');
    }

    try {
        await client.query('BEGIN');

        const sql = `
            INSERT INTO threat_indicators
                (indicator_type, value, ip_value, source_name, confidence, active)
            VALUES ($1, $2, $3::inet, $4, $5, $6)
            ON CONFLICT (value) DO UPDATE SET
                active = EXCLUDED.active,
                last_seen_at = NOW()
        `;

        let imported = 0;
        for (const ip of ipList) {
            const trimmed = ip.trim();
            if (!trimmed) continue;

            await client.query(sql, [
                'ipv4',
                trimmed,
                trimmed,
                sourceName,
                80,
                true,
            ]);
            imported++;
        }

        await client.query('COMMIT');
        return imported;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// ============================================================
// Grok Conversations
// ============================================================

/**
 * Upsert a Grok conversation
 */
async function upsertGrokConversation(conversation) {
    const sql = `
        INSERT INTO grok_conversations (id, title, last_scraped, message_count, metadata)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET
            title = EXCLUDED.title,
            last_updated = NOW(),
            last_scraped = EXCLUDED.last_scraped,
            message_count = EXCLUDED.message_count,
            metadata = EXCLUDED.metadata
        RETURNING id
    `;

    const params = [
        conversation.id,
        conversation.title || 'Untitled',
        conversation.last_scraped ? new Date(conversation.last_scraped) : null,
        conversation.message_count || 0,
        conversation.metadata || {},
    ];

    const result = await safeQuery(sql, params);
    return result.rows[0].id;
}

/**
 * Get all Grok conversations
 */
async function getAllGrokConversations() {
    const sql = `
        SELECT id, title, message_count, created_at, last_updated, last_scraped, metadata
        FROM grok_conversations
        ORDER BY last_updated DESC
    `;
    const result = await safeQuery(sql);
    return result.rows;
}

/**
 * Get a single Grok conversation by ID
 */
async function getGrokConversation(conversationId) {
    const sql = `
        SELECT id, title, message_count, created_at, last_updated, last_scraped, metadata
        FROM grok_conversations
        WHERE id = $1
    `;
    const result = await safeQuery(sql, [conversationId]);
    return result.rows[0] || null;
}

// ============================================================
// Grok Messages
// ============================================================

/**
 * Save a single Grok message
 */
async function saveGrokMessage(message) {
    const sql = `
        INSERT INTO grok_messages
            (id, conversation_id, content, author, timestamp, scraped_at, payload)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO UPDATE SET
            content = EXCLUDED.content,
            author = EXCLUDED.author,
            timestamp = EXCLUDED.timestamp,
            payload = EXCLUDED.payload
        RETURNING id
    `;

    const params = [
        message.id,
        message.conversationId || message.conversation_id,
        message.content,
        message.author,
        message.timestamp ? new Date(message.timestamp) : null,
        message.scrapedAt ? new Date(message.scrapedAt) : new Date(),
        safePayload(message.payload || message),
    ];

    const result = await safeQuery(sql, params);
    return result.rows[0].id;
}

/**
 * Batch save Grok messages
 */
async function saveGrokMessagesBatch(messages) {
    if (!messages || messages.length === 0) return [];

    const client = await getHealthyClient();
    if (!client) {
        throw new Error('Database unavailable');
    }

    try {
        await client.query('BEGIN');

        const sql = `
            INSERT INTO grok_messages
                (id, conversation_id, content, author, timestamp, scraped_at, payload)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (id) DO UPDATE SET
                content = EXCLUDED.content,
                author = EXCLUDED.author,
                timestamp = EXCLUDED.timestamp,
                payload = EXCLUDED.payload
            RETURNING id
        `;

        const ids = [];
        for (const message of messages) {
            const params = [
                message.id,
                message.conversationId || message.conversation_id,
                message.content,
                message.author,
                message.timestamp ? new Date(message.timestamp) : null,
                message.scrapedAt ? new Date(message.scrapedAt) : new Date(),
                safePayload(message.payload || message),
            ];

            const result = await client.query(sql, params);
            ids.push(result.rows[0].id);
        }

        // Update conversation stats
        if (messages.length > 0) {
            const conversationId = messages[0].conversationId || messages[0].conversation_id;
            await client.query(`
                UPDATE grok_conversations
                SET message_count = (SELECT COUNT(*) FROM grok_messages WHERE conversation_id = $1),
                    last_updated = NOW()
                WHERE id = $1
            `, [conversationId]);
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

/**
 * Get messages by conversation with pagination
 */
async function getGrokMessagesByConversation(conversationId, limit = 1000, offset = 0) {
    const sql = `
        SELECT id, conversation_id, content, author, timestamp, scraped_at, payload
        FROM grok_messages
        WHERE conversation_id = $1
        ORDER BY timestamp ASC
        LIMIT $2 OFFSET $3
    `;
    const result = await safeQuery(sql, [conversationId, limit, offset]);
    return result.rows;
}

/**
 * Get recent Grok messages
 */
async function getRecentGrokMessages(hours = 24, limit = 100) {
    const timeAgo = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const sql = `
        SELECT id, conversation_id, content, author, timestamp, scraped_at
        FROM grok_messages
        WHERE scraped_at > $1
        ORDER BY timestamp DESC
        LIMIT $2
    `;
    const result = await safeQuery(sql, [timeAgo, limit]);
    return result.rows;
}

/**
 * Search inside Grok message payload (JSONB)
 */
async function searchGrokMessages(query, limit = 100, offset = 0) {
    const sql = `
        SELECT id, conversation_id, content, author, timestamp, payload
        FROM grok_messages
        WHERE payload ILIKE $1 OR content ILIKE $1
        ORDER BY timestamp DESC
        LIMIT $2 OFFSET $3
    `;
    const result = await safeQuery(sql, [`%${query}%`, limit, offset]);
    return result.rows;
}

/**
 * Get Grok message count
 */
async function getGrokMessageCount(conversationId = null) {
    if (conversationId) {
        const result = await safeQuery(
            'SELECT COUNT(*) as count FROM grok_messages WHERE conversation_id = $1',
            [conversationId]
        );
        return parseInt(result.rows[0].count, 10);
    }

    const result = await safeQuery('SELECT COUNT(*) as count FROM grok_messages');
    return parseInt(result.rows[0].count, 10);
}

// ============================================================
// Metadata
// ============================================================

async function getMeta(key) {
    const sql = `SELECT value FROM database_meta WHERE key = $1`;
    const result = await safeQuery(sql, [key]);
    return result.rows[0]?.value ?? null;
}

async function setMeta(key, value) {
    const sql = `
        INSERT INTO database_meta (key, value, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET
            value = EXCLUDED.value,
            updated_at = NOW()
    `;
    await safeQuery(sql, [key, value]);
}

// ============================================================
// JSONL Import
// ============================================================

/**
 * Import a JSONL file into the database
 */
async function importJSONL(filePath, batchSize = 500) {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());

    let imported = 0;
    let failed = 0;

    for (let i = 0; i < lines.length; i += batchSize) {
        const batch = lines.slice(i, i + batchSize).map(line => {
            try {
                const parsed = JSON.parse(line);
                return {
                    ...parsed,
                    payload: parsed,
                    source: parsed.source || 'jsonl-import',
                };
            } catch {
                failed++;
                return null;
            }
        }).filter(Boolean);

        if (batch.length > 0) {
            try {
                await insertPacketEventsBatch(batch);
                imported += batch.length;
            } catch (err) {
                console.error(`[Database] Failed to import batch at line ${i}:`, err.message);
                failed += batch.length;
            }
        }
    }

    // Record import metadata
    await setMeta('last_import_from_jsonl', {
        file: filePath,
        imported,
        failed,
        importedAt: new Date().toISOString(),
    });

    return { imported, failed };
}

/**
 * Import Grok data from IndexedDB export JSON
 * (matches the format from XScraperDatabase.exportAsJSON())
 */
async function importGrokIndexedDBExport(exportData) {
    if (!exportData || typeof exportData !== 'object') {
        throw new Error('Invalid export data format');
    }

    const conversations = exportData.conversations || exportData.data?.conversations || [];
    const messages = exportData.messages || exportData.data?.messages || [];

    console.log(`[Database] Importing Grok export: ${conversations.length} conversations, ${messages.length} messages`);
    console.log(`[Database] Export data size: ${JSON.stringify(exportData).length} bytes`);

    let importedConversations = 0;
    let importedMessages = 0;
    let failed = 0;

    // Import conversations first
    for (const conv of conversations) {
        try {
            const convId = conv.id || conv.conversationId;
            if (!convId) {
                console.warn('[Database] Skipping conversation with no id:', conv);
                failed++;
                continue;
            }
            const convSize = JSON.stringify(conv).length;
            console.log(`[Database] Importing conversation ${convId} (${convSize} bytes)`);
            await upsertGrokConversation({
                id: convId,
                title: conv.title || conv.conversationTitle || 'Untitled',
                message_count: conv.message_count || 0,
                last_scraped: conv.last_scraped || conv.last_updated || conv.exportDate,
                metadata: conv,
            });
            importedConversations++;
        } catch (err) {
            console.error(`[Database] Failed to import conversation ${conv.id || conv.conversationId}:`, err.message);
            failed++;
        }
    }

    // Import messages in batches
    const BATCH_SIZE = 200;
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
        const batch = messages.slice(i, i + BATCH_SIZE).map((msg, idx) => {
            const convId = msg.conversationId || msg.conversation_id;
            if (!convId) {
                console.warn(`[Database] Skipping message ${msg.id} with no conversationId`);
                return null;
            }
            const msgSize = JSON.stringify(msg).length;
            const contentLength = msg.content ? msg.content.length : 0;
            console.log(`[Database] Processing message ${msg.id} (conv: ${convId}, size: ${msgSize} bytes, content: ${contentLength} chars)`);
            return {
                id: msg.id,
                conversation_id: convId,
                content: msg.content,
                author: msg.author || 'unknown',
                timestamp: msg.ts ? new Date(msg.ts) : (msg.timestamp ? new Date(msg.timestamp) : null),
                scraped_at: msg.savedAt ? new Date(msg.savedAt) : new Date(),
                payload: msg,
            };
        }).filter(Boolean);

        if (batch.length === 0) continue;

        try {
            console.log(`[Database] Saving message batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} messages)`);
            await saveGrokMessagesBatch(batch);
            importedMessages += batch.length;
            console.log(`[Database] Batch saved. Total messages imported: ${importedMessages}/${messages.length}`);
        } catch (err) {
            console.error(`[Database] Failed to import message batch at ${i}:`, err.message);
            console.error(`[Database] Batch error details:`, err.stack || err);
            failed += batch.length;
        }
    }

    // Record import metadata
    await setMeta('last_import_from_grok_indexeddb', {
        exportedAt: exportData.exportDate,
        importedConversations,
        importedMessages,
        failed,
        importedAt: new Date().toISOString(),
    });

    console.log(`[Database] Grok import complete: ${importedConversations} conversations, ${importedMessages} messages, ${failed} failed`);

    return {
        importedConversations,
        importedMessages,
        failed,
    };
}

// ============================================================
// Health & Stats
// ============================================================

async function getStats() {
    try {
        const packetCount = await safeQuery('SELECT COUNT(*) as count FROM network_packet_events');
        const threatCount = await safeQuery('SELECT COUNT(*) as count FROM threat_indicators WHERE active = TRUE');
        const blacklistedCount = await safeQuery('SELECT COUNT(*) as count FROM network_packet_events WHERE is_blacklisted = TRUE');
        const grokMessageCount = await safeQuery('SELECT COUNT(*) as count FROM grok_messages');
        const grokConversationCount = await safeQuery('SELECT COUNT(*) as count FROM grok_conversations');

        return {
            totalPackets: parseInt(packetCount.rows[0].count, 10),
            activeThreats: parseInt(threatCount.rows[0].count, 10),
            blacklistedPackets: parseInt(blacklistedCount.rows[0].count, 10),
            grokMessages: parseInt(grokMessageCount.rows[0].count, 10),
            grokConversations: parseInt(grokConversationCount.rows[0].count, 10),
            connected: dbHealth?.ok ?? false,
        };
    } catch (err) {
        console.error('[Database] getStats error:', err);
        return {
            totalPackets: 0,
            activeThreats: 0,
            blacklistedPackets: 0,
            grokMessages: 0,
            grokConversations: 0,
            connected: false,
        };
    }
}

async function healthCheck() {
    try {
        await safeQuery('SELECT 1');
        return { healthy: true };
    } catch (err) {
        return { healthy: false, error: err.message };
    }
}

function getConnectionInfo() {
    return {
        host: resolved.host,
        port: resolved.port,
        database: resolved.database,
        user: resolved.user,
        connected: dbHealth?.ok ?? false,
    };
}

async function executeQuery(sql) {
    if (!sql || typeof sql !== 'string') {
        throw new Error('Query must be a non-empty string');
    }

    const trimmed = sql.trim();
    if (!trimmed) {
        throw new Error('Query must be a non-empty string');
    }

    const upper = trimmed.toUpperCase();
    if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
        throw new Error('Only SELECT queries are allowed from the UI');
    }

    const result = await safeQuery(trimmed);
    return result.rows;
}

// ============================================================
// Singleton Export
// ============================================================
const databaseService = {
    insertPacketEvent,
    insertPacketEventsBatch,
    getRecentPackets,
    getPacketsByIP,
    getProtocolDistribution,
    searchPayloadJsonb,
    isIPBlacklisted,
    addThreatIndicator,
    getActiveThreatIndicators,
    importIPBlacklist,
    upsertGrokConversation,
    getAllGrokConversations,
    getGrokConversation,
    saveGrokMessage,
    saveGrokMessagesBatch,
    getGrokMessagesByConversation,
    getRecentGrokMessages,
    searchGrokMessages,
    getGrokMessageCount,
    getMeta,
    setMeta,
    importJSONL,
    importGrokIndexedDBExport,
    getStats,
    healthCheck,
    getConnectionInfo,
    executeQuery,
};

export default databaseService;
export { databaseService };
