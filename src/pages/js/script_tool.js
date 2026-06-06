import { scriptManager } from "../../core/scriptManager.js";

const TERMINAL_KEY = "emerald_terminal_log";
const MAX_TERMINAL_LINES = 500;

let dom = null;
let terminalLog = [];
let renderQueued = false;
let saveTimer = null;

function getDom() {
    return {
        loadScriptsButton: document.getElementById('loadScriptsButton'),
        saveScriptButton: document.getElementById('saveScriptButton'),
        scriptList: document.getElementById('scriptList'),
        scriptContent: document.getElementById('scriptContent'),
        terminalOutput: document.getElementById('terminalOutput'),
        chooseScriptLocationButton: document.getElementById('chooseScriptLocationButton'),
        aboutButton: document.getElementById('aboutButton'),
        scriptButtons: new Map(),
        autoRunToggles: new Map()
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

function renderScripts(files, configScripts) {
    if (!dom?.scriptList) return;
    dom.scriptList.innerHTML = "";
    dom.scriptButtons?.clear?.();
    dom.autoRunToggles?.clear?.();

    for (const file of files) {
        const cfg = configScripts.find(s => s.file === file) || {
            file,
            displayName: `Run ${file}`,
            autoRun: false
        };

        const div = document.createElement("div");

        const runBtn = document.createElement("button");
        const isRunning = scriptManager.isScriptRunning(file);
        runBtn.textContent = isRunning ? `Stop ${file}` : cfg.displayName;
        runBtn.onclick = () => scriptManager.runScript(file);

        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.checked = !!cfg.autoRun;
        toggle.title = "Auto-run";
        toggle.onchange = () => {
            scriptManager.updateConfig(file, { autoRun: toggle.checked });
        };

        const viewBtn = document.createElement("button");
        viewBtn.textContent = `View ${file}`;
        viewBtn.onclick = () => scriptManager.viewScript(file);   // ← FIXED!

        div.append(runBtn, toggle, viewBtn);
        dom.scriptList.appendChild(div);
    }
}

/* ---------------- LOG ---------------- */

function logToTerminal(msg) {
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

    scriptManager.init();

    /* ---------------- UI EVENTS ---------------- */

    dom.loadScriptsButton?.addEventListener("click", () => {
        scriptManager.loadScripts();
    });

    dom.saveScriptButton?.addEventListener("click", () => {
        scriptManager.saveScript();     // ← FIXED!
    });

    dom.aboutButton?.addEventListener("click", () => {
        window.location.href = "./pages/about.html";
    });
    dom.chooseScriptLocationButton?.addEventListener("click", () => {
        scriptManager.chooseCustomScriptFolder();
    });

    scriptManager.bindUI = () => { }; // reserved hook if needed
});

window.addEventListener("beforeunload", () => {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTerminalLog(terminalLog);
    }
});
