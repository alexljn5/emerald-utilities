// Content script - communicates between extension and heavensgate.js

console.log('[XSCRAPER_CONTENT] XScraper content script loaded');

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'scrapeMessages') {
        scrapeViaScraper().then(result => {
            sendResponse(result);
        }).catch(error => {
            sendResponse({ success: false, error: error.message });
        });
        return true;
    }
});

/**
 * Communicate with heavensgate.js scraper in page context
 */
async function scrapeViaScraper() {
    // Wait briefly for heavensgate.js to be injected/initialized in the page context.
    await new Promise(r => setTimeout(r, 100));

    if (!window.__grokScraper) {
        throw new Error('Scraper not available');
    }

    if (typeof window.__grokScraper.scrapeAll === 'function') {
        return await window.__grokScraper.scrapeAll();
    }

    if (typeof window.__grokScraper.scrape === 'function') {
        return window.__grokScraper.scrape();
    }

    throw new Error('Scraper not available');
}

console.log('[XSCRAPER_CONTENT] Ready to communicate with heavensgate.js');