import { useEffect, useState, useRef } from 'react';
import PageShell from './PageShell.jsx';
import {
    checkFirefoxInstalled, launchFirefox, getDefaultPages, exportData, getRealtimeStats,
    startRealtimeCrawler, stopRealtimeCrawler, startLocalServer,
    clearExports, clearLocalStore, forwardPending, saveToSqlite,
    startForwardWorker, getForwardStatus, clearSent,
    verifyAutoForward, forwardLegacyToPostgres, scrapeAndForwardInWebview
} from '../scrapers/xscraper/index.js';
import xscraperLogo from '../../img/logos/alexljn5_logo_merge_transparent.png';

/** How often the UI polls the durable forwarder for live counters. */
const STATUS_POLL_MS = 2000;
import '../css/internet.css';

const DEFAULT_PAGES = [
    { id: 'grok', name: 'Grok', url: 'https://grok.com' },
    { id: 'x', name: 'X', url: 'https://x.com' },
    { id: 'grok-x', name: 'Grok X', url: 'https://grok.x.com' }
];

export default function Internet({ route, setRoute }) {
    const [firefoxReady, setFirefoxReady] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [activePage, setActivePage] = useState('grok');
    const [browserUrl, setBrowserUrl] = useState('https://grok.com');
    const [scraperStatus, setScraperStatus] = useState('Ready');
    const [scraperStats, setScraperStats] = useState({ messages: 0, conversations: 0 });
    const [partition, setPartition] = useState(null);
    const [webviewUrl, setWebviewUrl] = useState('');
    const [webviewReady, setWebviewReady] = useState(false);
    const [isScraping, setIsScraping] = useState(false);
    const [realtimeStats, setRealtimeStats] = useState({ seen: 0, queue: 0 });
    // Live counters, polled from the durable forwarder + extension debug.
    const [forwardStats, setForwardStats] = useState({
        inserted: 0, skipped: 0, errors: 0,
        local: 0, pending: 0, forwarded: 0, failed: 0,
        pgConnected: null, workerRunning: false, connection: 'idle', lastSyncAt: null
    });
    // Automatic sync is normal operation and is ON by default.
    const [liveSyncEnabled, setLiveSyncEnabled] = useState(() => {
        try {
            return localStorage.getItem('xscraper.liveSyncEnabled') !== 'false';
        } catch {
            return true;
        }
    });
    // Confirmation modal for clearing sent messages.
    const [showClearSentModal, setShowClearSentModal] = useState(false);
    const browserViewRef = useRef(null);
    const webviewRef = useRef(null);
    const scrapeIntervalRef = useRef(null);
    // Set when SCRAPE+FORWARD is requested before the webview exists, so the
    // pipeline starts by itself as soon as the browser is ready.
    const autoStartRef = useRef(false);
    // One automatic start per ready browser.
    const autoStartedRef = useRef(false);
    // Guard against overlapping scrape-poll ticks.
    const pollBusyRef = useRef(false);

    /**
         * Push the extension's IndexedDB delta into the durable SQLite queue.
         *
         * The scraped messages live in the extension's IndexedDB (only the
         * webview can read it). The main-process batch worker reads the durable
         * SQLite queue, so we must mirror the IndexedDB delta into SQLite here.
         * Without this, the worker sees pending_total=0 even though the scraper
         * happily counted messages as "seen".
         *
         * Returns the number of messages persisted to SQLite.
         */
    async function flushDeltaToSqlite() {
        const webview = webviewRef.current;
        if (!webview || !webviewReady) {
            console.log('[XScraper][QUEUE] flushDeltaToSqlite skipped: webview not ready');
            return 0;
        }
        try {
            const res = await webview.executeJavaScript(`
                (async () => {
                    if (window.__grokScraper && typeof window.__grokScraper.exportIncrementalJSON === 'function') {
                        try {
                            return await window.__grokScraper.exportIncrementalJSON(0);
                        } catch (e) {
                            return { success: false, error: String(e && e.message || e) };
                        }
                    }
                    return { success: false, error: 'Scraper not injected yet' };
                })()
            `);
            // exportIncrementalJSON now returns { messages: [...] } directly
            // or { success: true, data: { messages: [...] } } from background
            const messages = res?.messages || res?.data?.messages || [];
            if (!Array.isArray(messages) || messages.length === 0) {
                console.log('[XScraper][QUEUE] flushDeltaToSqlite: no delta to persist (0)');
                return 0;
            }

            // Group by conversation so each conversation is saved with its own ID/title.
            const byConv = new Map();
            for (const m of messages) {
                const cid = m.conversationId || 'default';
                if (!byConv.has(cid)) byConv.set(cid, []);
                byConv.get(cid).push(m);
            }

            let persisted = 0;
            for (const [cid, msgs] of byConv) {
                const title = msgs[0]?.conversationTitle || 'Scraped Conversation';
                const r = await saveToSqlite(msgs, cid, title);
                console.log(
                    `[XScraper][QUEUE] persisted conv=${cid} batch=${msgs.length} ` +
                    `inserted=${r?.inserted ?? 0} duplicates=${r?.duplicates ?? 0}`
                );
                persisted += r?.inserted ?? 0;
            }
            console.log(`[XScraper][QUEUE] flushDeltaToSqlite done: delta=${messages.length} newlyPersisted=${persisted}`);
            return persisted;
        } catch (err) {
            console.error('[XScraper][QUEUE] flushDeltaToSqlite error:', err?.message || err);
            return 0;
        }
    }

    // Poll the durable forwarder for live counters (real database state).
    useEffect(() => {
        let cancelled = false;
        let timer = null;

        async function poll() {
            if (cancelled) return;
            const status = await getForwardStatus();
            if (cancelled || !status?.success) return;

            setForwardStats(prev => ({
                ...prev,
                // Local/pending reflect the COMBINED Node-reachable source
                // (SQLite + legacy JSON exports) that the worker actually drains.
                local: status.local?.total ?? prev.local,
                pending: status.queue?.size ?? status.sqlite?.pending ?? prev.pending,
                forwarded: status.sqlite?.forwarded ?? prev.forwarded,
                failed: status.sqlite?.failed ?? prev.failed,
                // Inserted/skipped come from the worker's last batch result, not
                // from manual button clicks. This is the authoritative count.
                inserted: status.worker?.lastResult?.inserted ?? prev.inserted,
                skipped: status.worker?.lastResult?.skipped ?? prev.skipped,
                pgConnected: status.pg?.connected ?? null,
                workerRunning: status.worker?.started ?? prev.workerRunning,
                connection: !status.pg?.connected ? 'retrying'
                    : (status.worker?.running ? 'syncing'
                        : ((status.queue?.size ?? 0) > 0 ? 'syncing' : 'connected')),
                lastSyncAt: status.worker?.lastRunAt ? new Date(status.worker.lastRunAt).getTime() : prev.lastSyncAt,
            }));
        }

        poll();
        timer = setInterval(poll, STATUS_POLL_MS);

        return () => {
            cancelled = true;
            if (timer) clearInterval(timer);
        };
    }, []);

    // Ensure the singleton worker is running once on mount.
    useEffect(() => {
        startForwardWorker().then(() => undefined).catch(() => undefined);
    }, []);

    // Start local server + check Firefox on mount.
    useEffect(() => {
        let cancelled = false;

        async function checkFirefox() {
            try {
                const installed = await checkFirefoxInstalled();
                if (!cancelled) setFirefoxReady(installed);
            } catch (err) {
                if (!cancelled) setError('Unable to check Firefox installation');
            }
        }

        async function startServer() {
            try {
                const result = await startLocalServer();
                if (result?.success) {
                    console.log('[XScraper] Local server started:', result.message);
                } else {
                    console.warn('[XScraper] Local server failed to start:', result?.error);
                }
            } catch (err) {
                console.warn('[XScraper] Local server error:', err);
            }
        }

        checkFirefox();
        startServer();

        return () => {
            cancelled = true;
        };
    }, []);

    // Track webview events
    useEffect(() => {
        const webview = webviewRef.current;
        if (!webview) return;

        const handleDomReady = () => setWebviewReady(true);
        const handleDidFailLoad = (err) => {
            console.error('Webview load error:', err);
            setError(`Failed to load page: ${err}`);
        };
        const handleDidNavigate = (e) => {
            setBrowserUrl(e.url);
            const matchedPage = DEFAULT_PAGES.find(p => p.url === e.url);
            if (matchedPage) setActivePage(matchedPage.id);
        };

        webview.addEventListener('dom-ready', handleDomReady);
        webview.addEventListener('did-fail-load', handleDidFailLoad);
        webview.addEventListener('did-navigate', handleDidNavigate);

        return () => {
            webview.removeEventListener('dom-ready', handleDomReady);
            webview.removeEventListener('did-fail-load', handleDidFailLoad);
            webview.removeEventListener('did-navigate', handleDidNavigate);
        };
    }, [partition]);

    // PLUG-AND-PLAY: automatic sync is normal operation. As soon as the
    // browser is usable, the pipeline starts by itself.
    useEffect(() => {
        if (!webviewReady) {
            autoStartedRef.current = false;
            return;
        }
        if (isScraping || loading) return;
        if (!liveSyncEnabled && !autoStartRef.current) return;
        if (autoStartedRef.current && !autoStartRef.current) return;
        autoStartedRef.current = true;
        autoStartRef.current = false;
        startLiveSync();
    }, [webviewReady, isScraping, loading, liveSyncEnabled]);

    // Scrape + Forward polling loop: read scraper stats + push delta to SQLite.
    useEffect(() => {
        if (!isScraping || !webviewReady) {
            if (scrapeIntervalRef.current) {
                clearInterval(scrapeIntervalRef.current);
                scrapeIntervalRef.current = null;
            }
            return;
        }

        const pollAndForward = async () => {
            if (pollBusyRef.current) return;
            pollBusyRef.current = true;
            try {
                // 1. Scraper stats (Seen / queue).
                const result = await getRealtimeStats(webviewRef.current);
                if (result?.success && result.stats) {
                    setRealtimeStats(result.stats);
                    setScraperStats(prev => ({ ...prev, messages: result.stats.seen || prev.messages }));
                }

                // 2. Push the current IndexedDB delta into the durable SQLite
                //    queue. The main-process worker (or the poll's own
                //    forwardPending below) drains SQLite -> PostgreSQL.
                const persisted = await flushDeltaToSqlite();
                if (persisted > 0) {
                    console.log(`[XScraper][QUEUE] poll: persisted ${persisted} new messages to SQLite`);
                    // A new batch landed — force a drain right away so the
                    // UI/PG updates promptly instead of waiting for the tick.
                    const fwd = await forwardPending();
                    console.log(
                        `[XScraper][QUEUE] poll: after forwardPending inserted=${fwd?.inserted ?? 0} ` +
                        `skipped=${fwd?.skipped ?? 0} failed=${fwd?.failed ?? 0} pending=${fwd?.pending ?? 0}`
                    );
                }
            } catch (err) {
                console.error('[XScraper] Poll error:', err);
            } finally {
                pollBusyRef.current = false;
            }
        };

        pollBusyRef.current = false;
        pollAndForward();
        scrapeIntervalRef.current = setInterval(pollAndForward, STATUS_POLL_MS);

        return () => {
            if (scrapeIntervalRef.current) {
                clearInterval(scrapeIntervalRef.current);
                scrapeIntervalRef.current = null;
            }
        };
    }, [isScraping, webviewReady]);

    // Sync webview size
    useEffect(() => {
        const browserView = browserViewRef.current;
        const webview = webviewRef.current;
        if (!browserView || !webview) return;

        let animationFrame = null;

        const syncWebviewSize = () => {
            if (animationFrame) cancelAnimationFrame(animationFrame);
            animationFrame = requestAnimationFrame(() => {
                const { width, height } = browserView.getBoundingClientRect();
                if (width <= 0 || height <= 0) return;
                const pixelWidth = Math.floor(width);
                const pixelHeight = Math.floor(height);
                webview.setAttribute('autosize', 'on');
                webview.setAttribute('minwidth', String(pixelWidth));
                webview.setAttribute('minheight', String(pixelHeight));
                webview.setAttribute('maxwidth', String(pixelWidth));
                webview.setAttribute('maxheight', String(pixelHeight));
                webview.style.width = `${pixelWidth}px`;
                webview.style.height = `${pixelHeight}px`;
            });
        };

        syncWebviewSize();
        const resizeObserver = new ResizeObserver(syncWebviewSize);
        resizeObserver.observe(browserView);
        window.addEventListener('resize', syncWebviewSize);

        return () => {
            if (animationFrame) cancelAnimationFrame(animationFrame);
            resizeObserver.disconnect();
            window.removeEventListener('resize', syncWebviewSize);
        };
    }, [partition, webviewUrl]);

    async function handleLaunchFirefox() {
        if (!firefoxReady) {
            setError('Firefox is not installed or not detected');
            return;
        }
        setLoading(true);
        setError('');
        try {
            if (partition) {
                setWebviewUrl(browserUrl);
                setScraperStatus('Navigating...');
            } else {
                const result = await launchFirefox({ url: browserUrl, extensionPath: 'src/scrapers/xscraper' });
                if (result?.success) {
                    setPartition(result.partition);
                    setWebviewUrl(result.url);
                    setScraperStatus('Browser session ready');
                } else {
                    setError(result?.error || 'Failed to launch browser');
                }
            }
        } catch (err) {
            setError(err?.message || 'Failed to launch browser');
        } finally {
            setLoading(false);
        }
    }

    async function handleCloseBrowser() {
        setLoading(true);
        try {
            setPartition(null);
            setWebviewUrl('');
            setWebviewReady(false);
            setIsScraping(false);
            setScraperStatus('Browser closed');
        } catch (err) {
            setError(err?.message || 'Failed to close browser');
        } finally {
            setLoading(false);
        }
    }

    async function handleNavigate(pageId) {
        const page = DEFAULT_PAGES.find(p => p.id === pageId);
        if (page) {
            setActivePage(pageId);
            setBrowserUrl(page.url);
            if (partition) setWebviewUrl(page.url);
            setScraperStatus(`Navigating to ${page.name}...`);
        }
    }

    async function handleScrape() {
        if (!webviewRef.current || !webviewReady) {
            setError('Browser is not ready');
            return;
        }
        if (isScraping) {
            setLoading(true);
            setScraperStatus('Stopping scrape...');
            try {
                const result = await stopRealtimeCrawler(webviewRef.current);
                if (result?.success) {
                    setIsScraping(false);
                    setScraperStatus('Scrape stopped');
                } else {
                    setError(result?.error || 'Failed to stop scrape');
                }
            } catch (err) {
                setError(err?.message || 'Failed to stop scrape');
            } finally {
                setLoading(false);
            }
            return;
        }

        setLoading(true);
        setScraperStatus('Starting scrape...');
        try {
            const result = await startRealtimeCrawler(webviewRef.current);
            if (result?.success) {
                setIsScraping(true);
                setScraperStatus('Scraping + reconciling with PostgreSQL');
            } else {
                setError(result?.error || 'Failed to start scrape');
            }
        } catch (err) {
            setError(err?.message || 'Failed to start scrape');
        } finally {
            setLoading(false);
        }
    }

    async function handleExport() {
        if (!webviewRef.current || !webviewReady) {
            setError('Browser is not ready');
            return;
        }
        setLoading(true);
        setScraperStatus('Exporting data...');
        try {
            const exportResult = await webviewRef.current.executeJavaScript(`
                (function() {
                    if (window.__grokScraper && typeof window.__grokScraper.exportAsJSON === 'function') {
                        return window.__grokScraper.exportAsJSON();
                    }
                    return { success: false, error: 'Export not available' };
                })()
            `);
            if (exportResult?.success && exportResult.data) {
                const fsResult = await exportData(exportResult.data);
                if (fsResult?.success) {
                    if (fsResult.files && fsResult.files.length > 1) {
                        setScraperStatus(`Exported ${fsResult.files.length} conversations to database/grok/`);
                    } else {
                        setScraperStatus(`Exported to ${fsResult.filename}`);
                    }
                } else {
                    setError(fsResult?.error || 'Failed to write export to filesystem');
                }
            } else {
                setError(exportResult?.error || 'Export failed');
            }
        } catch (err) {
            setError(err?.message || 'Export failed');
        } finally {
            setLoading(false);
        }
    }

    /**
     * Manual "Send to PostgreSQL" — the SAME durable pipeline the worker uses.
     * First pushes the current IndexedDB delta into SQLite, then forces a
     * batch run. Structured result, never crashes main.
     */
    async function handleForwardToPostgres() {
        setLoading(true);
        setScraperStatus('Forwarding to PostgreSQL...');
        setError('');
        try {
            // 1. Push any IndexedDB delta into the durable SQLite queue.
            if (webviewRef.current && webviewReady) {
                await flushDeltaToSqlite();
            }
            // 2. Force the worker to drain the queue now.
            const r = await forwardPending();
            if (r?.success || (r?.failed === 0 && r?.error == null)) {
                setForwardStats(prev => ({
                    ...prev,
                    inserted: prev.inserted + (r?.inserted || 0),
                    skipped: prev.skipped + (r?.skipped || 0),
                    errors: prev.errors + ((r?.failed || 0) > 0 ? 1 : 0),
                }));
                setScraperStatus(
                    `Forwarded: ${r?.inserted || 0} inserted, ${r?.skipped || 0} already in PostgreSQL`
                    + ((r?.pending || 0) > 0 ? `, ${r.pending} still pending` : '')
                );
            } else {
                setError(r?.error || 'Forward failed');
                setScraperStatus('PostgreSQL unreachable - messages stay queued locally');
            }
        } catch (err) {
            setError(err?.message || 'Forward failed');
            setScraperStatus('Forward failed');
        } finally {
            setLoading(false);
        }
    }

    /**
     * THE button. One click = whole pipeline:
     * launch browser -> start crawler -> start worker -> stream to PG.
     * Clicking again stops the live sync.
     */
    async function handleScrapeAndForward() {
        if (isScraping) {
            // STOP: finish pending forwarding, confirm, then clear local data
            setLoading(true);
            setScraperStatus('Stopping: flushing pending...');
            setError('');
            console.log('[XScraper][STOP] Stop requested');
            try {
                // 1. Stop the crawler
                await stopRealtimeCrawler(webviewRef.current);

                // 2. Flush any remaining IndexedDB delta to SQLite
                if (webviewRef.current && webviewReady) {
                    const persisted = await flushDeltaToSqlite();
                    console.log(`[XScraper][STOP] Flushed ${persisted} messages to SQLite`);
                }

                // 3. Force the worker to drain the queue now
                const fwd = await forwardPending();
                console.log(
                    `[XScraper][STOP] PostgreSQL flush: inserted=${fwd?.inserted ?? 0} ` +
                    `skipped=${fwd?.skipped ?? 0} failed=${fwd?.failed ?? 0}`
                );

                // 4. Clear successfully-forwarded messages from local queue
                const cleared = await clearSent();
                console.log(`[XScraper][STOP] Cleared ${cleared?.deleted ?? 0} forwarded messages from local queue`);

                setScraperStatus(
                    `Stopped: forwarded=${fwd?.inserted ?? 0}, cleared=${cleared?.deleted ?? 0}`
                );
            } catch (err) {
                console.error('[XScraper][STOP] Error during stop:', err?.message || err);
                setScraperStatus('Stop completed with errors — local data preserved for retry');
            } finally {
                autoStartRef.current = false;
                persistLiveSync(false);
                setIsScraping(false);
                setLoading(false);
            }
            return;
        }

        setError('');
        persistLiveSync(true);

        // No browser yet: launch it and pick up automatically once ready.
        if (!partition || !webviewReady || !webviewRef.current) {
            autoStartRef.current = true;
            setScraperStatus('Launching browser...');
            if (!partition) await handleLaunchFirefox();
            return;
        }

        await startLiveSync();
    }

    /** Persist the automatic-sync flag as an ordinary app setting. */
    function persistLiveSync(enabled) {
        setLiveSyncEnabled(enabled);
        try {
            localStorage.setItem('xscraper.liveSyncEnabled', String(enabled));
        } catch {
            /* storage unavailable */
        }
    }

    async function startLiveSync() {
        if (!webviewRef.current) return;

        setLoading(true);
        setError('');
        setScraperStatus('Starting live sync...');
        try {
            // 1. Ensure the durable worker is running (singleton).
            await startForwardWorker();

            // 2. Run the complete AUTO+SCRAPE cycle in the content script:
            //    scrape current conversation -> persist to SQLite -> notify main process.
            console.log('[XScraper][AUTO+SCRAPE] Starting initial cycle');
            const cycleResult = await scrapeAndForwardInWebview(webviewRef.current, 8000);
            if (cycleResult?.success) {
                console.log(`[XScraper][AUTO+SCRAPE] Initial cycle complete:`, cycleResult);
            } else {
                console.warn('[XScraper][AUTO+SCRAPE] Initial cycle failed:', cycleResult?.error);
            }

            // 3. Drop the scraper's in-memory dedupe cache so the current
            //    view is captured again (re-emitting is identity-safe).
            try {
                await webviewRef.current.executeJavaScript(`
                    (function () {
                        if (window.__grokScraper && typeof window.__grokScraper.resetSeen === 'function') {
                            return window.__grokScraper.resetSeen();
                        }
                        return null;
                    })()
                `);
            } catch (err) {
                console.warn('[XScraper] resetSeen before scrape failed:', err?.message);
            }

            // 4. Start the real-time scraper. The poll loop pushes each delta
            //    into SQLite; the worker drains it to PostgreSQL automatically.
            const scrapeResult = await startRealtimeCrawler(webviewRef.current);
            if (scrapeResult?.success) {
                setIsScraping(true);
                setScraperStatus('Live: scraping and streaming to PostgreSQL');
            } else {
                setError(scrapeResult?.error || 'Failed to start scrape');
                setScraperStatus('Live sync failed to start');
            }
        } catch (err) {
            setError(err?.message || 'Live sync failed');
            setScraperStatus('Live sync failed');
        } finally {
            autoStartRef.current = false;
            setLoading(false);
        }
    }

    async function handleClearExports() {
        setLoading(true);
        setScraperStatus('Clearing exports...');
        setError('');
        try {
            const result = await clearExports();
            if (result?.success) {
                setScraperStatus(`Cleared ${result.deleted} export files`);
            } else {
                setError(result?.error || 'Failed to clear exports');
                setScraperStatus('Clear failed');
            }
        } catch (err) {
            setError(err?.message || 'Clear failed');
            setScraperStatus('Clear failed');
        } finally {
            setLoading(false);
        }
    }

    async function handleClearLocalStore() {
        setLoading(true);
        setScraperStatus('Clearing local XScraper store...');
        setError('');
        try {
            const result = await clearLocalStore({ sqlite: true, indexeddb: true, exports: true });
            if (result?.success) {
                if (webviewRef.current && webviewReady) {
                    try {
                        await webviewRef.current.executeJavaScript(`
                            (function () {
                                if (window.__grokScraper && typeof window.__grokScraper.resetSeen === 'function') {
                                    return window.__grokScraper.resetSeen();
                                }
                                return null;
                            })()
                        `);
                    } catch (err) {
                        console.warn('[XScraper] resetSeen failed:', err?.message);
                    }
                    try {
                        webviewRef.current.reload();
                    } catch (err) {
                        console.warn('[XScraper] webview reload failed:', err?.message);
                    }
                }
                setIsScraping(false);
                setScraperStats(prev => ({ ...prev, messages: 0 }));
                setRealtimeStats({ seen: 0, queue: 0, stuck: 0, idle: 0 });
                setForwardStats(prev => ({ ...prev, inserted: 0, skipped: 0, errors: 0, local: 0, pending: 0, forwarded: 0, failed: 0 }));
                setScraperStatus(result.message || 'Local store cleared (PostgreSQL untouched)');
            } else {
                setError(result?.error || (result?.errors || []).join('; ') || 'Failed to clear local store');
                setScraperStatus('Clear failed');
            }
        } catch (err) {
            setError(err?.message || 'Clear failed');
            setScraperStatus('Clear failed');
        } finally {
            setLoading(false);
        }
    }

    /** Clear fully-forwarded messages after user confirms the modal. */
    async function handleConfirmClearSent() {
        setShowClearSentModal(false);
        setLoading(true);
        setScraperStatus('Clearing sent messages...');
        try {
            const r = await clearSent();
            if (r?.success) {
                setScraperStatus(r.deleted > 0 ? `Cleared ${r.deleted} forwarded messages from local queue` : 'No forwarded messages to clear');
            } else {
                setError(r?.error || 'Failed to clear sent messages');
            }
        } catch (err) {
            setError(err?.message || 'Failed to clear sent messages');
        } finally {
            setLoading(false);
        }
    }

    /**
     * Verify the automatic SQLite → PostgreSQL pipeline end to end: push a
     * test message into the durable queue and confirm it reaches PostgreSQL.
     */
    async function handleVerifyForward() {
        setLoading(true);
        setScraperStatus('Verifying auto-forward pipeline...');
        setError('');
        try {
            const r = await verifyAutoForward();
            if (r?.success) {
                setScraperStatus(
                    `Auto-forward verified: test message inserted=${r.inserted} confirmed in PostgreSQL`
                    + (r.verified ? ' (confirmed present)' : '')
                );
            } else {
                setError(r?.error || 'Verification failed');
                setScraperStatus('Auto-forward verification failed');
            }
        } catch (err) {
            setError(err?.message || 'Verification failed');
            setScraperStatus('Auto-forward verification failed');
        } finally {
            setLoading(false);
        }
    }

    /**
     * One-time import of legacy JSON exports into the durable pipeline.
     * Idempotent: already-present messages are skipped, never duplicated.
     */
    async function handleForwardLegacy() {
        setLoading(true);
        setScraperStatus('Reconciling legacy JSON exports with PostgreSQL...');
        setError('');
        try {
            const r = await forwardLegacyToPostgres();
            if (r?.success) {
                setScraperStatus(
                    `Legacy reconcile done: ${r.inserted ?? 0} inserted, ${r.skipped ?? 0} already present`
                );
            } else {
                setError(r?.error || 'Legacy reconcile failed');
                setScraperStatus('Legacy reconcile failed');
            }
        } catch (err) {
            setError(err?.message || 'Legacy reconcile failed');
            setScraperStatus('Legacy reconcile failed');
        } finally {
            setLoading(false);
        }
    }

    const connectionLabel =
        forwardStats.connection === 'connected' ? 'PostgreSQL: connected'
            : forwardStats.connection === 'syncing' ? 'PostgreSQL: syncing...'
                : forwardStats.connection === 'retrying' ? 'PostgreSQL: retrying'
                    : (liveSyncEnabled ? 'Auto-sync: on' : 'Auto-sync: off');

    return (
        <PageShell title="Internet Access" route={route} setRoute={setRoute} showBack={true} leftChildren={
            <div className="navBox">
                <h2>XScraper</h2>
                <div className="xscraper-icon-container">
                    <img src={xscraperLogo} alt="XScraper" className="xscraper-icon" width="64" height="64" />
                </div>
                <div className="xscraper-status">
                    <span className={`status-indicator ${isScraping ? 'scraping' : (firefoxReady ? 'ready' : 'error')}`}>
                        {isScraping ? 'Scraping + PostgreSQL' : (firefoxReady ? 'Firefox Ready' : 'Firefox Not Found')}
                    </span>
                </div>
                <div className="xscraper-stats">
                    <div className="stat-item">
                        <span className="stat-label">Status</span>
                        <span className="stat-value">{scraperStatus}</span>
                    </div>
                    <div className="stat-item">
                        <span className="stat-label">Seen</span>
                        <span className="stat-value">{realtimeStats.seen}</span>
                    </div>
                    <div className="stat-item">
                        <span className="stat-label">Scrape queue</span>
                        <span className="stat-value">{realtimeStats.queue}</span>
                    </div>
                    <div className="stat-item">
                        <span className="stat-label">Local</span>
                        <span className="stat-value">{forwardStats.local}</span>
                    </div>
                    <div className="stat-item">
                        <span className="stat-label">Pending</span>
                        <span className="stat-value">{forwardStats.pending}</span>
                    </div>
                    <div className="stat-item">
                        <span className="stat-label">Inserted</span>
                        <span className="stat-value">{forwardStats.inserted}</span>
                    </div>
                    <div className="stat-item">
                        <span className="stat-label">Already in DB</span>
                        <span className="stat-value">{forwardStats.skipped}</span>
                    </div>
                    {forwardStats.failed > 0 && (
                        <div className="stat-item">
                            <span className="stat-label">Failed</span>
                            <span className="stat-value error">{forwardStats.failed}</span>
                        </div>
                    )}
                    <div className="stat-item">
                        <span className="stat-label">Auto-sync</span>
                        <span className={`stat-value sync-${forwardStats.connection}`}>{connectionLabel}</span>
                    </div>
                    {forwardStats.lastSyncAt && (
                        <div className="stat-item">
                            <span className="stat-label">Last sync</span>
                            <span className="stat-value">{new Date(forwardStats.lastSyncAt).toLocaleTimeString()}</span>
                        </div>
                    )}
                </div>
                <div className="xscraper-primary-action">
                    <button
                        className={`nav-btn full primary${isScraping ? ' live' : ''}`}
                        type="button"
                        onClick={handleScrapeAndForward}
                        disabled={loading || !firefoxReady}
                        title="Scrape conversations and forward to PostgreSQL"
                    >
                        {loading ? 'Working...' : (isScraping ? 'Stop' : 'SCRAPE + FORWARD')}
                    </button>
                </div>
                <div className="page-selector">
                    <h3>Quick Pages</h3>
                    <div className="page-buttons">
                        {DEFAULT_PAGES.map(page => (
                            <button
                                key={page.id}
                                className={`page-btn ${activePage === page.id ? 'active' : ''}`}
                                onClick={() => handleNavigate(page.id)}
                                type="button"
                            >
                                {page.name}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="advanced-section">
                    <h3 className="advanced-section-title">Advanced / Recovery</h3>
                    <div className="advanced-controls">
                        <button className="nav-btn full" type="button" onClick={handleLaunchFirefox} disabled={loading || !firefoxReady}>
                            {loading ? 'Launching...' : 'Launch Browser'}
                        </button>
                        <button className="nav-btn full" type="button" onClick={handleCloseBrowser} disabled={loading || !partition}>
                            Close Browser
                        </button>
                        <button className="nav-btn full" type="button" onClick={handleScrape} disabled={loading || !webviewReady}>
                            {isScraping ? 'Stop Scrape Only' : 'Start Scrape Only'}
                        </button>
                        <button className="nav-btn full" type="button" onClick={handleExport} disabled={loading || !webviewReady}>
                            Export Data
                        </button>
                        <button className="nav-btn full" type="button" onClick={handleForwardToPostgres} disabled={loading}>
                            Send to PostgreSQL
                        </button>
                        <button className="nav-btn full" type="button" onClick={handleVerifyForward} disabled={loading}>
                            Verify Auto-Forward
                        </button>
                        <button className="nav-btn full" type="button" onClick={handleForwardLegacy} disabled={loading}>
                            Reconcile Legacy JSON
                        </button>
                        <button className="nav-btn full" type="button" onClick={() => setShowClearSentModal(true)} disabled={loading || forwardStats.forwarded === 0}>
                            Clear Sent Messages
                        </button>
                        <button className="nav-btn full" type="button" onClick={handleClearExports} disabled={loading}>
                            Clear Exports
                        </button>
                        <button className="nav-btn full danger" type="button" onClick={handleClearLocalStore} disabled={loading}
                            title="Wipes the local SQLite cache, the extension IndexedDB and JSON snapshots. PostgreSQL is not touched.">
                            Clear Local Store
                        </button>
                    </div>
                </div>
            </div>
        }>
            <div className="browser-view">
                {webviewUrl ? (
                    <webview
                        ref={webviewRef}
                        src={webviewUrl}
                        className="browser-webview"
                        partition={partition || undefined}
                        allowpopups="true"
                    />
                ) : (
                    <div className="browser-placeholder">
                        <p>Launch Firefox to start scraping</p>
                        <p className="browser-hint">XScraper will extract conversations and forward to PostgreSQL</p>
                    </div>
                )}
            </div>

            {showClearSentModal && (
                <div className="xs-modal-overlay" onClick={() => setShowClearSentModal(false)}>
                    <div className="xs-modal" onClick={(e) => e.stopPropagation()}>
                        <h3 className="xs-modal-title">Clear Sent Messages?</h3>
                        <p className="xs-modal-body">
                            This deletes {forwardStats.forwarded} forwarded message(s) from the local SQLite queue.
                            PostgreSQL already holds them, so no data is lost there. Continue?
                        </p>
                        <div className="xs-modal-actions">
                            <button className="nav-btn full" type="button" onClick={() => setShowClearSentModal(false)}>
                                Cancel
                            </button>
                            <button className="nav-btn full danger" type="button" onClick={handleConfirmClearSent}>
                                Clear Sent
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </PageShell>
    );
}
