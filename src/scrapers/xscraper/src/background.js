/**
 * BACKGROUND.JS - Service Worker for XScraper
 * Offline-first persistence with optional server sync
 */

console.log('[XSCRAPER_BACKGROUND] Service worker initialized');

const SERVER_URL = 'http://localhost:3000';
let localDb = null;

/**
 * Server sync control (prevents spam + CORS flooding)
 */
let lastServerAttempt = 0;
const SERVER_COOLDOWN_MS = 10000;
const USE_SERVER = false; // <- IMPORTANT: disable unless backend is ready

/**
 * Initialize IndexedDB
 */
async function initializeLocalDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('XScraper', 1);

        request.onerror = () => reject(request.error);

        request.onsuccess = () => {
            localDb = request.result;
            console.log('[XSCRAPER_BACKGROUND] Local database ready');
            resolve(localDb);
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
 * Server save (optional, non-blocking)
 */
async function saveToSQLiteServer(messages, conversationId, conversationTitle) {
    if (!USE_SERVER) return { skipped: true };

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
        console.warn('[XSCRAPER_BACKGROUND] Server unavailable:', err.message || err);
        return { offline: true, error: String(err?.message || err) };
    }
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
    if (!localDb) await initializeLocalDatabase();

    const tx = localDb.transaction(['conversations'], 'readwrite');
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
    if (!localDb) await initializeLocalDatabase();

    // rate limit server attempts
    const now = Date.now();
    let serverResult = { skipped: true };

    if (USE_SERVER && now - lastServerAttempt > SERVER_COOLDOWN_MS) {
        lastServerAttempt = now;
        serverResult = await saveToSQLiteServer(messages, conversationId, conversationTitle);
    }

    // Also save conversation metadata
    await handleSaveConversation(conversationId, conversationTitle);

    const tx = localDb.transaction(['messages'], 'readwrite');
    const store = tx.objectStore('messages');

    let saved = 0;

    for (const m of messages) {
        const msg = {
            ...m,
            id: m.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            savedAt: Date.now(),
            conversationId
        };

        try {
            store.add(msg);
            saved++;
        } catch {
            // duplicate ignored
        }
    }

    return new Promise((resolve, reject) => {
        tx.oncomplete = () => {
            console.log(`[XSCRAPER_BACKGROUND] Saved ${saved} messages (local)`);

            resolve({
                saved,
                localBackup: true,
                serverUsed: USE_SERVER,
                serverResult,
                // attachments are persisted as part of message objects (metadata/url only)
                attachmentCount: messages.reduce((acc, m) => acc + (Array.isArray(m.attachments) ? m.attachments.length : 0), 0)
            });
        };

        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Get messages
 */
async function handleGetMessages() {
    if (!localDb) await initializeLocalDatabase();

    return new Promise((resolve, reject) => {
        const tx = localDb.transaction(['messages'], 'readonly');
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
    if (!localDb) await initializeLocalDatabase();

    const localStats = await new Promise((resolve, reject) => {
        const tx = localDb.transaction(['messages', 'conversations'], 'readonly');

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
    if (!localDb) await initializeLocalDatabase();

    return new Promise((resolve, reject) => {
        const tx = localDb.transaction(['messages', 'conversations', 'metadata'], 'readwrite');

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
    if (!localDb) await initializeLocalDatabase();

    return new Promise((resolve, reject) => {
        const tx = localDb.transaction(['messages', 'conversations'], 'readonly');

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
    if (!localDb) await initializeLocalDatabase();

    return new Promise((resolve, reject) => {
        const tx = localDb.transaction(['messages'], 'readonly');
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