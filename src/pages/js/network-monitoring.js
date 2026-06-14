import { networkManager } from '../../core/networkManager.js';
import { versionNumber } from '../../globals.js';

const toggleButton = /** @type {HTMLButtonElement | null} */ (document.getElementById('networkToggle'));
const clearLogsButton = /** @type {HTMLButtonElement | null} */ (document.getElementById('clearNetworkLogs'));
const statusElement = document.getElementById('networkStatus');
const logBox = document.getElementById('fullPacketCaptureLog');
const versionDisplay = document.getElementById('versionDisplay');

let isBusy = false;

function setStatusColor() {
    if (!statusElement) return;

    if (networkManager.state.isCapturing) {
        statusElement.style.color = '#0f0';
    } else if (networkManager.state.status.startsWith('Error')) {
        statusElement.style.color = '#ff4444';
    } else {
        statusElement.style.color = '#f44';
    }
}

function renderLogBox() {
    if (!logBox) return;

    logBox.replaceChildren();

    if (networkManager.state.logs.length === 0) {
        const placeholder = document.createElement('div');
        placeholder.className = 'logPlaceholder';
        placeholder.textContent = networkManager.state.isCapturing
            ? 'Capturing... waiting for packets.'
            : 'No packets yet. Click Start Capture.';
        logBox.appendChild(placeholder);
        return;
    }

    const fragment = document.createDocumentFragment();

    for (const line of networkManager.state.logs) {
        const logLine = document.createElement('div');
        logLine.className = 'logLine';
        logLine.textContent = line;
        fragment.appendChild(logLine);
    }

    logBox.appendChild(fragment);
    logBox.scrollTop = logBox.scrollHeight;
    requestAnimationFrame(() => {
        logBox.scrollTop = logBox.scrollHeight;
    });
}

function renderNetwork() {
    if (toggleButton) {
        toggleButton.disabled = isBusy;
        toggleButton.textContent = networkManager.state.isCapturing ? '⏹ Stop Capture' : '▶ Start Capture';
    }

    if (statusElement) {
        statusElement.textContent = networkManager.state.status;
        setStatusColor();
    }

    if (versionDisplay) {
        versionDisplay.textContent = `v${versionNumber}`;
    }

    renderLogBox();
}

toggleButton?.addEventListener('click', async () => {
    if (isBusy) return;

    isBusy = true;
    renderNetwork();

    try {
        if (networkManager.state.isCapturing) {
            await networkManager.stopCapture();
        } else {
            const started = await networkManager.startCapture();

            if (!started) {
                networkManager.state.status = 'Error: capture did not start';
                networkManager.emit();
            }
        }
    } catch (error) {
        networkManager.state.isCapturing = false;
        networkManager.state.status = `Error: ${error instanceof Error ? error.message : String(error)}`;
        networkManager.emit();
    } finally {
        isBusy = false;
        renderNetwork();
    }
});

clearLogsButton?.addEventListener('click', () => {
    networkManager.clearLogs();
});

networkManager.onStateChange(renderNetwork);
networkManager.bindEvents();
renderNetwork();
