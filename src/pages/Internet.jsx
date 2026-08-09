import { useEffect, useState, useRef } from 'react';
import PageShell from './PageShell.jsx';
import { checkFirefoxInstalled, launchFirefox, getDefaultPages, exportData, getRealtimeStats, startRealtimeCrawler, stopRealtimeCrawler, exportIncremental, getNewMessages, forwardToPostgres, startLocalServer, forwardExportedToPostgres, clearExports } from '../scrapers/xscraper/index.js';
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
    const browserViewRef = useRef(null);
    const webviewRef = useRef(null);
    const scrapeIntervalRef = useRef(null);
    const lastAutoExportRef = useRef(0);
    const lastExportTimestampRef = useRef(0);
    const lastForwardTimestampRef = useRef(Date.now());

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

                // 2. Auto-export every 5 seconds
                const now = Date.now();
                if (now - lastAutoExportRef.current > 5000 && webviewRef.current) {
                    lastAutoExportRef.current = now;
                    const exportResult = await webviewRef.current.executeJavaScript(`
                        (function() {
                            if (window.__grokScraper && typeof window.__grokScraper.exportAsJSON === 'function') {
                                return window.__grokScraper.exportAsJSON();
                            }
                            return { success: false, error: 'Export not available' };
                        })()
                    `);
                    if (exportResult?.success && exportResult.data) {
                        const fsResult = await exportData(exportResult.data, 'great_white_throne');
                        if (fsResult?.success) {
                            const count = fsResult.files ? fsResult.files.length : 1;
                            setScraperStatus(`Live export (${count} files)`);
                        }
                    }
                }

                // 3. Forward new messages to PostgreSQL (direct from extension IndexedDB)
                const since = lastForwardTimestampRef.current;
                let newMessages = [];
                try {
                    const incResult = await webviewRef.current.executeJavaScript(`
                        (async () => {
                            if (window.__grokScraper && typeof window.__grokScraper.exportIncrementalJSON === 'function') {
                                return await window.__grokScraper.exportIncrementalJSON(${since});
                            }
                            return { success: false, error: 'Incremental export not available', messages: [] };
                        })()
                    `);
                    if (incResult?.messages && incResult.messages.length > 0) {
                        newMessages = incResult.messages;
                    }
                } catch (err) {
                    console.warn('[XScraper] Incremental export failed, falling back to local server:', err.message);
                    // Fallback: try local server
                    const fallbackResult = await getNewMessages(since);
                    if (fallbackResult?.success && fallbackResult.messages && fallbackResult.messages.length > 0) {
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
            }
        };

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
        setScraperStatus('Forwarding to PostgreSQL...');
        setError('');
        try {
            const result = await forwardExportedToPostgres();
            if (result?.success) {
                setForwardStats(prev => ({
                    inserted: prev.inserted + (result.inserted || 0),
                    skipped: prev.skipped + (result.skipped || 0),
                    errors: prev.errors + (result.errors || 0),
                }));
                setScraperStatus(result.message || `Forwarded ${result.inserted} messages to PostgreSQL`);
            } else {
                setError(result?.error || 'Failed to forward to PostgreSQL');
                setScraperStatus('Forward failed');
            }
        } catch (err) {
            setError(err?.message || 'Forward failed');
            setScraperStatus('Forward failed');
        } finally {
            setLoading(false);
        }
    }

    async function handleScrapeAndForward() {
        if (!webviewRef.current || !webviewReady) {
            setError('Browser is not ready');
            return;
        }

        setLoading(true);
        setScraperStatus('Starting scrape + forward...');
        setError('');
        try {
            // 1. Forward any existing exported data first
            const forwardResult = await forwardExportedToPostgres();
            if (forwardResult?.success) {
                setForwardStats(prev => ({
                    inserted: prev.inserted + (forwardResult.inserted || 0),
                    skipped: prev.skipped + (forwardResult.skipped || 0),
                    errors: prev.errors + (forwardResult.errors || 0),
                }));
            }

            // 2. Start the real-time scraper
            const scrapeResult = await startRealtimeCrawler(webviewRef.current);
            if (scrapeResult?.success) {
                setIsScraping(true);
                // See above: reconcile the full local store on the first pass.
                lastForwardTimestampRef.current = 0;
                setScraperStatus('Scraping + reconciling with PostgreSQL');
            } else {
                setError(scrapeResult?.error || 'Failed to start scrape');
                setScraperStatus('Scrape failed');
            }
        } catch (err) {
            setError(err?.message || 'Scrape + forward failed');
            setScraperStatus('Scrape + forward failed');
        } finally {
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
                    {isScraping && (
                        <>
                            <span className="forwarding-stat">Forwarded: {forwardStats.inserted}</span>
                            <span className="forwarding-stat">Skipped: {forwardStats.skipped}</span>
                            {forwardStats.errors > 0 && (
                                <span className="forwarding-stat error">Errors: {forwardStats.errors}</span>
                            )}
                        </>
                    )}
                </div>
                <div className="navButtons">
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
                    {!isScraping ? (
                        <button
                            className="nav-btn full"
                            type="button"
                            onClick={handleScrapeAndForward}
                            disabled={loading || !webviewReady}
                        >
                            Scrape & Forward
                        </button>
                    ) : (
                        <button
                            className="nav-btn full"
                            type="button"
                            onClick={handleScrape}
                            disabled={loading || !webviewReady}
                        >
                            Stop Scrape
                        </button>
                    )}
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
