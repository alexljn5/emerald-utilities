const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { versionNumber } = require('../globals');
const { spawn } = require('child_process');

/* ---------------- STATE ---------------- */

const state = {
    currentScript: null,
    areScriptsVisible: false,
    scriptRunners: new Map(),
    config: { scripts: [], customScriptsPath: null },
    autoRunExecuted: false
};

/* ---------------- TERMINAL PERSISTENCE ---------------- */

const TERMINAL_KEY = 'emerald_terminal_log';

function loadTerminalLog() {
    try {
        return JSON.parse(sessionStorage.getItem(TERMINAL_KEY) || '[]');
    } catch {
        return [];
    }
}

function saveTerminalLog(log) {
    sessionStorage.setItem(TERMINAL_KEY, JSON.stringify(log.slice(-200)));
}

function renderTerminal(dom, log) {
    if (!dom?.terminalOutput) return;

    dom.terminalOutput.innerHTML = '';

    for (const msg of log.slice(-20)) {
        const div = document.createElement('div');
        div.textContent = msg;
        dom.terminalOutput.appendChild(div);
    }

    dom.terminalOutput.scrollTop = dom.terminalOutput.scrollHeight;
}

/* ---------------- DOM ---------------- */

function getDom() {
    return {
        loadScriptsButton: document.getElementById('loadScriptsButton'),
        saveScriptButton: document.getElementById('saveScriptButton'),
        scriptList: document.getElementById('scriptList'),
        scriptContent: document.getElementById('scriptContent'),
        terminalOutput: document.getElementById('terminalOutput'),
        chooseScriptLocationButton: document.getElementById('chooseScriptLocationButton'),
        argsInput: document.getElementById('argsInput'),
        aboutButton: document.getElementById('aboutButton'),
        versionDisplay: document.getElementById('versionDisplay'),
        scriptButtons: new Map(),
        autoRunToggles: new Map()
    };
}

let dom = null;

/* ---------------- INIT ---------------- */

function initApp() {
    if (window.__emeraldInitialized) return;
    window.__emeraldInitialized = true;

    dom = getDom();

    // restore terminal from sessionStorage immediately
    const log = loadTerminalLog();
    renderTerminal(dom, log);

    if (dom.versionDisplay) {
        dom.versionDisplay.textContent = `v${versionNumber}`;
    }

    if (dom.aboutButton) {
        dom.aboutButton.onclick = () => {
            window.location.href = './pages/about.html';
        };
    }

    dom.loadScriptsButton?.addEventListener('click', toggleScripts);
    dom.saveScriptButton?.addEventListener('click', saveScript);

    loadScripts().then(tryAutoRun);
}

document.addEventListener('DOMContentLoaded', initApp);

/* ---------------- LOGGING (FIXED) ---------------- */

function logToTerminal(message) {
    const log = loadTerminalLog();

    log.push(message);
    saveTerminalLog(log);

    if (!dom?.terminalOutput) {
        ipcRenderer.send('log', message);
        return;
    }

    renderTerminal(dom, log);

    ipcRenderer.send('log', message);
}

/* ---------------- AUTO RUN ---------------- */

async function tryAutoRun() {
    if (sessionStorage.getItem('autoRunDone')) return;
    sessionStorage.setItem('autoRunDone', '1');

    for (const [file, toggle] of dom.autoRunToggles) {
        if (!toggle.checked) continue;

        const ok = await hasAllDependencies(file);
        if (ok) runScript(file);
        else {
            await updateConfig(file, { autoRun: false });
            toggle.checked = false;
            logToTerminal(`Disabled auto-run for ${file} (missing dependencies).`);
        }
    }
}

/* ---------------- PATHS ---------------- */

const getScriptsDir = () => {
    if (state.config.customScriptsPath) return state.config.customScriptsPath;

    const devPath = path.join(__dirname, '../scripts');
    const resPath = path.join(process.resourcesPath || '', 'scripts');

    if (fsSync.existsSync(devPath)) return devPath;
    if (fsSync.existsSync(resPath)) return resPath;

    return devPath;
};

/* ---------------- CONFIG (FIXED: added logs) ---------------- */

async function updateConfig(file, updates) {
    try {
        const configPath = path.join(
            await ipcRenderer.invoke('get-user-data-path'),
            'config.json'
        );

        const idx = state.config.scripts.findIndex(s => s.file === file);

        if (idx === -1) {
            state.config.scripts.push({
                file,
                type: file.match(/\.(js|sh|bat|exe)$/)?.[1] ?? 'unknown',
                autoRun: false,
                displayName: `Run ${file}`,
                ...updates
            });
            logToTerminal(`[config] added ${file} with autoRun=${updates.autoRun ?? false}`);
        } else {
            state.config.scripts[idx] = {
                ...state.config.scripts[idx],
                ...updates
            };
            logToTerminal(`[config] updated ${file} → autoRun=${updates.autoRun ?? state.config.scripts[idx].autoRun}`);
        }

        await fs.writeFile(configPath, JSON.stringify(state.config, null, 2), 'utf8');
        logToTerminal(`[config] saved to disk`);
    } catch (err) {
        console.error(err);
        logToTerminal(`Config error: ${err.message}`);
    }
}

/* ---------------- UI ---------------- */

function toggleScripts() {
    if (!dom) return;

    if (state.areScriptsVisible) {
        dom.scriptList.innerHTML = '';
        dom.scriptButtons.clear();
        dom.autoRunToggles.clear();
        dom.loadScriptsButton.textContent = 'Load Scripts';
        state.areScriptsVisible = false;
        logToTerminal('Scripts hidden.');
    } else {
        loadScripts();
        dom.loadScriptsButton.textContent = 'Hide Scripts';
        state.areScriptsVisible = true;
        logToTerminal('Scripts loaded.');
    }
}

/* ---------------- LOAD SCRIPTS ---------------- */

async function loadScripts() {
    try {
        const configPath = path.join(await ipcRenderer.invoke('get-user-data-path'), 'config.json');
        let scriptsDir = getScriptsDir();

        try {
            state.config = JSON.parse(await fs.readFile(configPath, 'utf8'));
        } catch {
            state.config = { scripts: [], customScriptsPath: null };
            await fs.writeFile(configPath, JSON.stringify(state.config, null, 2));
        }

        scriptsDir = state.config.customScriptsPath || scriptsDir;

        if (!fsSync.existsSync(scriptsDir)) {
            await fs.mkdir(scriptsDir, { recursive: true });
        }

        dom.scriptList.innerHTML = '';
        dom.scriptButtons.clear();
        dom.autoRunToggles.clear();
        state.scriptRunners.clear();

        const files = (await fs.readdir(scriptsDir))
            .filter(f => f.match(/\.(js|sh|bat|exe)$/));

        for (const file of files) {
            const cfg = state.config.scripts.find(s => s.file === file) || {
                file,
                displayName: `Run ${file}`,
                autoRun: false
            };

            const div = document.createElement('div');

            const runBtn = document.createElement('button');
            runBtn.textContent = cfg.displayName;
            runBtn.onclick = () => runScript(file);

            const toggle = document.createElement('input');
            toggle.type = 'checkbox';
            toggle.checked = cfg.autoRun === true;

            toggle.addEventListener('change', () => {
                updateConfig(file, { autoRun: toggle.checked });
            });

            const viewBtn = document.createElement('button');
            viewBtn.textContent = `View ${file}`;
            viewBtn.onclick = () => viewScript(file);

            div.appendChild(runBtn);
            div.appendChild(toggle);
            div.appendChild(viewBtn);

            dom.scriptList.appendChild(div);

            dom.scriptButtons.set(file, runBtn);
            dom.autoRunToggles.set(file, toggle);
        }

        dom.chooseScriptLocationButton.onclick = async () => {
            const customPath = await ipcRenderer.invoke('select-directory');
            if (!customPath) return;

            state.config.customScriptsPath = customPath;
            await fs.writeFile(configPath, JSON.stringify(state.config, null, 2));

            logToTerminal(`Scripts dir set: ${customPath}`);
            loadScripts();
        };

    } catch (err) {
        console.error(err);
        logToTerminal(`Load error: ${err.message}`);
    }
}

/* ---------------- VIEW / SAVE ---------------- */

async function viewScript(file) {
    try {
        const scriptPath = path.join(getScriptsDir(), file);

        if (file.endsWith('.exe')) {
            logToTerminal('Cannot view binary file');
            return;
        }

        dom.scriptContent.value = await fs.readFile(scriptPath, 'utf8');
        state.currentScript = file;
    } catch (err) {
        logToTerminal(`View error: ${err.message}`);
    }
}

async function saveScript() {
    if (!state.currentScript) return logToTerminal('No script selected');

    try {
        const scriptPath = path.join(getScriptsDir(), state.currentScript);
        await fs.writeFile(scriptPath, dom.scriptContent.value, 'utf8');
        logToTerminal(`Saved ${state.currentScript}`);
    } catch (err) {
        logToTerminal(`Save error: ${err.message}`);
    }
}

/* ---------------- EXECUTION ---------------- */

async function runScript(file) {
    if (state.scriptRunners.has(file)) {
        state.scriptRunners.get(file)();
        return;
    }

    const scriptPath = path.join(getScriptsDir(), file);

    if (!fsSync.existsSync(scriptPath)) {
        return logToTerminal(`Missing: ${file}`);
    }

    const isWindows = process.platform === 'win32';

    let command, args = [];

    switch (file.split('.').pop()) {
        case 'js':
            command = 'node';
            args = [scriptPath];
            break;
        case 'sh':
            command = 'bash';
            args = [scriptPath];
            break;
        case 'bat':
            command = 'cmd.exe';
            args = ['/c', scriptPath];
            break;
        case 'exe':
            command = scriptPath;
            break;
        default:
            return logToTerminal('Unsupported type');
    }

    const child = spawn(command, args, { shell: isWindows });

    child.stdout.on('data', d => logToTerminal(d.toString()));
    child.stderr.on('data', d => logToTerminal(`ERR: ${d}`));

    child.on('exit', code => {
        logToTerminal(`${file} exited (${code})`);
        state.scriptRunners.delete(file);
    });

    state.scriptRunners.set(file, () => child.kill());
}

/* ---------------- DEPENDENCIES ---------------- */

async function hasAllDependencies(file) {
    const scriptPath = path.join(getScriptsDir(), file);
    const ext = file.split('.').pop();

    if (!['bat', 'sh', 'js'].includes(ext)) return true;

    const content = await fs.readFile(scriptPath, 'utf8');
    const matches = content.match(/\b[\w\-.]+\.exe\b/gi) || [];

    const allow = new Set([
        'powershell.exe', 'cmd.exe', 'bash.exe', 'node.exe',
        'npm.exe', 'explorer.exe', 'taskkill.exe', 'reg.exe', 'wmic.exe'
    ]);

    for (const m of matches) {
        const exe = m.toLowerCase();
        if (allow.has(exe)) continue;

        if (!fsSync.existsSync(path.join(path.dirname(scriptPath), exe))) {
            logToTerminal(`Missing dep: ${exe}`);
            return false;
        }
    }

    return true;
}