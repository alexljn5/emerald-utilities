import { scriptManager } from "../../core/scriptManager.js";

const TERMINAL_KEY = "emerald_terminal_log";

let dom = null;

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
        return JSON.parse(sessionStorage.getItem(TERMINAL_KEY) || "[]");
    } catch {
        return [];
    }
}

function saveTerminalLog(log) {
    sessionStorage.setItem(TERMINAL_KEY, JSON.stringify(log.slice(-200)));
}

function renderTerminal(log) {
    if (!dom?.terminalOutput) return;

    dom.terminalOutput.innerHTML = "";

    for (const msg of log.slice(-20)) {
        const div = document.createElement("div");
        div.textContent = msg;
        dom.terminalOutput.appendChild(div);
    }
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
        runBtn.textContent = cfg.displayName;
        runBtn.onclick = () => scriptManager.runScript(file);

        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.checked = !!cfg.autoRun;
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
    const log = loadTerminalLog();
    log.push(msg);
    saveTerminalLog(log);
    renderTerminal(log);
}

/* ---------------- INIT ---------------- */

document.addEventListener("DOMContentLoaded", () => {
    dom = getDom();

    // bind engine
    scriptManager.bindLogger(logToTerminal);
    scriptManager.bindDom(dom);
    scriptManager.bindRenderer(renderScripts);
    scriptManager.replayStartupLogToTerminal(40);

    // restore terminal
    renderTerminal(loadTerminalLog());

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