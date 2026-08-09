import path from 'path';
import { existsSync, writeFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync, rmSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { BrowserWindow, session, ipcMain } from 'electron';
import { forwardScrapedMessagesToPostgres } from '../database/ai-persistence.js';
import { readLocalXScraperSource, clearSqliteStore, defaultSqlitePath } from '../database/xscraper-local-source.js';
import { reconcileScrapedMessages } from '../database/xscraper-sync.js';
import { saveMessages as saveMessagesToSqliteQueue } from '../database/xscraper-forwarder.js';
import {
    saveMessages as forwarderSave,
    getPending as forwarderGetPending,
    markForwarded as forwarderMarkForwarded,
    markFailed as forwarderMarkFailed,
    clearForwarded as forwarderClearForwarded,
    getStatus as forwarderGetStatus,
    runBatch as forwarderRunBatch,
    forceRun as forwarderForceRun,
    startWorker as forwarderStartWorker,
    stopWorker as forwarderStopWorker,
} from '../database/xscraper-forwarder.js';

// Track local server process and restart state
let localServerProcess = null;
const LOCAL_SERVER_PORT = 3000;
let serverRestartAttempts = 0;
const MAX_SERVER_RESTARTS = 5;
let serverRestartTimer = null;

// Firefox browser windows tracking
const firefoxWindows = new Map();
const loadedExtensionPartitions = new Set();


export function registerXScraperIpcHandlers(context) {
    const { ipcMain, app, getDialogParentWindow, pushScriptLog } = context;

    // Get the correct extension path for both development and production
    function getXScraperExtensionPath(extensionPath) {
        // In production (packaged app), use resourcesPath for extraResources
        // The extraResources config maps src/scrapers/xscraper/ to scrapers/xscraper/
        // so we need to strip the 'src/' prefix when in production
        if (app.isPackaged && process.resourcesPath) {
            const productionPath = extensionPath.replace(/^src\//, '');
            return path.join(process.resourcesPath, productionPath);
        }
        // In development, use the app path
        return path.join(app.getAppPath(), extensionPath);
    }

    // Check if Firefox is installed
    ipcMain.handle('xscraper:check-firefox', async () => {
        try {
            let firefoxPath = null;
            if (process.platform === 'win32') {
                // Check common Firefox installation paths on Windows
                const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
                const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

                const possiblePaths = [
                    path.join(programFiles, 'Mozilla Firefox', 'firefox.exe'),
                    path.join(programFilesX86, 'Mozilla Firefox', 'firefox.exe'),
                    path.join(process.env.LOCALAPPDATA || '', 'Mozilla Firefox', 'firefox.exe')
                ];

                for (const fp of possiblePaths) {
                    if (existsSync(fp)) {
                        firefoxPath = fp;
                        break;
                    }
                }
            } else {
                // Unix-like systems
                try {
                    const whichResult = execSync('which firefox', { stdio: 'pipe' }).toString().trim();
                    if (whichResult) {
                        firefoxPath = whichResult;
                    }
                } catch {
                    // Firefox not found
                }
            }

            return { installed: !!firefoxPath, path: firefoxPath };
        } catch (err) {
            console.error('[XScraper] Firefox check error:', err);
            return { installed: false, error: err.message };
        }
    });

    // Launch Firefox with XScraper extension - returns partition for webview embedding
    ipcMain.handle('xscraper:launch-firefox', async (_event, { url, extensionPath }) => {
        try {
            // Inline Firefox check (cannot use renderer-side invoke from main process)
            let firefoxPath = null;
            if (process.platform === 'win32') {
                const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
                const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
                const possiblePaths = [
                    path.join(programFiles, 'Mozilla Firefox', 'firefox.exe'),
                    path.join(programFilesX86, 'Mozilla Firefox', 'firefox.exe'),
                    path.join(process.env.LOCALAPPDATA || '', 'Mozilla Firefox', 'firefox.exe')
                ];
                for (const fp of possiblePaths) {
                    if (existsSync(fp)) {
                        firefoxPath = fp;
                        break;
                    }
                }
            } else {
                try {
                    const whichResult = execSync('which firefox', { stdio: 'pipe' }).toString().trim();
                    if (whichResult) firefoxPath = whichResult;
                } catch {
                    // Firefox not found
                }
            }

            if (!firefoxPath) {
                return { success: false, error: 'Firefox is not installed' };
            }

            // Persistent partitions are required for extension loading and keep login cookies.
            const partition = 'persist:xscraper';
            const browserSession = session.fromPartition(partition);

            // Load the XScraper extension into the session
            if (extensionPath && !loadedExtensionPartitions.has(partition)) {
                try {
                    const absoluteExtensionPath = getXScraperExtensionPath(extensionPath);

                    // Verify the extension directory exists
                    if (!existsSync(absoluteExtensionPath)) {
                        throw new Error(`Extension directory not found: ${absoluteExtensionPath}`);
                    }

                    if (browserSession.extensions?.loadExtension) {
                        await browserSession.extensions.loadExtension(absoluteExtensionPath);
                    } else {
                        await browserSession.loadExtension(absoluteExtensionPath);
                    }
                    loadedExtensionPartitions.add(partition);
                    console.log('[XScraper] Extension loaded into partition:', absoluteExtensionPath);
                } catch (extErr) {
                    console.error('[XScraper] Failed to load extension:', extErr);
                    return { success: false, error: `Failed to load XScraper extension: ${extErr.message}` };
                }
            }

            pushScriptLog(`[XScraper] Session prepared with partition: ${partition}`);
            return { success: true, partition, url: url || 'https://grok.com' };
        } catch (err) {
            console.error('[XScraper] Firefox launch error:', err);
            return { success: false, error: err.message };
        }
    });

    // Close Firefox window
    ipcMain.handle('xscraper:close-firefox', async (_event, { windowId }) => {
        try {
            const entry = firefoxWindows.get(windowId);
            if (!entry) {
                return { success: false, error: 'Firefox window not found' };
            }

            if (!entry.window.isDestroyed()) {
                entry.window.close();
            }
            firefoxWindows.delete(windowId);
            return { success: true };
        } catch (err) {
            console.error('[XScraper] Firefox close error:', err);
            return { success: false, error: err.message };
        }
    });

    // Navigate Firefox to URL
    ipcMain.handle('xscraper:navigate-firefox', async (_event, { windowId, url }) => {
        try {
            const entry = firefoxWindows.get(windowId);
            if (!entry) {
                return { success: false, error: 'Firefox window not found' };
            }

            if (!entry.window.isDestroyed()) {
                await entry.window.loadURL(url);
                entry.url = url;
            }
            return { success: true };
        } catch (err) {
            console.error('[XScraper] Firefox navigate error:', err);
            return { success: false, error: err.message };
        }
    });

    // Scrape current page
    ipcMain.handle('xscraper:scrape-current', async () => {
        try {
            // Find the active Firefox window
            let activeWindow = null;
            for (const entry of firefoxWindows.values()) {
                if (!entry.window.isDestroyed()) {
                    activeWindow = entry;
                    break;
                }
            }

            if (!activeWindow) {
                return { success: false, error: 'No active Firefox window found' };
            }

            // Execute scraping in the page context
            const result = await activeWindow.window.webContents.executeJavaScript(`
                (function() {
                    if (window.__grokScraper && typeof window.__grokScraper.scrapeAll === 'function') {
                        return window.__grokScraper.scrapeAll();
                    }
                    return { success: false, error: 'Scraper not available' };
                })()
            `);

            return result;
        } catch (err) {
            console.error('[XScraper] Scrape error:', err);
            return { success: false, error: err.message };
        }
    });

    // Export data from extension IndexedDB to filesystem
    ipcMain.handle('xscraper:export-data', async (_event, exportData, filename) => {
        try {
            if (!exportData || typeof exportData !== 'object') {
                return { success: false, error: 'No export data provided' };
            }

            // Write to src/database/grok/ with timestamp-based filename
            const exportDir = path.join(process.cwd(), 'src', 'database', 'grok');
            if (!existsSync(exportDir)) {
                mkdirSync(exportDir, { recursive: true });
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const messages = exportData.messages || [];
            const conversations = exportData.conversations || [];

            // Ensure filename has .json extension
            const ensureJson = (name) => name.endsWith('.json') ? name : `${name}.json`;

            // Group messages by conversationId
            const messagesByConv = {};
            for (const msg of messages) {
                const cid = msg.conversationId || 'default';
                if (!messagesByConv[cid]) messagesByConv[cid] = [];
                messagesByConv[cid].push(msg);
            }

            // Build conversation lookup from conversations array + discovered message groups
            const convMap = {};
            for (const conv of conversations) {
                convMap[conv.id || 'default'] = conv;
            }
            // Also add any conversation IDs found in messages but not in conversations array
            for (const cid of Object.keys(messagesByConv)) {
                if (!convMap[cid]) {
                    convMap[cid] = { id: cid, title: cid };
                }
            }

            // Create messages subfolder
            const messagesDir = path.join(exportDir, 'messages');
            if (!existsSync(messagesDir)) {
                mkdirSync(messagesDir, { recursive: true });
            }

            const results = [];

            // Export each conversation as its own JSON file in messages/
            for (const [cid, convMessages] of Object.entries(messagesByConv)) {
                const conv = convMap[cid] || { id: cid, title: cid };
                const convData = {
                    version: exportData.version || '1.0',
                    exportDate: exportData.exportDate || new Date().toISOString(),
                    totalMessages: convMessages.length,
                    totalConversations: 1,
                    messages: convMessages,
                    conversations: [conv]
                };
                const convFilename = ensureJson(`${cid}.json`);
                const filepath = path.join(messagesDir, convFilename);
                writeFileSync(filepath, JSON.stringify(convData, null, 2), 'utf8');
                pushScriptLog(`[XScraper] Exported ${convMessages.length} messages to ${filepath}`);
                results.push({ success: true, filepath, filename: convFilename });
            }

            // Also create a compilation grok_export_<date>.json in the root
            const compilationFilename = ensureJson(filename || `grok_export_${timestamp}_${messages.length}msgs.json`);
            const compilationPath = path.join(exportDir, compilationFilename);
            writeFileSync(compilationPath, JSON.stringify(exportData, null, 2), 'utf8');
            pushScriptLog(`[XScraper] Exported compilation ${messages.length} messages to ${compilationPath}`);
            results.push({ success: true, filepath: compilationPath, filename: compilationFilename });

            return { success: true, files: results };
        } catch (err) {
            console.error('[XScraper] Export error:', err);
            return { success: false, error: err.message };
        }
    });

    // Get real-time stats from the webview
    ipcMain.handle('xscraper:get-realtime-stats', async () => {
        try {
            // Find the active window with a webview
            let activeWindow = null;
            for (const entry of firefoxWindows.values()) {
                if (!entry.window.isDestroyed()) {
                    activeWindow = entry;
                    break;
                }
            }

            if (!activeWindow) {
                return { success: false, error: 'No active browser window found' };
            }

            const result = await activeWindow.window.webContents.executeJavaScript(`
                (function() {
                    if (window.__grokScraper && typeof window.__grokScraper.debug === 'function') {
                        return window.__grokScraper.debug();
                    }
                    return { seen: 0, queue: 0, stuck: 0, idle: 0 };
                })()
            `);

            return { success: true, stats: result };
        } catch (err) {
            console.error('[XScraper] Real-time stats error:', err);
            return { success: false, error: err.message };
        }
    });

    // Start real-time crawler
    ipcMain.handle('xscraper:start-realtime', async () => {
        try {
            let activeWindow = null;
            for (const entry of firefoxWindows.values()) {
                if (!entry.window.isDestroyed()) {
                    activeWindow = entry;
                    break;
                }
            }

            if (!activeWindow) {
                return { success: false, error: 'No active browser window found' };
            }

            await activeWindow.window.webContents.executeJavaScript(`
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
            console.error('[XScraper] Start real-time error:', err);
            return { success: false, error: err.message };
        }
    });

    // Stop real-time crawler
    ipcMain.handle('xscraper:stop-realtime', async () => {
        try {
            let activeWindow = null;
            for (const entry of firefoxWindows.values()) {
                if (!entry.window.isDestroyed()) {
                    activeWindow = entry;
                    break;
                }
            }

            if (!activeWindow) {
                return { success: false, error: 'No active browser window found' };
            }

            await activeWindow.window.webContents.executeJavaScript(`
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
            console.error('[XScraper] Stop real-time error:', err);
            return { success: false, error: err.message };
        }
    });

    // Ensure local server is running, start it if needed
    async function ensureLocalServerRunning() {
        if (localServerProcess && !localServerProcess.killed) {
            // Quick health check to verify it's actually responding
            try {
                const healthCheck = await fetch(`http://localhost:${LOCAL_SERVER_PORT}/health`, {
                    signal: AbortSignal.timeout(2000)
                });
                if (healthCheck.ok) {
                    return true;
                }
            } catch {
                // Server not responding — fall through to restart
            }
        }

        // Server is not running or not responding — start it
        console.log('[XScraper] Local server not running, starting...');
        const result = await ipcMain.invoke('xscraper:start-local-server');
        if (!result.success) {
            console.error('[XScraper] Failed to start local server:', result.error);
            return false;
        }
        return true;
    }

    // Get new messages from local server since last check (for real-time forwarding)
    ipcMain.handle('xscraper:get-new-messages', async (_event, { since, conversationId }) => {
        try {
            const serverReady = await ensureLocalServerRunning();
            if (!serverReady) {
                return { success: false, error: 'Local server unavailable', messages: [] };
            }

            const serverUrl = 'http://localhost:3000';
            const params = new URLSearchParams();
            if (since) params.set('since', since);
            if (conversationId) params.set('conversationId', conversationId);

            const response = await fetch(`${serverUrl}/api/messages/new?${params.toString()}`);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            return { success: true, ...data };
        } catch (err) {
            console.error('[XScraper] Get new messages error:', err);
            return { success: false, error: err.message, messages: [] };
        }
    });

    // Forward scraped messages to PostgreSQL via the durable SQLite queue.
    // A manual call here is the SAME pipeline the worker uses: persist to
    // SQLite (durable), then force a batch run. Never marks forwarded before
    // PostgreSQL confirms.
    ipcMain.handle('xscraper:forward-to-postgres', async (_event, { messages, conversationId, conversationTitle }) => {
        try {
            if (!messages || !Array.isArray(messages) || messages.length === 0) {
                return { success: true, inserted: 0, skipped: 0, message: 'No messages to forward' };
            }

            if (!conversationId) {
                return { success: false, error: 'conversationId is required' };
            }

            // 1. Durable persist to the SQLite queue (unforwarded).
            const saved = await forwarderSave(messages, conversationId, conversationTitle);
            if (!saved.success) {
                return { success: false, error: saved.error || 'Failed to persist to SQLite queue', inserted: 0, skipped: 0 };
            }

            // 2. Force one batch run past the backoff.
            const r = await forwarderForceRun();
            return {
                success: r.success,
                inserted: r.inserted || 0,
                skipped: r.skipped || 0,
                failed: r.failed || 0,
                pending: r.pending || 0,
                error: r.error || null,
                message: `Forwarded batch: ${r.inserted || 0} inserted, ${r.skipped || 0} already present`,
            };
        } catch (err) {
            console.error('[XScraper] Forward to PostgreSQL error:', err);
            return { success: false, error: err.message, inserted: 0, skipped: 0 };
        }
    });

    // ------------------------------------------------------------------
    // Durable forwarder service IPC (the ONE canonical pipeline).
    // Manual, automatic and SCRAPE+FORWARD all route through these.
    // ------------------------------------------------------------------

    // Save scraped messages into the durable SQLite queue.
    ipcMain.handle('xscraper:save-to-sqlite', async (_event, { messages, conversationId, conversationTitle }) => {
        try {
            if (!messages || !Array.isArray(messages) || messages.length === 0) {
                return { success: true, inserted: 0, duplicates: 0, total: 0 };
            }
            if (!conversationId) {
                return { success: false, error: 'conversationId is required', inserted: 0, duplicates: 0, total: 0 };
            }
            const r = await forwarderSave(messages, conversationId, conversationTitle);
            return r;
        } catch (err) {
            console.error('[XScraper] save-to-sqlite error:', err);
            return { success: false, error: err.message, inserted: 0, duplicates: 0, total: 0 };
        }
    });

    // Force the batch worker to run now (manual "Send to PostgreSQL").
    ipcMain.handle('xscraper:forward-pending', async () => {
        try {
            const r = await forwarderForceRun();
            const status = await forwarderGetStatus();
            return { success: r.success, ...r, status };
        } catch (err) {
            console.error('[XScraper] forward-pending error:', err);
            return { success: false, error: err.message };
        }
    });

    // Start / stop / check the singleton batch worker.
    ipcMain.handle('xscraper:worker-start', async () => {
        try {
            return forwarderStartWorker();
        } catch (err) {
            console.error('[XScraper] worker-start error:', err);
            return { success: false, error: err.message };
        }
    });
    ipcMain.handle('xscraper:worker-stop', async () => {
        try {
            return forwarderStopWorker();
        } catch (err) {
            console.error('[XScraper] worker-stop error:', err);
            return { success: false, error: err.message };
        }
    });

    // Live forwarder status for the UI counters.
    ipcMain.handle('xscraper:get-forward-status', async () => {
        try {
            return { success: true, ...(await forwarderGetStatus()) };
        } catch (err) {
            console.error('[XScraper] get-forward-status error:', err);
            return { success: false, error: err.message };
        }
    });

    // Clear fully-forwarded messages from the local SQLite queue.
    ipcMain.handle('xscraper:clear-sent', async () => {
        try {
            const r = await forwarderClearForwarded();
            return { success: true, ...r };
        } catch (err) {
            console.error('[XScraper] clear-sent error:', err);
            return { success: false, error: err.message, deleted: 0 };
        }
    });

    // One-click SCRAPE + FORWARD workflow in the main process.
    // Ensures the server and worker are running, then kicks a batch.
    ipcMain.handle('xscraper:scrape-and-forward', async () => {
        try {
            const serverOk = await ensureLocalServerRunning();
            if (!serverOk) {
                return { success: false, error: 'Local XScraper server unavailable' };
            }
            const worker = forwarderStartWorker();
            const r = await forwarderRunBatch();
            const status = await forwarderGetStatus();
            return { success: true, serverOk, worker, batch: r, status };
        } catch (err) {
            console.error('[XScraper] scrape-and-forward error:', err);
            return { success: false, error: err.message };
        }
    });

    // Shared server start logic (used by IPC handler and auto-restart)
    async function startLocalServer() {
        if (localServerProcess) {
            return { success: true, message: 'Local server already running', port: LOCAL_SERVER_PORT };
        }

        const serverPath = path.join(process.cwd(), 'src', 'scrapers', 'xscraper', 'src', 'server', 'server.js');

        if (!existsSync(serverPath)) {
            return { success: false, error: `Server script not found at ${serverPath}` };
        }

        localServerProcess = spawn('node', [serverPath], {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
        });

        localServerProcess.stdout.on('data', (data) => {
            console.log(`[XScraper Server] ${data.toString().trim()}`);
        });

        localServerProcess.stderr.on('data', (data) => {
            console.error(`[XScraper Server] ${data.toString().trim()}`);
        });

        localServerProcess.on('exit', (code) => {
            console.log(`[XScraper Server] exited with code ${code}`);
            localServerProcess = null;
            // Auto-restart if not a clean shutdown
            if (code !== 0 && serverRestartAttempts < MAX_SERVER_RESTARTS) {
                scheduleServerRestart();
            }
        });

        localServerProcess.on('error', (err) => {
            console.error('[XScraper Server] failed to start:', err);
            localServerProcess = null;
            if (serverRestartAttempts < MAX_SERVER_RESTARTS) {
                scheduleServerRestart();
            }
        });

        // Wait for server to be ready with retry logic
        const maxRetries = 10;
        const retryDelay = 500;
        for (let i = 0; i < maxRetries; i++) {
            try {
                const healthCheck = await fetch(`http://localhost:${LOCAL_SERVER_PORT}/health`, {
                    signal: AbortSignal.timeout(2000)
                });
                if (healthCheck.ok) {
                    serverRestartAttempts = 0;
                    return { success: true, message: 'Local server started', port: LOCAL_SERVER_PORT };
                }
            } catch {
                // Server not ready yet
            }
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }

        // Server didn't respond in time — clean up and report failure
        if (localServerProcess && !localServerProcess.killed) {
            localServerProcess.kill('SIGTERM');
        }
        localServerProcess = null;
        return { success: false, error: 'Local server failed to respond within timeout' };
    }

    // Start local XScraper server (bridge between extension and Electron)
    ipcMain.handle('xscraper:start-local-server', async () => {
        try {
            return await startLocalServer();
        } catch (err) {
            console.error('[XScraper] Start local server error:', err);
            localServerProcess = null;
            return { success: false, error: err.message };
        }
    });

    function scheduleServerRestart() {
        if (serverRestartTimer) {
            clearTimeout(serverRestartTimer);
        }
        serverRestartAttempts++;
        console.log(`[XScraper] Scheduling server restart (attempt ${serverRestartAttempts}/${MAX_SERVER_RESTARTS})`);
        serverRestartTimer = setTimeout(async () => {
            serverRestartTimer = null;
            console.log('[XScraper] Attempting server restart...');
            const result = await startLocalServer();
            console.log('[XScraper] Restart result:', result);
        }, 3000);
    }

    // Stop local XScraper server
    ipcMain.handle('xscraper:stop-local-server', async () => {
        try {
            if (serverRestartTimer) {
                clearTimeout(serverRestartTimer);
                serverRestartTimer = null;
            }
            if (localServerProcess) {
                localServerProcess.kill('SIGTERM');
                localServerProcess = null;
                serverRestartAttempts = 0;
                return { success: true, message: 'Local server stopped' };
            }
            return { success: true, message: 'Local server was not running' };
        } catch (err) {
            console.error('[XScraper] Stop local server error:', err);
            return { success: false, error: err.message };
        }
    });

    // Clear exported XScraper JSON files
    ipcMain.handle('xscraper:clear-exports', async () => {
        try {
            const messagesDir = path.join(process.cwd(), 'src', 'database', 'grok', 'messages');
            const exportDir = path.join(process.cwd(), 'src', 'database', 'grok');

            let deleted = 0;

            // Delete files in messages/ subdirectory
            if (existsSync(messagesDir)) {
                const files = readdirSync(messagesDir).filter(f => f.endsWith('.json'));
                for (const file of files) {
                    try {
                        unlinkSync(path.join(messagesDir, file));
                        deleted++;
                    } catch (err) {
                        console.error(`[XScraper] Failed to delete ${file}:`, err.message);
                    }
                }
            }

            // Delete compilation exports in root grok/ directory
            if (existsSync(exportDir)) {
                const files = readdirSync(exportDir).filter(f => f.endsWith('.json'));
                for (const file of files) {
                    try {
                        unlinkSync(path.join(exportDir, file));
                        deleted++;
                    } catch (err) {
                        console.error(`[XScraper] Failed to delete ${file}:`, err.message);
                    }
                }
            }

            pushScriptLog(`[XScraper] Cleared ${deleted} export files`);
            return { success: true, deleted };
        } catch (err) {
            console.error('[XScraper] Clear exports error:', err);
            return { success: false, error: err.message, deleted: 0 };
        }
    });

    // Reconcile the local XScraper store (SQLite + any legacy JSON exports)
    // against PostgreSQL. Idempotent: repeated runs converge to pending = 0.
    //
    // Extracted so the background ticker can reuse exactly the same path as
    // the manual button - one reconciliation implementation, not two.
    async function reconcileLocalStoreToPostgres({ quiet = false } = {}) {
        const log = quiet ? () => { } : pushScriptLog;

        const local = await readLocalXScraperSource({});

        log(
            `[XScraper→Postgres] Local sources: sqlite=${local.sources.sqlite.total} json=${local.sources.json.total}`
        );

        if (local.byConversation.size === 0) {
            return {
                success: true,
                inserted: 0, skipped: 0, errors: 0,
                localTotal: 0, alreadyInPostgres: 0, pendingToInsert: 0,
                results: [],
                message: 'No locally stored XScraper messages found — nothing to reconcile'
            };
        }

        const totals = {
            localTotal: 0, alreadyInPostgres: 0, pendingToInsert: 0,
            inserted: 0, skipped: 0, invalid: 0, duplicatesInLocalSource: 0, errors: 0
        };
        const results = [];

        for (const [conversationId, messages] of local.byConversation) {
            const title = local.titles.get(conversationId) || 'Scraped Conversation';
            try {
                const r = await forwardScrapedMessagesToPostgres(messages, conversationId, title);
                if (r.success) {
                    totals.localTotal += r.localTotal || 0;
                    totals.alreadyInPostgres += r.alreadyInPostgres || 0;
                    totals.pendingToInsert += r.pendingToInsert || 0;
                    totals.inserted += r.inserted || 0;
                    totals.skipped += r.skipped || 0;
                    totals.invalid += r.invalid || 0;
                    totals.duplicatesInLocalSource += r.duplicatesInLocalSource || 0;
                    log(
                        `[XScraper→Postgres] ${conversationId}: local=${r.localTotal} already=${r.alreadyInPostgres} ` +
                        `pending=${r.pendingToInsert} inserted=${r.inserted} skipped=${r.skipped}`
                    );
                    results.push({ conversationId, ...r });
                } else {
                    totals.errors++;
                    log(`[XScraper→Postgres] ${conversationId}: FAILED - ${r.error}`);
                    results.push({ conversationId, error: r.error });
                }
            } catch (err) {
                totals.errors++;
                log(`[XScraper→Postgres] ${conversationId}: Exception - ${err.message}`);
                results.push({ conversationId, error: err.message });
            }
        }

        log(
            `[XScraper→Postgres] Complete: local_total=${totals.localTotal} already_in_postgres=${totals.alreadyInPostgres} ` +
            `pending_to_insert=${totals.pendingToInsert} inserted=${totals.inserted} skipped=${totals.skipped} errors=${totals.errors}`
        );

        return {
            success: totals.errors === 0,
            ...totals,
            results,
            message: `Reconciled ${totals.localTotal} local messages: inserted ${totals.inserted}, already present ${totals.alreadyInPostgres}`
        };
    }

    ipcMain.handle('xscraper:forward-exported-to-postgres', async () => {
        try {
            return await reconcileLocalStoreToPostgres();
        } catch (err) {
            console.error('[XScraper] Reconcile local store to PostgreSQL error:', err);
            return { success: false, error: err.message, inserted: 0, skipped: 0, errors: 1 };
        }
    });

    // ---------------------------------------------------------------------
    // Background reconciler.
    //
    // The renderer poll loop only exists while the Internet page is mounted.
    // This keeps draining the local store into PostgreSQL after the user
    // navigates away, so anything the extension already flushed to SQLite
    // still lands in the database. It is the same idempotent reconciliation,
    // so it can never duplicate or retransmit known messages.
    // ---------------------------------------------------------------------
    let backgroundSyncTimer = null;
    let backgroundSyncBusy = false;
    let backgroundSyncLastRun = null;
    let backgroundSyncLastResult = null;

    async function backgroundSyncTick() {
        if (backgroundSyncBusy) return;
        backgroundSyncBusy = true;
        try {
            const r = await reconcileLocalStoreToPostgres({ quiet: true });
            backgroundSyncLastRun = new Date().toISOString();
            backgroundSyncLastResult = {
                localTotal: r.localTotal || 0,
                alreadyInPostgres: r.alreadyInPostgres || 0,
                inserted: r.inserted || 0,
                pendingToInsert: r.pendingToInsert || 0,
                errors: r.errors || 0
            };
            // Only speak up when something actually changed.
            if ((r.inserted || 0) > 0 || (r.errors || 0) > 0) {
                pushScriptLog(
                    `[XScraper→Postgres] background: inserted ${r.inserted || 0}, ` +
                    `already present ${r.alreadyInPostgres || 0}, errors ${r.errors || 0}`
                );
            }
        } catch (err) {
            console.warn('[XScraper] background sync tick failed:', err.message);
        } finally {
            backgroundSyncBusy = false;
        }
    }

    ipcMain.handle('xscraper:background-sync', async (_event, { enabled = true, intervalMs = 60000 } = {}) => {
        try {
            if (!enabled) {
                if (backgroundSyncTimer) {
                    clearInterval(backgroundSyncTimer);
                    backgroundSyncTimer = null;
                    pushScriptLog('[XScraper→Postgres] background sync stopped');
                }
                return { success: true, running: false, lastRun: backgroundSyncLastRun };
            }

            if (backgroundSyncTimer) {
                return { success: true, running: true, lastRun: backgroundSyncLastRun, alreadyRunning: true };
            }

            const ms = Math.max(10000, Number(intervalMs) || 60000);
            backgroundSyncTimer = setInterval(backgroundSyncTick, ms);
            if (typeof backgroundSyncTimer.unref === 'function') backgroundSyncTimer.unref();
            pushScriptLog(`[XScraper→Postgres] background sync started (every ${Math.round(ms / 1000)}s)`);
            backgroundSyncTick();
            return { success: true, running: true, intervalMs: ms };
        } catch (err) {
            console.error('[XScraper] background sync error:', err);
            return { success: false, error: err.message, running: !!backgroundSyncTimer };
        }
    });

    ipcMain.handle('xscraper:background-sync-status', async () => ({
        success: true,
        running: !!backgroundSyncTimer,
        busy: backgroundSyncBusy,
        lastRun: backgroundSyncLastRun,
        lastResult: backgroundSyncLastResult
    }));

    // Read-only XScraper sync diagnostic (never writes)
    ipcMain.handle('xscraper:diagnose', async (_event, { conversationId } = {}) => {
        try {
            const local = await readLocalXScraperSource({ conversationId: conversationId || null });
            const report = [];

            for (const [cid, messages] of local.byConversation) {
                const stats = await reconcileScrapedMessages(messages, cid, undefined, { dryRun: true });
                report.push({
                    conversationId: cid,
                    localMessages: stats.localTotal,
                    postgresMessages: stats.postgresTotalAfter,
                    alreadyPersisted: stats.alreadyInPostgres,
                    pendingInsertion: stats.pendingToInsert,
                    duplicatesLocal: stats.duplicatesInLocalSource,
                    invalid: stats.invalid,
                    checkpoint: stats.checkpoint,
                });
            }

            return { success: true, sources: local.sources, report };
        } catch (err) {
            console.error('[XScraper] Diagnose error:', err);
            return { success: false, error: err.message };
        }
    });

    // Wipe the LOCAL XScraper store only. PostgreSQL is never touched.
    //
    // Layers cleared (all opt-out-able):
    //   sqlite    %APPDATA%/.xscraper/x_messages.db  (local server cache)
    //   indexeddb extension IndexedDB in the persist:xscraper session
    //   exports   legacy JSON snapshots under src/database/grok/
    //
    // Safe because reconciliation is identity based: anything already in
    // grok_messages stays there, and re-scraped messages will be recognised as
    // already present instead of being duplicated.
    ipcMain.handle('xscraper:clear-local-store', async (_event, options = {}) => {
        const {
            sqlite = true,
            indexeddb = true,
            exports: clearJsonExports = true,
        } = options || {};

        const summary = {
            success: true,
            sqlite: { cleared: false, messagesDeleted: 0, conversationsDeleted: 0, path: defaultSqlitePath() },
            indexeddb: { cleared: false },
            exports: { cleared: false, deleted: 0 },
            errors: [],
        };

        // 1. SQLite cache written by the local server
        if (sqlite) {
            try {
                const r = await clearSqliteStore({});
                summary.sqlite = { cleared: r.available, ...r };
                pushScriptLog(
                    r.available
                        ? `[XScraper] Cleared local SQLite store: ${r.messagesDeleted} messages, ${r.conversationsDeleted} conversations`
                        : `[XScraper] No local SQLite store at ${r.path}`
                );
            } catch (err) {
                summary.success = false;
                summary.errors.push(`sqlite: ${err.message}`);
                pushScriptLog(`[XScraper] Failed to clear SQLite store: ${err.message}`);
            }
        }

        // 2. Extension IndexedDB (the layer the scraper itself writes to)
        if (indexeddb) {
            try {
                const browserSession = session.fromPartition('persist:xscraper');
                await browserSession.clearStorageData({ storages: ['indexdb'] });
                summary.indexeddb.cleared = true;
                pushScriptLog('[XScraper] Cleared extension IndexedDB (persist:xscraper)');
            } catch (err) {
                summary.success = false;
                summary.errors.push(`indexeddb: ${err.message}`);
                pushScriptLog(`[XScraper] Failed to clear IndexedDB: ${err.message}`);
            }
        }

        // 3. Legacy JSON snapshots
        if (clearJsonExports) {
            try {
                const messagesDir = path.join(process.cwd(), 'src', 'database', 'grok', 'messages');
                const exportDir = path.join(process.cwd(), 'src', 'database', 'grok');
                let deleted = 0;
                for (const dir of [messagesDir, exportDir]) {
                    if (!existsSync(dir)) continue;
                    for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
                        try {
                            unlinkSync(path.join(dir, file));
                            deleted++;
                        } catch (err) {
                            console.error(`[XScraper] Failed to delete ${file}:`, err.message);
                        }
                    }
                }
                summary.exports = { cleared: true, deleted };
                pushScriptLog(`[XScraper] Cleared ${deleted} JSON export files`);
            } catch (err) {
                summary.success = false;
                summary.errors.push(`exports: ${err.message}`);
            }
        }

        summary.message =
            `Local store cleared — sqlite: ${summary.sqlite.messagesDeleted} messages, ` +
            `indexeddb: ${summary.indexeddb.cleared ? 'wiped' : 'skipped'}, ` +
            `json: ${summary.exports.deleted} files. PostgreSQL untouched.`;
        pushScriptLog(`[XScraper] ${summary.message}`);
        return summary;
    });
}
