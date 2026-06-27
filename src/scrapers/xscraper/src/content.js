// Content script - bridges the page scraper and the extension background.

console.log('[XSCRAPER_CONTENT] XScraper content script loaded');

function injectPageScraper() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('src/heavensgate.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
}

injectPageScraper();

window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    const message = event.data;
    if (!message || message.source !== 'xscraper-page' || message.action !== 'saveMessages') return;

    chrome.runtime.sendMessage({
        action: 'saveMessages',
        messages: Array.isArray(message.messages) ? message.messages : []
    }).catch(() => { });
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'scrapeMessages') {
        requestPageScrape().then(result => {
            sendResponse(result);
        }).catch(error => {
            sendResponse({ success: false, error: error.message });
        });
        return true;
    }
});

/**
 * Communicate with heavensgate.js scraper in the page context.
 */
async function requestPageScrape() {
    const requestId = `xscraper-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            window.removeEventListener('message', handleResponse);
            reject(new Error('Scraper timed out'));
        }, 15000);

        function handleResponse(event) {
            if (event.source !== window) return;

            const message = event.data;
            if (!message || message.source !== 'xscraper-page' || message.requestId !== requestId) return;
            if (message.action !== 'scrapeResponse') return;

            clearTimeout(timeout);
            window.removeEventListener('message', handleResponse);
            resolve(message.result);
        }

        window.addEventListener('message', handleResponse);
        window.postMessage({
            source: 'xscraper-content',
            action: 'scrapeMessages',
            requestId
        }, '*');
    });
}

console.log('[XSCRAPER_CONTENT] Ready to communicate with heavensgate.js');
