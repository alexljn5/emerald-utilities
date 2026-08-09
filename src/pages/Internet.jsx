import { useEffect, useState, useRef } from 'react';
import PageShell from './PageShell.jsx';
import { checkFirefoxInstalled, launchFirefox, getDefaultPages, exportData, getRealtimeStats, startRealtimeCrawler, stopRealtimeCrawler, exportIncremental, getNewMessages, forwardToPostgres, startLocalServer, forwardExportedToPostgres, clearExports, clearLocalStore } from '../scrapers/xscraper/index.js';
import xscraperLogo from '../../img/logos/alexljn5_logo_merge_transparent.png';
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
    const [forwardStats, setForwardStats] = useState({ inserted: 0, skipped: 0, errors: 0 });
    const [showAdvanced, setShowAdvanced] = useState(false);
    const browserViewRef = useRef(null);
    const webviewRef = useRef(null);
    const scrapeIntervalRef = useRef(null);
    const lastAutoExportRef = useRef(0);
    const lastExportTimestampRef = useRef(0);
    const lastForwardTimestampRef = useRef(Date.now());
    // Prevents overlapping poll ticks: a slow PostgreSQL round-trip must not
    // cause the same delta to be read and forwarded twice concurrently.
    const pollBusyRef = useRef(false);
    // Set when Live Sync is requested before the webview exists, so the sync
    // starts by itself as soon as the browser is ready (one button -> all).
    const autoStartRef = useRef(false);

    /**
     * Read messages the extension has stored locally since `since`.
     *
     * The response travels page -> content script -> background -> back, and
     * the background wraps its payload: { success, data: { messages: [...] } }.
     * Reading `result.messages` (no `.data`) silently yields undefined, which
     * is why the live loop reported "Forwarded: 0" while the scraper happily
     * counted 134 seen messages.
     */
    async function readLocalDelta(webview, since) {
        if (!webview) return [];
        const res = await webview.executeJavaScript(`
            (async () => {
                if (window.__grokScraper && typeof window.__grokScraper.exportIncrementalJSON === 'function') {
                    try {
                        return await window.__grokScraper.exportIncrementalJSON(${Number(since) || 0});
                    } catch (e) {
                        return { success: false, error: String(e && e.message || e) };
                    }
                }
                return { success: false, error: 'Scraper not injected yet' };
            })()
        `);
        if (res && res.success === false && res.error) {
            console.warn('[XScraper] local delta unavailable:', res.error);
        }
        return res?.data?.messages || res?.messages || [];
    }

    useEffect(() => {
        let cancelled = false;

        async function checkFirefox() {
            try {
                const installed = await checkFirefoxInstalled();
                if (!cancelled) {
                    setFirefoxReady(installed);
                }
            } catch (err) {
                if (!cancelled) {
                    setError('Unable to check Firefox installation');
                }
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
            if (matchedPage) {
                setActivePage(matchedPage.id);
            }
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

    // One-button continuation: Live Sync was requested while the browser was
    // still starting, so kick it off the moment the webview is usable.
    useEffect(() => {
        if (!autoStartRef.current) return;
        if (!webviewReady || isScraping || loading) return;
        autoStartRef.current = false;
        startLiveSync();
    }, [webviewReady, isScraping, loading]);

    // Scrape + Forward polling loop
    useEffect(() => {
        if (!isScraping || !webviewReady) {
            if (scrapeIntervalRef.current) {
                clearInterval(scrapeIntervalRef.current);
                scrapeIntervalRef.current = null;
            }
            return;
        }

        const pollAndForward = async () => {
            // A tick that is still waiting on PostgreSQL must not be joined by
            // the next one: both would read the same delta from the same
            // checkpoint and send it twice.
            if (pollBusyRef.current) return;
            pollBusyRef.current = true;
            try {
                // 1. Get scraper stats
                const result = await getRealtimeStats(webviewRef.current);
                if (result?.success && result.stats) {
                    setRealtimeStats(result.stats);
                    setScraperStats(prev => ({
                        ...prev,
                        messages: result.stats.seen || prev.messages
                    }));
                }

                // 2. NO automatic JSON export.
                //    PostgreSQL is the authoritative store; dumping the whole
                //    IndexedDB to src/database/grok/*.json every 5 seconds only
                //    recreated files that were deliberately deleted and spammed
                //    the log. Use the "Export Data" button for a manual snapshot.

                // 3. Forward new messages to PostgreSQL (direct from extension IndexedDB)
                const since = lastForwardTimestampRef.current;
                let newMessages = [];
                try {
                    newMessages = await readLocalDelta(webviewRef.current, since);
                } catch (err) {
                    console.warn('[XScraper] Incremental export failed, falling back to local server:', err.message);
                    // Fallback: try local server (SQLite mirror written by the
                    // extension's HTTP flush).
                    const fallbackResult = await getNewMessages(since);
                    if (fallbackResult?.success && fallbackResult.messages?.length > 0) {
                        newMessages = fallbackResult.messages;
                    }
                }

                if (newMessages.length > 0) {
                    console.log(`[XScraper] ${newMessages.length} local messages to reconcile`);

                    const messagesByConv = {};
                    for (const msg of newMessages) {
                        const cid = msg.conversationId || 'default';
                        if (!messagesByConv[cid]) messagesByConv[cid] = [];
                        messagesByConv[cid].push(msg);
                    }

                    let totalInserted = 0;
                    let totalSkipped = 0;
                    let totalErrors = 0;
                    let allConfirmed = true;

                    for (const [convId, msgs] of Object.entries(messagesByConv)) {
                        const fwdResult = await forwardToPostgres(msgs, convId);
                        if (fwdResult?.success) {
                            totalInserted += fwdResult.inserted || 0;
                            totalSkipped += fwdResult.skipped || 0;
                            totalErrors += fwdResult.errors?.length || 0;
                        } else {
                            // PostgreSQL did not confirm persistence for this batch.
                            allConfirmed = false;
                            totalErrors += 1;
                            console.warn('[XScraper] Forward failed, keeping messages local for retry:', fwdResult?.error);
                        }
                    }

                    setForwardStats(prev => ({
                        inserted: prev.inserted + totalInserted,
                        skipped: prev.skipped + totalSkipped,
                        errors: prev.errors + totalErrors,
                    }));

                    // DURABLE CHECKPOINT: only advance once PostgreSQL confirmed
                    // persistence, and only up to the newest message we actually
                    // handled — never to "now", which would silently drop any
                    // message saved locally while the request was in flight.
                    if (allConfirmed) {
                        const maxSavedAt = newMessages.reduce(
                            (acc, m) => Math.max(acc, Number(m.savedAt) || 0),
                            0
                        );
                        if (maxSavedAt > lastForwardTimestampRef.current) {
                            lastForwardTimestampRef.current = maxSavedAt;
                        }
                        setScraperStatus(`PostgreSQL: inserted ${totalInserted}, already present ${totalSkipped}`);
                    } else {
                        setScraperStatus('PostgreSQL unavailable — retrying, nothing lost');
                    }
                }
            } catch (err) {
                console.error('[XScraper] Poll error:', err);
            } finally {
                pollBusyRef.current = false;
            }
        };

        pollBusyRef.current = false;
        pollAndForward();
        scrapeIntervalRef.current = setInterval(pollAndForward, 2000);

        return () => {
            if (scrapeIntervalRef.current) {
                clearInterval(scrapeIntervalRef.current);
                scrapeIntervalRef.current = null;
            }
        };
    }, [isScraping, webviewReady]);

    useEffect(() => {
        const browserView = browserViewRef.current;
        const webview = webviewRef.current;
        if (!browserView || !webview) return;

        let animationFrame = null;

        const syncWebviewSize = () => {
            if (animationFrame) {
                cancelAnimationFrame(animationFrame);
            }

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
            if (animationFrame) {
                cancelAnimationFrame(animationFrame);
            }
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
                const result = await launchFirefox({
                    url: browserUrl,
                    extensionPath: 'src/scrapers/xscraper'
                });
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
            if (partition) {
                setWebviewUrl(page.url);
            }
            setScraperStatus(`Navigating to ${page.name}...`);
        }
    }

    async function handleScrape() {
        if (!webviewRef.current || !webviewReady) {
            setError('Browser is not ready');
            return;
        }

        if (isScraping) {
            // Stop scraping
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

        // Start scraping
        setLoading(true);
        setScraperStatus('Starting scrape...');
        try {
            const result = await startRealtimeCrawler(webviewRef.current);
            if (result?.success) {
                setIsScraping(true);
                setForwardStats({ inserted: 0, skipped: 0, errors: 0 });
                // Start from 0: the first pass reconciles the WHOLE local store
                // against PostgreSQL. Already-persisted messages are detected by
                // canonical identity and skipped, so this is cheap and converges.
                lastForwardTimestampRef.current = 0;
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

    async function handleForwardToPostgres() {
        setLoading(true);
        setScraperStatus('Reconciling local XScraper store with PostgreSQL...');
        setError('');
        try {
            const totals = { localTotal: 0, alreadyInPostgres: 0, inserted: 0, skipped: 0, errors: 0 };
            const add = (r) => {
                totals.localTotal += r.localTotal || 0;
                totals.alreadyInPostgres += r.alreadyInPostgres || 0;
                totals.inserted += r.inserted || 0;
                totals.skipped += r.skipped || 0;
                totals.errors += r.errors || 0;
            };

            // 1. Extension IndexedDB — the store the scraper itself writes to.
            //    It lives in the webview partition, so only the renderer can
            //    read it; the main process sees SQLite/JSON only. Without this
            //    step the button reports "sqlite=0 json=0" even though the
            //    extension is holding a freshly scraped conversation.
            if (webviewRef.current && webviewReady) {
                const msgs = await readLocalDelta(webviewRef.current, 0);
                if (msgs.length > 0) {
                    const byConv = {};
                    for (const msg of msgs) {
                        const cid = msg.conversationId || 'default';
                        if (!byConv[cid]) byConv[cid] = [];
                        byConv[cid].push(msg);
                    }
                    for (const [cid, list] of Object.entries(byConv)) {
                        const r = await forwardToPostgres(list, cid);
                        if (r?.success) {
                            add(r);
                        } else {
                            totals.errors += 1;
                            console.warn('[XScraper] IndexedDB reconcile failed:', r?.error);
                        }
                    }
                }
            }

            // 2. SQLite cache + any legacy JSON snapshots (main process side).
            const result = await forwardExportedToPostgres();
            if (result?.success) {
                add(result);
            } else {
                totals.errors += 1;
                setError(result?.error || 'Failed to reconcile local store');
            }

            setForwardStats(prev => ({
                inserted: prev.inserted + totals.inserted,
                skipped: prev.skipped + totals.skipped,
                errors: prev.errors + totals.errors,
            }));

            if (totals.localTotal === 0) {
                setScraperStatus('No local XScraper messages found — nothing to reconcile');
            } else {
                setScraperStatus(
                    `Reconciled ${totals.localTotal} local messages: inserted ${totals.inserted}, ` +
                    `already present ${totals.alreadyInPostgres}`
                );
            }
        } catch (err) {
            setError(err?.message || 'Forward failed');
            setScraperStatus('Forward failed');
        } finally {
            setLoading(false);
        }
    }

    /**
     * THE button. Everything the pipeline needs, in one click:
     * launch the browser if it isn't up, catch up on the local mirror, reset
     * the scraper's dedupe cache, start the crawler and leave the poll loop
     * streaming every new message straight into PostgreSQL. Clicking it again
     * stops the live sync.
     */
    async function handleLiveSync() {
        if (isScraping) {
            setLoading(true);
            setScraperStatus('Stopping live sync...');
            try {
                await stopRealtimeCrawler(webviewRef.current);
            } catch (err) {
                console.warn('[XScraper] stopCrawler failed:', err?.message);
            } finally {
                autoStartRef.current = false;
                setIsScraping(false);
                setScraperStatus('Live sync stopped');
                setLoading(false);
            }
            return;
        }

        setError('');

        // No browser yet: launch it and pick up automatically as soon as the
        // webview reports dom-ready, so the user still only pressed once.
        if (!partition || !webviewReady || !webviewRef.current) {
            autoStartRef.current = true;
            setScraperStatus('Launching browser for live sync...');
            if (!partition) await handleLaunchFirefox();
            return;
        }

        await startLiveSync();
    }

    async function startLiveSync() {
        if (!webviewRef.current) return;

        setLoading(true);
        setError('');
        setScraperStatus('Starting live sync...');
        try {
            // 1. Catch up: reconcile whatever is already in the local SQLite
            //    mirror and any legacy JSON snapshots. Identity-based
            //    reconciliation makes this safe on every start — messages
            //    PostgreSQL already holds come back as skipped, not inserted.
            const sweep = await forwardExportedToPostgres();
            if (sweep?.success) {
                setForwardStats(prev => ({
                    inserted: prev.inserted + (sweep.inserted || 0),
                    skipped: prev.skipped + (sweep.skipped || 0),
                    errors: prev.errors + (sweep.errors || 0),
                }));
            }

            // 2. Drop the scraper's in-memory dedupe cache so the messages
            //    currently on screen are captured again. Without this, a
            //    scraper that already "saw" them after a local wipe would never
            //    re-emit anything. Re-emitting is harmless: IndexedDB upserts by
            //    id and PostgreSQL reconciliation is identity based.
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

            // 3. Start the real-time scraper. From here the poll loop above
            //    forwards every delta to PostgreSQL by itself.
            const scrapeResult = await startRealtimeCrawler(webviewRef.current);
            if (scrapeResult?.success) {
                setIsScraping(true);
                // Reconcile the full local store on the first pass.
                lastForwardTimestampRef.current = 0;
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
                // The local checkpoint is meaningless once the local store is
                // empty; reset it so the next pass reconciles from scratch.
                lastForwardTimestampRef.current = 0;

                // The injected scraper keeps an in-memory `seen` set of message
                // ids, and the extension caches an open IndexedDB handle.
                // Wiping the storage underneath them leaves the scraper running
                // but unable to record anything — it looks exactly like
                // "scraping but nothing arrives". Reset the dedupe cache, then
                // reload the webview so a fresh IndexedDB connection is opened.
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

                // Scraping has to be restarted after the reload.
                setIsScraping(false);
                setScraperStats(prev => ({ ...prev, messages: 0 }));
                setRealtimeStats({ seen: 0, queue: 0, stuck: 0, idle: 0 });
                setForwardStats({ inserted: 0, skipped: 0, errors: 0 });
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
                    <span>Messages: {scraperStats.messages}</span>
                    <span>Seen: {realtimeStats.seen}</span>
                    <span>Queue: {realtimeStats.queue}</span>
                    <span className="forwarding-stat">Inserted: {forwardStats.inserted}</span>
                    <span className="forwarding-stat">Skipped: {forwardStats.skipped}</span>
                    {forwardStats.errors > 0 && (
                        <span className="forwarding-stat error">Errors: {forwardStats.errors}</span>
                    )}
                </div>
                <div className="navButtons">
                    {/* One button, whole pipeline: launch -> catch up -> scrape
                        -> stream to PostgreSQL. Everything else is optional. */}
                    <button
                        className={`nav-btn full primary${isScraping ? ' live' : ''}`}
                        type="button"
                        onClick={handleLiveSync}
                        disabled={loading || !firefoxReady}
                        title="Launches the browser if needed, reconciles the local store, then streams every new message to PostgreSQL as it is scraped."
                    >
                        {loading ? 'Working...' : (isScraping ? 'Stop Live Sync' : 'Start Live Sync')}
                    </button>

                    <button
                        className="nav-btn full subtle"
                        type="button"
                        onClick={() => setShowAdvanced(v => !v)}
                    >
                        {showAdvanced ? 'Hide manual controls' : 'Manual controls'}
                    </button>

                    {showAdvanced && (
                        <>
                            <button
                                className="nav-btn full"
                                type="button"
                                onClick={handleLaunchFirefox}
                                disabled={loading || !firefoxReady}
                            >
                                {loading ? 'Launching...' : 'Launch Browser'}
                            </button>
                            <button
                                className="nav-btn full"
                                type="button"
                                onClick={handleCloseBrowser}
                                disabled={loading || !partition}
                            >
                                Close Browser
                            </button>
                            <button
                                className="nav-btn full"
                                type="button"
                                onClick={handleScrape}
                                disabled={loading || !webviewReady}
                            >
                                {isScraping ? 'Stop Scrape Only' : 'Start Scrape Only'}
                            </button>
                            <button
                                className="nav-btn full"
                                type="button"
                                onClick={handleExport}
                                disabled={loading || !webviewReady}
                            >
                                Export Data
                            </button>
                            <button
                                className="nav-btn full"
                                type="button"
                                onClick={handleForwardToPostgres}
                                disabled={loading}
                            >
                                Forward to PostgreSQL
                            </button>
                            <button
                                className="nav-btn full"
                                type="button"
                                onClick={handleClearExports}
                                disabled={loading}
                            >
                                Clear Exports
                            </button>
                            <button
                                className="nav-btn full danger"
                                type="button"
                                onClick={handleClearLocalStore}
                                disabled={loading}
                                title="Wipes the local SQLite cache, the extension IndexedDB and JSON snapshots. PostgreSQL is not touched."
                            >
                                Clear Local Store
                            </button>
                        </>
                    )}
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
        </PageShell>
    );
}
