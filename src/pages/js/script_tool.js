import { scriptManager } from "../../core/scriptManager.js";

const TERMINAL_KEY = "emerald_terminal_log";
const MAX_TERMINAL_LINES = 500;

let dom = null;
let terminalLog = [];
let renderQueued = false;
let saveTimer = null;
let selectedFile = null;

function getDom() {
    return {
        loadScriptsButton: document.getElementById('loadScriptsButton'),
        saveScriptButton: document.getElementById('saveScriptButton'),
        scriptList: document.getElementById('scriptList'),
        detailPanel: document.getElementById('detailPanel'),
        detailScriptName: document.getElementById('detailScriptName'),
        runButton: document.getElementById('runButton'),
        runStartupButton: document.getElementById('runStartupButton'),
        viewButton: document.getElementById('viewButton'),
        autoRunToggle: document.getElementById('autoRunToggle'),
        cronEnabledToggle: document.getElementById('cronEnabledToggle'),
        cronInput: document.getElementById('cronInput'),
        cronToggleButton: document.getElementById('cronToggleButton'),
        argsInput: document.getElementById('argsInput'),
        scriptContent: document.getElementById('scriptContent'),
        terminalOutput: document.getElementById('terminalOutput'),
        terminalToggleButton: document.getElementById('terminalToggleButton'),
        chooseScriptLocationButton: document.getElementById('chooseScriptLocationButton'),
        aboutButton: document.getElementById('aboutButton'),
        ahkPathRow: document.querySelector('.ahkPathRow'),
        ahkPathInput: document.getElementById('ahkPathInput'),
        ahkBrowseButton: document.getElementById('ahkBrowseButton'),
        ahkResetButton: document.getElementById('ahkResetButton')
    };
}

/* ---------------- TERMINAL ---------------- */

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
    if (!dom?.terminalOutput) return;

    dom.terminalOutput.innerHTML = "";

    for (const entry of log.map(normalizeLogEntry).slice(-MAX_TERMINAL_LINES)) {
        const div = document.createElement("div");
        div.textContent = entry.message;
        dom.terminalOutput.appendChild(div);
    }
    dom.terminalOutput.scrollTop = dom.terminalOutput.scrollHeight;
}

function toggleTerminal() {
    if (!dom?.terminalOutput || !dom?.terminalToggleButton) return;
    const isHidden = dom.terminalOutput.classList.toggle('terminalHidden');
    dom.terminalToggleButton.classList.toggle('terminalHidden', isHidden);
    dom.terminalToggleButton.textContent = isHidden ? 'Show Terminal' : 'Terminal';
}

/* ---------------- SCRIPT LIST ---------------- */

function renderScripts(files, configScripts) {
    if (!dom?.scriptList) return;
    dom.scriptList.innerHTML = "";

    const safeFiles = Array.isArray(files) ? files : [];
    const safeConfigScripts = Array.isArray(configScripts) ? configScripts : [];

    for (const file of safeFiles) {
        const cfg = safeConfigScripts.find(s => s.file === file) || {
            file,
            displayName: `Run ${file}`,
            autoRun: false
        };

        const item = document.createElement("div");
        item.className = "scriptListItem";
        if (file === selectedFile) {
            item.classList.add("active");
        }

        const nameSpan = document.createElement("span");
        nameSpan.className = "scriptName";
        nameSpan.textContent = cfg.displayName || file;

        const badge = document.createElement("span");
        badge.className = "scriptBadge";
        const isRunning = scriptManager.isScriptRunning(file);
        const isCronRunning = scriptManager.isCronRunning(file);
        const isAutoRun = !!cfg.autoRun;
        const isCronEnabled = !!cfg.cronEnabled;

        let badgeText = "";
        if (isCronRunning) {
            badgeText = isAutoRun ? "Auto+Cron" : "Cron";
            badge.classList.add("cronBadge");
        } else if (isRunning) {
            badgeText = isAutoRun ? "Auto+Running" : "Running";
        } else if (isCronEnabled) {
            badgeText = "Auto+Cron";
            badge.classList.add("cronBadge");
        } else if (isAutoRun) {
            badgeText = "Auto";
        }
        badge.textContent = badgeText;

        item.append(nameSpan, badge);

        item.addEventListener("click", () => {
            selectScript(file);
        });

        dom.scriptList.appendChild(item);
    }

    updateRunButton();
    updateCronButton();
}

function updateRunButton(file = selectedFile) {
    if (!file || !dom?.runButton) return;

    const isRunning = scriptManager.isScriptRunning(file);
    dom.runButton.textContent = isRunning ? `⏹ Stop ${file}` : `▶ Run ${file}`;
}

function updateCronButton(file = selectedFile) {
    if (!file || !dom?.cronToggleButton) return;

    const isCronRunning = scriptManager.isCronRunning(file);
    dom.cronToggleButton.textContent = isCronRunning ? `⏹ Stop Cron` : `▶ Start Cron`;
    dom.cronInput.disabled = isCronRunning;

    if (isCronRunning) {
        dom.cronToggleButton.classList.add("cronActive");
    } else {
        dom.cronToggleButton.classList.remove("cronActive");
    }
}

function selectScript(file) {
    selectedFile = file;
    const scripts = scriptManager.normalizeScripts();
    const cfg = scripts.find(s => s.file === file) || { autoRun: false, cronEnabled: false, cronInterval: 0 };

    // Update list active state
    const items = dom.scriptList.querySelectorAll(".scriptListItem");
    const files = Array.isArray(scriptManager.state.config._files) ? scriptManager.state.config._files : [];
    items.forEach((el, idx) => {
        if (files[idx] === file) {
            el.classList.add("active");
        } else {
            el.classList.remove("active");
        }
    });

    // Show detail panel
    dom.detailPanel.classList.remove("hidden");
    dom.detailScriptName.textContent = file;

    // Show AHK path row only for .ahk files
    if (dom.ahkPathRow) {
        dom.ahkPathRow.style.display = file.toLowerCase().endsWith('.ahk') ? '' : 'none';
    }

    updateRunButton(file);
    updateCronButton(file);

    // Update auto-run toggle
    dom.autoRunToggle.checked = !!cfg.autoRun;

    // Update cron enabled toggle
    if (dom.cronEnabledToggle) {
        dom.cronEnabledToggle.checked = !!cfg.cronEnabled;
    }

    // Update cron interval input
    if (dom.cronInput && cfg.cronInterval > 0) {
        dom.cronInput.value = cfg.cronInterval;
    }

    // Load script content
    scriptManager.viewScript(file);
}

/* ---------------- LOG ---------------- */

function logToTerminal(msg) {
    if (typeof msg === 'string') {
        // Clean any remaining garbage
        msg = msg.replace(/[\u2500-\u257F]/g, '-')
            .replace(/[^\x20-\x7E\n]/g, '');
    }
    appendTerminalLog(msg);
}

/* ---------------- INIT ---------------- */

document.addEventListener("DOMContentLoaded", () => {
    dom = getDom();
    terminalLog = loadTerminalLog().map(normalizeLogEntry);

    // bind engine
    scriptManager.bindLogger(logToTerminal);
    scriptManager.bindDom(dom);
    scriptManager.bindRenderer(renderScripts);

    // restore terminal
    renderTerminal(terminalLog);
    scriptManager.replayMainProcessLogToTerminal(MAX_TERMINAL_LINES);

    scriptManager.init({ bindUI: true, skipAutoRun: true });

    /* ---------------- UI EVENTS ---------------- */

    dom.loadScriptsButton?.addEventListener("click", () => {
        scriptManager.loadScripts();
    });

    dom.saveScriptButton?.addEventListener("click", () => {
        scriptManager.saveScript();
    });

    dom.chooseScriptLocationButton?.addEventListener("click", () => {
        scriptManager.chooseCustomScriptFolder();
    });

    dom.aboutButton?.addEventListener("click", () => {
        window.location.href = "./pages/about.html";
    });

    dom.terminalToggleButton?.addEventListener("click", () => {
        toggleTerminal();
    });

    // Detail panel events
    dom.runButton?.addEventListener("click", () => {
        if (!selectedFile) return;
        scriptManager.runScript(selectedFile);
    });

    dom.runStartupButton?.addEventListener("click", async () => {
        if (!selectedFile) return;
        await scriptManager.runScript(selectedFile);
    });

    dom.viewButton?.addEventListener("click", () => {
        if (!selectedFile) return;
        scriptManager.viewScript(selectedFile);
    });

    dom.autoRunToggle?.addEventListener("change", () => {
        if (!selectedFile) return;
        scriptManager.updateConfig(selectedFile, { autoRun: dom.autoRunToggle.checked });
    });

    dom.cronEnabledToggle?.addEventListener("change", () => {
        if (!selectedFile) return;
        const intervalMs = parseInt(dom.cronInput.value, 10) || 0;
        scriptManager.saveCronConfig(selectedFile, intervalMs, dom.cronEnabledToggle.checked);
        scriptManager._log(`Cron auto-start ${dom.cronEnabledToggle.checked ? 'enabled' : 'disabled'} for ${selectedFile}`);
    });

    dom.cronToggleButton?.addEventListener("click", async () => {
        if (!selectedFile) return;
        const intervalMs = parseInt(dom.cronInput.value, 10);
        if (!intervalMs || intervalMs < 1000) {
            scriptManager._log("Cron interval must be at least 1000ms (1 second)");
            return;
        }
        if (scriptManager.isCronRunning(selectedFile)) {
            await scriptManager.stopCronScript(selectedFile);
            await scriptManager.saveCronConfig(selectedFile, intervalMs, false);
        } else {
            await scriptManager.startCronScript(selectedFile, intervalMs);
            await scriptManager.saveCronConfig(selectedFile, intervalMs, true);
        }
        selectScript(selectedFile);
    });

    /* ---------------- AHK PATH CONFIG ---------------- */

    async function loadAhkPath() {
        if (!dom.ahkPathInput) return;
        try {
            const ahkPath = await window.electronAPI.invoke('get-ahk-path');
            dom.ahkPathInput.value = ahkPath || '';
        } catch (e) {
            dom.ahkPathInput.value = '';
        }
    }

    dom.ahkBrowseButton?.addEventListener("click", async () => {
        const result = await window.electronAPI.invoke('select-file', {
            title: 'Select AutoHotkey.exe',
            filters: [{ name: 'Executable', extensions: ['exe'] }],
            properties: ['openFile']
        });
        if (result && !result.canceled && result.filePaths.length > 0) {
            dom.ahkPathInput.value = result.filePaths[0];
            await window.electronAPI.invoke('set-ahk-path', result.filePaths[0]);
            scriptManager._log(`[AHK] Path set to: ${result.filePaths[0]}`);
        }
    });

    dom.ahkResetButton?.addEventListener("click", async () => {
        dom.ahkPathInput.value = '';
        await window.electronAPI.invoke('set-ahk-path', null);
        scriptManager._log('[AHK] Path reset to auto-detect');
    });

    dom.ahkPathInput?.addEventListener("change", async () => {
        const val = dom.ahkPathInput.value.trim();
        await window.electronAPI.invoke('set-ahk-path', val || null);
        scriptManager._log(`[AHK] Path set to: ${val || 'auto-detect'}`);
    });

    // Load settings on init
    loadAhkPath();

    dom.scriptManager = scriptManager; // expose for external updates
});

window.addEventListener("beforeunload", () => {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTerminalLog(terminalLog);
    }
});
