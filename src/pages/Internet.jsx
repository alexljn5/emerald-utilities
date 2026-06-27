import { useEffect, useState, useRef } from 'react';
import PageShell from './PageShell.jsx';
import { invoke } from '../js/electronApi.js';
import { checkFirefoxInstalled, launchFirefox, getDefaultPages, exportData, getRealtimeStats, startRealtimeCrawler, stopRealtimeCrawler, exportIncremental } from '../scrapers/xscraper/index.js';
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
    const [isRealtime, setIsRealtime] = useState(false);
    const [realtimeStats, setRealtimeStats] = useState({ seen: 0, queue: 0 });
    const browserViewRef = useRef(null);
    const webviewRef = useRef(null);
    const realtimeIntervalRef = useRef(null);
    const lastAutoExportRef = useRef(0);
    const lastExportTimestampRef = useRef(0);

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

        checkFirefox();

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

    // Real-time stats polling + auto-export
    useEffect(() => {
        if (!isRealtime || !webviewReady) {
            if (realtimeIntervalRef.current) {
                clearInterval(realtimeIntervalRef.current);
                realtimeIntervalRef.current = null;
            }
            return;
        }

        const pollStats = async () => {
            try {
                const result = await getRealtimeStats(webviewRef.current);
                if (result?.success && result.stats) {
                    setRealtimeStats(result.stats);
                    setScraperStats(prev => ({
                        ...prev,
                        messages: result.stats.seen || prev.messages
                    }));

                    // Auto-export all messages every 5 seconds to a live file
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
                            const fsResult = await exportData(exportResult.data, 'grok_export_live.json');
                            if (fsResult?.success) {
                                setScraperStatus(`Live export updated (${exportResult.data.totalMessages || 0} messages)`);
                            } else {
                                console.error('Auto-export failed:', fsResult?.error);
                            }
                        }
                    }
                }
            } catch (err) {
                console.error('Real-time stats poll error:', err);
            }
        };

        pollStats();
        realtimeIntervalRef.current = setInterval(pollStats, 1000);

        return () => {
            if (realtimeIntervalRef.current) {
                clearInterval(realtimeIntervalRef.current);
                realtimeIntervalRef.current = null;
            }
        };
    }, [isRealtime, webviewReady]);

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
                // Session already exists, just navigate the webview
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

        if (isRealtime) {
            // Stop real-time crawler
            setLoading(true);
            setScraperStatus('Stopping real-time scrape...');
            try {
                const result = await stopRealtimeCrawler(webviewRef.current);
                if (result?.success) {
                    setIsRealtime(false);
                    setScraperStatus('Real-time scrape stopped');
                } else {
                    setError(result?.error || 'Failed to stop real-time scrape');
                }
            } catch (err) {
                setError(err?.message || 'Failed to stop real-time scrape');
            } finally {
                setLoading(false);
            }
            return;
        }

        setLoading(true);
        setScraperStatus('Scraping messages...');
        try {
            const result = await webviewRef.current.executeJavaScript(`
                (async function() {
                    const waitForScraper = async () => {
                        for (let attempt = 0; attempt < 50; attempt += 1) {
                            if (window.__grokScraper) return window.__grokScraper;
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                        return null;
                    };

                    const scraper = await waitForScraper();
                    if (!scraper) {
                        return { success: false, error: 'Scraper not available' };
                    }

                    if (typeof scraper.scrapeAll === 'function') {
                        return scraper.scrapeAll();
                    }

                    if (typeof scraper.scrape === 'function') {
                        return scraper.scrape();
                    }

                    return { success: false, error: 'Scraper not available' };
                })()
            `);
            if (result?.success) {
                setScraperStats(prev => ({
                    ...prev,
                    messages: prev.messages + (result.saved || 0)
                }));
                setScraperStatus('Scraping complete');
            } else {
                setError(result?.error || 'Scraping failed');
            }
        } catch (err) {
            setError(err?.message || 'Scraping failed');
        } finally {
            setLoading(false);
        }
    }

    async function handleStartRealtime() {
        if (!webviewRef.current || !webviewReady) {
            setError('Browser is not ready');
            return;
        }

        setLoading(true);
        setScraperStatus('Starting real-time scrape...');
        try {
            const result = await startRealtimeCrawler(webviewRef.current);
            if (result?.success) {
                setIsRealtime(true);
                setScraperStatus('Real-time scraping active');
            } else {
                setError(result?.error || 'Failed to start real-time scrape');
            }
        } catch (err) {
            setError(err?.message || 'Failed to start real-time scrape');
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
                // Write to filesystem via main process
                const fsResult = await exportData(exportResult.data);
                if (fsResult?.success) {
                    setScraperStatus(`Exported to ${fsResult.filename}`);
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

    return (
        <PageShell title="Internet Access" route={route} setRoute={setRoute} showBack={true} leftChildren={
            <div className="navBox">
                <h2>XScraper</h2>
                <div className="xscraper-icon-container">
                    <img src={xscraperLogo} alt="XScraper" className="xscraper-icon" width="64" height="64" />
                </div>
                <div className="xscraper-status">
                    <span className={`status-indicator ${isRealtime ? 'realtime' : (firefoxReady ? 'ready' : 'error')}`}>
                        {isRealtime ? 'Real-Time Scraping Active' : (firefoxReady ? 'Firefox Ready' : 'Firefox Not Found')}
                    </span>
                </div>
                <div className="xscraper-stats">
                    <span>Messages: {scraperStats.messages}</span>
                    <span>Seen: {realtimeStats.seen}</span>
                    <span>Queue: {realtimeStats.queue}</span>
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
                    {!isRealtime ? (
                        <button
                            className="nav-btn full"
                            type="button"
                            onClick={handleStartRealtime}
                            disabled={loading || !webviewReady}
                        >
                            Start Real-Time Scrape
                        </button>
                    ) : (
                        <button
                            className="nav-btn full"
                            type="button"
                            onClick={handleScrape}
                            disabled={loading || !webviewReady}
                        >
                            Stop Real-Time Scrape
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
            <div className="internet-content">
                {error && (
                    <div className="internet-error">
                        {error}
                    </div>
                )}

                <div className="browser-container">
                    <div className="browser-header">
                        <div className="browser-tabs">
                            {DEFAULT_PAGES.map(page => (
                                <button
                                    key={page.id}
                                    className={`browser-tab ${activePage === page.id ? 'active' : ''}`}
                                    onClick={() => handleNavigate(page.id)}
                                    type="button"
                                >
                                    {page.name}
                                </button>
                            ))}
                        </div>
                        <div className="browser-address-bar">
                            <input
                                type="text"
                                value={browserUrl}
                                onChange={(e) => setBrowserUrl(e.target.value)}
                                placeholder="Enter URL"
                                className="address-input"
                            />
                            <button
                                className="go-btn"
                                onClick={handleLaunchFirefox}
                                disabled={loading || !firefoxReady}
                                type="button"
                            >
                                Go
                            </button>
                        </div>
                    </div>

                    <div className="browser-view" ref={browserViewRef}>
                        {partition && webviewUrl ? (
                            <webview
                                ref={webviewRef}
                                src={webviewUrl}
                                partition={partition}
                                className="browser-webview"
                                autosize="on"
                                minwidth="320"
                                minheight="240"
                                maxwidth="4096"
                                maxheight="4096"
                                style={{ width: '100%', height: '100%' }}
                            />
                        ) : (
                            <div className="browser-placeholder">
                                <p>Firefox browser will appear here</p>
                                <p className="browser-hint">Click "Launch Browser" to start browsing</p>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </PageShell>
    );
}
