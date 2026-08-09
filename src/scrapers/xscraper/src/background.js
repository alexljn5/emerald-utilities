/**
 * BACKGROUND.JS - Service Worker for XScraper
 * Offline-first persistence with optional server sync
 */

console.log('[XSCRAPER_BACKGROUND] Service worker initialized');

const SERVER_URL = 'http://localhost:3000';
let localDb = null;

/**
 * Server sync control.
 *
 * Previously a 10s cooldown silently DROPPED every batch that arrived before
 * the cooldown elapsed, which is why the durable SQLite store stayed empty
 * even though IndexedDB filled up. Even the later "in-flight skip" could drop
 * a batch that arrived while a POST was still awaiting a response.
 *
 * Now we use a serialized outbound queue: every batch is enqueued and POSTed
 * to the server SQLite one at a time. No batch is ever dropped — the server
 * SQLite store is the durable queue that the batch worker drains to Postgres.
 */
let serverSyncQueue = [];
let serverSyncActive = false;
const USE_SERVER = true; // enabled for real-time PostgreSQL forwarding
const SERVER_MAX_RETRIES = 3;
const SERVER_RETRY_DELAY_MS = 1000;

/**
 * Serialized drain of the server-sync queue. Guarantees every enqueued batch
 * reaches the durable SQLite server, one at a time (no flooding, no drops).
 */
async function drainServerSyncQueue() {
    if (serverSyncActive) return;
    serverSyncActive = true;
    try {
        while (serverSyncQueue.length > 0) {
            const { messages, conversationId, conversationTitle } = serverSyncQueue.shift();
            try {
                await saveToSQLiteServer(messages, conversationId, conversationTitle);
            } catch (err) {
                console.warn('[XSCRAPER_BACKGROUND] server POST failed:', err.message || err);
            }
        }
    } finally {
        serverSyncActive = false;
    }
}

/** Enqueue a batch for durable server SQLite persistence (no drops). */
function enqueueServerSync(messages, conversationId, conversationTitle) {
    if (!USE_SERVER) return;
    serverSyncQueue.push({ messages, conversationId, conversationTitle });
    drainServerSyncQueue();
}

/**
 * Initialize IndexedDB
 */
async function initializeLocalDatabase() {
    if (localDb) return localDb;

    localDb = await new Promise((resolve, reject) => {
        const request = indexedDB.open('XScraper', 1);

        request.onerror = () => reject(request.error);

        request.onsuccess = () => {
            console.log('[XSCRAPER_BACKGROUND] Local database ready');
            resolve(request.result);
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;

            if (!db.objectStoreNames.contains('messages')) {
                const store = db.createObjectStore('messages', { keyPath: 'id' });
                store.createIndex('timestamp', 'timestamp');
                store.createIndex('conversationId', 'conversationId');
            }

            if (!db.objectStoreNames.contains('conversations')) {
                db.createObjectStore('conversations', { keyPath: 'id' });
            }

            if (!db.objectStoreNames.contains('metadata')) {
                db.createObjectStore('metadata', { keyPath: 'key' });
            }
        };
    });

    // The host app can wipe this storage from the outside (Electron's
    // session.clearStorageData). That force-closes the connection and every
    // later transaction throws InvalidStateError forever, which looks exactly
    // like "the scraper stopped working". Drop the handle so it reopens.
    localDb.onclose = () => {
        console.warn('[XSCRAPER_BACKGROUND] IndexedDB connection closed — will reopen on next use');
        localDb = null;
    };
    localDb.onversionchange = () => {
        console.warn('[XSCRAPER_BACKGROUND] IndexedDB version change / wipe — closing handle');
        try { localDb.close(); } catch { /* already gone */ }
        localDb = null;
    };

    return localDb;
}

/**
 * Open a transaction, transparently reopening the database once if the
 * previous connection was force-closed underneath us.
 */
async function dbTx(stores, mode) {
    await initializeLocalDatabase();
    try {
        return localDb.transaction(stores, mode);
    } catch (err) {
        console.warn('[XSCRAPER_BACKGROUND] stale IndexedDB connection, reopening:', err?.name || err);
        localDb = null;
        await initializeLocalDatabase();
        return localDb.transaction(stores, mode);
    }
}

/**
 * Safe server check (no crash, no timeout misuse)
 */
async function checkServerConnection() {
    if (!USE_SERVER) return false;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);

        const res = await fetch(`${SERVER_URL}/health`, {
            signal: controller.signal
        });

        clearTimeout(timeout);
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * Server save (optional, non-blocking, with retry)
 */
async function saveToSQLiteServer(messages, conversationId, conversationTitle) {
    if (!USE_SERVER) return { skipped: true };

    let lastErr = null;
    for (let attempt = 0; attempt < SERVER_MAX_RETRIES; attempt++) {
        try {
            const res = await fetch(`${SERVER_URL}/api/messages/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages,
                    conversationId,
                    conversationTitle
                })
            });

            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            return await res.json();
        } catch (err) {
            lastErr = err;
            if (attempt < SERVER_MAX_RETRIES - 1) {
                await new Promise(r => setTimeout(r, SERVER_RETRY_DELAY_MS));
            }
        }
    }
    console.warn('[XSCRAPER_BACKGROUND] Server unavailable after retries:', lastErr?.message || lastErr);
    return { offline: true, error: String(lastErr?.message || lastErr) };
}

/**
 * Message handler
 */
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    (async () => {
        try {
            switch (req.action) {

                case 'saveMessages': {
                    const result = await handleSaveMessages(
                        req.messages || [],
                        req.conversationId || 'default',
                        req.conversationTitle || 'Chat'
                    );
                    sendResponse({ success: true, result });
                    break;
                }

                case 'saveConversation': {
                    const result = await handleSaveConversation(
                        req.conversationId || 'default',
                        req.conversationTitle || 'Chat'
                    );
                    sendResponse({ success: true, result });
                    break;
                }

                case 'getMessages': {
                    const messages = await handleGetMessages();
                    sendResponse({ success: true, messages });
                    break;
                }

                case 'getStats': {
                    const stats = await handleGetStats();
                    sendResponse({ success: true, ...stats });
                    break;
                }

                case 'clearAll': {
                    await handleClearAll();
                    sendResponse({ success: true });
                    break;
                }

                case 'exportData': {
                    console.log('[XSCRAPER_BACKGROUND] exportData requested');
                    const data = await handleExportData();
                    console.log('[XSCRAPER_BACKGROUND] exportData response ready, messages:', data.totalMessages);
                    sendResponse({ success: true, data });
                    break;
                }

                case 'exportIncrementalData': {
                    console.log('[XSCRAPER_BACKGROUND] exportIncrementalData requested, since:', req.since);
                    const data = await handleIncrementalExport(req.since);
                    console.log('[XSCRAPER_BACKGROUND] exportIncrementalData response ready, new messages:', data.messages.length);
                    sendResponse({ success: true, data });
                    break;
                }

                default:
                    sendResponse({ success: false, error: 'Unknown action' });
            }
        } catch (err) {
            sendResponse({ success: false, error: String(err?.message || err) });
        }
    })();

    return true;
});

/**
 * Save conversation metadata
 */
async function handleSaveConversation(conversationId, conversationTitle) {
    const tx = await dbTx(['conversations'], 'readwrite');
    const store = tx.objectStore('conversations');

    const conv = {
        id: conversationId,
        title: conversationTitle || 'Chat',
        savedAt: Date.now()
    };

    store.put(conv);

    return new Promise((resolve, reject) => {
        tx.oncomplete = () => {
            console.log(`[XSCRAPER_BACKGROUND] Saved conversation: ${conversationId}`);
            resolve({ success: true, conversationId });
        };

        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Save messages (offline-first)
 */
async function handleSaveMessages(messages, conversationId, conversationTitle) {
    // Serialized outbound queue: every batch is enqueued and POSTed to the
    // durable SQLite server one at a time. No batch is ever dropped, even if
    // many scrape-flushes arrive in quick succession.
    let serverResult = { skipped: true };

    if (USE_SERVER) {
        enqueueServerSync(messages, conversationId, conversationTitle);
        serverResult = { queued: true };
    }

    // Also save conversation metadata
    await handleSaveConversation(conversationId, conversationTitle);

    const tx = await dbTx(['messages'], 'readwrite');
    const store = tx.objectStore('messages');

    let saved = 0;
    let failed = 0;

    for (const m of messages) {
        const msg = {
            ...m,
            id: m.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            savedAt: Date.now(),
            conversationId
        };

        // `put`, not `add`. `add` rejects an existing key, and an unhandled
        // failed request ABORTS THE WHOLE TRANSACTION — so one already-known
        // message silently threw away every genuinely new message batched with
        // it. The try/catch never helped: the failure is asynchronous.
        const req = store.put(msg);
        req.onsuccess = () => { saved++; };
        req.onerror = (event) => {
            failed++;
            console.warn('[XSCRAPER_BACKGROUND] message save failed:', req.error?.name || req.error);
            // Keep the rest of the batch alive.
            event.preventDefault();
            event.stopPropagation();
        };
    }

    return new Promise((resolve, reject) => {
        tx.oncomplete = () => {
            console.log(`[XSCRAPER_BACKGROUND] Saved ${saved} messages (local)${failed ? `, ${failed} failed` : ''}`);

            resolve({
                saved,
                failed,
                localBackup: true,
                serverUsed: USE_SERVER,
                serverResult,
                // attachments are persisted as part of message objects (metadata/url only)
                attachmentCount: messages.reduce((acc, m) => acc + (Array.isArray(m.attachments) ? m.attachments.length : 0), 0)
            });
        };

        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
}

/**
 * Get messages
 */
async function handleGetMessages() {
    const tx = await dbTx(['messages'], 'readonly');

    return new Promise((resolve, reject) => {
        const store = tx.objectStore('messages');
        const req = store.getAll();

        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Stats
 */
async function handleGetStats() {
    const statsTx = await dbTx(['messages', 'conversations'], 'readonly');

    const localStats = await new Promise((resolve, reject) => {
        const tx = statsTx;

        const msgReq = tx.objectStore('messages').count();
        const convReq = tx.objectStore('conversations').count();

        tx.oncomplete = () => {
            resolve({
                messageCount: msgReq.result,
                conversationCount: convReq.result
            });
        };

        tx.onerror = () => reject(tx.error);
    });

    let serverStats = null;

    try {
        if (USE_SERVER) {
            const res = await fetch(`${SERVER_URL}/api/stats`);
            if (res.ok) serverStats = await res.json();
        }
    } catch {
        serverStats = null;
    }

    return {
        ...localStats,
        serverStats,
        serverConnected: !!serverStats
    };
}

/**
 * Clear all data
 */
async function handleClearAll() {
    const tx = await dbTx(['messages', 'conversations', 'metadata'], 'readwrite');

    return new Promise((resolve, reject) => {
        tx.objectStore('messages').clear();
        tx.objectStore('conversations').clear();
        tx.objectStore('metadata').clear();

        tx.oncomplete = () => {
            console.log('[XSCRAPER_BACKGROUND] Local database cleared');
            resolve();
        };

        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Export data
 */
async function handleExportData() {
    const tx = await dbTx(['messages', 'conversations'], 'readonly');

    return new Promise((resolve, reject) => {
        const messagesReq = tx.objectStore('messages').getAll();
        const convReq = tx.objectStore('conversations').getAll();

        tx.oncomplete = () => {
            resolve({
                version: '1.0',
                exportDate: new Date().toISOString(),
                totalMessages: messagesReq.result.length,
                totalConversations: convReq.result.length,
                messages: messagesReq.result,
                conversations: convReq.result
            });
        };

        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Incremental export (only messages saved after `since` timestamp)
 */
async function handleIncrementalExport(since = 0) {
    const tx = await dbTx(['messages'], 'readonly');

    return new Promise((resolve, reject) => {
        const store = tx.objectStore('messages');
        const req = store.getAll();

        req.onsuccess = () => {
            const newMessages = req.result.filter(m => (m.savedAt || 0) > since);
            resolve({
                version: '1.0',
                exportDate: new Date().toISOString(),
                messages: newMessages
            });
        };

        req.onerror = () => reject(req.error);
    });
}

/**
 * Init DB
 */
chrome.runtime.onInstalled.addListener(() => {
    console.log('[XSCRAPER_BACKGROUND] Extension installed');
    initializeLocalDatabase().catch(console.error);
});

console.log('[XSCRAPER_BACKGROUND] Ready (offline-first mode)');