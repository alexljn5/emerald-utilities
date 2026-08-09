import path from 'path';
import { existsSync, writeFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync, rmSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { BrowserWindow, session, ipcMain } from 'electron';
import { forwardScrapedMessagesToPostgres } from '../database/ai-persistence.js';
import { readLocalXScraperSource } from '../database/xscraper-local-source.js';
import { reconcileScrapedMessages } from '../database/xscraper-sync.js';

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

    // Forward scraped messages to PostgreSQL
    ipcMain.handle('xscraper:forward-to-postgres', async (_event, { messages, conversationId, conversationTitle }) => {
        try {
            if (!messages || !Array.isArray(messages) || messages.length === 0) {
                return { success: true, inserted: 0, skipped: 0, message: 'No messages to forward' };
            }

            if (!conversationId) {
                return { success: false, error: 'conversationId is required' };
            }

            const result = await forwardScrapedMessagesToPostgres(messages, conversationId, conversationTitle);
            return result;
        } catch (err) {
            console.error('[XScraper] Forward to PostgreSQL error:', err);
            return { success: false, error: err.message, inserted: 0, skipped: 0 };
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
    ipcMain.handle('xscraper:forward-exported-to-postgres', async () => {
        try {
            const local = await readLocalXScraperSource({});

            pushScriptLog(
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
                        pushScriptLog(
                            `[XScraper→Postgres] ${conversationId}: local=${r.localTotal} already=${r.alreadyInPostgres} ` +
                            `pending=${r.pendingToInsert} inserted=${r.inserted} skipped=${r.skipped}`
                        );
                        results.push({ conversationId, ...r });
                    } else {
                        totals.errors++;
                        pushScriptLog(`[XScraper→Postgres] ${conversationId}: FAILED - ${r.error}`);
                        results.push({ conversationId, error: r.error });
                    }
                } catch (err) {
                    totals.errors++;
                    pushScriptLog(`[XScraper→Postgres] ${conversationId}: Exception - ${err.message}`);
                    results.push({ conversationId, error: err.message });
                }
            }

            pushScriptLog(
                `[XScraper→Postgres] Complete: local_total=${totals.localTotal} already_in_postgres=${totals.alreadyInPostgres} ` +
                `pending_to_insert=${totals.pendingToInsert} inserted=${totals.inserted} skipped=${totals.skipped} errors=${totals.errors}`
            );

            return {
                success: totals.errors === 0,
                ...totals,
                results,
                message: `Reconciled ${totals.localTotal} local messages: inserted ${totals.inserted}, already present ${totals.alreadyInPostgres}`
            };
        } catch (err) {
            console.error('[XScraper] Reconcile local store to PostgreSQL error:', err);
            return { success: false, error: err.message, inserted: 0, skipped: 0, errors: 1 };
        }
    });

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
}
