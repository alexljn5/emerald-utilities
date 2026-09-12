import { invoke } from '../../utils/electronApi.js';

export async function checkFirefoxInstalled() {
    try {
        const result = await invoke('xscraper:check-firefox');
        return result?.installed ?? false;
    } catch (err) {
        console.error('[XScraper] checkFirefoxInstalled error:', err);
        return false;
    }
}

export async function launchFirefox({ url, extensionPath = 'x_scraper' }) {
    try {
        const result = await invoke('xscraper:launch-firefox', {
            url: url || 'https://grok.com',
            extensionPath
        });
        return result;
    } catch (err) {
        console.error('[XScraper] launchFirefox error:', err);
        return { success: false, error: err.message };
    }
}

export function getDefaultPages() {
    return [
        { id: 'grok', name: 'Grok', url: 'https://grok.com' },
        { id: 'x', name: 'X', url: 'https://x.com' },
        { id: 'grok-x', name: 'Grok X', url: 'https://grok.x.com' }
    ];
}

export async function exportData(exportData, filename) {
    try {
        const result = await invoke('xscraper:export-data', exportData, filename);
        return result;
    } catch (err) {
        console.error('[XScraper] exportData error:', err);
        return { success: false, error: err.message };
    }
}

export async function getRealtimeStats(webview) {
    try {
        if (!webview) {
            return { success: false, stats: { seen: 0, queue: 0 } };
        }
        const result = await webview.executeJavaScript(`
            (function() {
                if (window.__grokScraper && typeof window.__grokScraper.debug === 'function') {
                    return window.__grokScraper.debug();
                }
                return { seen: 0, queue: 0, stuck: 0, idle: 0 };
            })()
        `);
        return { success: true, stats: result };
    } catch (err) {
        console.error('[XScraper] getRealtimeStats error:', err);
        return { success: false, stats: { seen: 0, queue: 0 } };
    }
}

export async function startRealtimeCrawler(webview) {
    try {
        if (!webview) {
            return { success: false, error: 'No webview' };
        }
        await webview.executeJavaScript(`
            (function() {
                if (window.__grokScraper && typeof window.__grokScraper.startCrawler === 'function') {
                    window.__grokScraper.startCrawler();
                    return { success: true };
                }
                return { success: false, error: 'Crawler not available' };
            })()
        `);
        return { success: true };
    } catch (err) {
        console.error('[XScraper] startRealtimeCrawler error:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Run the complete AUTO+SCRAPE cycle in the content script:
 * scrape current conversation -> persist to SQLite -> notify main process.
 */
export async function scrapeAndForwardInWebview(webview, timeout = 8000) {
    try {
        if (!webview) {
            return { success: false, error: 'No webview' };
        }
        const result = await webview.executeJavaScript(`
            (function() {
                if (window.__grokScraper && typeof window.__grokScraper.scrapeAndForward === 'function') {
                    return window.__grokScraper.scrapeAndForward(${timeout});
                }
                return { success: false, error: 'scrapeAndForward not available' };
            })()
        `);
        return result;
    } catch (err) {
        console.error('[XScraper] scrapeAndForwardInWebview error:', err);
        return { success: false, error: err.message };
    }
}

export async function stopRealtimeCrawler(webview) {
    try {
        if (!webview) {
            return { success: false, error: 'No webview' };
        }
        await webview.executeJavaScript(`
            (function() {
                if (window.__grokScraper && typeof window.__grokScraper.stopCrawler === 'function') {
                    window.__grokScraper.stopCrawler();
                    return { success: true };
                }
                return { success: false, error: 'Crawler not available' };
            })()
        `);
        return { success: true };
    } catch (err) {
        console.error('[XScraper] stopRealtimeCrawler error:', err);
        return { success: false, error: err.message };
    }
}

export async function exportIncremental(webview, since) {
    try {
        if (!webview) {
            return { success: false, error: 'No webview' };
        }
        if (typeof since !== 'number') {
            return { success: false, error: 'Invalid since parameter' };
        }
        const result = await webview.executeJavaScript(`
            (function() {
                if (window.__grokScraper && typeof window.__grokScraper.exportIncrementalJSON === 'function') {
                    return window.__grokScraper.exportIncrementalJSON(${since});
                }
                return { success: false, error: 'Incremental export not available' };
            })()
        `);
        return result;
    } catch (err) {
        console.error('[XScraper] exportIncremental error:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Get new messages from the local server since a given timestamp.
 * Used for real-time forwarding to PostgreSQL.
 */
export async function getNewMessages(since, conversationId = null) {
    try {
        const result = await invoke('xscraper:get-new-messages', { since, conversationId });
        return result;
    } catch (err) {
        console.error('[XScraper] getNewMessages error:', err);
        return { success: false, error: err.message, messages: [] };
    }
}

/**
 * Forward scraped messages to PostgreSQL.
 * Used for real-time database persistence.
 */
export async function forwardToPostgres(messages, conversationId, conversationTitle = 'Scraped Conversation') {
    try {
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return { success: true, inserted: 0, skipped: 0 };
        }
        const result = await invoke('xscraper:forward-to-postgres', {
            messages,
            conversationId,
            conversationTitle
        });
        return result;
    } catch (err) {
        console.error('[XScraper] forwardToPostgres error:', err);
        return { success: false, error: err.message, inserted: 0, skipped: 0 };
    }
}

/**
 * Start the local XScraper server (bridge between extension and Electron)
 */
export async function startLocalServer() {
    try {
        const result = await invoke('xscraper:start-local-server');
        return result;
    } catch (err) {
        console.error('[XScraper] startLocalServer error:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Stop the local XScraper server
 */
export async function stopLocalServer() {
    try {
        const result = await invoke('xscraper:stop-local-server');
        return result;
    } catch (err) {
        console.error('[XScraper] stopLocalServer error:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Forward all exported XScraper JSON data to PostgreSQL.
 * Reads from src/database/grok/messages/ and inserts into grok_messages.
 */
export async function forwardExportedToPostgres() {
    try {
        const result = await invoke('xscraper:forward-exported-to-postgres');
        return result;
    } catch (err) {
        console.error('[XScraper] forwardExportedToPostgres error:', err);
        return { success: false, error: err.message, inserted: 0, skipped: 0, errors: 0 };
    }
}

/**
 * Clear all exported XScraper JSON files.
 * Deletes files from src/database/grok/messages/ and src/database/grok/*.json
 */
export async function clearExports() {
    try {
        const result = await invoke('xscraper:clear-exports');
        return result;
    } catch (err) {
        console.error('[XScraper] clearExports error:', err);
        return { success: false, error: err.message, deleted: 0 };
    }
}

/**
 * Wipe the LOCAL XScraper store (SQLite cache + extension IndexedDB + JSON
 * snapshots). PostgreSQL is never touched — messages already reconciled into
 * grok_messages remain there, and re-scraping cannot create duplicates because
 * reconciliation is identity based.
 *
 * @param {{sqlite?: boolean, indexeddb?: boolean, exports?: boolean}} [options]
 */
export async function clearLocalStore(options = {}) {
    try {
        const result = await invoke('xscraper:clear-local-store', options);
        return result;
    } catch (err) {
        console.error('[XScraper] clearLocalStore error:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Read-only XScraper sync diagnostic (local vs PostgreSQL). Never writes.
 */
export async function diagnoseSync(conversationId = null) {
    try {
        const result = await invoke('xscraper:diagnose', { conversationId });
        return result;
    } catch (err) {
        console.error('[XScraper] diagnoseSync error:', err);
        return { success: false, error: err.message };
    }
}

// ============================================================
// Durable forwarder service API (the ONE canonical pipeline)
// ============================================================

/**
 * Duplicate-safe persist of scraped messages into the durable SQLite queue.
 * Messages are marked unforwarded so the batch worker picks them up.
 */
export async function saveToSqlite(messages, conversationId, conversationTitle) {
    try {
        const result = await invoke('xscraper:save-to-sqlite', { messages, conversationId, conversationTitle });
        return result;
    } catch (err) {
        console.error('[XScraper] saveToSqlite error:', err);
        return { success: false, error: err.message, inserted: 0, duplicates: 0, total: 0 };
    }
}

/**
 * Force the batch worker to run now (manual "Send to PostgreSQL").
 */
export async function forwardPending() {
    try {
        const result = await invoke('xscraper:forward-pending');
        return result;
    } catch (err) {
        console.error('[XScraper] forwardPending error:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Start the singleton batch worker.
 */
export async function startForwardWorker() {
    try {
        const result = await invoke('xscraper:worker-start');
        return result;
    } catch (err) {
        console.error('[XScraper] startForwardWorker error:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Stop the singleton batch worker.
 */
export async function stopForwardWorker() {
    try {
        const result = await invoke('xscraper:worker-stop');
        return result;
    } catch (err) {
        console.error('[XScraper] stopForwardWorker error:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Live forwarder status (SQLite local/pending/forwarded/failed, PG, worker).
 */
export async function getForwardStatus() {
    try {
        const result = await invoke('xscraper:get-forward-status');
        return result;
    } catch (err) {
        console.error('[XScraper] getForwardStatus error:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Clear fully-forwarded messages from the local SQLite queue.
 */
export async function clearSent() {
    try {
        const result = await invoke('xscraper:clear-sent');
        return result;
    } catch (err) {
        console.error('[XScraper] clearSent error:', err);
        return { success: false, error: err.message, deleted: 0 };
    }
}

/**
 * One-click SCRAPE + FORWARD workflow in the main process.
 */
export async function scrapeAndForward() {
    try {
        const result = await invoke('xscraper:scrape-and-forward');
        return result;
    } catch (err) {
        console.error('[XScraper] scrapeAndForward error:', err);
        return { success: false, error: err.message };
    }
}

/**
 * One-time reconciliation of legacy JSON exports into PostgreSQL.
 */
export async function forwardLegacyToPostgres() {
    try {
        const result = await invoke('xscraper:forward-legacy');
        return result;
    } catch (err) {
        console.error('[XScraper] forwardLegacyToPostgres error:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Auto-forward verification: insert a test message into the durable SQLite
 * queue, drain it, and confirm it reached PostgreSQL.
 */
export async function verifyAutoForward() {
    try {
        const result = await invoke('xscraper:verify-forward');
        return result;
    } catch (err) {
        console.error('[XScraper] verifyAutoForward error:', err);
        return { success: false, error: err.message };
    }
}
