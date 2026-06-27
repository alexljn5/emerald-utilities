import { BrowserWindow, session } from 'electron';
import path from 'path';
import { existsSync } from 'fs';
import { execSync } from 'child_process';

// Firefox browser windows tracking
const firefoxWindows = new Map();
const loadedExtensionPartitions = new Set();

export function registerXScraperIpcHandlers(context) {
    const { ipcMain, app, getDialogParentWindow, pushScriptLog } = context;

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
                    const absoluteExtensionPath = path.join(app.getAppPath(), extensionPath);
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

    // Export data
    ipcMain.handle('xscraper:export-data', async () => {
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

            // Execute export in the page context
            const result = await activeWindow.window.webContents.executeJavaScript(`
                (function() {
                    if (window.__grokScraper && typeof window.__grokScraper.exportAsJSON === 'function') {
                        return window.__grokScraper.exportAsJSON();
                    }
                    return { success: false, error: 'Export not available' };
                })()
            `);

            return result;
        } catch (err) {
            console.error('[XScraper] Export error:', err);
            return { success: false, error: err.message };
        }
    });
}
