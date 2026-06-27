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

    function init() {
        console.log('[XSCRAPER_DAEMON] starting');

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
            ts: Date.now()
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

        c.scrollTop = 0;
        c.dispatchEvent(new Event('scroll', { bubbles: true }));
    }

    /* ---------------- FLUSH ---------------- */

    function startFlush() {
        setInterval(() => {
            if (!queue.length) return;

            const batch = queue.splice(0, 30);

            if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
                chrome.runtime.sendMessage({
                    action: 'saveMessages',
                    messages: batch
                }).catch(() => { });
                return;
            }

            window.postMessage({
                source: 'xscraper-page',
                action: 'saveMessages',
                messages: batch
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
            idle: Date.now() - lastMutationTime
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
