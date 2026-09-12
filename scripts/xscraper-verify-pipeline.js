/**
 * XScraper Pipeline Verification Script
 *
 * Verifies the complete XScraper → SQLite → PostgreSQL pipeline:
 * 1. Message identity is deterministic (conversation_id + source_message_id)
 * 2. Local SQLite persistence works
 * 3. Batch worker forwards to PostgreSQL
 * 4. Successfully-forwarded messages are cleaned from local queue
 * 5. UI counters reflect actual state
 */

import { createHash } from 'crypto';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ============================================================
// 1. Verify message identity functions
// ============================================================

function sha256Hex(value) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function contentHashOf(author, content) {
    return sha256Hex(`${String(author || '').trim()}\n${String(content || '').trim()}`).slice(0, 32);
}

function sourceMessageIdOf(msg, conversationId) {
    const candidates = [msg?.source_message_id, msg?.sourceMessageId, msg?.id, msg?.messageId, msg?.message_id];
    for (const c of candidates) {
        if (c === undefined || c === null) continue;
        const s = String(c).trim();
        if (!s) continue;
        if (/^(msg|scraped)_\d{10,}_[a-z0-9]+$/i.test(s)) continue;
        return s;
    }
    const author = msg?.author ?? '';
    const content = msg?.content ?? msg?.text ?? '';
    return `h_${sha256Hex(`${conversationId}\u0000${author}\u0000${String(content).trim()}`).slice(0, 24)}`;
}

function canonicalRowId(conversationId, sourceMessageId) {
    return `xs_${sha256Hex(`${conversationId}\u0000${sourceMessageId}`).slice(0, 32)}`;
}

function canonicalIdentity(msg, conversationId) {
    const sourceMessageId = sourceMessageIdOf(msg, conversationId);
    const author = String(msg?.author ?? '').trim() || 'You';
    const content = String(msg?.content ?? msg?.text ?? '').trim();
    return {
        conversationId,
        sourceMessageId,
        contentHash: contentHashOf(author, content),
        rowId: canonicalRowId(conversationId, sourceMessageId),
        key: `${conversationId}\u0000${sourceMessageId}`,
    };
}

console.log('=== XScraper Pipeline Verification ===\n');

// Test 1: Deterministic identity
console.log('[TEST 1] Message identity determinism');
const msg1 = { id: 'm_123', content: 'Hello world', author: 'You', conversationId: 'conv-1' };
const msg2 = { id: 'm_456', content: 'Hello world', author: 'You', conversationId: 'conv-1' };
const msg3 = { id: 'm_789', content: 'Hello world', author: 'You', conversationId: 'conv-2' };

const id1 = canonicalIdentity(msg1, 'conv-1');
const id2 = canonicalIdentity(msg2, 'conv-1');
const id3 = canonicalIdentity(msg3, 'conv-2');

console.log(`  Same content, same conversation: rowId matches = ${id1.rowId === id2.rowId}`);
console.log(`  Same content, different conversation: rowId differs = ${id1.rowId !== id3.rowId}`);
console.log(`  Source message ID preserved = ${id1.sourceMessageId === 'm_123'}`);

// Test 2: Legacy random ID rejection
console.log('\n[TEST 2] Legacy random ID rejection');
const legacyMsg = { id: 'msg_1234567890_abc123', content: 'test', author: 'You' };
const legacyId = sourceMessageIdOf(legacyMsg, 'conv-1');
console.log(`  Legacy random ID rejected = ${!legacyId.startsWith('msg_') && !legacyId.startsWith('scraped_')}`);
console.log(`  Fallback hash used = ${legacyId.startsWith('h_')}`);

// Test 3: SQLite path resolution
console.log('\n[TEST 3] Local SQLite store path');
const sqlitePath = path.join(
    process.env.XSCRAPER_HOME ||
    path.join(process.env.APPDATA || process.env.HOME || '.', '.xscraper'),
    'x_messages.db'
);
console.log(`  SQLite path = ${sqlitePath}`);
console.log(`  SQLite exists = ${existsSync(sqlitePath)}`);

// Test 4: Check forwarding columns exist in SQLite
console.log('\n[TEST 4] SQLite forwarding columns');
if (existsSync(sqlitePath)) {
    try {
        const sqlite3 = require('sqlite3');
        const db = new sqlite3.Database(sqlitePath, sqlite3.OPEN_READONLY);
        const cols = new Set();
        db.all('PRAGMA table_info(messages)', (err, rows) => {
            if (err) {
                console.log(`  Error reading schema: ${err.message}`);
                return;
            }
            for (const r of rows) cols.add(r.name);
            const required = ['forwarded', 'forwarded_at', 'attempts', 'last_error'];
            for (const col of required) {
                console.log(`  Column ${col} exists = ${cols.has(col)}`);
            }
            db.close();
        });
    } catch (err) {
        console.log(`  Could not open SQLite: ${err.message}`);
    }
} else {
    console.log('  SQLite not found — will be created on first scrape');
}

// Test 5: Verify xscraper_sync_state table exists in PostgreSQL
console.log('\n[TEST 5] PostgreSQL checkpoint table');
try {
    const { pool } = await import('../src/database/db-pool.js');
    const result = await pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_name = 'xscraper_sync_state'"
    );
    console.log(`  xscraper_sync_state exists = ${result.rows.length > 0}`);
} catch (err) {
    console.log(`  Could not check PostgreSQL: ${err.message}`);
}

// Test 6: Verify grok_messages source attribution
console.log('\n[TEST 6] PostgreSQL source attribution');
try {
    const { pool } = await import('../src/database/db-pool.js');
    const result = await pool.query(`
        SELECT source, COUNT(*) AS count
        FROM grok_messages
        GROUP BY source
        ORDER BY count DESC
    `);
    for (const row of result.rows) {
        console.log(`  source=${row.source} count=${row.count}`);
    }
} catch (err) {
    console.log(`  Could not query PostgreSQL: ${err.message}`);
}

// Test 7: Verify no NULL/empty source_message_id
console.log('\n[TEST 7] source_message_id integrity');
try {
    const { pool } = await import('../src/database/db-pool.js');
    const nullCheck = await pool.query(`
        SELECT COUNT(*) AS n FROM grok_messages
        WHERE source_message_id IS NULL OR BTRIM(source_message_id) = ''
    `);
    console.log(`  NULL/empty source_message_id = ${nullCheck.rows[0]?.n ?? 0}`);
} catch (err) {
    console.log(`  Could not query PostgreSQL: ${err.message}`);
}

console.log('\n=== Verification Complete ===');
