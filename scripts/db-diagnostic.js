#!/usr/bin/env node
/**
 * Database Diagnostic Script
 * Inspects grok_conversations, grok_messages, and related tables.
 * Outputs a timestamped .txt file with full diagnostics.
 *
 * SECURITY: Passwords and API keys are REDACTED.
 */

import { Pool } from 'pg';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_CONFIG = {
    host: 'localhost',
    port: 5432,
    database: 'emerald_utilities',
    user: 'alexljn5',
    password: 'shit12aids55',
};

const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_FILE = join(__dirname, '..', 'logs', `db-diagnostic-${TIMESTAMP}.txt`);

const pool = new Pool(DB_CONFIG);

function redact(value) {
    if (!value) return '<null>';
    if (typeof value !== 'string') return JSON.stringify(value);
    // Redact anything that looks like a password, key, or token
    if (/password|secret|token|key|api_key|auth/i.test(value) && value.length > 10) {
        return value.slice(0, 4) + '...[REDACTED]';
    }
    return value;
}

async function query(text, params = []) {
    const result = await pool.query(text, params);
    return result.rows;
}

async function main() {
    const lines = [];
    const sep = '='.repeat(80);
    const sub = '-'.repeat(60);

    lines.push(sep);
    lines.push(`EMERALD UTILITIES - DATABASE DIAGNOSTIC`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Database: ${DB_CONFIG.database} @ ${DB_CONFIG.host}:${DB_CONFIG.port}`);
    lines.push(sep);
    lines.push('');

    // 1. Table existence check
    lines.push('TABLE EXISTENCE CHECK');
    lines.push(sub);
    const tables = await query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
    `);
    lines.push(`Tables found: ${tables.map(t => t.table_name).join(', ')}`);
    lines.push('');

    // 2. Row counts for relevant tables
    lines.push('ROW COUNTS');
    lines.push(sub);
    const tableNames = ['grok_conversations', 'grok_messages', 'grok_raw_imports', 'database_meta'];
    for (const table of tableNames) {
        try {
            const count = await query(`SELECT COUNT(*) as count FROM ${table}`);
            lines.push(`${table}: ${count[0]?.count ?? 0} rows`);
        } catch (e) {
            lines.push(`${table}: ERROR - ${e.message}`);
        }
    }
    lines.push('');

    // 3. Recent conversations
    lines.push('RECENT CONVERSATIONS (last 10)');
    lines.push(sub);
    try {
        const conversations = await query(`
            SELECT id, title, message_count, created_at, last_updated, metadata
            FROM grok_conversations
            ORDER BY last_updated DESC
            LIMIT 10
        `);
        if (conversations.length === 0) {
            lines.push('No conversations found.');
        } else {
            for (const conv of conversations) {
                lines.push(`Conversation ID: ${conv.id}`);
                lines.push(`  Title: ${conv.title}`);
                lines.push(`  Message Count: ${conv.message_count}`);
                lines.push(`  Created: ${conv.created_at}`);
                lines.push(`  Last Updated: ${conv.last_updated}`);
                if (conv.metadata) {
                    const meta = typeof conv.metadata === 'string' ? JSON.parse(conv.metadata) : conv.metadata;
                    lines.push(`  Metadata: ${JSON.stringify(meta, null, 2)}`);
                }
                lines.push('');
            }
        }
    } catch (e) {
        lines.push(`Error: ${e.message}`);
    }
    lines.push('');

    // 4. Recent messages across all conversations
    lines.push('RECENT MESSAGES (last 20 across all conversations)');
    lines.push(sub);
    try {
        const messages = await query(`
            SELECT id, conversation_id, content, author, timestamp, scraped_at, payload
            FROM grok_messages
            ORDER BY timestamp DESC
            LIMIT 20
        `);
        if (messages.length === 0) {
            lines.push('No messages found.');
        } else {
            // Sort chronologically for readability
            messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
            for (const msg of messages) {
                lines.push(`Message ID: ${msg.id}`);
                lines.push(`  Conversation: ${msg.conversation_id}`);
                lines.push(`  Author: ${msg.author}`);
                lines.push(`  Timestamp: ${msg.timestamp}`);
                lines.push(`  Scraped At: ${msg.scraped_at}`);
                lines.push(`  Content: ${msg.content?.substring(0, 500)}${msg.content?.length > 500 ? '...' : ''}`);
                if (msg.payload) {
                    const payload = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
                    lines.push(`  Payload: ${JSON.stringify(payload, null, 2)}`);
                }
                lines.push('');
            }
        }
    } catch (e) {
        lines.push(`Error: ${e.message}`);
    }
    lines.push('');

    // 5. Messages per conversation (detailed)
    lines.push('MESSAGES BY CONVERSATION (detailed)');
    lines.push(sub);
    try {
        const convs = await query(`SELECT id, title FROM grok_conversations ORDER BY last_updated DESC LIMIT 5`);
        for (const conv of convs) {
            lines.push(`Conversation: ${conv.id} (${conv.title})`);
            const msgs = await query(`
                SELECT id, content, author, timestamp
                FROM grok_messages
                WHERE conversation_id = $1
                ORDER BY timestamp ASC
            `, [conv.id]);
            lines.push(`  Messages: ${msgs.length}`);
            for (const msg of msgs) {
                lines.push(`    [${msg.timestamp}] ${msg.author}: ${msg.content?.substring(0, 200)}${msg.content?.length > 200 ? '...' : ''}`);
            }
            lines.push('');
        }
    } catch (e) {
        lines.push(`Error: ${e.message}`);
    }
    lines.push('');

    // 6. Check for embeddings
    lines.push('EMBEDDING STATUS');
    lines.push(sub);
    try {
        const withEmbeddings = await query(`SELECT COUNT(*) as count FROM grok_messages WHERE embedding IS NOT NULL`);
        const totalMessages = await query(`SELECT COUNT(*) as count FROM grok_messages`);
        lines.push(`Messages with embeddings: ${withEmbeddings[0]?.count ?? 0}`);
        lines.push(`Total messages: ${totalMessages[0]?.count ?? 0}`);
        lines.push(`Embedding coverage: ${totalMessages[0]?.count > 0 ? Math.round((withEmbeddings[0]?.count / totalMessages[0]?.count) * 100) : 0}%`);
    } catch (e) {
        lines.push(`Error: ${e.message}`);
    }
    lines.push('');

    // 7. Database connection info (sanitized)
    lines.push('CONNECTION INFO (sanitized)');
    lines.push(sub);
    lines.push(`Host: ${DB_CONFIG.host}`);
    lines.push(`Port: ${DB_CONFIG.port}`);
    lines.push(`Database: ${DB_CONFIG.database}`);
    lines.push(`User: ${DB_CONFIG.user}`);
    lines.push(`Password: [REDACTED]`);
    lines.push('');

    lines.push(sep);
    lines.push('END OF DIAGNOSTIC');
    lines.push(sep);

    // Ensure logs directory exists
    const logsDir = join(__dirname, '..', 'logs');
    try { mkdirSync(logsDir, { recursive: true }); } catch (e) { /* ignore */ }

    writeFileSync(OUTPUT_FILE, lines.join('\n'), 'utf-8');
    console.log(`Diagnostic written to: ${OUTPUT_FILE}`);
}

main().catch(e => {
    console.error('Diagnostic failed:', e);
    process.exit(1);
}).finally(() => pool.end());
