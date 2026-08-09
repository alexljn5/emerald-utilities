/**
 * Apply the XScraper identity migration (005) to the remote PostgreSQL server.
 *
 * XSCRAPER ONLY — this applies exactly one migration file and nothing else.
 * The migration is additive and idempotent (IF NOT EXISTS / backfill of NULLs),
 * so running it twice is safe.
 *
 * Usage:
 *   node scripts/xscraper-migrate.js
 */

import { readFile } from 'fs/promises';
import path from 'path';
import { pool, connectionInfo } from '../src/database/db-pool.js';

const MIGRATION = path.join(process.cwd(), 'src', 'database', 'migrations', '005_xscraper_message_identity.sql');

async function main() {
    console.log(`[xscraper-migrate] target: ${connectionInfo.user}@${connectionInfo.host}:${connectionInfo.port}/${connectionInfo.database}`);
    console.log(`[xscraper-migrate] file:   ${MIGRATION}`);

    const sql = await readFile(MIGRATION, 'utf8');

    const before = await pool.query(`SELECT COUNT(*)::int AS n FROM grok_messages`);
    console.log(`[xscraper-migrate] grok_messages rows before: ${before.rows[0].n}`);

    await pool.query(sql);

    const after = await pool.query(`
        SELECT
            COUNT(*)::int AS total,
            COUNT(source_message_id)::int AS with_source_id,
            COUNT(content_hash)::int AS with_content_hash
        FROM grok_messages`);
    console.log('[xscraper-migrate] after:', after.rows[0]);

    const idx = await pool.query(
        `SELECT indexname FROM pg_indexes
         WHERE tablename = 'grok_messages' AND indexname = 'uq_grok_messages_conversation_source'`);
    console.log(`[xscraper-migrate] canonical unique index present: ${idx.rows.length === 1}`);

    const state = await pool.query(
        `SELECT to_regclass('public.xscraper_sync_state') AS t`);
    console.log(`[xscraper-migrate] xscraper_sync_state present: ${state.rows[0].t !== null}`);

    if (before.rows[0].n !== after.rows[0].total) {
        throw new Error('Row count changed during migration — aborting (this must never happen).');
    }
    console.log('[xscraper-migrate] OK — no rows were added or removed.');
}

main()
    .then(() => pool.end())
    .catch(async (err) => {
        console.error('[xscraper-migrate] FAILED:', err.message);
        await pool.end();
        process.exit(1);
    });
