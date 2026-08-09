/**
 * XScraper conversation diagnostic — READ ONLY.
 *
 * XSCRAPER ONLY. This script never writes to PostgreSQL and never writes to
 * the local XScraper store.
 *
 * Usage:
 *   node scripts/xscraper-diagnose.js                      # every conversation
 *   node scripts/xscraper-diagnose.js <conversationId>
 *   node scripts/xscraper-diagnose.js --all-db             # include DB-only conversations
 */

import { pool, connectionInfo } from '../src/database/db-pool.js';
import { readLocalXScraperSource } from '../src/database/xscraper-local-source.js';
import {
    normalizeScrapedMessage,
    findExistingIdentities,
    getXScraperCheckpoint,
} from '../src/database/xscraper-sync.js';

const pad = (label) => String(label).padEnd(22);
const iso = (v) => (v ? (v.toISOString ? v.toISOString() : String(v)) : '(none)');

async function dbStats(conversationId) {
    const res = await pool.query(
        `SELECT COUNT(*)::int              AS total,
                MIN(timestamp)             AS earliest_ts,
                MAX(timestamp)             AS latest_ts,
                COUNT(source_message_id)::int AS with_source_id,
                COUNT(embedding)::int      AS with_embedding
         FROM grok_messages WHERE conversation_id = $1`,
        [conversationId]
    );
    const bounds = await pool.query(
        `(SELECT id, source_message_id, timestamp FROM grok_messages
          WHERE conversation_id = $1 ORDER BY timestamp ASC, id ASC LIMIT 1)
         UNION ALL
         (SELECT id, source_message_id, timestamp FROM grok_messages
          WHERE conversation_id = $1 ORDER BY timestamp DESC, id DESC LIMIT 1)`,
        [conversationId]
    );
    const dupes = await pool.query(
        `SELECT COUNT(*)::int AS n FROM (
            SELECT 1 FROM grok_messages
            WHERE conversation_id = $1
            GROUP BY content_hash HAVING COUNT(*) > 1) x`,
        [conversationId]
    );
    return {
        ...res.rows[0],
        earliest: bounds.rows[0] || null,
        latest: bounds.rows[1] || bounds.rows[0] || null,
        duplicateContentGroups: dupes.rows[0].n,
    };
}

async function diagnoseConversation(conversationId, localMessages) {
    console.log('');
    console.log('='.repeat(78));
    console.log(`Conversation: ${conversationId}`);
    console.log('='.repeat(78));

    // --- local analysis (identity + validation + local duplicates) ---
    const seen = new Map();
    let invalid = 0;
    let duplicatesLocal = 0;
    let latestLocalSavedAt = 0;
    let latestLocalTs = null;

    for (const raw of localMessages) {
        const { valid, row } = normalizeScrapedMessage(raw, conversationId);
        if (!valid) { invalid++; continue; }
        if (seen.has(row.identity.key)) { duplicatesLocal++; continue; }
        seen.set(row.identity.key, row);
        if (row.savedAt > latestLocalSavedAt) latestLocalSavedAt = row.savedAt;
        if (!latestLocalTs || row.timestamp > latestLocalTs) latestLocalTs = row.timestamp;
    }

    const unique = [...seen.values()];
    const existing = unique.length
        ? await findExistingIdentities(conversationId, unique.map(u => u.sourceMessageId))
        : new Map();

    let already = 0;
    for (const row of unique) if (existing.has(row.sourceMessageId)) already++;
    const pending = unique.length - already;

    const db = await dbStats(conversationId);
    const checkpoint = await getXScraperCheckpoint(conversationId);

    console.log(pad('Local messages:') + localMessages.length);
    console.log(pad('PostgreSQL messages:') + db.total);
    console.log(pad('Already persisted:') + already);
    console.log(pad('Pending insertion:') + pending);
    console.log(pad('Duplicates local:') + duplicatesLocal);
    console.log(pad('Invalid messages:') + invalid);
    console.log(pad('Latest local message:') + (latestLocalTs ? iso(latestLocalTs) : '(none)') +
        (latestLocalSavedAt ? `  (savedAt=${latestLocalSavedAt})` : ''));
    console.log(pad('Latest DB message:') + iso(db.latest_ts) + (db.latest ? `  id=${db.latest.id}` : ''));
    console.log(pad('Earliest DB message:') + iso(db.earliest_ts) + (db.earliest ? `  id=${db.earliest.id}` : ''));
    console.log(pad('Checkpoint:') + (checkpoint
        ? `savedAt=${checkpoint.last_source_savedat} confirmed=${checkpoint.confirmed_count} last_sync=${iso(checkpoint.last_synced_at)} last_source_id=${checkpoint.last_source_id || '(none)'}`
        : '(none recorded)'));
    console.log(pad('DB rows w/ source id:') + `${db.with_source_id}/${db.total}`);
    console.log(pad('DB rows w/ embedding:') + `${db.with_embedding}/${db.total}   (RAG vector search needs embeddings)`);
    console.log(pad('DB dup content groups:') + db.duplicateContentGroups);
    console.log(pad('CONVERGED:') + (pending === 0 ? 'YES — nothing to forward' : `NO — ${pending} message(s) pending`));

    return { pending, already, local: localMessages.length, db: db.total };
}

async function main() {
    const argv = process.argv.slice(2);
    const includeDbOnly = argv.includes('--all-db');
    const target = argv.find(a => !a.startsWith('-')) || null;

    console.log(`PostgreSQL: ${connectionInfo.user}@${connectionInfo.host}:${connectionInfo.port}/${connectionInfo.database}`);

    const local = await readLocalXScraperSource({ conversationId: target });
    console.log(`Local SQLite: ${local.sources.sqlite.path} (available=${local.sources.sqlite.available}, messages=${local.sources.sqlite.total})`);
    console.log(`Local JSON:   ${local.sources.json.path} (available=${local.sources.json.available}, messages=${local.sources.json.total})`);

    const conversationIds = new Set(local.byConversation.keys());

    if (target) {
        conversationIds.add(target);
    } else if (includeDbOnly) {
        const res = await pool.query('SELECT DISTINCT conversation_id FROM grok_messages');
        for (const r of res.rows) conversationIds.add(r.conversation_id);
    }

    if (conversationIds.size === 0) {
        console.log('\nNo local XScraper conversations found. Use --all-db to inspect PostgreSQL-side conversations.');
        return;
    }

    let totalPending = 0;
    for (const cid of conversationIds) {
        const r = await diagnoseConversation(cid, local.byConversation.get(cid) || []);
        totalPending += r.pending;
    }

    console.log('');
    console.log('='.repeat(78));
    console.log(pad('TOTAL PENDING:') + totalPending + (totalPending === 0 ? '  → synchronisation has converged' : ''));
    console.log('='.repeat(78));
}

main()
    .then(() => pool.end())
    .catch(async (err) => {
        console.error('[xscraper-diagnose] FAILED:', err.message);
        await pool.end();
        process.exit(1);
    });
