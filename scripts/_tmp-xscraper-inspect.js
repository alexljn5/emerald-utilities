/**
 * TEMPORARY read-only inspection of the XScraper pipeline endpoints.
 * Deleted after diagnosis. Does NOT modify anything.
 */
import path from 'path';
import { existsSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

async function inspectPostgres() {
    console.log('=== POSTGRES ===');
    const { pool, connectionInfo } = await import('../src/database/db-pool.js');
    console.log('target:', connectionInfo);

    const tables = ['grok_conversations', 'grok_messages', 'grok_raw_imports'];

    for (const t of tables) {
        const cols = await pool.query(
            `SELECT column_name, data_type, is_nullable, column_default
             FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`, [t]);
        if (cols.rows.length === 0) {
            console.log(`\n-- ${t}: DOES NOT EXIST`);
            continue;
        }
        console.log(`\n-- ${t} columns:`);
        for (const c of cols.rows) {
            console.log(`   ${c.column_name.padEnd(20)} ${c.data_type.padEnd(28)} null=${c.is_nullable} default=${c.column_default || ''}`);
        }
        const cons = await pool.query(
            `SELECT conname, pg_get_constraintdef(oid) AS def
             FROM pg_constraint WHERE conrelid = $1::regclass`, [t]);
        console.log(`-- ${t} constraints:`);
        for (const c of cons.rows) console.log(`   ${c.conname}: ${c.def}`);
        const idx = await pool.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1`, [t]);
        console.log(`-- ${t} indexes:`);
        for (const c of idx.rows) console.log(`   ${c.indexname}: ${c.indexdef}`);
    }

    const totals = await pool.query(`SELECT
        (SELECT COUNT(*) FROM grok_messages) AS messages,
        (SELECT COUNT(*) FROM grok_conversations) AS conversations`);
    console.log('\n-- totals:', totals.rows[0]);

    const perConv = await pool.query(
        `SELECT conversation_id, COUNT(*) AS n,
                MIN(timestamp) AS earliest, MAX(timestamp) AS latest
         FROM grok_messages GROUP BY conversation_id ORDER BY n DESC LIMIT 15`);
    console.log('\n-- messages per conversation (top 15):');
    for (const r of perConv.rows) {
        console.log(`   ${String(r.conversation_id).padEnd(42)} n=${String(r.n).padStart(6)} ${r.earliest?.toISOString?.() || r.earliest} .. ${r.latest?.toISOString?.() || r.latest}`);
    }

    const sample = await pool.query(
        `SELECT id, conversation_id, author, left(content, 60) AS snippet, timestamp, payload
         FROM grok_messages ORDER BY scraped_at DESC LIMIT 5`);
    console.log('\n-- sample newest rows:');
    for (const r of sample.rows) {
        console.log(`   id=${r.id} conv=${r.conversation_id} author=${r.author} payload=${JSON.stringify(r.payload)}`);
        console.log(`      "${(r.snippet || '').replace(/\s+/g, ' ')}"`);
    }

    // id shape analysis
    const shapes = await pool.query(
        `SELECT
            COUNT(*) FILTER (WHERE id LIKE 'm\\_%') AS content_hash_ids,
            COUNT(*) FILTER (WHERE id LIKE 'msg\\_%') AS msg_ids,
            COUNT(*) FILTER (WHERE id LIKE 'scraped\\_%') AS scraped_random_ids,
            COUNT(*) FILTER (WHERE id LIKE 'xs\\_%') AS canonical_ids,
            COUNT(*) AS total
         FROM grok_messages`);
    console.log('\n-- id shapes:', shapes.rows[0]);

    // duplicate content within conversation
    const dupes = await pool.query(
        `SELECT COUNT(*) AS dup_groups FROM (
            SELECT conversation_id, author, md5(content) FROM grok_messages
            GROUP BY 1,2,3 HAVING COUNT(*) > 1) x`);
    console.log('-- duplicate (conv,author,content) groups:', dupes.rows[0].dup_groups);

    await pool.end();
}

function inspectSqlite() {
    console.log('\n=== LOCAL SQLITE (XScraper server store) ===');
    const dbPath = path.join(process.env.APPDATA || process.env.HOME, '.xscraper', 'x_messages.db');
    console.log('path:', dbPath, 'exists:', existsSync(dbPath));
    if (!existsSync(dbPath)) return Promise.resolve();

    const sqlite3 = require('sqlite3');
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
    const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r || [])));

    return (async () => {
        const t = await all(`SELECT name, sql FROM sqlite_master WHERE type='table'`);
        for (const row of t) console.log(`\n-- table ${row.name}:\n${row.sql}`);
        const counts = await all(`SELECT COUNT(*) AS n FROM messages`);
        console.log('\n-- local messages:', counts[0].n);
        const perConv = await all(`SELECT conversation_id, COUNT(*) n, MIN(timestamp) a, MAX(timestamp) b
                                   FROM messages GROUP BY conversation_id ORDER BY n DESC LIMIT 15`);
        for (const r of perConv) console.log(`   ${String(r.conversation_id).padEnd(42)} n=${r.n} ${r.a} .. ${r.b}`);
        const sample = await all(`SELECT id, conversation_id, author, substr(content,1,60) c, timestamp, scraped_at
                                  FROM messages ORDER BY scraped_at DESC LIMIT 5`);
        console.log('\n-- sample local rows:');
        for (const r of sample) console.log(`   id=${r.id} conv=${r.conversation_id} author=${r.author} ts=${r.timestamp} scraped=${r.scraped_at}\n      "${(r.c || '').replace(/\s+/g, ' ')}"`);
        db.close();
    })();
}

(async () => {
    try { await inspectSqlite(); } catch (e) { console.error('sqlite inspect failed:', e.message); }
    try { await inspectPostgres(); } catch (e) { console.error('postgres inspect failed:', e.message); }
})();
