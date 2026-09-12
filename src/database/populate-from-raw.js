import path from 'path';
import fs from 'fs';
import { pool } from './db-pool.js';
import { resolveDatabasePath } from '../utils/pathResolver.js';
import { dbLog } from '../utils/logger.js';

/**
 * Import grok JSON message files into the database.
 *
 * Safe to run multiple times:
 *   - Uses ON CONFLICT (id) DO NOTHING, so re-running never duplicates rows.
 *   - Reports how many messages were newly inserted vs. skipped.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] Import even if the table already has rows.
 * @returns {Promise<{filesProcessed:number, inserted:number, skipped:number, skippedImport:boolean}>}
 */
async function populateFromRaw(opts = {}) {
    const { force = false } = opts;
    dbLog.info('[populate] Starting population from raw JSON...');

    // Report current state before doing anything.
    let existing = 0;
    try {
        const res = await pool.query('SELECT COUNT(*)::int AS c FROM grok_messages');
        existing = res.rows[0].c;
        dbLog.info(`[populate] grok_messages currently has ${existing} rows.`);
    } catch (e) {
        dbLog.error('populate-count', e, 'Ensure DB is reachable and schema applied');
        throw e;
    }

    if (existing > 0 && !force) {
        dbLog.info('[populate] Table already populated — skipping import (pass { force: true } to override).');
        return { filesProcessed: 0, inserted: 0, skipped: 0, skippedImport: true };
    }

    const grokDir = resolveDatabasePath('grok');
    if (!fs.existsSync(grokDir)) {
        dbLog.warn(`[populate] grok folder not found at ${grokDir} — nothing to import.`);
        return { filesProcessed: 0, inserted: 0, skipped: 0, skippedImport: true };
    }

    // Recursive find all .json files
    const files = [];
    function findJson(dir) {
        const items = fs.readdirSync(dir);
        for (const item of items) {
            const fullPath = path.join(dir, item);
            if (fs.statSync(fullPath).isDirectory()) {
                findJson(fullPath);
            } else if (item.endsWith('.json')) {
                files.push(fullPath);
            }
        }
    }
    findJson(grokDir);

    dbLog.info(`[populate] Found ${files.length} JSON files in ${grokDir}`);

    let totalInserted = 0;
    let totalSkipped = 0;

    for (const file of files) {
        // Each file is imported inside a single transaction on one pooled
        // client. This turns thousands of per-message round-trips into a
        // handful of batched statements, and guarantees a file is imported
        // atomically (all-or-nothing) instead of leaving partial rows behind.
        const client = await pool.connect();
        try {
            const content = fs.readFileSync(file, 'utf8');
            const data = JSON.parse(content);

            // Handle different JSON structures
            let messages = [];
            if (data.messages && Array.isArray(data.messages)) {
                messages = data.messages;
            } else if (Array.isArray(data)) {
                // Filter out non-message objects (metadata objects without id)
                messages = data.filter(item => item.id && item.content);
            }

            if (messages.length === 0) {
                client.release();
                continue;
            }

            await client.query('BEGIN');

            // 1) Insert every distinct conversation ONCE (previously this ran
            //    once per message, i.e. thousands of redundant inserts).
            const conversationIds = new Set();
            for (const msg of messages) {
                conversationIds.add(msg.conversationId || msg.conversation_id || 'unknown');
            }
            for (const conversationId of conversationIds) {
                await client.query(
                    `INSERT INTO grok_conversations (id, title, created_at, last_updated)
                     VALUES ($1, $2, NOW(), NOW())
                     ON CONFLICT (id) DO NOTHING`,
                    [conversationId, 'Imported Conversation']
                );
            }

            // 2) Insert messages in batches with a single multi-row INSERT per
            //    batch. ON CONFLICT (id) DO NOTHING keeps this idempotent.
            const BATCH_SIZE = 500;
            let fileInserted = 0;

            for (let start = 0; start < messages.length; start += BATCH_SIZE) {
                const batch = messages.slice(start, start + BATCH_SIZE);
                const values = [];
                const params = [];
                let p = 1;

                for (const msg of batch) {
                    const conversationId = msg.conversationId || msg.conversation_id || 'unknown';
                    values.push(
                        `($${p}, $${p + 1}, $${p + 2}, $${p + 3}, to_timestamp($${p + 4}::bigint / 1000), $${p + 5})`
                    );
                    params.push(
                        msg.id,
                        conversationId,
                        msg.content || '',
                        'user',
                        msg.ts || msg.timestamp || Date.now(),
                        msg
                    );
                    p += 6;
                }

                const ins = await client.query(
                    `INSERT INTO grok_messages
                        (id, conversation_id, content, author, timestamp, payload)
                     VALUES ${values.join(', ')}
                     ON CONFLICT (id) DO NOTHING`,
                    params
                );
                fileInserted += ins.rowCount;
            }

            await client.query('COMMIT');

            const fileSkipped = messages.length - fileInserted;
            totalInserted += fileInserted;
            totalSkipped += fileSkipped;
            dbLog.debug(
                `[populate] ${path.basename(file)}: ${messages.length} messages ` +
                `(${fileInserted} new, ${fileSkipped} already present)`
            );
        } catch (e) {
            try {
                await client.query('ROLLBACK');
            } catch {
                // ignore rollback failure; original error is what matters
            }
            dbLog.error(`populate-file ${path.basename(file)}`, e, 'skipping this file');
        } finally {
            client.release();
        }
    }

    dbLog.info(
        `[populate] Done. Files: ${files.length}, inserted: ${totalInserted}, ` +
        `skipped (already present): ${totalSkipped}.`
    );

    return {
        filesProcessed: files.length,
        inserted: totalInserted,
        skipped: totalSkipped,
        skippedImport: false,
    };
}

// Export for use in auto-setup
export { populateFromRaw as populateGrokMessages, populateFromRaw };

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    const force = process.argv.includes('--force');
    populateFromRaw({ force })
        .then(() => pool.end())
        .catch((err) => {
            dbLog.error('populate-fatal', err);
            pool.end().then(() => process.exit(1));
        });
}
