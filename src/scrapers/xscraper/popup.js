let poll;

document.addEventListener('DOMContentLoaded', async () => {
    await refresh();
    setup();

    // live updates while popup is open
    poll = setInterval(refresh, 1500);
});

async function refresh() {
    const stats = await chrome.runtime.sendMessage({ action: 'getStats' });
    const msgs = await chrome.runtime.sendMessage({ action: 'getMessages' });

    if (stats.success) {
        document.getElementById('messageCount').textContent = stats.messageCount;
    }

    if (msgs.success) {
        const el = document.getElementById('messagesList');

        const last = msgs.messages.slice(-6).reverse();

        el.innerHTML = last.map(m =>
            `<li>${m.content.slice(0, 80)}</li>`
        ).join('');
    }
}

function setup() {
    document.getElementById('scrapeBtn').onclick = async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        chrome.tabs.sendMessage(tab.id, { action: 'scrapeMessages' });
    };

    document.getElementById('exportBtn').onclick = async () => {
        const res = await chrome.runtime.sendMessage({ action: 'exportData' });

        if (res.success && res.data) {
            const json = JSON.stringify(res.data, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `x-messages-${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
        }
    };

    document.getElementById('clearBtn').onclick = async () => {
        if (confirm('Clear all saved messages?')) {
            await chrome.runtime.sendMessage({ action: 'clearAll' });
            await refresh();
        }
    };

    document.getElementById('restartBtn')?.addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true });

        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => window.__grokScraper?.restart?.()
        });
    });

    document.getElementById('scrapeAllBtn')?.addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true });

        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => window.__grokScraper?.forceScroll?.()
        });
    });

    document.getElementById('debugBtn')?.addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true });

        const res = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => window.__grokScraper?.debug?.()
        });

        console.log('[POPUP DEBUG]', res);
    });
}

window.addEventListener('unload', () => {
    clearInterval(poll);
});