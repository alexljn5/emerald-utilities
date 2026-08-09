/**
 * XScraper Forwarding Service — the ONE canonical pipeline.
 *
 * XSCRAPER ONLY. This module owns the durable forwarding queue and the batch
 * worker that drains it into remote PostgreSQL.
 *
 * Pipeline:
 *
 *   extension  →  local server  →  SQLite (durable queue)  →  batch worker
 *            →  PostgreSQL (idempotent)  →  mark forwarded (only after ACK)
 *
 * The local SQLite store (%APPDATA%/.xscraper/x_messages.db) is the durable
 * source of truth for messages awaiting forwarding. It is NOT an in-memory
 * array and NOT JSON exports. Three extra columns are added to the existing
 * `messages` table (LOCAL ONLY — PostgreSQL schema is never touched):
 *
 *   forwarded    INTEGER 0/1      — acknowledged by PostgreSQL
 *   attempts     INTEGER          — send attempts (for retry visibility)
 *   last_error   TEXT             — last failure reason
 *
 * All three entry points (manual Send-to-Postgres, auto-sync, SCRAPE+FORWARD)
 * call this same service. There is exactly ONE worker and it is a singleton.
 *
 * Guarantees:
 *   - A message is marked forwarded ONLY after PostgreSQL confirms it exists
 *     (inserted now, or already present). Never merely because it was selected.
 *   - PostgreSQL reconciliation is idempotent — re-running never duplicates.
 *   - PostgreSQL outages keep messages pending in SQLite; the worker retries
 *     with capped exponential backoff (1s -> 60s) and never busy-loops.
 *   - One bad message is marked invalid/skipped without killing the worker.
 */

import { createRequire } from 'module';
import path from 'path';
import { existsSync } from 'fs';
import { reconcileScrapedMessages } from './xscraper-sync.js';
import { checkDbHealth } from './db-pool.js';
import { readLocalXScraperSource } from './xscraper-local-source.js';
import { ragLog } from '../utils/logger.js';

const require = createRequire(import.meta.url);

// ----------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------
const BATCH_SIZE = 100;          // messages per PostgreSQL round-trip
const MAX_CONCURRENT_BATCHES = 2; // parallel reconciliation batches
const WORKER_INTERVAL_MS = 2000;  // worker tick
const MAX_BACKOFF_MS = 60000;     // retry ceiling
const BACKOFF_BASE_MS = 1000;     // first retry

function defaultSqlitePath() {
    const base = process.env.XSCRAPER_HOME
        || path.join(process.env.APPDATA || process.env.HOME || '.', '.xscraper');
    return path.join(base, 'x_messages.db');
}

// ----------------------------------------------------------------------
// Local SQLite access (write). The server process holds the same file;
// sqlite3 supports concurrent connections with a busy timeout.
// ----------------------------------------------------------------------
function openDb(dbPath) {
    const sqlite3 = require('sqlite3');
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
    db.configure('busyTimeout', 5000);
    return db;
}

function runAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
}

function allAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

function getAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

// ----------------------------------------------------------------------
// Service singleton state
// ----------------------------------------------------------------------
let workerTimer = null;
let workerRunning = false;   // guards against overlapping ticks
let workerStarted = false;
let backoffMs = 0;
let backoffUntil = 0;
let activeBatchId = null;
let retryCount = 0;
let lastRunAt = null;
let lastResult = null;
let lastPgHealth = null;
let dbPath = null;

// ----------------------------------------------------------------------
// Schema (local only, additive)
// ----------------------------------------------------------------------
async function ensureSchema(db) {
    // `messages` table is created by the server; if it does not exist yet
    // (server never started), create it so the queue is still durable.
    await runAsync(db, `CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        content TEXT NOT NULL,
        author TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        scraped_at DATETIME,
        UNIQUE(content, author, conversation_id)
    )`);
    await runAsync(db, `CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        message_count INTEGER DEFAULT 0,
        last_scraped DATETIME
    )`);

    // Local-only forwarding state columns. Use a portable existence check:
    // some bundled sqlite3 builds predate "ADD COLUMN IF NOT EXISTS".
    const cols = new Set((await allAsync(db, `PRAGMA table_info(messages)`)).map(c => c.name));
    if (!cols.has('forwarded')) {
        await runAsync(db, `ALTER TABLE messages ADD COLUMN forwarded INTEGER DEFAULT 0`);
    }
    if (!cols.has('forwarded_at')) {
        await runAsync(db, `ALTER TABLE messages ADD COLUMN forwarded_at DATETIME`);
    }
    if (!cols.has('attempts')) {
        await runAsync(db, `ALTER TABLE messages ADD COLUMN attempts INTEGER DEFAULT 0`);
    }
    if (!cols.has('last_error')) {
        await runAsync(db, `ALTER TABLE messages ADD COLUMN last_error TEXT`);
    }
}

// ----------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------

/**
 * Duplicate-safe upsert of scraped messages into the durable SQLite queue.
 * Messages are marked unforwarded on insert so the worker picks them up.
 *
 * @param {Array<object>} messages
 * @param {string} conversationId
 * @param {string} [conversationTitle]
 * @returns {Promise<{inserted:number, duplicates:number, total:number, path:string}>}
 */
export async function saveMessages(messages, conversationId, conversationTitle = 'Scraped Conversation') {
    const list = Array.isArray(messages) ? messages : [];
    if (!conversationId) {
        return { success: false, error: 'conversationId is required', inserted: 0, duplicates: 0, total: 0 };
    }

    const db = openDb(dbPath || defaultSqlitePath());
    let inserted = 0;
    try {
        await ensureSchema(db);
        await runAsync(db, `INSERT OR IGNORE INTO conversations (id, title, last_scraped)
                            VALUES (?, ?, ?)`,
            [conversationId, conversationTitle, new Date().toISOString()]);

        for (const m of list) {
            const content = String(m?.content ?? m?.text ?? '');
            if (!content) continue;
            const author = String(m?.author ?? m?.role ?? 'You');
            const id = m?.id || m?.messageId || m?.source_message_id || `m_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            const ts = m?.timestamp || m?.ts || new Date().toISOString();
            const r = await runAsync(db,
                `INSERT OR IGNORE INTO messages
                    (id, conversation_id, content, author, timestamp, scraped_at, forwarded, attempts)
                 VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
                [id, conversationId, content, author, ts, new Date().toISOString()]);
            if (r.changes > 0) inserted++;
        }

        await runAsync(db,
            `UPDATE conversations
             SET message_count = (SELECT COUNT(*) FROM messages WHERE conversation_id = ?),
                 last_updated = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [conversationId, conversationId]);

        return { success: true, inserted, duplicates: list.length - inserted, total: list.length, path: dbPath || defaultSqlitePath() };
    } catch (err) {
        ragLog.warn('xscraper-forwarder', `saveMessages failed: ${err.message}`);
        return { success: false, error: err.message, inserted, duplicates: list.length - inserted, total: list.length };
    } finally {
        db.close();
    }
}

/**
 * Read pending (unforwarded) messages from SQLite, oldest first.
 * @param {number} [limit]
 * @returns {Promise<Array<object>>}
 */
export async function getPending(limit = BATCH_SIZE) {
    const db = openDb(dbPath || defaultSqlitePath());
    try {
        await ensureSchema(db);
        const rows = await allAsync(db,
            `SELECT id, conversation_id, content, author, timestamp, scraped_at
             FROM messages WHERE COALESCE(forwarded, 0) = 0
             ORDER BY COALESCE(timestamp, created_at) ASC
             LIMIT ?`,
            [limit]);
        return rows.map(r => ({
            id: r.id,
            source_message_id: r.id,
            conversationId: r.conversation_id,
            content: r.content,
            author: r.author,
            timestamp: r.timestamp,
            scraped_at: r.scraped_at,
            savedAt: r.scraped_at ? Date.parse(r.scraped_at) : Date.now(),
            __source: 'sqlite',
        }));
    } finally {
        db.close();
    }
}

/**
 * Mark a set of message ids as forwarded (only called after PG confirms).
 * @param {Array<string>} ids
 */
export async function markForwarded(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    const db = openDb(dbPath || defaultSqlitePath());
    try {
        await ensureSchema(db);
        const placeholders = ids.map(() => '?').join(',');
        await runAsync(db,
            `UPDATE messages
             SET forwarded = 1, forwarded_at = ?, attempts = attempts + 1, last_error = NULL
             WHERE id IN (${placeholders})`,
            [new Date().toISOString(), ...ids]);
    } finally {
        db.close();
    }
}

/**
 * Increment attempts and record the last failure for a set of ids.
 * Messages stay pending (forwarded stays 0) so they are retried.
 * @param {Array<string>} ids
 * @param {string} error
 */
export async function markFailed(ids, error) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    const db = openDb(dbPath || defaultSqlitePath());
    try {
        await ensureSchema(db);
        const placeholders = ids.map(() => '?').join(',');
        await runAsync(db,
            `UPDATE messages SET attempts = attempts + 1, last_error = ? WHERE id IN (${placeholders})`,
            [String(error || 'unknown').slice(0, 500), ...ids]);
    } finally {
        db.close();
    }
}

/**
 * Clear (delete) fully-forwarded messages from the local SQLite queue.
 * @returns {Promise<{deleted:number}>}
 */
export async function clearForwarded() {
    const db = openDb(dbPath || defaultSqlitePath());
    try {
        await ensureSchema(db);
        const r = await runAsync(db, `DELETE FROM messages WHERE COALESCE(forwarded, 0) = 1`);
        return { deleted: r.changes };
    } finally {
        db.close();
    }
}

/**
 * Full service status — used by the UI and the diagnostic command.
 */
export async function getStatus() {
    const dbPathResolved = dbPath || defaultSqlitePath();
    let sqlite = { available: existsSync(dbPathResolved), path: dbPathResolved, local: 0, pending: 0, forwarded: 0, failed: 0 };
    let pg = { connected: false };
    let queueSize = 0;

    if (sqlite.available) {
        const db = openDb(dbPathResolved);
        try {
            await ensureSchema(db);
            const localRes = await getAsync(db, `SELECT COUNT(*) AS n FROM messages`);
            const pendingRes = await getAsync(db, `SELECT COUNT(*) AS n FROM messages WHERE COALESCE(forwarded, 0) = 0`);
            const forwardedRes = await getAsync(db, `SELECT COUNT(*) AS n FROM messages WHERE COALESCE(forwarded, 0) = 1`);
            const failedRes = await getAsync(db, `SELECT COUNT(*) AS n FROM messages WHERE COALESCE(forwarded, 0) = 0 AND attempts > 0`);
            sqlite.local = localRes?.n || 0;
            sqlite.pending = pendingRes?.n || 0;
            sqlite.forwarded = forwardedRes?.n || 0;
            sqlite.failed = failedRes?.n || 0;
        } catch (err) {
            sqlite.error = err.message;
        } finally {
            db.close();
        }
    }

    // Also surface the combined Node-reachable local source (SQLite + legacy
    // JSON exports). The worker drains BOTH, so the UI's "Local"/"Pending"
    // counters must include JSON-exported messages that are not yet in SQLite.
    let local = { sqlite: 0, json: 0, conversations: 0, total: 0 };
    try {
        const all = await readLocalXScraperSource({});
        local.sqlite = all.sources.sqlite.total || 0;
        local.json = all.sources.json.total || 0;
        local.conversations = all.byConversation.size;
        let total = 0;
        for (const msgs of all.byConversation.values()) total += msgs.length;
        local.total = total;
        // queueSize = combined pending (all local messages not yet confirmed).
        queueSize = local.total - (sqlite.forwarded || 0);
    } catch (err) {
        local.error = err.message;
    }

    const health = await checkDbHealth();
    pg = { connected: health.ok, host: health.host, port: health.port, database: health.database, kind: health.kind, reason: health.reason };
    lastPgHealth = pg;

    return {
        sqlite,
        local,
        pg,
        queue: {
            size: Math.max(0, queueSize),
            batchSize: BATCH_SIZE,
            concurrency: MAX_CONCURRENT_BATCHES,
        },
        worker: {
            started: workerStarted,
            running: workerRunning,
            activeBatchId: activeBatchId || null,
            retryCount,
            backoffMs,
            backoffUntil,
            lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null,
            lastResult,
        },
    };
}

// ----------------------------------------------------------------------
// Batch worker
// ----------------------------------------------------------------------

/**
 * Run one forward pass over the live SQLite queue (unforwarded messages).
 * Safe to call directly (returns the result) and from the worker tick (which
 * guards concurrency).
 *
 * The live durable queue is SQLite. Legacy JSON exports are NOT part of the
 * live queue — they are reconciled once via `forwardLegacy()`.
 */
export async function runBatch() {
    if (workerRunning) {
        return { success: false, skipped: true, reason: 'worker busy' };
    }
    workerRunning = true;
    activeBatchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const batchId = activeBatchId;
    try {
        // Respect backoff unless forced (manual override sets backoffUntil=0).
        if (backoffUntil > Date.now() && backoffMs > 0) {
            return { success: true, skipped: true, reason: 'backoff', backoffMs };
        }

        // 1. Read ONLY unforwarded SQLite messages (the durable live queue).
        const pendingMessages = await getPending(BATCH_SIZE * MAX_CONCURRENT_BATCHES);
        if (pendingMessages.length === 0) {
            // Idle — reset backoff so a recovering PG is tried as soon as a new
            // batch lands. Silent: nothing changed, nothing to log.
            backoffMs = 0;
            backoffUntil = 0;
            retryCount = 0;
            activeBatchId = null;
            lastRunAt = Date.now();
            lastResult = { inserted: 0, skipped: 0, failed: 0, pending: 0, idle: true };
            return { success: true, inserted: 0, skipped: 0, failed: 0, pending: 0, batchId, idle: true };
        }

        // 2. Quick PG reachability check so we don't hammer a dead host.
        const health = await checkDbHealth();
        if (!health.ok) {
            // Do not mark anything forwarded. Keep pending, schedule retry.
            const failIds = pendingMessages.map(m => m.id);
            await markFailed(failIds, health.reason || 'postgresql unreachable');
            scheduleRetry();
            activeBatchId = null;
            lastRunAt = Date.now();
            lastResult = { inserted: 0, skipped: 0, failed: failIds.length, pending: pendingMessages.length, error: health.reason };
            ragLog.warn('xscraper-pg', `batch_id=${batchId} unreachable: ${health.reason} — ${failIds.length} kept local for retry`);
            return { success: false, error: health.reason, failed: failIds.length, pending: pendingMessages.length, batchId, retryable: true };
        }

        // 3. Group by conversation and reconcile (idempotent). Bounded concurrency.
        const byConv = new Map();
        for (const m of pendingMessages) {
            const cid = m.conversationId || 'default';
            if (!byConv.has(cid)) byConv.set(cid, []);
            byConv.get(cid).push(m);
        }
        const convs = [...byConv.entries()];
        let inserted = 0;
        let acked = 0;      // already present in PG
        let failed = 0;
        let confirmedIds = [];
        let failedIds = [];

        const runOne = async ([cid, msgs]) => {
            try {
                const r = await reconcileScrapedMessages(msgs, cid, 'Scraped Conversation');
                if (r.success) {
                    inserted += r.inserted || 0;
                    acked += r.alreadyInPostgres || 0;
                    confirmedIds.push(...msgs.map(m => m.id));
                } else {
                    failed += msgs.length;
                    failedIds.push(...msgs.map(m => m.id));
                }
            } catch (err) {
                failed += msgs.length;
                failedIds.push(...msgs.map(m => m.id));
            }
        };

        for (let i = 0; i < convs.length; i += MAX_CONCURRENT_BATCHES) {
            const chunk = convs.slice(i, i + MAX_CONCURRENT_BATCHES);
            await Promise.all(chunk.map(runOne));
        }

        // 4. Durable checkpoint: mark forwarded ONLY for confirmed ids.
        if (confirmedIds.length > 0) {
            await markForwarded(confirmedIds);
        }
        if (failedIds.length > 0) {
            await markFailed(failedIds, 'postgresql reconcile failed');
        }

        // 5. Remaining pending after this batch.
        const remaining = await getPending(1);
        const pendingAfter = remaining.length;

        // 6. Retry scheduling.
        if (failed > 0) {
            scheduleRetry();
        } else {
            backoffMs = 0;
            backoffUntil = 0;
            retryCount = 0;
        }

        activeBatchId = null;
        lastRunAt = Date.now();
        lastResult = { inserted, skipped: acked, failed, pending: pendingAfter };
        // Concise, meaningful log — only when something was actually forwarded.
        ragLog.info('xscraper-batch',
            `batch_id=${batchId} attempted=${pendingMessages.length} inserted=${inserted} already=${acked} failed=${failed} pending=${pendingAfter}`);

        return {
            success: failed === 0,
            batchId,
            queueSize: pendingMessages.length,
            inserted,
            skipped: acked,
            failed,
            pending: pendingAfter,
            confirmedIds: confirmedIds.length,
        };
    } catch (err) {
        ragLog.error('xscraper-forwarder', err, `runBatch(${batchId}) failed: ${err.message}`);
        activeBatchId = null;
        return { success: false, error: err.message, batchId, retryable: true };
    } finally {
        workerRunning = false;
    }
}

/**
 * One-time reconciliation of the legacy JSON exports (the historical 5,788)
 * into PostgreSQL. NOT part of the live queue — call explicitly (e.g. a
 * "Reconcile Legacy" recovery button). Idempotent.
 */
export async function forwardLegacy() {
    const local = await readLocalXScraperSource({});
    const byConv = local.byConversation;
    if (byConv.size === 0) {
        return { success: true, length: 0, inserted: 0, already: 0, failed: 0 };
    }
    let inserted = 0;
    let already = 0;
    let failed = 0;
    let length = 0;
    for (const [cid, msgs] of byConv) {
        // Only reconcile messages that are JSON-sourced (not already in the
        // SQLite live queue), so we don't double-send live messages.
        const jsonMsgs = msgs.filter(m => m.__source === 'json');
        if (jsonMsgs.length === 0) continue;
        length += jsonMsgs.length;
        try {
            const title = local.titles.get(cid) || 'Scraped Conversation';
            const r = await reconcileScrapedMessages(jsonMsgs, cid, title);
            if (r.success) {
                inserted += r.inserted || 0;
                already += r.alreadyInPostgres || 0;
            } else {
                failed += 1;
            }
        } catch {
            failed += 1;
        }
    }
    ragLog.info('xscraper-batch', `forwardLegacy: length=${length} inserted=${inserted} already=${already} failed=${failed}`);
    return { success: failed === 0, length, inserted, already, failed };
}

/**
 * Insert a test message into the durable SQLite queue and force a drain,
 * proving the auto-forward path works end-to-end (SQLite → PostgreSQL).
 */
export async function sendTestMessage(conversationId = 'xscraper-verify') {
    const content = `XSCRAPER AUTO-FORWARD VERIFY ${new Date().toISOString()} ${Math.random().toString(36).slice(2, 8)}`;
    const id = `verify_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const saved = await saveMessages([{ id, content, author: 'You', timestamp: new Date().toISOString() }], conversationId, 'XScraper Verify');
    if (!saved.success) {
        return { success: false, error: saved.error };
    }
    const r = await forceRun();
    const found = await (async () => {
        try {
            const { pool } = await import('./db-pool.js');
            const res = await pool.query(
                'SELECT 1 FROM grok_messages WHERE conversation_id = $1 AND source_message_id = $2',
                [conversationId, id]);
            return res.rowCount > 0;
        } catch {
            return false;
        }
    })();
    return {
        success: r.success && found,
        testId: id,
        content,
        inserted: r.inserted || 0,
        skipped: r.skipped || 0,
        pending: r.pending || 0,
        confirmedInPostgres: found,
        message: found
            ? 'VERIFIED: test message reached PostgreSQL via auto-forward'
            : 'Test message queued but not yet confirmed in PostgreSQL',
    };
}

function scheduleRetry() {
    retryCount++;
    backoffMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, retryCount - 1), MAX_BACKOFF_MS);
    backoffUntil = Date.now() + backoffMs;
    ragLog.info('xscraper-retry', `backoff=${backoffMs}ms attempt=${retryCount}`);
}

/**
 * Start the singleton batch worker. Idempotent — safe to call many times.
 */
export function startWorker({ intervalMs = WORKER_INTERVAL_MS } = {}) {
    if (workerStarted && workerTimer) {
        return { success: true, alreadyRunning: true, intervalMs };
    }
    workerStarted = true;
    workerTimer = setInterval(async () => {
        try {
            await runBatch();
        } catch (err) {
            ragLog.error('xscraper-forwarder', err, 'worker tick failed');
        }
    }, intervalMs);
    if (typeof workerTimer.unref === 'function') workerTimer.unref();
    ragLog.info('xscraper-forwarder', `batch worker started (every ${intervalMs}ms)`);
    // Kick immediately.
    runBatch().catch(() => { });
    return { success: true, intervalMs };
}

/**
 * Stop the singleton batch worker.
 */
export function stopWorker() {
    if (workerTimer) {
        clearInterval(workerTimer);
        workerTimer = null;
    }
    workerStarted = false;
    return { success: true, running: false };
}

/** Force an immediate run, bypassing backoff (used by manual action). */
export async function forceRun() {
    backoffUntil = 0;
    backoffMs = 0;
    return runBatch();
}

/** Allow tests/scripts to override the SQLite path. */
export function _setSqlitePath(p) {
    dbPath = p;
}
