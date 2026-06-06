// src/pages/index.js
import { scriptManager } from "../../core/scriptManager.js";

const TERMINAL_KEY = "emerald_terminal_log";
const MAX_TERMINAL_LINES = 500;
let terminalLog = [];
let renderQueued = false;
let saveTimer = null;

function loadTerminalLog() {
    try {
        return JSON.parse(localStorage.getItem(TERMINAL_KEY) || "[]");
    } catch {
        return [];
    }
}

function normalizeLogEntry(entry) {
    if (typeof entry === "string") {
        return { id: null, message: entry };
    }
    return {
        id: entry?.id ?? null,
        message: entry?.message ?? ""
    };
}

function saveTerminalLog(log) {
    localStorage.setItem(TERMINAL_KEY, JSON.stringify(log.slice(-MAX_TERMINAL_LINES)));
}

function queueTerminalSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveTerminalLog(terminalLog), 200);
}

function queueTerminalRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
        renderQueued = false;
        renderTerminal(terminalLog);
    });
}

function appendTerminalLog(entry) {
    const normalized = normalizeLogEntry(entry);
    if (!normalized.message) return;

    if (normalized.id !== null && terminalLog.some(item => item.id === normalized.id)) {
        return;
    }

    terminalLog.push(normalized);
    terminalLog = terminalLog.slice(-MAX_TERMINAL_LINES);
    queueTerminalSave();
    queueTerminalRender();
}

function renderTerminal(log) {
    const term = document.getElementById('terminalOutput');
    if (!term) return;

    term.innerHTML = "";
    for (const entry of log.map(normalizeLogEntry).slice(-MAX_TERMINAL_LINES)) {
        const line = document.createElement('div');
        line.textContent = entry.message;
        term.appendChild(line);
    }
    term.scrollTop = term.scrollHeight;
}

document.addEventListener("DOMContentLoaded", () => {
    // Version display
    const versionEl = document.getElementById("versionDisplay");
    if (versionEl && typeof versionNumber !== "undefined") {
        versionEl.textContent = `v${versionNumber}`;
    }

    // About button
    const aboutBtn = document.getElementById("aboutButton");
    if (aboutBtn) {
        aboutBtn.addEventListener("click", () => {
            window.location.href = "./pages/about.html";
        });
    }

    // Script Tool button
    const scriptToolBtn = document.getElementById("scriptToolButton");
    if (scriptToolBtn) {
        scriptToolBtn.addEventListener("click", () => {
            window.location.href = "./pages/script_tool.html";
        });
    }

    // Background auto-run scripts (this is what prints the creepy message)
    scriptManager.init({ bindUI: false });
    renderTerminal(terminalLog);

    // Expose for console debugging
    window.scriptManager = scriptManager;

    console.log("%c[Emerald] Dashboard initialized", "color:#ff4444");
});

// After scriptManager.init({ bindUI: false });

// Simple logger for dashboard terminal
function dashboardLog(msg) {
    appendTerminalLog(msg);
}

// Bind it so background scripts appear on the main dashboard too
terminalLog = loadTerminalLog().map(normalizeLogEntry);
scriptManager.bindLogger(dashboardLog);

// Replay previous startup logs into the dashboard terminal
scriptManager.replayMainProcessLogToTerminal(MAX_TERMINAL_LINES);

window.addEventListener("beforeunload", () => {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTerminalLog(terminalLog);
    }
});
