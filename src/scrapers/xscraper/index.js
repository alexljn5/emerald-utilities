/**
 * XScraper Module Entry Point
 * Provides browser extension functionality for X/Grok scraping
 * Uses Electron session partitions to embed the browser directly in the app
 */

import { invoke } from '../../js/electronApi.js';

// Default pages for the embedded browser
const DEFAULT_PAGES = [
    { id: 'grok', name: 'Grok', url: 'https://grok.com' },
    { id: 'x', name: 'X', url: 'https://x.com' },
    { id: 'grok-x', name: 'Grok X', url: 'https://grok.x.com' }
];

/**
 * Check if Firefox is installed
 */
export async function checkFirefoxInstalled() {
    try {
        const result = await invoke('xscraper:check-firefox');
        return result?.installed ?? false;
    } catch (err) {
        console.error('[XSCRAPER] Error checking Firefox:', err);
        return false;
    }
}

/**
 * Launch browser session with XScraper extension loaded.
 * Returns { success, partition, url } for use with <webview> tag.
 */
export async function launchFirefox(options = {}) {
    try {
        const result = await invoke('xscraper:launch-firefox', {
            url: options.url || 'https://grok.com',
            extensionPath: options.extensionPath || getExtensionPath()
        });
        return result;
    } catch (err) {
        console.error('[XSCRAPER] Error launching browser:', err);
        throw err;
    }
}

/**
 * Get extension path
 */
function getExtensionPath() {
    return 'src/scrapers/xscraper';
}

/**
 * Get default pages
 */
export function getDefaultPages() {
    return [...DEFAULT_PAGES];
}

export default {
    checkFirefoxInstalled,
    launchFirefox,
    getDefaultPages
};
