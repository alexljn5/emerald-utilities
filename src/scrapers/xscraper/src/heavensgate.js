(function () {
    'use strict';

    let observer;
    let seen = new Set();
    let queue = [];

    let lastMutationTime = Date.now();
    let lastScrollTime = 0;

    let scrollStuckCounter = 0;

    const SCAN_INTERVAL = 800;
    const WATCHDOG_INTERVAL = 2000;
    const IDLE_THRESHOLD = 6000;

    // Current conversation ID extracted from the page
    let currentConversationId = 'default';
    let currentConversationTitle = 'Chat';

    function extractConversationId() {
        // 1. Try URL first: https://grok.com/app?conversationId=<UUID> or /c/<UUID> or hash
        try {
            const url = window.location.href;
            // Query param
            const urlMatch = url.match(/conversationId=([a-f0-9-]+)/i) || url.match(/\/c\/([a-f0-9-]+)/i);
            if (urlMatch && urlMatch[1]) {
                console.log('[XSCRAPER_DAEMON] conversationId from URL:', urlMatch[1]);
                return urlMatch[1];
            }
            // Hash fragment: #<UUID> or #conversation/<UUID>
            const hashMatch = url.match(/#([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i) ||
                url.match(/#conversation\/([a-f0-9-]+)/i);
            if (hashMatch && hashMatch[1]) {
                console.log('[XSCRAPER_DAEMON] conversationId from URL hash:', hashMatch[1]);
                return hashMatch[1];
            }
        } catch (e) { /* ignore */ }

        // 2. Try window.__NEXT_DATA__ or similar state objects (deep search for UUID)
        try {
            const state = window.__NEXT_DATA__ || window.__APP_STATE__ || window.__GROK_STATE__;
            if (state) {
                if (state.conversationId) {
                    console.log('[XSCRAPER_DAEMON] conversationId from state.conversationId:', state.conversationId);
                    return state.conversationId;
                }
                if (state.chat && state.chat.id) {
                    console.log('[XSCRAPER_DAEMON] conversationId from state.chat.id:', state.chat.id);
                    return state.chat.id;
                }
                if (state.currentConversationId) {
                    console.log('[XSCRAPER_DAEMON] conversationId from state.currentConversationId:', state.currentConversationId);
                    return state.currentConversationId;
                }
                // Deep search for any UUID-like string in state
                const json = JSON.stringify(state);
                const uuidMatch = json.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
                if (uuidMatch) {
                    console.log('[XSCRAPER_DAEMON] conversationId from deep state search:', uuidMatch[1]);
                    return uuidMatch[1];
                }
            }
        } catch (e) { /* ignore */ }

        // 3. Try to find in DOM: data attributes, meta tags, or any element with UUID-like content
        try {
            const selectors = [
                '[data-conversation-id]',
                '[data-chat-id]',
                '[data-thread-id]',
                '[data-session-id]',
                '[data-current-conversation]',
                'meta[name="conversation-id"]',
                'meta[name="chat-id"]',
                '[id*="conversation"]',
                '[id*="chat-"]',
                '[id*="thread-"]'
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) {
                    const id = el.getAttribute('data-conversation-id') ||
                        el.getAttribute('data-chat-id') ||
                        el.getAttribute('data-thread-id') ||
                        el.getAttribute('data-session-id') ||
                        el.getAttribute('data-current-conversation') ||
                        el.getAttribute('content') ||
                        el.id;
                    if (id && /^[a-f0-9-]+$/i.test(id)) {
                        console.log('[XSCRAPER_DAEMON] conversationId from DOM selector', sel, ':', id);
                        return id;
                    }
                }
            }

            // Search all elements for UUID-like text content or attributes
            const allElements = document.querySelectorAll('*');
            for (const el of allElements) {
                for (const attr of ['id', 'data-id', 'data-conversation', 'data-thread', 'data-conversation-id']) {
                    const val = el.getAttribute(attr);
                    if (val && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(val)) {
                        console.log('[XSCRAPER_DAEMON] conversationId from DOM attr', attr, ':', val);
                        return val;
                    }
                }
            }
        } catch (e) { /* ignore */ }

        // 4. Try to find in script tags or inline scripts
        try {
            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const text = script.textContent || script.innerText;
                const uuidMatch = text.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
                if (uuidMatch) {
                    console.log('[XSCRAPER_DAEMON] conversationId from script tag:', uuidMatch[1]);
                    return uuidMatch[1];
                }
            }
        } catch (e) { /* ignore */ }

        console.log('[XSCRAPER_DAEMON] conversationId not found, using default');
        return 'default';
    }

    function extractConversationTitle() {
        try {
            // Try to get title from page
            const titleEl = document.querySelector('h1, h2, [data-title]');
            if (titleEl) {
                const title = titleEl.textContent?.trim() || titleEl.getAttribute('data-title');
                if (title && title.length > 0 && title.length < 100) return title;
            }

            // Try URL or state
            const state = window.__NEXT_DATA__ || window.__APP_STATE__ || window.__GROK_STATE__;
            if (state && state.title) return state.title;
            if (state && state.chat && state.chat.title) return state.chat.title;
        } catch (e) { /* ignore */ }

        return 'Chat';
    }

    function updateConversationContext() {
        currentConversationId = extractConversationId();
        currentConversationTitle = extractConversationTitle();
    }

    function init() {
        console.log('[XSCRAPER_DAEMON] starting');

        updateConversationContext();
        startObserver();
        startFlush();
        startWatchdog();
        startMessageBridge();
        // NOTE: do NOT auto-start the crawler on page load. The crawler should
        // only run when manually triggered (via popup button or explicit API).

        window.__grokScraper = {
            debug,
            forceScroll,
            startCrawler: startAutoScrollLoop,
            stopCrawler: stopAutoScrollLoop,
            scrapeAll,
            scrape,
            exportAsJSON,
            exportIncrementalJSON,
            resetSeen,
            scrapeAndForward,
            restart: () => {
                seen.clear();
                startObserver();
                forceScroll();
            }
        };
    }
    /* ---------------- OBSERVER ---------------- */

    function startObserver() {
        if (observer) observer.disconnect();

        observer = new MutationObserver((mutations) => {
            lastMutationTime = Date.now();

            // Refresh conversation context on any DOM mutation (chat switch, nav, etc.)
            updateConversationContext();

            for (const m of mutations) {
                for (const n of m.addedNodes) {
                    if (n.nodeType !== 1) continue;
                    processNode(n);

                    n.querySelectorAll?.('article, div, p').forEach(processNode);
                }
            }
        });

        observer.observe(document.body, {
            subtree: true,
            childList: true
        });

        console.log('[XSCRAPER_DAEMON] observer active');
    }

    /* ---------------- PROCESS ---------------- */

    function processNode(node) {
        const msg = extract(node);
        if (!msg || seen.has(msg.id)) return;

        seen.add(msg.id);
        queue.push(msg);
    }

    /**
     * Drop the in-memory dedupe cache.
     *
     * `seen` is what stops the same DOM node being queued twice, but it also
     * means that once the local store is wiped the scraper will never re-emit
     * anything it already looked at — the page keeps scrolling and nothing is
     * ever saved again. Clearing local storage MUST clear this too.
     */
    function resetSeen() {
        const had = seen.size;
        seen.clear();
        queue.length = 0;
        console.log(`[XSCRAPER_DAEMON] seen cache reset (dropped ${had} ids)`);
        // Re-walk what is already on screen so the current view is captured
        // again without waiting for new mutations.
        try {
            document.querySelectorAll('article, div, p').forEach(processNode);
        } catch (e) { /* ignore */ }
        return { success: true, dropped: had, queued: queue.length };
    }

    /**
     * Best-effort DOM author detection for a scraped message node.
     *
     * Walks up from the message element looking for common author markers
     * (data-author, data-username, .author, .username, role classes, name
     * attributes). Falls back to 'Grok' when none are found — the local
     * SQLite store requires a non-null author, and an empty author used to
     * make the whole save batch fail with SQLITE_CONSTRAINT.
     */
    function detectAuthor(el) {
        try {
            // Walk up a bounded number of ancestors (the message container).
            let node = el;
            for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
                // data-author / data-username / data-name attributes
                for (const attr of ['data-author', 'data-username', 'data-user', 'data-name', 'data-role-name']) {
                    const v = node.getAttribute?.(attr);
                    if (v && v.trim()) return v.trim();
                }
                // role classes: .assistant / .user / .human / .grok / .bot
                if (node.classList && node.classList.length) {
                    const cls = [...node.classList].join(' ');
                    const lower = cls.toLowerCase();
                    if (/assistant|grok|bot|ai\b/.test(lower)) return 'Grok';
                    if (/user|human|you\b/.test(lower)) return 'You';
                }
                // aria labels / titles sometimes carry the speaker name
                const aria = node.getAttribute?.('aria-label') || node.getAttribute?.('title');
                if (aria && aria.trim()) {
                    const clean = aria.replace(/^(message|from|by)\s*:?\s*/i, '').trim();
                    if (clean && clean.length < 40) return clean;
                }
                // direct child author/username elements
                const authorEl = node.querySelector?.('[data-author], [data-username], .author, .username, [class*="username"]');
                if (authorEl) {
                    const t = authorEl.textContent?.trim();
                    if (t && t.length < 40) return t;
                }
            }
        } catch (e) { /* ignore */ }

        return 'Grok';
    }

    function extract(el) {
        const text = el.textContent?.trim();
        if (!text || text.length < 3) return null;

        // Try to preserve original message ID from DOM attributes
        const originalId = el.getAttribute?.('data-message-id') ||
            el.getAttribute?.('data-msg-id') ||
            el.getAttribute?.('data-id') ||
            null;

        // Deterministic identity: conversation-scoped, stable across re-scrapes.
        // Preference: original DOM id > content-hash (conversation-scoped).
        const stableId = originalId || `m_${hash(`${currentConversationId}\u0000${text}`)}`;

        return {
            id: stableId,
            content: text,
            author: detectAuthor(el),
            ts: Date.now(),
            conversationId: currentConversationId,
            conversationTitle: currentConversationTitle
        };
    }

    function hash(s) {
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
        return 'm_' + h;
    }

    /* ---------------- AUTO SCROLL ENGINE ---------------- */

    let _autoScrollTimerId = null; // holds the interval id when crawler is running

    function startAutoScrollLoop() {
        if (_autoScrollTimerId) return; // already running

        _autoScrollTimerId = setInterval(() => {
            const container = findScroll();

            if (!container) return;

            const before = container.scrollTop;

            // scroll DOWN to load older messages (user-facing control can decide direction)
            // Use positive deltaY to simulate wheel-down; adjust as needed.
            container.scrollTop = Math.max(0, container.scrollTop - 300);
            container.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }));

            const after = container.scrollTop;

            if (before === after) {
                scrollStuckCounter++;
            } else {
                scrollStuckCounter = 0;
            }

            lastScrollTime = Date.now();
        }, SCAN_INTERVAL);
    }

    function stopAutoScrollLoop() {
        if (!_autoScrollTimerId) return;
        clearInterval(_autoScrollTimerId);
        _autoScrollTimerId = null;
    }

    async function scrapeAll(timeout = 8000) {
        // Start the crawler, let it run for `timeout` ms, then stop and return a summary.
        console.log(`[XScraper][AUTO+SCRAPE] Starting cycle targetConv=${currentConversationId}`);
        startAutoScrollLoop();
        await new Promise(r => setTimeout(r, timeout));
        stopAutoScrollLoop();
        const result = { success: true, duration: timeout, seen: seen.size, queued: queue.length };
        console.log(`[XScraper][AUTO+SCRAPE] Scrape complete: seen=${result.seen} queued=${result.queued}`);
        return result;
    }

    /**
     * Complete AUTO+SCRAPE cycle: scrape current conversation, persist to SQLite,
     * forward to PostgreSQL, drain transient queue.
     */
    async function scrapeAndForward(timeout = 8000) {
        const cycleId = `cycle_${Date.now()}`;
        console.log(`[XScraper][AUTO+SCRAPE][${cycleId}] Starting cycle targetConv=${currentConversationId}`);

        try {
            // 1. Scrape current conversation
            updateConversationContext();
            const scrapeResult = await scrapeAll(timeout);
            const discovered = scrapeResult.seen;
            const queued = scrapeResult.queued;

            console.log(`[XScraper][QUEUE] before: scrape=${queued} pending=${queue.length}`);

            // 2. Force-flush any remaining in-memory messages to the durable SQLite server
            // The startFlush interval handles this normally, but we force it here to
            // ensure no messages are lost when the cycle ends.
            if (queue.length > 0) {
                const batch = queue.splice(0, 200);
                const enrichedBatch = batch.map(m => ({
                    ...m,
                    conversationId: currentConversationId,
                    conversationTitle: currentConversationTitle
                }));
                const now = Date.now();
                if (now - serverLastAttempt >= SERVER_COOLDOWN_MS) {
                    serverLastAttempt = now;
                    await saveToServer(enrichedBatch, currentConversationId, currentConversationTitle);
                }
                console.log(`[XScraper][AUTO+SCRAPE][${cycleId}] Force-flushed ${batch.length} messages to SQLite`);
            }

            console.log(`[XScraper][QUEUE] after persistence: scrape=0 pending=${queue.length}`);

            // 3. Notify the main process to run the batch worker
            // The worker will drain SQLite → PostgreSQL automatically
            if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
                chrome.runtime.sendMessage({
                    action: 'scrapeAndForward'
                }).catch((err) => {
                    console.warn(`[XScraper][AUTO+SCRAPE][${cycleId}] scrapeAndForward IPC failed:`, err?.message || err);
                });
            }

            console.log(`[XScraper][AUTO+SCRAPE][${cycleId}] Cycle complete: discovered=${discovered} queued=${queued} remaining=${queue.length}`);
            return {
                success: true,
                cycleId,
                discovered,
                queued,
                remaining: queue.length,
                conversationId: currentConversationId
            };
        } catch (err) {
            console.error(`[XScraper][AUTO+SCRAPE][${cycleId}] ERROR:`, err?.message || err);
            return {
                success: false,
                cycleId,
                error: err?.message || err,
                conversationId: currentConversationId
            };
        }
    }

    function scrape() {
        // single nudge/scroll to attempt to load more messages
        forceScroll();
        return { success: true };
    }

    async function exportAsJSON() {
        console.log('[XSCRAPER_HEAVENS] exportAsJSON called');
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                console.error('[XSCRAPER_HEAVENS] export timed out');
                reject(new Error('Export timed out'));
            }, 15000);

            if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
                chrome.runtime.sendMessage(
                    { action: 'exportData' },
                    (response) => {
                        clearTimeout(timeout);
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                            return;
                        }
                        resolve(response?.data || { messages: [], conversations: [] });
                    }
                );
            } else {
                // Fallback: read from in-memory queue + current DOM
                const messages = [...queue].map(m => ({
                    id: m.id,
                    content: m.content,
                    author: m.author,
                    timestamp: m.ts,
                    conversationId: m.conversationId,
                    conversationTitle: m.conversationTitle
                }));
                resolve({
                    version: '1.0',
                    exportDate: new Date().toISOString(),
                    totalMessages: messages.length,
                    totalConversations: 1,
                    messages,
                    conversations: [{ id: currentConversationId, title: currentConversationTitle }]
                });
            }
        });
    }

    async function exportIncrementalJSON(since) {
        console.log('[XSCRAPER_HEAVENS] exportIncrementalJSON called, since:', since);
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                console.error('[XSCRAPER_HEAVENS] incremental export timed out');
                reject(new Error('Incremental export timed out'));
            }, 15000);

            if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
                chrome.runtime.sendMessage(
                    { action: 'exportIncrementalData', since },
                    (response) => {
                        clearTimeout(timeout);
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                            return;
                        }
                        resolve(response?.data || { messages: [] });
                    }
                );
            } else {
                // Fallback: filter in-memory queue by timestamp
                const cutoff = typeof since === 'number' ? since : 0;
                const messages = queue.filter(m => (m.ts || 0) > cutoff).map(m => ({
                    id: m.id,
                    content: m.content,
                    author: m.author,
                    timestamp: m.ts,
                    conversationId: m.conversationId,
                    conversationTitle: m.conversationTitle,
                    savedAt: m.ts
                }));
                resolve({
                    version: '1.0',
                    exportDate: new Date().toISOString(),
                    messages
                });
            }
        });
    }

    /* ---------------- WATCHDOG ---------------- */

    function startWatchdog() {
        setInterval(() => {
            const now = Date.now();

            // 1. stuck scroll recovery
            if (scrollStuckCounter > 5) {
                console.warn('[XSCRAPER_DAEMON] scroll stuck → forcing restart');
                forceScroll();
                scrollStuckCounter = 0;
            }

            // 2. idle recovery (UI virtualization pause)
            if (now - lastMutationTime > IDLE_THRESHOLD) {
                console.warn('[XSCRAPER_DAEMON] idle detected → nudging DOM');
                forceScroll();
            }

        }, WATCHDOG_INTERVAL);
    }

    function forceScroll() {
        const c = findScroll();
        if (!c) return;

        // Refresh conversation context before scrolling (chat might have changed)
        updateConversationContext();

        c.scrollTop = 0;
        c.dispatchEvent(new Event('scroll', { bubbles: true }));
    }

    /* ---------------- SERVER SAVE (PRIMARY, DURABLE) ---------------- */

    const SERVER_URL = 'http://localhost:3000';
    // The durable queue is SQLite on the local server. The extension
    // IndexedDB bridge is unreliable (rate-limited, context-messaging
    // fragility), so the page scraper POSTs DIRECTLY to the server. This is
    // what actually lands in SQLite and feeds the batch worker.
    let serverLastAttempt = 0;
    const SERVER_COOLDOWN_MS = 2000; // small cooldown, NOT 10s — we must not drop messages

    async function saveToServer(messages, conversationId, conversationTitle) {
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
            console.warn('[XSCRAPER_DAEMON] server save failed:', err?.message || err);
            return { offline: true, error: String(err?.message || err) };
        }
    }

    /* ---------------- FLUSH ---------------- */

    function startFlush() {
        setInterval(async () => {
            if (!queue.length) return;

            // Refresh conversation context before flushing
            updateConversationContext();

            // 30 per 1200ms (25/s) was slower than the crawler could enqueue
            // while auto-scrolling a long conversation, so the in-page queue
            // grew instead of draining ("Queue: 575" that never went down).
            // 200 per 500ms (400/s) outruns the crawler and a 200-record
            // IndexedDB put still fits comfortably in one transaction.
            const batch = queue.splice(0, 200);

            // Ensure all messages in batch have current conversationId
            const enrichedBatch = batch.map(m => ({
                ...m,
                conversationId: currentConversationId,
                conversationTitle: currentConversationTitle
            }));

            // PRIMARY: POST directly to the local SQLite server (durable queue).
            // This is the authoritative path — it lands in SQLite immediately
            // and the batch worker drains it into PostgreSQL.
            // CRITICAL: only remove from the in-memory queue after the server
            // confirms the save. If the server is unreachable, put the batch
            // back at the front of the queue so it is retried on the next tick.
            const now = Date.now();
            let serverSaved = false;
            if (now - serverLastAttempt >= SERVER_COOLDOWN_MS) {
                serverLastAttempt = now;
                try {
                    const result = await saveToServer(enrichedBatch, currentConversationId, currentConversationTitle);
                    serverSaved = !result?.offline;
                    if (!serverSaved) {
                        console.warn(`[XSCRAPER_DAEMON] server save returned offline, requeueing ${batch.length} messages`);
                        queue.unshift(...batch);
                        return;
                    }
                } catch (err) {
                    console.warn(`[XSCRAPER_DAEMON] server save exception, requeueing ${batch.length} messages:`, err?.message || err);
                    queue.unshift(...batch);
                    return;
                }
            }

            // FALLBACK: also mirror into the extension IndexedDB for offline
            // resilience. Non-blocking; if the server is unreachable the data
            // is still preserved locally and can be reconciled later.
            if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
                chrome.runtime.sendMessage({
                    action: 'saveMessages',
                    messages: enrichedBatch,
                    conversationId: currentConversationId,
                    conversationTitle: currentConversationTitle
                }).catch((err) => {
                    console.warn('[XSCRAPER_DAEMON] saveMessages failed:', err?.message || err);
                });
                return;
            }

            window.postMessage({
                source: 'xscraper-page',
                action: 'saveMessages',
                messages: enrichedBatch,
                conversationId: currentConversationId,
                conversationTitle: currentConversationTitle
            }, '*');

        }, 500);
    }

    function startMessageBridge() {
        window.addEventListener('message', async (event) => {
            if (event.source !== window) return;

            const message = event.data;
            if (!message || message.source !== 'xscraper-content') return;
            if (message.action !== 'scrapeMessages') return;

            try {
                const result = await scrapeAll();
                window.postMessage({
                    source: 'xscraper-page',
                    action: 'scrapeResponse',
                    requestId: message.requestId,
                    result
                }, '*');
            } catch (err) {
                window.postMessage({
                    source: 'xscraper-page',
                    action: 'scrapeResponse',
                    requestId: message.requestId,
                    result: { success: false, error: err?.message || 'Scraper failed' }
                }, '*');
            }
        });
    }

    /* ---------------- SCROLL FINDER ---------------- */

    function findScroll() {
        let best = null;
        let bestSize = 0;

        for (const el of document.querySelectorAll('*')) {
            const s = getComputedStyle(el);
            if (!(s.overflowY === 'auto' || s.overflowY === 'scroll')) continue;

            const size = el.scrollHeight - el.clientHeight;
            if (size > bestSize) {
                bestSize = size;
                best = el;
            }
        }

        return best;
    }

    /* ---------------- DEBUG ---------------- */

    function debug() {
        return {
            seen: seen.size,
            queue: queue.length,
            stuck: scrollStuckCounter,
            idle: Date.now() - lastMutationTime,
            conversationId: currentConversationId,
            conversationTitle: currentConversationTitle
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
