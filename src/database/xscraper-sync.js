/**
 * XScraper → PostgreSQL reconciliation.
 *
 * XSCRAPER ONLY. This module owns:
 *   - canonical message identity
 *   - normalization / validation of locally stored XScraper messages
 *   - idempotent insertion into grok_messages
 *   - the DURABLE sync checkpoint (advanced only after PostgreSQL confirms)
 *
 * The golden rule implemented here:
 *
 *   local_total = already_in_postgres + pending_to_insert + invalid + duplicates_in_local_source
 *   inserted    <= pending_to_insert
 *
 * Re-running reconciliation over the same local dataset MUST converge to
 * pending_to_insert = 0 / inserted = 0.
 */

import { createHash } from 'crypto';
import { pool, checkDbHealth } from './db-pool.js';
import { ragLog } from '../utils/logger.js';

const INSERT_BATCH_SIZE = 500;
const LOOKUP_BATCH_SIZE = 2000;

// ============================================================
// Identity
// ============================================================

function sha256Hex(value) {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Deterministic content fingerprint for a message.
 * Uses only IMMUTABLE fields (author + content). Never a timestamp, never a
 * random value, never an array index — so the same logical message always
 * fingerprints identically, no matter how many times it is re-scraped.
 */
export function contentHashOf(author, content) {
    return sha256Hex(`${String(author || '').trim()}\n${String(content || '').trim()}`).slice(0, 32);
}

/**
 * Resolve the STABLE source id of a locally stored XScraper message.
 *
 * Preference order:
 *   1. an id supplied by the local store (the scraper's `m_<contenthash>`,
 *      the SQLite primary key, or an explicit source id)
 *   2. a deterministic fallback derived from immutable fields
 *
 * Never returns a random value.
 */
export function sourceMessageIdOf(msg, conversationId) {
    const candidates = [msg?.source_message_id, msg?.sourceMessageId, msg?.id, msg?.messageId, msg?.message_id];
    for (const c of candidates) {
        if (c === undefined || c === null) continue;
        const s = String(c).trim();
        // Reject the old random ids: `msg_<epoch>_<random>` / `scraped_<epoch>_<random>`
        if (!s) continue;
        if (/^(msg|scraped)_\d{10,}_[a-z0-9]+$/i.test(s)) continue;
        return s;
    }
    // Deterministic fallback for legacy messages with no stable source id.
    const author = msg?.author ?? '';
    const content = msg?.content ?? msg?.text ?? '';
    return `h_${sha256Hex(`${conversationId}\u0000${author}\u0000${String(content).trim()}`).slice(0, 24)}`;
}

/**
 * The PRIMARY KEY used for newly inserted rows.
 *
 * Deterministic and CONVERSATION-SCOPED, derived from the canonical identity
 * (conversation_id + source_message_id). Re-importing the same local message
 * therefore always targets the same primary key.
 *
 * Legacy rows keep their original `m_<hash>` primary key; they are matched by
 * the (conversation_id, source_message_id) unique index instead, so this never
 * creates a duplicate of an already-stored message.
 */
export function canonicalRowId(conversationId, sourceMessageId) {
    return `xs_${sha256Hex(`${conversationId}\u0000${sourceMessageId}`).slice(0, 32)}`;
}

/**
 * Full canonical identity of a local XScraper message.
 */
export function canonicalIdentity(msg, conversationId) {
    const sourceMessageId = sourceMessageIdOf(msg, conversationId);
    const author = normalizeAuthor(msg);
    const content = String(msg?.content ?? msg?.text ?? '').trim();
    return {
        conversationId,
        sourceMessageId,
        contentHash: contentHashOf(author, content),
        rowId: canonicalRowId(conversationId, sourceMessageId),
        key: `${conversationId}\u0000${sourceMessageId}`,
    };
}

// ============================================================
// Normalization
// ============================================================

function normalizeAuthor(msg) {
    const raw = String(msg?.author ?? '').trim();
    if (raw) return raw;
    const role = String(msg?.role ?? '').trim().toLowerCase();
    if (role === 'assistant') return 'Grok';
    return 'You';
}

function roleOfAuthor(author) {
    const a = String(author || '').toLowerCase();
    if (a === 'assistant' || a === 'grok' || a === 'cream') return 'assistant';
    return 'user';
}

function toDateOrNull(value) {
    if (value === undefined || value === null || value === '') return null;
    const d = typeof value === 'number' ? new Date(value) : new Date(String(value));
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Local "savedAt" watermark of a message, used for the incremental checkpoint.
 * Returns epoch milliseconds (0 when unknown).
 */
export function sourceSavedAtOf(msg) {
    const candidates = [msg?.savedAt, msg?.scraped_at, msg?.scrapedAt, msg?.ts, msg?.timestamp];
    for (const c of candidates) {
        const d = toDateOrNull(c);
        if (d) return d.getTime();
    }
    return 0;
}

/**
 * Normalize a raw local XScraper message into the shape grok_messages needs.
 * Returns { valid, reason, row } — `row` is null when invalid.
 */
export function normalizeScrapedMessage(msg, conversationId) {
    if (!msg || typeof msg !== 'object') {
        return { valid: false, reason: 'not-an-object', row: null };
    }
    if (!conversationId) {
        return { valid: false, reason: 'missing-conversation-id', row: null };
    }

    const content = String(msg.content ?? msg.text ?? '').trim();
    if (!content) {
        return { valid: false, reason: 'empty-content', row: null };
    }

    const author = normalizeAuthor(msg);
    const identity = canonicalIdentity({ ...msg, author, content }, conversationId);
    const timestamp = toDateOrNull(msg.timestamp) || toDateOrNull(msg.ts) || toDateOrNull(msg.scraped_at) || new Date();
    const savedAt = sourceSavedAtOf(msg);

    return {
        valid: true,
        reason: null,
        row: {
            id: identity.rowId,
            conversationId,
            sourceMessageId: identity.sourceMessageId,
            contentHash: identity.contentHash,
            content,
            author,
            role: roleOfAuthor(author),
            timestamp,
            savedAt,
            payload: {
                role: roleOfAuthor(author),
                source: 'xscraper',
                sourceMessageId: identity.sourceMessageId,
                originalAuthor: msg.author ?? null,
                scrapedAt: (toDateOrNull(msg.scraped_at) || toDateOrNull(msg.scrapedAt) || new Date()).toISOString(),
                localSavedAt: savedAt || null,
            },
            identity,
        },
    };
}

// ============================================================
// Checkpoint (durable = confirmed by PostgreSQL)
// ============================================================

export async function getXScraperCheckpoint(conversationId, client = pool) {
    const res = await client.query(
        `SELECT conversation_id, last_source_savedat, last_message_ts, last_source_id,
                confirmed_count, last_synced_at, metadata
         FROM xscraper_sync_state WHERE conversation_id = $1`,
        [conversationId]
    );
    return res.rows[0] || null;
}

export async function listXScraperCheckpoints(client = pool) {
    const res = await client.query(
        `SELECT conversation_id, last_source_savedat, last_message_ts, last_source_id,
                confirmed_count, last_synced_at
         FROM xscraper_sync_state ORDER BY last_synced_at DESC`
    );
    return res.rows;
}

/**
 * Advance the durable checkpoint. Only ever called INSIDE the transaction that
 * persisted the messages, i.e. after PostgreSQL confirmed the writes. The
 * watermark never moves backwards.
 */
async function advanceCheckpoint(client, conversationId, { savedAt, lastTimestamp, lastSourceId, confirmedCount }) {
    await client.query(
        `INSERT INTO xscraper_sync_state
            (conversation_id, last_source_savedat, last_message_ts, last_source_id, confirmed_count, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (conversation_id) DO UPDATE SET
            last_source_savedat = GREATEST(xscraper_sync_state.last_source_savedat, EXCLUDED.last_source_savedat),
            last_message_ts     = GREATEST(COALESCE(xscraper_sync_state.last_message_ts, 'epoch'::timestamptz), COALESCE(EXCLUDED.last_message_ts, 'epoch'::timestamptz)),
            last_source_id      = COALESCE(EXCLUDED.last_source_id, xscraper_sync_state.last_source_id),
            confirmed_count     = EXCLUDED.confirmed_count,
            last_synced_at      = NOW()`,
        [conversationId, savedAt || 0, lastTimestamp, lastSourceId, confirmedCount]
    );
}

// ============================================================
// Existence lookup
// ============================================================

/**
 * Ask PostgreSQL which of these canonical identities already exist.
 * Matches on (conversation_id, source_message_id) and — for pre-migration
 * rows — on the legacy primary key too.
 */
export async function findExistingIdentities(conversationId, sourceIds, client = pool) {
    const found = new Map();
    for (let i = 0; i < sourceIds.length; i += LOOKUP_BATCH_SIZE) {
        const chunk = sourceIds.slice(i, i + LOOKUP_BATCH_SIZE);
        const res = await client.query(
            `SELECT id, source_message_id
             FROM grok_messages
             WHERE conversation_id = $1
               AND (source_message_id = ANY($2::text[]) OR id = ANY($2::text[]))`,
            [conversationId, chunk]
        );
        for (const row of res.rows) {
            found.set(row.source_message_id || row.id, row.id);
            // A legacy row may still be keyed only by its primary key.
            found.set(row.id, row.id);
        }
    }
    return found;
}

// ============================================================
// Reconciliation
// ============================================================

async function ensureConversation(client, conversationId, title) {
    await client.query(
        `INSERT INTO grok_conversations (id, title, message_count, metadata)
         VALUES ($1, $2, 0, $3)
         ON CONFLICT (id) DO UPDATE SET
            title = COALESCE(NULLIF(EXCLUDED.title, ''), grok_conversations.title),
            last_updated = NOW()`,
        [conversationId, title || 'Scraped Conversation', { source: 'xscraper' }]
    );
}

/**
 * Reconcile locally stored XScraper messages against PostgreSQL.
 *
 * @param {Array<object>} messages     raw messages from the local XScraper store
 * @param {string} conversationId
 * @param {string} [conversationTitle]
 * @param {object} [options]
 * @param {boolean} [options.dryRun]   analyse only, never write
 * @returns {Promise<object>} counters
 */
export async function reconcileScrapedMessages(messages, conversationId, conversationTitle = 'Scraped Conversation', options = {}) {
    const { dryRun = false } = options;

    if (!conversationId) {
        return {
            success: false,
            error: 'conversationId is required',
            conversationId: null,
            localTotal: Array.isArray(messages) ? messages.length : 0,
            alreadyInPostgres: 0, pendingToInsert: 0, inserted: 0, skipped: 0,
            invalid: 0, duplicatesInLocalSource: 0, errors: [],
        };
    }

    const list = Array.isArray(messages) ? messages : [];
    const stats = {
        success: false,
        conversationId,
        localTotal: list.length,
        invalid: 0,
        duplicatesInLocalSource: 0,
        alreadyInPostgres: 0,
        pendingToInsert: 0,
        inserted: 0,
        skipped: 0,
        errors: [],
        checkpoint: null,
        postgresTotalAfter: null,
        dryRun,
    };

    // --- 1. Normalize + validate + dedupe the LOCAL source -------------
    const byIdentity = new Map();
    for (const raw of list) {
        const { valid, reason, row } = normalizeScrapedMessage(raw, conversationId);
        if (!valid) {
            stats.invalid++;
            if (stats.errors.length < 20) stats.errors.push({ reason, id: raw?.id ?? null });
            continue;
        }
        if (byIdentity.has(row.identity.key)) {
            stats.duplicatesInLocalSource++;
            // Keep the earliest timestamp but the highest savedAt watermark.
            const prev = byIdentity.get(row.identity.key);
            if (row.savedAt > prev.savedAt) prev.savedAt = row.savedAt;
            continue;
        }
        byIdentity.set(row.identity.key, row);
    }

    const candidates = [...byIdentity.values()];

    if (candidates.length === 0) {
        // Nothing usable locally — this is still a successful, converged run.
        const health = await checkDbHealth();
        stats.success = health.ok;
        if (!health.ok) stats.error = `Database unavailable: ${health.reason}`;
        stats.skipped = stats.duplicatesInLocalSource;
        return stats;
    }

    // --- 2. Ask PostgreSQL what it already has -------------------------
    const health = await checkDbHealth();
    if (!health.ok) {
        // PostgreSQL unavailable: DO NOT advance the checkpoint, keep local data.
        stats.error = `Database unavailable: ${health.reason}`;
        stats.pendingToInsert = candidates.length;
        ragLog.warn('xscraper-sync', `PostgreSQL unavailable, retaining ${candidates.length} local messages for retry`);
        return stats;
    }

    const client = await pool.connect();
    try {
        await ensureConversation(client, conversationId, conversationTitle);

        const existing = await findExistingIdentities(
            conversationId,
            candidates.map(c => c.sourceMessageId),
            client
        );

        const pending = [];
        for (const row of candidates) {
            if (existing.has(row.sourceMessageId)) {
                stats.alreadyInPostgres++;
            } else {
                pending.push(row);
            }
        }
        stats.pendingToInsert = pending.length;

        if (dryRun) {
            stats.skipped = stats.alreadyInPostgres + stats.duplicatesInLocalSource;
            stats.success = true;
            stats.checkpoint = await getXScraperCheckpoint(conversationId, client);
            const cnt = await client.query('SELECT COUNT(*)::int AS n FROM grok_messages WHERE conversation_id = $1', [conversationId]);
            stats.postgresTotalAfter = cnt.rows[0].n;
            return stats;
        }

        // --- 3. Insert only what is missing, idempotently --------------
        await client.query('BEGIN');

        for (let i = 0; i < pending.length; i += INSERT_BATCH_SIZE) {
            const chunk = pending.slice(i, i + INSERT_BATCH_SIZE);
            const values = [];
            const params = [];
            let p = 1;
            for (const row of chunk) {
                values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, NOW())`);
                params.push(
                    row.id,
                    row.conversationId,
                    row.content,
                    row.author,
                    row.timestamp,
                    JSON.stringify(row.payload),
                    row.sourceMessageId,
                    row.contentHash,
                    'xscraper'
                );
            }

            const res = await client.query(
                `INSERT INTO grok_messages
                    (id, conversation_id, content, author, timestamp, payload,
                     source_message_id, content_hash, source, scraped_at)
                 VALUES ${values.join(', ')}
                 ON CONFLICT DO NOTHING
                 RETURNING id`,
                params
            );
            // Only rows PostgreSQL actually persisted are counted as inserted.
            stats.inserted += res.rowCount;
        }

        // Rows that were pending but lost an ON CONFLICT race are "already there".
        const conflicted = pending.length - stats.inserted;
        if (conflicted > 0) stats.alreadyInPostgres += conflicted;
        stats.skipped = stats.alreadyInPostgres + stats.duplicatesInLocalSource;

        // --- 4. Conversation stats (one query, not one per message) ----
        const countRes = await client.query(
            `UPDATE grok_conversations
             SET message_count = (SELECT COUNT(*) FROM grok_messages WHERE conversation_id = $1),
                 last_updated  = NOW(),
                 last_scraped  = NOW()
             WHERE id = $1
             RETURNING message_count`,
            [conversationId]
        );
        stats.postgresTotalAfter = countRes.rows[0]?.message_count ?? null;

        // --- 5. Durable checkpoint: only now, after confirmed writes ---
        let maxSavedAt = 0;
        let maxTs = null;
        let lastSourceId = null;
        for (const row of candidates) {
            if (row.savedAt > maxSavedAt) {
                maxSavedAt = row.savedAt;
                lastSourceId = row.sourceMessageId;
            }
            if (!maxTs || (row.timestamp && row.timestamp > maxTs)) maxTs = row.timestamp;
        }
        await advanceCheckpoint(client, conversationId, {
            savedAt: maxSavedAt,
            lastTimestamp: maxTs,
            lastSourceId,
            confirmedCount: stats.postgresTotalAfter ?? 0,
        });

        await client.query('COMMIT');

        stats.success = true;
        stats.checkpoint = await getXScraperCheckpoint(conversationId, client);

        ragLog.info(
            'xscraper-sync',
            `conv=${conversationId} local_total=${stats.localTotal} already_in_postgres=${stats.alreadyInPostgres} ` +
            `pending_to_insert=${stats.pendingToInsert} inserted=${stats.inserted} skipped=${stats.skipped} ` +
            `invalid=${stats.invalid} duplicates_local=${stats.duplicatesInLocalSource}`
        );

        return stats;
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
        stats.success = false;
        stats.error = err.message;
        stats.inserted = 0; // nothing was durably persisted
        stats.errors.push({ reason: 'transaction-failed', error: err.message });
        ragLog.warn('xscraper-sync', `Reconciliation failed for ${conversationId}: ${err.message}`);
        return stats;
    } finally {
        client.release();
    }
}

/**
 * Read-only reconciliation report for a single conversation.
 */
export async function analyzeConversation(messages, conversationId) {
    return reconcileScrapedMessages(messages, conversationId, undefined, { dryRun: true });
}

/**
 * Read-only diagnostic for ONE message.
 */
export async function inspectSingleMessage(msg, conversationId, client = pool) {
    const normalized = normalizeScrapedMessage(msg, conversationId);
    const result = {
        conversationId,
        localIdentity: {
            id: msg?.id ?? null,
            author: msg?.author ?? null,
            timestamp: msg?.timestamp ?? msg?.ts ?? null,
            contentPreview: String(msg?.content ?? msg?.text ?? '').slice(0, 80),
        },
        valid: normalized.valid,
        reason: normalized.reason,
        canonicalIdentity: normalized.row
            ? {
                conversationId,
                sourceMessageId: normalized.row.sourceMessageId,
                contentHash: normalized.row.contentHash,
                rowId: normalized.row.id,
            }
            : null,
        postgres: null,
        exists: false,
        wouldBe: normalized.valid ? 'insert' : 'invalid',
    };

    if (!normalized.valid) return result;

    const res = await client.query(
        `SELECT id, conversation_id, source_message_id, content_hash, author, timestamp, scraped_at, source
         FROM grok_messages
         WHERE conversation_id = $1
           AND (source_message_id = $2 OR id = $2 OR id = $3)
         LIMIT 1`,
        [conversationId, normalized.row.sourceMessageId, normalized.row.id]
    );

    if (res.rows.length > 0) {
        result.postgres = res.rows[0];
        result.exists = true;
        result.wouldBe = 'skip';
    }
    return result;
}
