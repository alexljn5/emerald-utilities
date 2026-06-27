import { invoke } from '../../js/electronApi.js';

export async function checkFirefoxInstalled() {
    try {
        const result = await invoke('xscraper:check-firefox');
        return result?.installed ?? false;
    } catch (err) {
        console.error('[XScraper] checkFirefoxInstalled error:', err);
        return false;
    }
}

export async function launchFirefox({ url, extensionPath = 'src/scrapers/xscraper' }) {
    try {
        const result = await invoke('xscraper:launch-firefox', {
            url: url || 'https://grok.com',
            extensionPath
        });
        return result;
    } catch (err) {
        console.error('[XScraper] launchFirefox error:', err);
        return { success: false, error: err.message };
    }
}

export function getDefaultPages() {
    return [
        { id: 'grok', name: 'Grok', url: 'https://grok.com' },
        { id: 'x', name: 'X', url: 'https://x.com' },
        { id: 'grok-x', name: 'Grok X', url: 'https://grok.x.com' }
    ];
}
