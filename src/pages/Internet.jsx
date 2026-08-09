import { useEffect, useState, useRef } from 'react';
import PageShell from './PageShell.jsx';
import { checkFirefoxInstalled, launchFirefox, getDefaultPages, exportData, getRealtimeStats, startRealtimeCrawler, stopRealtimeCrawler, exportIncremental, getNewMessages, forwardToPostgres, startLocalServer, forwardExportedToPostgres, clearExports, clearLocalStore } from '../scrapers/xscraper/index.js';
import xscraperLogo from '../../img/logos/alexljn5_logo_merge_transparent.png';

/** Automatic forwarding worker tick. */
const SYNC_TICK_MS = 2000;
/** Messages per PostgreSQL round-trip. */
const FORWARD_CHUNK = 250;
/** When nothing is pending, only re-read the local store every N ticks. */
const IDLE_READ_TICKS = 4;
/** Upper bound for reconnect backoff. */
const MAX_BACKOFF_MS = 60000;
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
    // Real pipeline state, so the UI can never show "Inserted: 0" without
    // saying whether work is waiting, running, blocked or simply done.
    const [syncState, setSyncState] = useState({
        connection: 'idle',   // idle | syncing | connected | retrying
        discovered: 0,        // messages present in the local store
        pending: 0,           // not yet confirmed by PostgreSQL
        processing: 0,        // in flight right now
        failed: 0,            // failed transmissions (still retryable)
        lastSyncAt: null
    });
    // Automatic sync is normal operation and is ON by default. Persisted as an
    // ordinary app setting — deliberately not an environment variable.
    const [liveSyncEnabled, setLiveSyncEnabled] = useState(() => {
        try {
            return localStorage.getItem('xscraper.liveSyncEnabled') !== 'false';
        } catch {
            return true;
        }
    });
    const [showAdvanced, setShowAdvanced] = useState(false);
    const browserViewRef = useRef(null);
    const webviewRef = useRef(null);
    const scrapeIntervalRef = useRef(null);
    const lastAutoExportRef = useRef(0);
    const lastExportTimestampRef = useRef(0);
    // Canonical identities PostgreSQL has confirmed during this session.
    // The live loop is identity-based, NOT timestamp-based: `savedAt` is
    // rewritten on every re-save of the same message, and a single bogus or
    // future `savedAt` used to poison the watermark permanently, which left
    // the loop silent and forced a manual "Forward to PostgreSQL" click.
    const forwardedIdsRef = useRef(new Set());
    // Exactly one flush may run at a time. The manual button and the automatic
    // worker share this lock, so clicking "Forward now" during a live sync
    // cannot produce a second pipeline or a double insert attempt.
    const flushBusyRef = useRef(false);
    const flushPendingRef = useRef(async () => null);
    const pendingCountRef = useRef(0);
    // Cheap short-circuit so a fully reconciled store does not cause a
    // full IndexedDB read + PostgreSQL round-trip on every single tick.
    const idleTicksRef = useRef(0);
    // Bounded reconnect backoff when PostgreSQL is unreachable.
    const backoffUntilRef = useRef(0);
    const backoffMsRef = useRef(0);
    // Prevents overlapping poll ticks: a slow PostgreSQL round-trip must not
    // cause the same delta to be read and forwarded twice concurrently.
    const pollBusyRef = useRef(false);
    // Set when Live Sync is requested before the webview exists, so the sync
    // starts by itself as soon as the browser is ready (one button -> all).
    const autoStartRef = useRef(false);
    // One automatic start per ready browser, so a failing crawler start does
    // not retry on every render.
    const autoStartedRef = useRef(false);

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

    /**
     * Canonical identity of a locally stored message.
     *
     * Must mirror the backend: PostgreSQL identity is
     * (conversation_id, source_message_id) and the scraper's `m.id` IS the
     * source_message_id. Position, array index and savedAt are deliberately
     * NOT part of the identity — they change on every re-save and re-export.
     */
    function identityOf(m) {
        const cid = m.conversationId || 'default';
        const sid = m.id || m.messageId || m.sourceMessageId || '';
        return `${cid}::${sid}`;
    }

    /**
     * THE authoritative queue flush.
     *
     * Both the automatic worker and the manual "Forward now" button call this
     * exact function, so a manual click never spawns a second pipeline and can
     * never race the timer: `flushBusyRef` serialises them.
     *
     * Returns { discovered, pending, attempted, inserted, skipped, failed, pendingAfter }.
     */
    async function flushPending({ force = false, reason = 'auto' } = {}) {
        if (flushBusyRef.current) return null;

        // Bounded backoff: PostgreSQL unreachable -> wait, do not hammer it and
        // do not spawn overlapping retries. A manual click bypasses the wait.
        if (!force && backoffUntilRef.current > Date.now()) return null;

        flushBusyRef.current = true;
        try {
            // Reading the whole local store is the only way to be correct
            // (identities, not timestamps). Once the store is fully reconciled
            // we back off to one read every IDLE_READ_TICKS ticks so a large
            // history does not get serialised out of the webview every 2s.
            if (!force && pendingCountRef.current === 0 && idleTicksRef.current > 0) {
                idleTicksRef.current -= 1;
                return null;
            }
            idleTicksRef.current = IDLE_READ_TICKS;

            let localMessages = [];
            try {
                localMessages = await readLocalDelta(webviewRef.current, 0);
            } catch (err) {
                console.warn('[XScraper] IndexedDB read failed, trying SQLite mirror:', err.message);
                const fallback = await getNewMessages(0);
                if (fallback?.success && fallback.messages?.length) {
                    localMessages = fallback.messages;
                }
            }

            // Subtract what PostgreSQL already confirmed this session.
            const pending = [];
            for (const m of localMessages) {
                if (!forwardedIdsRef.current.has(identityOf(m))) pending.push(m);
            }

            pendingCountRef.current = pending.length;
            setSyncState(prev => ({
                ...prev,
                discovered: localMessages.length,
                pending: pending.length
            }));

            if (pending.length === 0) {
                setSyncState(prev => ({ ...prev, connection: 'idle' }));
                return {
                    discovered: localMessages.length, pending: 0, attempted: 0,
                    inserted: 0, skipped: 0, failed: 0, pendingAfter: 0
                };
            }

            setSyncState(prev => ({ ...prev, connection: 'syncing', processing: pending.length }));

            const byConv = {};
            for (const m of pending) {
                const cid = m.conversationId || 'default';
                (byConv[cid] ||= []).push(m);
            }

            let inserted = 0;
            let skipped = 0;
            let failed = 0;
            let anyFailure = false;

            for (const [convId, msgs] of Object.entries(byConv)) {
                // Chunked so one huge conversation cannot stall the worker or
                // blow the IPC payload limit.
                for (let i = 0; i < msgs.length; i += FORWARD_CHUNK) {
                    const chunk = msgs.slice(i, i + FORWARD_CHUNK);
                    const r = await forwardToPostgres(chunk, convId);

                    if (r?.success) {
                        inserted += r.inserted || 0;
                        skipped += r.skipped || 0;
                        // Durable: PostgreSQL confirmed the row is present
                        // (inserted now, or already there). Only now may the
                        // message leave the pending set.
                        for (const m of chunk) forwardedIdsRef.current.add(identityOf(m));
                    } else {
                        anyFailure = true;
                        failed += chunk.length;
                        console.warn('[XScraper] forward failed, staying pending for retry:', r?.error);
                    }
                }
            }

            const pendingAfter = Math.max(0, pending.length - (inserted + skipped));
            pendingCountRef.current = pendingAfter;

            setForwardStats(prev => ({
                inserted: prev.inserted + inserted,
                skipped: prev.skipped + skipped,
                errors: prev.errors + (anyFailure ? 1 : 0)
            }));

            if (anyFailure) {
                // Exponential, capped. Nothing is lost: the messages stay in
                // IndexedDB and stay out of forwardedIds.
                backoffMsRef.current = Math.min((backoffMsRef.current || 2000) * 2, MAX_BACKOFF_MS);
                backoffUntilRef.current = Date.now() + backoffMsRef.current;
                setSyncState(prev => ({
                    ...prev, processing: 0, failed: prev.failed + failed,
                    pending: pendingAfter, connection: 'retrying'
                }));
                setScraperStatus(`PostgreSQL unreachable — ${pendingAfter} pending, retry in ${Math.round(backoffMsRef.current / 1000)}s`);
            } else {
                backoffMsRef.current = 0;
                backoffUntilRef.current = 0;
                setSyncState(prev => ({
                    ...prev, processing: 0, pending: pendingAfter,
                    connection: 'connected', lastSyncAt: Date.now()
                }));
                setScraperStatus(`Live sync: +${inserted} new, ${skipped} already in PostgreSQL`);
            }

            console.log(
                `[XScraper] flush(${reason}) discovered=${localMessages.length} ` +
                `attempted=${pending.length} inserted=${inserted} skipped=${skipped} ` +
                `failed=${failed} pendingAfter=${pendingAfter}`
            );

            return {
                discovered: localMessages.length, pending: pending.length,
                attempted: pending.length, inserted, skipped, failed, pendingAfter
            };
        } finally {
            flushBusyRef.current = false;
        }
    }

    // Keep the ref pointing at the latest closure so the interval never calls
    // a stale version holding old state.
    flushPendingRef.current = flushPending;

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

    // PLUG-AND-PLAY: automatic sync is normal operation. As soon as the
    // browser is usable, the pipeline starts by itself — no Export click, no
    // Forward click, no manual scrape. `autoStartRef` still covers the case
    // where the user pressed the button before the webview existed.
    //
    // Stopping sets `liveSyncEnabled = false`, so a deliberate Stop is not
    // immediately undone by this effect.
    useEffect(() => {
        if (!webviewReady) {
            // Browser went away; allow one auto-start again when it returns.
            autoStartedRef.current = false;
            return;
        }
        if (isScraping || loading) return;
        if (!liveSyncEnabled && !autoStartRef.current) return;
        // Only one automatic attempt per ready browser. Without this a failing
        // crawler start would retry on every render forever.
        if (autoStartedRef.current && !autoStartRef.current) return;
        autoStartedRef.current = true;
        autoStartRef.current = false;
        startLiveSync();
    }, [webviewReady, isScraping, loading, liveSyncEnabled]);

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

                // 3. Flush pending local messages to PostgreSQL.
                //
                //    This is the ONE authoritative forwarding worker. It is
                //    identity-based, never timestamp-based: the extension
                //    rewrites `savedAt` every time it re-saves a message, and a
                //    single bogus/future `savedAt` used to push the watermark
                //    past everything, after which the loop went permanently
                //    silent and only a manual "Forward" (which reads from 0)
                //    still worked. That is the bug behind
                //    "Queue: 575 / Inserted: 0".
                await flushPendingRef.current();
            } catch (err) {
                console.error('[XScraper] Poll error:', err);
            } finally {
                pollBusyRef.current = false;
            }
        };

        pollBusyRef.current = false;
        pollAndForward();
        scrapeIntervalRef.current = setInterval(pollAndForward, SYNC_TICK_MS);

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
                // First pass reconciles the WHOLE local store against
                // PostgreSQL. Already-persisted messages are detected by
                // canonical identity and skipped, so this is cheap and converges.
                idleTicksRef.current = 0;
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
            //    read it; the main process sees SQLite/JSON only.
            //
            //    This calls THE SAME flush the automatic worker uses, forced
            //    past the backoff. It is a recovery/force-sync control, never a
            //    second pipeline: `flushBusyRef` serialises it against the
            //    timer, so a click during a live sync cannot double-send.
            if (webviewRef.current && webviewReady) {
                const r = await flushPendingRef.current({ force: true, reason: 'manual' });
                if (r) {
                    totals.localTotal += r.discovered || 0;
                    totals.alreadyInPostgres += r.skipped || 0;
                    // flushPending already updated forwardStats; only report here.
                    totals.reportedInserted = (totals.reportedInserted || 0) + (r.inserted || 0);
                    totals.reportedSkipped = (totals.reportedSkipped || 0) + (r.skipped || 0);
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
    /** Persist the automatic-sync flag as an ordinary app setting. */
    function persistLiveSync(enabled) {
        setLiveSyncEnabled(enabled);
        try {
            localStorage.setItem('xscraper.liveSyncEnabled', String(enabled));
        } catch {
            /* storage unavailable: in-memory default still applies */
        }
    }

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
                // A deliberate Stop turns automatic sync OFF, otherwise the
                // plug-and-play effect would restart it on the next render.
                persistLiveSync(false);
                setIsScraping(false);
                setScraperStatus('Live sync stopped');
                setSyncState(prev => ({ ...prev, connection: 'idle', processing: 0 }));
                setLoading(false);
            }
            return;
        }

        setError('');
        persistLiveSync(true);

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
                // Force a full local read on the very next tick so the first
                // pass reconciles the entire store.
                idleTicksRef.current = 0;
                backoffUntilRef.current = 0;
                backoffMsRef.current = 0;
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
                // The session's "already confirmed" identity set describes a
                // store that no longer exists; drop it so the next pass
                // reconciles whatever is re-scraped from scratch.
                forwardedIdsRef.current = new Set();
                pendingCountRef.current = 0;
                idleTicksRef.current = 0;
                setSyncState(prev => ({
                    ...prev, discovered: 0, pending: 0, processing: 0, connection: 'idle'
                }));

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
                    {/* Scraper side: what the page crawler has found. */}
                    <span>Seen: {realtimeStats.seen}</span>
                    <span>Scrape queue: {realtimeStats.queue}</span>
                    {/* Sync side: what PostgreSQL has actually confirmed. */}
                    <span>Local: {syncState.discovered}</span>
                    <span className="forwarding-stat">
                        Pending: {syncState.pending}
                        {syncState.processing > 0 ? ` (${syncState.processing} sending)` : ''}
                    </span>
                    <span className="forwarding-stat">Inserted: {forwardStats.inserted}</span>
                    <span className="forwarding-stat">Already in DB: {forwardStats.skipped}</span>
                    {syncState.failed > 0 && (
                        <span className="forwarding-stat error">Failed: {syncState.failed}</span>
                    )}
                    <span className={`forwarding-stat sync-${syncState.connection}`}>
                        {syncState.connection === 'connected' && 'PostgreSQL: connected'}
                        {syncState.connection === 'syncing' && 'PostgreSQL: syncing...'}
                        {syncState.connection === 'retrying' && 'PostgreSQL: retrying'}
                        {syncState.connection === 'idle' && (liveSyncEnabled ? 'Auto-sync: on' : 'Auto-sync: off')}
                    </span>
                    {syncState.lastSyncAt && (
                        <span>Last sync: {new Date(syncState.lastSyncAt).toLocaleTimeString()}</span>
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
