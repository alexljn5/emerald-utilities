/**
 * DATABASE SERVICE - PostgreSQL JSONB Storage Layer
 * Main-process-only database access for Emerald Utilities.
 *
 * This module provides:
 * - Connection pooling to PostgreSQL
 * - Packet event insertion (batch-safe)
 * - Threat indicator management
 * - Paged query helpers for the renderer
 * - JSONL import utilities
 * - Grok message and conversation storage
 *
 * SECURITY: This module MUST only run in the Electron main process.
 * Database credentials are never exposed to the renderer.
 */

import pg from 'pg';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// Configuration
// ============================================================
function loadEnvFile() {
    const envPath = join(__dirname, '.env');
    if (!existsSync(envPath)) return;

    try {
        const envContent = readFileSync(envPath, 'utf8');
        const envLines = envContent.split('\n');

        for (const line of envLines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;

            const [key, ...valueParts] = trimmed.split('=');
            const value = valueParts.join('=').replace(/^["']|["']$/g, '');

            if (key && value && !process.env[key]) {
                process.env[key] = value;
            }
        }
    } catch (err) {
        console.warn('[Database] Could not load .env file:', err.message);
    }
}

// Load .env into process.env before reading config
loadEnvFile();

function getDatabaseConfig() {
    // All values come from environment (loaded from .env or system env).
    // No secrets are hardcoded in source.
    const env = process.env;

    const config = {
        host: env.POSTGRES_HOST,
        port: parseInt(env.POSTGRES_PORT, 10),
        database: env.POSTGRES_DB,
        user: env.POSTGRES_USER,
        password: env.POSTGRES_PASSWORD,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    };

    // Validate required fields
    const missing = [];
    if (!config.host) missing.push('POSTGRES_HOST');
    if (!config.database) missing.push('POSTGRES_DB');
    if (!config.user) missing.push('POSTGRES_USER');
    if (!config.password) missing.push('POSTGRES_PASSWORD');

    if (missing.length > 0) {
        throw new Error(
            `[Database] Missing required environment variables: ${missing.join(', ')}. ` +
            `Please set them in src/database/.env or your system environment.`
        );
    }

    return config;
}

// ============================================================
// Connection Pool
// ============================================================
class DatabaseService {
    constructor() {
        this.pool = null;
        this.config = getDatabaseConfig();
        this.connected = false;
    }

    async connect() {
        if (this.connected && this.pool) return this.pool;

        try {
            this.pool = new pg.Pool(this.config);

            // Test connection
            const client = await this.pool.connect();
            const result = await client.query('SELECT NOW()');
            client.release();

            this.connected = true;
            console.log(`[Database] Connected to PostgreSQL at ${this.config.host}:${this.config.port}/${this.config.database}`);
            return this.pool;
        } catch (err) {
            this.connected = false;
            console.error('[Database] Connection failed:', err.message);
            throw err;
        }
    }

    async disconnect() {
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
            this.connected = false;
            console.log('[Database] Disconnected from PostgreSQL');
        }
    }

    async query(text, params = []) {
        if (!this.pool) await this.connect();
        return this.pool.query(text, params);
    }

    async getClient() {
        if (!this.pool) await this.connect();
        return this.pool.connect();
    }

    // ============================================================
    // Packet Events
    // ============================================================

    /**
     * Insert a single packet event
     */
    async insertPacketEvent(event) {
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

        const result = await this.query(sql, params);
        return result.rows[0].id;
    }

    /**
     * Batch insert packet events (more efficient for high volume)
     */
    async insertPacketEventsBatch(events) {
        if (!events || events.length === 0) return [];

        const client = await this.getClient();
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
    async getRecentPackets(limit = 100, offset = 0, filters = {}) {
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

        const result = await this.query(sql, params);
        return result.rows;
    }

    /**
     * Get packets involving a specific IP
     */
    async getPacketsByIP(ip, limit = 200, offset = 0) {
        const sql = `
            SELECT id, captured_at, source_ip, destination_ip,
                   protocol, transport_protocol, severity, payload
            FROM network_packet_events
            WHERE source_ip = $1 OR destination_ip = $1
            ORDER BY captured_at DESC
            LIMIT $2 OFFSET $3
        `;
        const result = await this.query(sql, [ip, limit, offset]);
        return result.rows;
    }

    /**
     * Get protocol distribution for a time window
     */
    async getProtocolDistribution(startTime, endTime) {
        const sql = `
            SELECT protocol, transport_protocol, COUNT(*) AS packet_count
            FROM network_packet_events
            WHERE captured_at >= $1 AND captured_at < $2
            GROUP BY protocol, transport_protocol
            ORDER BY packet_count DESC
        `;
        const result = await this.query(sql, [new Date(startTime), new Date(endTime)]);
        return result.rows;
    }

    /**
     * Search inside JSONB payload
     */
    async searchPayloadJsonb(tag, limit = 100, offset = 0) {
        const sql = `
            SELECT id, captured_at, payload
            FROM network_packet_events
            WHERE payload -> 'tags' ? $1
            ORDER BY captured_at DESC
            LIMIT $2 OFFSET $3
        `;
        const result = await this.query(sql, [tag, limit, offset]);
        return result.rows;
    }

    // ============================================================
    // Threat Indicators
    // ============================================================

    /**
     * Check if an IP is blacklisted
     */
    async isIPBlacklisted(ip) {
        const sql = `
            SELECT EXISTS (
                SELECT 1
                FROM threat_indicators
                WHERE active = TRUE
                  AND ip_value >>= $1::inet
            ) AS is_blacklisted
        `;
        const result = await this.query(sql, [ip]);
        return result.rows[0].is_blacklisted;
    }

    /**
     * Add a threat indicator
     */
    async addThreatIndicator(indicator) {
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

        const result = await this.query(sql, params);
        return result.rows[0].id;
    }

    /**
     * Get all active threat indicators
     */
    async getActiveThreatIndicators() {
        const sql = `
            SELECT id, indicator_type, value, ip_value, source_name,
                   confidence, active, first_seen_at, last_seen_at, metadata
            FROM threat_indicators
            WHERE active = TRUE
            ORDER BY last_seen_at DESC
        `;
        const result = await this.query(sql);
        return result.rows;
    }

    /**
     * Import threat indicators from array of IP strings
     */
    async importIPBlacklist(ipList, sourceName = 'local-blacklist') {
        const client = await this.getClient();
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
    async upsertGrokConversation(conversation) {
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

        const result = await this.query(sql, params);
        return result.rows[0].id;
    }

    /**
     * Get all Grok conversations
     */
    async getAllGrokConversations() {
        const sql = `
            SELECT id, title, message_count, created_at, last_updated, last_scraped, metadata
            FROM grok_conversations
            ORDER BY last_updated DESC
        `;
        const result = await this.query(sql);
        return result.rows;
    }

    /**
     * Get a single Grok conversation by ID
     */
    async getGrokConversation(conversationId) {
        const sql = `
            SELECT id, title, message_count, created_at, last_updated, last_scraped, metadata
            FROM grok_conversations
            WHERE id = $1
        `;
        const result = await this.query(sql, [conversationId]);
        return result.rows[0] || null;
    }

    // ============================================================
    // Grok Messages
    // ============================================================

    /**
     * Save a single Grok message
     */
    async saveGrokMessage(message) {
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
            message.payload || message,
        ];

        const result = await this.query(sql, params);
        return result.rows[0].id;
    }

    /**
     * Batch save Grok messages
     */
    async saveGrokMessagesBatch(messages) {
        if (!messages || messages.length === 0) return [];

        const client = await this.getClient();
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
                    message.payload || message,
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
    async getGrokMessagesByConversation(conversationId, limit = 1000, offset = 0) {
        const sql = `
            SELECT id, conversation_id, content, author, timestamp, scraped_at, payload
            FROM grok_messages
            WHERE conversation_id = $1
            ORDER BY timestamp DESC
            LIMIT $2 OFFSET $3
        `;
        const result = await this.query(sql, [conversationId, limit, offset]);
        return result.rows;
    }

    /**
     * Get recent Grok messages
     */
    async getRecentGrokMessages(hours = 24, limit = 100) {
        const timeAgo = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
        const sql = `
            SELECT id, conversation_id, content, author, timestamp, scraped_at
            FROM grok_messages
            WHERE scraped_at > $1
            ORDER BY timestamp DESC
            LIMIT $2
        `;
        const result = await this.query(sql, [timeAgo, limit]);
        return result.rows;
    }

    /**
     * Search inside Grok message payload (JSONB)
     */
    async searchGrokMessages(query, limit = 100, offset = 0) {
        const sql = `
            SELECT id, conversation_id, content, author, timestamp, payload
            FROM grok_messages
            WHERE payload ILIKE $1 OR content ILIKE $1
            ORDER BY timestamp DESC
            LIMIT $2 OFFSET $3
        `;
        const result = await this.query(sql, [`%${query}%`, limit, offset]);
        return result.rows;
    }

    /**
     * Get Grok message count
     */
    async getGrokMessageCount(conversationId = null) {
        if (conversationId) {
            const result = await this.query(
                'SELECT COUNT(*) as count FROM grok_messages WHERE conversation_id = $1',
                [conversationId]
            );
            return parseInt(result.rows[0].count, 10);
        }

        const result = await this.query('SELECT COUNT(*) as count FROM grok_messages');
        return parseInt(result.rows[0].count, 10);
    }

    // ============================================================
    // Metadata
    // ============================================================

    async getMeta(key) {
        const sql = `SELECT value FROM database_meta WHERE key = $1`;
        const result = await this.query(sql, [key]);
        return result.rows[0]?.value ?? null;
    }

    async setMeta(key, value) {
        const sql = `
            INSERT INTO database_meta (key, value, updated_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (key) DO UPDATE SET
                value = EXCLUDED.value,
                updated_at = NOW()
        `;
        await this.query(sql, [key, value]);
    }

    // ============================================================
    // JSONL Import
    // ============================================================

    /**
     * Import a JSONL file into the database
     */
    async importJSONL(filePath, batchSize = 500) {
        const { readFileSync } = await import('fs');
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
                    await this.insertPacketEventsBatch(batch);
                    imported += batch.length;
                } catch (err) {
                    console.error(`[Database] Failed to import batch at line ${i}:`, err.message);
                    failed += batch.length;
                }
            }
        }

        // Record import metadata
        await this.setMeta('last_import_from_jsonl', {
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
    async importGrokIndexedDBExport(exportData) {
        if (!exportData || typeof exportData !== 'object') {
            throw new Error('Invalid export data format');
        }

        const conversations = exportData.conversations || [];
        const messages = exportData.messages || [];

        let importedConversations = 0;
        let importedMessages = 0;
        let failed = 0;

        // Import conversations first
        for (const conv of conversations) {
            try {
                await this.upsertGrokConversation({
                    id: conv.id,
                    title: conv.title,
                    message_count: conv.message_count || 0,
                    last_scraped: conv.last_scraped || conv.last_updated,
                    metadata: conv,
                });
                importedConversations++;
            } catch (err) {
                console.error(`[Database] Failed to import conversation ${conv.id}:`, err.message);
                failed++;
            }
        }

        // Import messages in batches
        const BATCH_SIZE = 500;
        for (let i = 0; i < messages.length; i += BATCH_SIZE) {
            const batch = messages.slice(i, i + BATCH_SIZE).map(msg => ({
                ...msg,
                payload: msg,
            }));

            try {
                await this.saveGrokMessagesBatch(batch);
                importedMessages += batch.length;
            } catch (err) {
                console.error(`[Database] Failed to import message batch at ${i}:`, err.message);
                failed += batch.length;
            }
        }

        // Record import metadata
        await this.setMeta('last_import_from_grok_indexeddb', {
            exportedAt: exportData.exportDate,
            importedConversations,
            importedMessages,
            failed,
            importedAt: new Date().toISOString(),
        });

        return {
            importedConversations,
            importedMessages,
            failed,
        };
    }

    // ============================================================
    // Health & Stats
    // ============================================================

    async getStats() {
        const packetCount = await this.query('SELECT COUNT(*) as count FROM network_packet_events');
        const threatCount = await this.query('SELECT COUNT(*) as count FROM threat_indicators WHERE active = TRUE');
        const blacklistedCount = await this.query('SELECT COUNT(*) as count FROM network_packet_events WHERE is_blacklisted = TRUE');
        const grokMessageCount = await this.query('SELECT COUNT(*) as count FROM grok_messages');
        const grokConversationCount = await this.query('SELECT COUNT(*) as count FROM grok_conversations');

        return {
            totalPackets: parseInt(packetCount.rows[0].count, 10),
            activeThreats: parseInt(threatCount.rows[0].count, 10),
            blacklistedPackets: parseInt(blacklistedCount.rows[0].count, 10),
            grokMessages: parseInt(grokMessageCount.rows[0].count, 10),
            grokConversations: parseInt(grokConversationCount.rows[0].count, 10),
            connected: this.connected,
        };
    }

    async healthCheck() {
        try {
            await this.query('SELECT 1');
            return { healthy: true };
        } catch (err) {
            return { healthy: false, error: err.message };
        }
    }
}

// ============================================================
// Singleton Export
// ============================================================
const databaseService = new DatabaseService();

export default databaseService;
export { DatabaseService };
