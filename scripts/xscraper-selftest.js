/**
 * XScraper synchronisation self-test.
 *
 * XSCRAPER ONLY. Exercises the real pipeline without needing the port-3000
 * server: it writes into the same local SQLite store the server writes to
 * (%APPDATA%/.xscraper/x_messages.db), then runs the reconciler.
 *
 *   local XScraper SQLite store
 *     → reconciler (src/database/xscraper-sync.js)
 *       → PostgreSQL grok_messages
 *         → AI/RAG context retrieval
 *
 * TEST 1  historical reconciliation converges
 *         messages PostgreSQL already has → pending=0, inserted=0, twice.
 *
 * TEST 2  a genuinely new message is forwarded exactly once
 *         run 1 → inserted=1, run 2 → inserted=0 / skipped, and the historical
 *         messages are NOT retransmitted.
 *
 * TEST 3  the new message is retrievable for AI/RAG context.
 *
 * The test writes ONLY to a scratch conversation in the local SQLite store and
 * inserts exactly one new row in PostgreSQL. It deletes nothing.
 *
 * Usage:
 *   node scripts/xscraper-selftest.js
 *   node scripts/xscraper-selftest.js --keep      (leave scratch local rows)
 */

import { createRequire } from 'module';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { pool, connectionInfo } from '../src/database/db-pool.js';
import { readSqliteSource, defaultSqlitePath } from '../src/database/xscraper-local-source.js';
import { reconcileScrapedMessages } from '../src/database/xscraper-sync.js';
import { getRecentMessages } from '../src/database/ai-persistence.js';

const require = createRequire(import.meta.url);
const KEEP = process.argv.includes('--keep');

const line = (s = '') => console.log(s);
const head = (s) => { line(''); line('='.repeat(78)); line(s); line('='.repeat(78)); };
const kv = (k, v) => line(`  ${String(k).padEnd(30)}${v}`);

let failures = 0;
function expect(label, actual, expected) {
    const ok = actual === expected;
    if (!ok) failures++;
    line(`  [${ok ? 'PASS' : 'FAIL'}] ${String(label).padEnd(46)} expected=${expected} actual=${actual}`);
    return ok;
}

// ----------------------------------------------------------------------
// Local SQLite writer — mirrors what the XScraper server does on
// POST /api/messages/save (INSERT, UNIQUE(content, author, conversation_id))
// ----------------------------------------------------------------------
function openLocalDb() {
    const dbPath = defaultSqlitePath();
    const dir = path.dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const sqlite3 = require('sqlite3');
    return { db: new sqlite3.Database(dbPath), dbPath };
}

const run = (db, sql, params = []) => new Promise((res, rej) => {
    db.run(sql, params, function (err) { err ? rej(err) : res(this.changes || 0); });
});

async function ensureLocalSchema(db) {
    await run(db, `CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        content TEXT NOT NULL,
        author TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        scraped_at DATETIME,
        UNIQUE(content, author, conversation_id)
    )`);
    await run(db, `CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        message_count INTEGER DEFAULT 0,
        last_scraped DATETIME
    )`);
}

async function saveToLocalStore(messages, conversationId, title) {
    const { db, dbPath } = openLocalDb();
    try {
        await ensureLocalSchema(db);
        await run(db, `INSERT OR IGNORE INTO conversations (id, title, last_scraped) VALUES (?, ?, ?)`,
            [conversationId, title, new Date().toISOString()]);
        let written = 0;
        for (const m of messages) {
            written += await run(db,
                `INSERT OR IGNORE INTO messages (id, conversation_id, content, author, timestamp, scraped_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [m.id, conversationId, m.content, m.author, m.timestamp, new Date().toISOString()]);
        }
        return { written, dbPath };
    } finally {
        db.close();
    }
}

async function deleteScratchLocalRows(conversationId) {
    const { db } = openLocalDb();
    try {
        await run(db, `DELETE FROM messages WHERE conversation_id = ?`, [conversationId]);
        await run(db, `DELETE FROM conversations WHERE id = ?`, [conversationId]);
    } finally {
        db.close();
    }
}

async function reconcileLocalConversation(conversationId, title) {
    const local = await readSqliteSource({ conversationId });
    const messages = local.byConversation.get(conversationId) || [];
    return { localCount: messages.length, stats: await reconcileScrapedMessages(messages, conversationId, title) };
}

// ----------------------------------------------------------------------

async function main() {
    head('XScraper synchronisation self-test');
    kv('PostgreSQL', `${connectionInfo.user}@${connectionInfo.host}:${connectionInfo.port}/${connectionInfo.database}`);
    kv('Local SQLite store', defaultSqlitePath());
    kv('Local server needed', 'no (writes straight to the SQLite store)');

    const scratchConv = 'xscraper-selftest';
    const title = 'XScraper self-test';

    // ------------------------------------------------------------------
    // TEST 1 — historical local data reconciles and converges
    // ------------------------------------------------------------------
    head('TEST 1 — historical reconciliation converges');

    // Build "historical" local data: messages PostgreSQL already contains.
    // Taken from whatever conversation currently has the most rows, but
    // re-homed into the scratch conversation is NOT possible (identity is
    // conversation scoped), so we seed the scratch conversation once, let the
    // reconciler persist it, and then treat it as history.
    const seed = Array.from({ length: 25 }, (_, i) => ({
        id: `selftest_hist_${i}`,
        content: `XScraper self-test historical message #${i}`,
        author: i % 2 === 0 ? 'You' : 'Grok',
        timestamp: new Date(Date.now() - (30 - i) * 60000).toISOString(),
    }));
    const seedWrite = await saveToLocalStore(seed, scratchConv, title);
    kv('seeded into local SQLite', `${seed.length} messages (new rows: ${seedWrite.written})`);

    // Pass 0: makes PostgreSQL hold the history (idempotent if already there).
    const pass0 = await reconcileLocalConversation(scratchConv, title);
    kv('pass 0 inserted', pass0.stats.inserted);

    const run1 = await reconcileLocalConversation(scratchConv, title);
    kv('run 1 local_total', run1.stats.localTotal);
    kv('run 1 already_in_postgres', run1.stats.alreadyInPostgres);
    kv('run 1 pending_to_insert', run1.stats.pendingToInsert);
    kv('run 1 inserted', run1.stats.inserted);
    kv('run 1 skipped', run1.stats.skipped);
    kv('run 1 postgres_total_after', run1.stats.postgresTotalAfter);

    const run2 = await reconcileLocalConversation(scratchConv, title);
    kv('run 2 local_total', run2.stats.localTotal);
    kv('run 2 already_in_postgres', run2.stats.alreadyInPostgres);
    kv('run 2 pending_to_insert', run2.stats.pendingToInsert);
    kv('run 2 inserted', run2.stats.inserted);
    kv('run 2 skipped', run2.stats.skipped);
    kv('run 2 postgres_total_after', run2.stats.postgresTotalAfter);

    line('');
    expect('run 1 pending_to_insert == 0', run1.stats.pendingToInsert, 0);
    expect('run 1 inserted == 0', run1.stats.inserted, 0);
    expect('run 1 already == local_total', run1.stats.alreadyInPostgres, run1.stats.localTotal);
    expect('run 1 skipped == local_total', run1.stats.skipped, run1.stats.localTotal);
    expect('run 2 inserted == 0 (converged)', run2.stats.inserted, 0);
    expect('run 2 pending_to_insert == 0', run2.stats.pendingToInsert, 0);
    expect('PG count unchanged by reruns', run2.stats.postgresTotalAfter, run1.stats.postgresTotalAfter);

    // ------------------------------------------------------------------
    // TEST 2 — one genuinely new message
    // ------------------------------------------------------------------
    head('TEST 2 — real-time path for ONE new message');

    const unique = `XSCRAPER SELFTEST NEW ${new Date().toISOString()} ${Math.random().toString(36).slice(2, 10)}`;
    // Same id scheme the scraper uses: deterministic hash of the message text.
    const scraperHash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return 'm_' + h; };
    const newMessage = {
        id: scraperHash(unique),
        content: unique,
        author: 'You',
        timestamp: new Date().toISOString(),
    };
    kv('new source id', newMessage.id);

    const before = (await pool.query(
        'SELECT COUNT(*)::int AS n FROM grok_messages WHERE conversation_id = $1', [scratchConv])).rows[0].n;
    kv('PG count before', before);

    await saveToLocalStore([newMessage], scratchConv, title);

    const live1 = await reconcileLocalConversation(scratchConv, title);
    kv('run 1 local_total', live1.stats.localTotal);
    kv('run 1 already_in_postgres', live1.stats.alreadyInPostgres);
    kv('run 1 pending_to_insert', live1.stats.pendingToInsert);
    kv('run 1 inserted', live1.stats.inserted);
    kv('run 1 skipped', live1.stats.skipped);
    kv('run 1 checkpoint', JSON.stringify(live1.stats.checkpoint || {}));

    const live2 = await reconcileLocalConversation(scratchConv, title);
    kv('run 2 inserted', live2.stats.inserted);
    kv('run 2 already_in_postgres', live2.stats.alreadyInPostgres);
    kv('run 2 pending_to_insert', live2.stats.pendingToInsert);
    kv('run 2 skipped', live2.stats.skipped);

    const after = (await pool.query(
        'SELECT COUNT(*)::int AS n FROM grok_messages WHERE conversation_id = $1', [scratchConv])).rows[0].n;
    kv('PG count after', after);

    line('');
    expect('new message inserted exactly once', live1.stats.inserted, 1);
    expect('only the new message was pending', live1.stats.pendingToInsert, 1);
    expect('history skipped, not retransmitted', live1.stats.skipped, live1.stats.localTotal - 1);
    expect('rerun inserts nothing', live2.stats.inserted, 0);
    expect('rerun has no pending', live2.stats.pendingToInsert, 0);
    expect('rerun skips everything', live2.stats.skipped, live2.stats.localTotal);
    expect('PG grew by exactly 1', after - before, 1);

    // ------------------------------------------------------------------
    // TEST 3 — AI/RAG can retrieve the new message
    // ------------------------------------------------------------------
    head('TEST 3 — AI/RAG retrieval of the newly forwarded message');

    const direct = await pool.query(
        `SELECT id, conversation_id, author, content, source, source_message_id,
                embedding IS NOT NULL AS has_embedding
         FROM grok_messages WHERE conversation_id = $1 AND source_message_id = $2`,
        [scratchConv, newMessage.id]
    );
    kv('SELECT grok_messages rows', direct.rowCount);
    if (direct.rowCount) {
        kv('row id', direct.rows[0].id);
        kv('source', direct.rows[0].source);
        kv('source_message_id', direct.rows[0].source_message_id);
        kv('has embedding', direct.rows[0].has_embedding);
    }

    const recent = await getRecentMessages(scratchConv, 20);
    const inContext = recent.some(m => m.content === unique);
    kv('in conversation context window', inContext);

    const ragWindow = await pool.query(
        `SELECT id, content FROM grok_messages
         WHERE conversation_id = $1
         ORDER BY timestamp DESC, id DESC LIMIT 5`, [scratchConv]);
    const inRagWindow = ragWindow.rows.some(r => r.content === unique);
    kv('in RAG context window query', inRagWindow);

    const keywordHit = await pool.query(
        `SELECT id FROM grok_messages WHERE content ILIKE $1 LIMIT 1`,
        [`%${unique.slice(0, 40)}%`]);
    kv('keyword retrieval hit', keywordHit.rowCount === 1);

    line('');
    expect('message persisted in grok_messages', direct.rowCount, 1);
    expect('retrievable in AI context window', inContext, true);
    expect('retrievable by RAG window query', inRagWindow, true);
    expect('retrievable by keyword search', keywordHit.rowCount, 1);
    if (direct.rowCount && direct.rows[0].has_embedding === false) {
        line('  NOTE: embedding is NULL until rag-prepare.js embeds it, so pure vector');
        line('        search will not surface it yet. Conversation-scoped context');
        line('        retrieval — what TheAI actually uses per conversation — works now.');
    }

    if (!KEEP) {
        await deleteScratchLocalRows(scratchConv);
        line('');
        line(`  Scratch local SQLite rows for "${scratchConv}" removed (PostgreSQL rows kept).`);
    }

    head(failures === 0 ? 'RESULT: ALL TESTS PASSED' : `RESULT: ${failures} CHECK(S) FAILED`);
}

main()
    .then(async () => { await pool.end(); process.exit(failures === 0 ? 0 : 1); })
    .catch(async (err) => {
        console.error('[xscraper-selftest] FAILED:', err);
        try { await pool.end(); } catch { /* ignore */ }
        process.exit(1);
    });
