/**
 * SQLite Database Manager
 * Handles all database operations for XScraper message storage
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

class XScraperDatabase {
    constructor(dbPath) {
        this.dbPath = dbPath;
        this.db = null;
        this.initialized = false;
    }

    /**
     * Initialize database connection and create tables
     */
    async initialize() {
        return new Promise((resolve, reject) => {
            // Ensure directory exists
            const dir = path.dirname(this.dbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    console.error('Database connection error:', err);
                    reject(err);
                } else {
                    console.log(`Connected to SQLite database at ${this.dbPath}`);
                    this.createTables()
                        .then(() => this.ensureForwardingColumns())
                        .then(() => {
                            this.initialized = true;
                            resolve();
                        })
                        .catch(reject);
                }
            });
        });
    }

    /**
     * Create database tables if they don't exist
     */
    async createTables() {
        const queries = [
            // Messages table
            // NOTE: `forwarded` / `forwarded_at` / `attempts` / `last_error`
            // are the durable forwarding-queue columns the batch worker
            // (xscraper-forwarder.js) reads and writes. They MUST exist here,
            // otherwise the INSERT in saveMessages below throws
            // "no such column: forwarded" and every extension POST is dropped
            // before it ever reaches the worker — which is exactly the
            // "scrapes but never inserts into PostgreSQL" bug.
            `CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                content TEXT NOT NULL,
                author TEXT NOT NULL,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                scraped_at DATETIME,
                forwarded INTEGER DEFAULT 0,
                forwarded_at DATETIME,
                attempts INTEGER DEFAULT 0,
                last_error TEXT,
                UNIQUE(content, author, conversation_id)
            )`,

            // Conversations table
            `CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
                message_count INTEGER DEFAULT 0,
                last_scraped DATETIME
            )`,

            // Scrape logs table
            `CREATE TABLE IF NOT EXISTS scrape_logs (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                messages_found INTEGER,
                new_messages INTEGER,
                duplicates INTEGER,
                scrape_time INTEGER,
                status TEXT,
                error_message TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(conversation_id) REFERENCES conversations(id)
            )`,

            // Create indices for performance
            `CREATE INDEX IF NOT EXISTS idx_messages_conversation_id 
                ON messages(conversation_id)`,
            `CREATE INDEX IF NOT EXISTS idx_messages_author 
                ON messages(author)`,
            `CREATE INDEX IF NOT EXISTS idx_messages_created_at 
                ON messages(created_at)`,
            `CREATE INDEX IF NOT EXISTS idx_scrape_logs_conversation 
                ON scrape_logs(conversation_id)`,
            `CREATE INDEX IF NOT EXISTS idx_scrape_logs_created_at 
                ON scrape_logs(created_at)`
        ];

        for (const query of queries) {
            await this.run(query);
        }

        console.log('Database tables initialized successfully');
    }

    /**
     * Ensure the durable forwarding-queue columns exist on the `messages`
     * table. `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so
     * databases created before the forwarding worker must be migrated here.
     *
     * Idempotent: each column is only added if it is missing. Non-destructive:
     * existing rows are untouched (they default to forwarded=0 / attempts=0,
     * i.e. pending — which is exactly what we want for un-forwarded history).
     */
    async ensureForwardingColumns() {
        const check = () => new Promise((resolve, reject) => {
            this.db.all('PRAGMA table_info(messages)', (err, rows) => {
                if (err) reject(err);
                else resolve(new Set((rows || []).map(r => r.name)));
            });
        });

        try {
            const cols = await check();
            const want = [
                ['forwarded', 'INTEGER DEFAULT 0'],
                ['forwarded_at', 'DATETIME'],
                ['attempts', 'INTEGER DEFAULT 0'],
                ['last_error', 'TEXT'],
            ];

            for (const [name, def] of want) {
                // Re-check each iteration: ALTER TABLE changes the schema.
                if (cols.has(name)) {
                    console.log(`[XScraper DB] column messages.${name} already exists`);
                    continue;
                }
                try {
                    await this.run(`ALTER TABLE messages ADD COLUMN ${name} ${def}`);
                    cols.add(name);
                    console.log(`[XScraper DB] added messages.${name} ${def}`);
                } catch (err) {
                    // Race: another connection added it between check and alter.
                    if (String(err.message).includes('duplicate column')) {
                        cols.add(name);
                    } else {
                        throw err;
                    }
                }
            }
        } catch (err) {
            console.warn('[XScraper DB] ensureForwardingColumns warning:', err.message);
        }
        console.log('[XScraper DB] forwarding columns ensured');
    }

    /**
     * Execute SQL query
     */
    async run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, (err) => {
                if (err) {
                    console.error('SQL Error:', err, 'Query:', sql);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * Execute SELECT query
     */
    async get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) {
                    console.error('SQL Error:', err, 'Query:', sql);
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });
    }

    /**
     * Execute SELECT query returning all rows
     */
    async all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    console.error('SQL Error:', err, 'Query:', sql);
                    reject(err);
                } else {
                    resolve(rows || []);
                }
            });
        });
    }

    /**
         * Save messages to database
         */
    async saveMessages(messages, conversationId, conversationTitle) {
        const startTime = Date.now();
        let newCount = 0;
        let duplicateCount = 0;

        try {
            // Ensure conversation exists
            await this.upsertConversation(conversationId, conversationTitle);
            console.log(`[XScraper DB] saveMessages: conversation=${conversationId} batch=${Array.isArray(messages) ? messages.length : 0}`);

            // Insert messages
            for (const message of messages) {
                try {
                    await this.run(
                        `INSERT INTO messages 
                            (id, conversation_id, content, author, timestamp, scraped_at, forwarded) 
                         VALUES (?, ?, ?, ?, ?, ?, 0)`,
                        [
                            message.id || uuidv4(),
                            conversationId,
                            message.content,
                            message.author,
                            message.timestamp || new Date().toISOString(),
                            new Date().toISOString()
                        ]
                    );
                    newCount++;
                } catch (err) {
                    if (err.message.includes('UNIQUE constraint failed')) {
                        duplicateCount++;
                    } else {
                        console.error(`[XScraper DB] INSERT failed for message ${message.id}: ${err.message}`);
                        throw err;
                    }
                }
            }

            // Update conversation
            await this.updateConversationStats(conversationId);

            // Log scrape
            const scrapeTime = Date.now() - startTime;
            await this.logScrape(conversationId, messages.length, newCount, duplicateCount, scrapeTime, 'success');

            console.log(`[XScraper DB] saveMessages: conversation=${conversationId} new=${newCount} dup=${duplicateCount} total=${messages.length}`);
            return {
                success: true,
                newMessages: newCount,
                duplicates: duplicateCount,
                totalMessages: messages.length,
                scrapeTime
            };
        } catch (error) {
            console.error(`[XScraper DB] Error saving messages conversation=${conversationId}:`, error.message);
            await this.logScrape(conversationId, messages.length, newCount, duplicateCount, Date.now() - startTime, 'error', error.message);
            return {
                success: false,
                error: error.message,
                newMessages: newCount,
                duplicates: duplicateCount
            };
        }
    }

    /**
     * Upsert conversation (create or update)
     */
    async upsertConversation(conversationId, title) {
        const existing = await this.get(
            'SELECT id FROM conversations WHERE id = ?',
            [conversationId]
        );

        if (!existing) {
            await this.run(
                `INSERT INTO conversations (id, title, last_scraped) VALUES (?, ?, ?)`,
                [conversationId, title || 'Untitled', new Date().toISOString()]
            );
        } else {
            await this.run(
                `UPDATE conversations SET title = ?, last_scraped = ? WHERE id = ?`,
                [title || 'Untitled', new Date().toISOString(), conversationId]
            );
        }
    }

    /**
     * Update conversation message count
     */
    async updateConversationStats(conversationId) {
        await this.run(
            `UPDATE conversations 
             SET message_count = (SELECT COUNT(*) FROM messages WHERE conversation_id = ?),
                 last_updated = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [conversationId, conversationId]
        );
    }

    /**
     * Log scrape event
     */
    async logScrape(conversationId, totalFound, newMessages, duplicates, scrapeTime, status, errorMessage = null) {
        await this.run(
            `INSERT INTO scrape_logs 
                (id, conversation_id, messages_found, new_messages, duplicates, scrape_time, status, error_message) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [uuidv4(),
                conversationId,
                totalFound,
                newMessages,
                duplicates,
                scrapeTime,
                status,
                errorMessage
            ]
        );
    }

    /**
     * Get all conversations
     */
    async getAllConversations() {
        return this.all(
            `SELECT id, title, message_count, created_at, last_updated, last_scraped 
             FROM conversations 
             ORDER BY last_updated DESC`
        );
    }

    /**
     * Get messages by conversation
     */
    async getMessagesByConversation(conversationId, limit = 1000, offset = 0) {
        return this.all(
            `SELECT id, content, author, timestamp, scraped_at 
             FROM messages 
             WHERE conversation_id = ?
             ORDER BY timestamp DESC 
             LIMIT ? OFFSET ?`,
            [conversationId, limit, offset]
        );
    }

    /**
     * Get recent messages
     */
    async getRecentMessages(hours = 24, limit = 100) {
        const timeAgo = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
        return this.all(
            `SELECT id, content, author, timestamp, conversation_id
             FROM messages
             WHERE scraped_at > ?
             ORDER BY timestamp DESC
             LIMIT ?`,
            [timeAgo, limit]
        );
    }

    /**
     * Get messages since a given timestamp (for real-time forwarding)
     */
    async getMessagesSince(sinceTimestamp, conversationId = null) {
        const sinceDate = new Date(sinceTimestamp).toISOString();
        let query = `SELECT id, content, author, timestamp, conversation_id, scraped_at
                     FROM messages
                     WHERE scraped_at > ?`;
        const params = [sinceDate];

        if (conversationId) {
            query += ` AND conversation_id = ?`;
            params.push(conversationId);
        }

        query += ` ORDER BY timestamp ASC`;

        return this.all(query, params);
    }

    /**
     * Get duplicate detection (for auto-sync)
     */
    async checkDuplicates(conversationId, messageContents) {
        const placeholders = messageContents.map(() => '?').join(',');
        const existing = await this.all(
            `SELECT content FROM messages 
             WHERE conversation_id = ? AND content IN (${placeholders})`,
            [conversationId, ...messageContents]
        );
        return existing.map(m => m.content);
    }

    /**
     * Export all messages as JSON
     */
    async exportAsJSON(conversationId = null) {
        let messages;
        if (conversationId) {
            messages = await this.all(
                `SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp`,
                [conversationId]
            );
        } else {
            messages = await this.all('SELECT * FROM messages ORDER BY timestamp');
        }

        const conversations = await this.all('SELECT * FROM conversations ORDER BY last_updated DESC');

        return {
            version: '1.0',
            exportDate: new Date().toISOString(),
            totalMessages: messages.length,
            totalConversations: conversations.length,
            conversations,
            messages
        };
    }

    /**
     * Get database stats
     */
    async getStats() {
        const messageCount = await this.get('SELECT COUNT(*) as count FROM messages');
        const conversationCount = await this.get('SELECT COUNT(*) as count FROM conversations');
        const recentScraped = await this.get(
            `SELECT created_at FROM scrape_logs ORDER BY created_at DESC LIMIT 1`
        );

        return {
            totalMessages: messageCount?.count || 0,
            totalConversations: conversationCount?.count || 0,
            lastScrapeTime: recentScraped?.created_at || null,
            databasePath: this.dbPath
        };
    }

    /**
     * Clear old data (optional maintenance)
     */
    async clearOldData(daysOld = 90) {
        const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
        await this.run(
            `DELETE FROM messages WHERE created_at < ? AND id NOT IN 
             (SELECT id FROM messages ORDER BY created_at DESC LIMIT 10000)`,
            [cutoffDate]
        );
        console.log(`Cleaned up messages older than ${daysOld} days`);
    }

    /**
     * Close database connection
     */
    async close() {
        return new Promise((resolve, reject) => {
            if (this.db) {
                this.db.close((err) => {
                    if (err) reject(err);
                    else {
                        console.log('Database connection closed');
                        resolve();
                    }
                });
            } else {
                resolve();
            }
        });
    }
}

module.exports = XScraperDatabase;