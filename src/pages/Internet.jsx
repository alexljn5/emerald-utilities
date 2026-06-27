import { useEffect, useState, useRef } from 'react';
import PageShell from './PageShell.jsx';
import { invoke } from '../js/electronApi.js';
import { checkFirefoxInstalled, launchFirefox, getDefaultPages } from '../scrapers/xscraper/index.js';
import emeraldFavicon from '../../img/favicons/favicon.png';
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
    const browserViewRef = useRef(null);
    const webviewRef = useRef(null);

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

                webview.style.width = `${Math.floor(width)}px`;
                webview.style.height = `${Math.floor(height)}px`;
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

        setLoading(true);
        setScraperStatus('Scraping messages...');
        try {
            const result = await webviewRef.current.executeJavaScript(`
                (function() {
                    if (window.__grokScraper && typeof window.__grokScraper.scrapeAll === 'function') {
                        return window.__grokScraper.scrapeAll();
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

    async function handleExport() {
        if (!webviewRef.current || !webviewReady) {
            setError('Browser is not ready');
            return;
        }

        setLoading(true);
        setScraperStatus('Exporting data...');
        try {
            const result = await webviewRef.current.executeJavaScript(`
                (function() {
                    if (window.__grokScraper && typeof window.__grokScraper.exportAsJSON === 'function') {
                        return window.__grokScraper.exportAsJSON();
                    }
                    return { success: false, error: 'Export not available' };
                })()
            `);
            if (result?.success) {
                setScraperStatus('Export complete');
            } else {
                setError(result?.error || 'Export failed');
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
                    <img src={emeraldFavicon} alt="XScraper" className="xscraper-icon" width="48" height="48" />
                </div>
                <div className="xscraper-status">
                    <span className={`status-indicator ${firefoxReady ? 'ready' : 'error'}`}>
                        {firefoxReady ? 'Firefox Ready' : 'Firefox Not Found'}
                    </span>
                </div>
                <div className="xscraper-stats">
                    <span>Messages: {scraperStats.messages}</span>
                    <span>Conversations: {scraperStats.conversations}</span>
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
                    <button
                        className="nav-btn full"
                        type="button"
                        onClick={handleScrape}
                        disabled={loading || !webviewReady}
                    >
                        Scrape Messages
                    </button>
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
