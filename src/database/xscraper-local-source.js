/**
 * Reader for the LOCAL XScraper persistence layer.
 *
 * XSCRAPER ONLY. Nothing here writes to PostgreSQL.
 *
 * The XScraper stack has three local layers:
 *
 *   1. Extension IndexedDB ("XScraper" db, stores: messages/conversations)
 *      — lives inside the Electron `persist:xscraper` partition. Only the
 *        renderer/webview can read it, so Node-side tooling cannot.
 *      — reached at runtime through `exportIncrementalJSON(since)`.
 *
 *   2. SQLite  %APPDATA%/.xscraper/x_messages.db  (table `messages`)
 *      — written by the local XScraper server (src/scrapers/xscraper/src/server)
 *        when the extension POSTs to /api/messages/save.
 *      — THIS is the authoritative local store readable from Node.
 *
 *   3. JSON exports in src/database/grok/messages/<conversationId>.json
 *      — legacy snapshots produced by `xscraper:export-data`. Optional; the
 *        directory is currently empty because the exports were deleted.
 *
 * This module reads (2) and (3) and normalises both into the same shape so the
 * reconciler does not care where the data came from.
 */

import path from 'path';
import { existsSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export function defaultSqlitePath() {
    const base = process.env.XSCRAPER_HOME
        || path.join(process.env.APPDATA || process.env.HOME || '.', '.xscraper');
    return path.join(base, 'x_messages.db');
}

export function defaultJsonDir() {
    return path.join(process.cwd(), 'src', 'database', 'grok', 'messages');
}

// ------------------------------------------------------------------
// SQLite (authoritative local store)
// ------------------------------------------------------------------

function openSqlite(dbPath) {
    const sqlite3 = require('sqlite3');
    // busyTimeout prevents an immediate SQLITE_BUSY failure when the local
    // XScraper server is mid-write on the same store (scrape flush + this read
    // can overlap). The server's writer also uses a busy timeout, so reads
    // will wait briefly instead of throwing.
    return new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
        if (err) {
            console.error('[xscraper-local-source] SQLite open failed:', err.message);
        }
    }).configure('busyTimeout', 5000);
}

function allAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

/**
 * Read messages from the local SQLite store.
 * @param {object} [opts]
 * @param {string} [opts.dbPath]
 * @param {string} [opts.conversationId] restrict to one conversation
 * @returns {Promise<{available: boolean, path: string, byConversation: Map<string, Array>, total: number}>}
 */
export async function readSqliteSource({ dbPath = defaultSqlitePath(), conversationId = null } = {}) {
    const result = { available: false, path: dbPath, byConversation: new Map(), total: 0 };
    if (!existsSync(dbPath)) return result;

    const db = openSqlite(dbPath);
    try {
        let sql = `SELECT id, conversation_id, content, author, timestamp, scraped_at, created_at
                   FROM messages`;
        const params = [];
        if (conversationId) {
            sql += ` WHERE conversation_id = ?`;
            params.push(conversationId);
        }
        sql += ` ORDER BY COALESCE(timestamp, created_at) ASC`;

        const rows = await allAsync(db, sql, params);
        for (const r of rows) {
            const cid = r.conversation_id || 'default';
            if (!result.byConversation.has(cid)) result.byConversation.set(cid, []);
            result.byConversation.get(cid).push({
                id: r.id,
                conversationId: cid,
                content: r.content,
                author: r.author,
                timestamp: r.timestamp,
                scraped_at: r.scraped_at,
                savedAt: r.scraped_at ? Date.parse(r.scraped_at) : (r.created_at ? Date.parse(r.created_at) : 0),
                __source: 'sqlite',
            });
            result.total++;
        }
        result.available = true;
        return result;
    } finally {
        if (db) db.close();
    }
}

/**
 * Wipe the local SQLite XScraper store.
 *
 * This ONLY touches the local scraper cache (%APPDATA%/.xscraper/x_messages.db).
 * PostgreSQL is never touched — anything already reconciled stays in
 * `grok_messages`, and because reconciliation is identity based, clearing the
 * local cache can never cause duplicates later.
 *
 * @param {object} [opts]
 * @param {string} [opts.dbPath]
 * @returns {Promise<{available: boolean, path: string, messagesDeleted: number, conversationsDeleted: number}>}
 */
export async function clearSqliteStore({ dbPath = defaultSqlitePath() } = {}) {
    const result = { available: false, path: dbPath, messagesDeleted: 0, conversationsDeleted: 0 };
    if (!existsSync(dbPath)) return result;

    const sqlite3 = require('sqlite3');
    const db = new sqlite3.Database(dbPath);

    const run = (sql) => new Promise((resolve, reject) => {
        db.run(sql, function (err) { err ? reject(err) : resolve(this.changes || 0); });
    });

    try {
        try { result.messagesDeleted = await run('DELETE FROM messages'); } catch { /* table may not exist */ }
        try { result.conversationsDeleted = await run('DELETE FROM conversations'); } catch { /* optional */ }
        try { await run('VACUUM'); } catch { /* non-fatal */ }
        result.available = true;
        return result;
    } finally {
        if (db) db.close();
    }
}

/**
 * Conversation titles known to the local SQLite store.
 */
export async function readSqliteConversations({ dbPath = defaultSqlitePath() } = {}) {
    const map = new Map();
    if (!existsSync(dbPath)) return map;
    const db = openSqlite(dbPath);
    try {
        const rows = await allAsync(db, `SELECT id, title, message_count, last_scraped FROM conversations`);
        for (const r of rows) map.set(r.id, r);
        return map;
    } finally {
        if (db) db.close();
    }
}

// ------------------------------------------------------------------
// JSON exports (legacy snapshots, optional)
// ------------------------------------------------------------------

export async function readJsonSource({ dir = defaultJsonDir(), conversationId = null } = {}) {
    const result = { available: false, path: dir, byConversation: new Map(), total: 0, titles: new Map() };
    if (!existsSync(dir)) return result;

    let files;
    try {
        files = (await readdir(dir)).filter(f => f.endsWith('.json'));
    } catch {
        return result;
    }
    result.available = true;

    for (const file of files) {
        const cid = file.replace(/\.json$/, '');
        if (conversationId && cid !== conversationId) continue;

        let data;
        try {
            data = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
        } catch {
            continue;
        }

        const messages = Array.isArray(data.messages) ? data.messages : [];
        if (Array.isArray(data.conversations) && data.conversations[0]?.title) {
            result.titles.set(cid, data.conversations[0].title);
        }

        for (const m of messages) {
            const target = m.conversationId || cid;
            if (conversationId && target !== conversationId) continue;
            if (!result.byConversation.has(target)) result.byConversation.set(target, []);
            result.byConversation.get(target).push({ ...m, conversationId: target, __source: 'json' });
            result.total++;
        }
    }
    return result;
}

// ------------------------------------------------------------------
// Combined view
// ------------------------------------------------------------------

/**
 * Read every Node-reachable local XScraper source and merge them per
 * conversation. Merging is by object identity only — de-duplication by
 * canonical identity is the reconciler's job.
 *
 * @returns {Promise<{byConversation: Map<string, Array>, sources: object, titles: Map<string,string>}>}
 */
export async function readLocalXScraperSource({ conversationId = null, sqlitePath, jsonDir } = {}) {
    const sqlite = await readSqliteSource({ dbPath: sqlitePath || defaultSqlitePath(), conversationId });
    const json = await readJsonSource({ dir: jsonDir || defaultJsonDir(), conversationId });
    const convs = await readSqliteConversations({ dbPath: sqlitePath || defaultSqlitePath() });

    const byConversation = new Map();
    const push = (cid, msgs) => {
        if (!byConversation.has(cid)) byConversation.set(cid, []);
        byConversation.get(cid).push(...msgs);
    };
    for (const [cid, msgs] of sqlite.byConversation) push(cid, msgs);
    for (const [cid, msgs] of json.byConversation) push(cid, msgs);

    const titles = new Map(json.titles);
    for (const [cid, row] of convs) {
        if (row.title && !titles.has(cid)) titles.set(cid, row.title);
    }

    return {
        byConversation,
        titles,
        sources: {
            sqlite: { available: sqlite.available, path: sqlite.path, total: sqlite.total },
            json: { available: json.available, path: json.path, total: json.total },
        },
    };
}
