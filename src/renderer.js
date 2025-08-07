const { ipcRenderer } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs').promises;

// State management
const state = {
    currentScript: null,
    areScriptsVisible: false,
    scriptRunners: new Map(),
    config: { scripts: [], customScriptsPath: null },
};

// Cached DOM elements
const dom = {
    loadScriptsButton: document.getElementById('loadScriptsButton'),
    saveScriptButton: document.getElementById('saveScriptButton'),
    scriptList: document.getElementById('scriptList'),
    scriptContent: document.getElementById('scriptContent'),
    terminalOutput: document.getElementById('terminalOutput'),
    chooseScriptLocationButton: document.getElementById('chooseScriptLocationButton'),
    scriptButtons: new Map(),
    autoRunToggles: new Map(),
};

// Utility to get scripts directory
const getScriptsDir = () =>
    state.config.customScriptsPath ||
    (process.env.NODE_ENV === 'development'
        ? path.join(__dirname, '../scripts')
        : path.join(process.resourcesPath, 'scripts'));

// Update config.json
async function updateConfig(file, updates) {
    try {
        const configPath = path.join(await ipcRenderer.invoke('get-user-data-path'), 'config.json');
        const scriptEntry = state.config.scripts.find((s) => s.file === file) || {
            file,
            type: file.match(/\.(js|sh|bat|exe)$/)?.[1] ?? 'unknown',
            autoRun: false,
            displayName: `Run ${file}`,
        };

        if (!state.config.scripts.includes(scriptEntry)) {
            state.config.scripts.push(scriptEntry);
        }
        Object.assign(scriptEntry, updates);
        await fs.writeFile(configPath, JSON.stringify(state.config, null, 2), 'utf8');
        logToTerminal(`Updated config for ${file}`);
    } catch (err) {
        console.error('Failed to update config:', err);
        logToTerminal(`Error updating config: ${err.message}`);
    }
}

// Toggle script visibility
function toggleScripts() {
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

// Load scripts from directory
async function loadScripts() {
    try {
        const configPath = path.join(await ipcRenderer.invoke('get-user-data-path'), 'config.json');
        let scriptsDir = getScriptsDir();

        // Initialize config if not exists
        try {
            state.config = JSON.parse(await fs.readFile(configPath, 'utf8'));
        } catch {
            state.config = { scripts: [], customScriptsPath: null };
            await fs.writeFile(configPath, JSON.stringify(state.config, null, 2), 'utf8');
            logToTerminal('Created new config file.');
        }
        scriptsDir = state.config.customScriptsPath || scriptsDir;

        // Ensure scripts directory exists
        try {
            if (!(await fs.stat(scriptsDir)).isDirectory()) {
                throw new Error('Not a directory');
            }
        } catch {
            scriptsDir = process.env.NODE_ENV === 'development'
                ? path.join(__dirname, '../scripts')
                : path.join(process.resourcesPath, 'scripts');
            await fs.mkdir(scriptsDir, { recursive: true });
            logToTerminal(`Created scripts directory at ${scriptsDir}`);
        }

        dom.scriptList.innerHTML = '';
        state.scriptRunners.clear();
        dom.scriptButtons.clear();
        dom.autoRunToggles.clear();

        const files = (await fs.readdir(scriptsDir)).filter((file) => file.match(/\.(js|sh|bat|exe)$/));
        for (const file of files) {
            const scriptConfig = state.config.scripts.find((s) => s.file === file) || {
                file,
                type: file.match(/\.(js|sh|bat|exe)$/)?.[1] ?? 'unknown',
                autoRun: false,
                displayName: `Run ${file}`,
            };

            const div = document.createElement('div');
            const runButton = document.createElement('button');
            runButton.id = `run-${file}`;
            runButton.textContent = scriptConfig.displayName;
            runButton.onclick = () => runScript(file);

            const toggle = document.createElement('input');
            toggle.type = 'checkbox';
            toggle.id = `toggle-${file}`;
            toggle.checked = localStorage.getItem(`autoRun-${file}`) === 'true' || scriptConfig.autoRun;
            toggle.addEventListener('change', () => {
                localStorage.setItem(`autoRun-${file}`, toggle.checked);
                updateConfig(file, { autoRun: toggle.checked });
                logToTerminal(`Auto-run ${scriptConfig.displayName} ${toggle.checked ? 'enabled' : 'disabled'}`);
            });

            const viewButton = document.createElement('button');
            viewButton.textContent = `View ${file}`;
            viewButton.onclick = () => viewScript(file);

            div.appendChild(runButton);
            div.appendChild(toggle);
            div.appendChild(viewButton);
            dom.scriptList.appendChild(div);
            dom.scriptList.appendChild(document.createElement('br'));

            dom.scriptButtons.set(file, runButton);
            dom.autoRunToggles.set(file, toggle);
        }

        // Attach custom scripts directory button
        dom.chooseScriptLocationButton.onclick = async () => {
            const customPath = await ipcRenderer.invoke('select-directory');
            if (customPath) {
                state.config.customScriptsPath = customPath;
                await fs.writeFile(configPath, JSON.stringify(state.config, null, 2), 'utf8');
                logToTerminal(`Set custom scripts directory to ${customPath}`);
                loadScripts();
            }
        };
    } catch (err) {
        console.error('Failed to load scripts:', err);
        logToTerminal(`Error loading scripts: ${err.message}`);
    }
}

// View script content
async function viewScript(file) {
    try {
        const scriptPath = path.join(getScriptsDir(), file);
        if (file.endsWith('.exe')) {
            logToTerminal(`Cannot view binary file: ${file}`);
            return;
        }
        dom.scriptContent.value = await fs.readFile(scriptPath, 'utf8');
        state.currentScript = file;
    } catch (err) {
        console.error(`Failed to read ${file}:`, err);
        logToTerminal(`Error reading ${file}: ${err.message}`);
    }
}

// Save script content
async function saveScript() {
    if (!state.currentScript) {
        logToTerminal('No script selected to save!');
        return;
    }
    if (state.currentScript.endsWith('.exe')) {
        logToTerminal('Cannot save binary .exe files!');
        return;
    }
    try {
        const scriptPath = path.join(getScriptsDir(), state.currentScript);
        await fs.writeFile(scriptPath, dom.scriptContent.value, 'utf8');
        logToTerminal(`Saved ${state.currentScript}!`);
    } catch (err) {
        console.error(`Failed to save ${state.currentScript}:`, err);
        logToTerminal(`Error saving ${state.currentScript}: ${err.message}`);
    }
}

// Run a script
async function runScript(file) {
    if (state.scriptRunners.has(file)) {
        state.scriptRunners.get(file)();
        return;
    }

    const scriptPath = path.join(getScriptsDir(), file);
    try {
        await fs.access(scriptPath);
    } catch {
        logToTerminal(`Script not found: ${file}`);
        return;
    }
    const argsInput = document.getElementById('argsInput')?.value.split(' ').filter(Boolean) || [];
    let command, args;

    switch (file.split('.').pop().toLowerCase()) {
        case 'js':
            command = 'node';
            args = [scriptPath, ...argsInput];
            break;
        case 'sh':
            command = 'bash';
            args = [scriptPath, ...argsInput];
            break;
        case 'bat':
            command = 'cmd.exe';
            args = ['/c', scriptPath, ...argsInput];
            break;
        case 'exe':
            command = scriptPath;
            args = [...argsInput];
            break;
        default:
            logToTerminal('Unsupported file type!');
            return;
    }



    execFile(command, args, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error running ${file}:`, error);
            logToTerminal(`Error running ${file}: ${error.message}`);
            return;
        }
        if (stdout) {
            console.log(`Output from ${file}:`, stdout);
            logToTerminal(`Ran ${file}! Output: ${stdout}`);
        }
        if (stderr) {
            console.error(`Errors from ${file}:`, stderr);
            logToTerminal(`Errors from ${file}: ${stderr}`);
        }
    });
}
// Log to terminal
function logToTerminal(message) {
    if (dom.terminalOutput) {
        const maxLines = 20; // Reduced for memory
        const logEntry = document.createElement('div');
        logEntry.textContent = message;
        dom.terminalOutput.appendChild(logEntry);

        while (dom.terminalOutput.childNodes.length > maxLines) {
            dom.terminalOutput.removeChild(dom.terminalOutput.firstChild);
        }

        dom.terminalOutput.scrollTop = dom.terminalOutput.scrollHeight;
        ipcRenderer.send('log', message);
    } else {
        console.error('Terminal output element not found');
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    dom.loadScriptsButton.addEventListener('click', toggleScripts);
    dom.saveScriptButton.addEventListener('click', saveScript);
    await loadScripts();

    for (const [file, toggle] of dom.autoRunToggles) {
        if (toggle.checked) {
            runScript(file);
        }
    }
});