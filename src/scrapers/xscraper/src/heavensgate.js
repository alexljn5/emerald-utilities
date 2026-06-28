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
            restart: () => {
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

    function extract(el) {
        const text = el.textContent?.trim();
        if (!text || text.length < 3) return null;

        return {
            id: hash(text),
            content: text,
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
        startAutoScrollLoop();
        await new Promise(r => setTimeout(r, timeout));
        stopAutoScrollLoop();
        return { success: true, duration: timeout, seen: seen.size, queued: queue.length };
    }

    function scrape() {
        // single nudge/scroll to attempt to load more messages
        forceScroll();
        return { success: true };
    }

    async function exportAsJSON() {
        console.log('[XSCRAPER_HEAVENS] exportAsJSON called');
        return new Promise((resolve, reject) => {
            const requestId = `export-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const timeout = setTimeout(() => {
                window.removeEventListener('message', handler);
                console.error('[XSCRAPER_HEAVENS] export timed out');
                reject(new Error('Export timed out'));
            }, 15000);

            function handler(event) {
                if (event.source !== window) return;
                const message = event.data;
                console.log('[XSCRAPER_HEAVENS] received message:', message);
                if (!message || message.source !== 'xscraper-content' || message.requestId !== requestId) return;
                if (message.action !== 'exportResponse') return;
                clearTimeout(timeout);
                window.removeEventListener('message', handler);
                console.log('[XSCRAPER_HEAVENS] export response received');
                resolve(message.result);
            }

            window.addEventListener('message', handler);
            console.log('[XSCRAPER_HEAVENS] sending exportRequest');
            window.postMessage({
                source: 'xscraper-page',
                action: 'exportRequest',
                requestId
            }, '*');
        });
    }

    async function exportIncrementalJSON(since) {
        console.log('[XSCRAPER_HEAVENS] exportIncrementalJSON called, since:', since);
        return new Promise((resolve, reject) => {
            const requestId = `export-inc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const timeout = setTimeout(() => {
                window.removeEventListener('message', handler);
                console.error('[XSCRAPER_HEAVENS] incremental export timed out');
                reject(new Error('Incremental export timed out'));
            }, 15000);

            function handler(event) {
                if (event.source !== window) return;
                const message = event.data;
                if (!message || message.source !== 'xscraper-content' || message.requestId !== requestId) return;
                if (message.action !== 'exportIncrementalResponse') return;
                clearTimeout(timeout);
                window.removeEventListener('message', handler);
                console.log('[XSCRAPER_HEAVENS] incremental export response received, messages:', message.result?.data?.messages?.length);
                resolve(message.result);
            }

            window.addEventListener('message', handler);
            window.postMessage({
                source: 'xscraper-page',
                action: 'exportIncrementalRequest',
                requestId,
                since
            }, '*');
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

    /* ---------------- FLUSH ---------------- */

    function startFlush() {
        setInterval(() => {
            if (!queue.length) return;

            // Refresh conversation context before flushing
            updateConversationContext();

            const batch = queue.splice(0, 30);

            // Ensure all messages in batch have current conversationId
            const enrichedBatch = batch.map(m => ({
                ...m,
                conversationId: currentConversationId,
                conversationTitle: currentConversationTitle
            }));

            if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
                chrome.runtime.sendMessage({
                    action: 'saveMessages',
                    messages: enrichedBatch,
                    conversationId: currentConversationId,
                    conversationTitle: currentConversationTitle
                }).catch(() => { });
                return;
            }

            window.postMessage({
                source: 'xscraper-page',
                action: 'saveMessages',
                messages: enrichedBatch,
                conversationId: currentConversationId,
                conversationTitle: currentConversationTitle
            }, '*');

        }, 1200);
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
