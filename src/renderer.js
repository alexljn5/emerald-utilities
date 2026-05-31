const { ipcRenderer } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { versionNumber } = require('./globals');

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

document.getElementById('aboutButton').onclick = () => {
    window.location.href = './pages/about.html';
};

// Utility to get scripts directory
const getScriptsDir = () => {
    if (state.config.customScriptsPath) return state.config.customScriptsPath;

    const devPath = path.join(__dirname, '../scripts');
    const resPath = path.join(process.resourcesPath || '', 'scripts');

    // Prefer the source scripts folder when running from repo (dev)
    if (fsSync.existsSync(devPath)) return devPath;

    // Otherwise use the packaged resources scripts folder if present
    if (fsSync.existsSync(resPath)) return resPath;

    // Fallback to devPath (will be created if needed)
    return devPath;
};

// Update config.json
async function updateConfig(file, updates) {
    try {
        const configPath = path.join(
            await ipcRenderer.invoke('get-user-data-path'),
            'config.json'
        );

        // find real index in array
        let idx = state.config.scripts.findIndex(s => s.file === file);

        if (idx === -1) {
            state.config.scripts.push({
                file,
                type: file.match(/\.(js|sh|bat|exe)$/)?.[1] ?? 'unknown',
                autoRun: false,
                displayName: `Run ${file}`,
                ...updates
            });
        } else {
            state.config.scripts[idx] = {
                ...state.config.scripts[idx],
                ...updates
            };
        }

        await fs.writeFile(configPath, JSON.stringify(state.config, null, 2), 'utf8');

        logToTerminal(`Config saved: ${file}`);
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
            // Only mark toggle checked when script is explicitly configured to auto-run in user config
            toggle.checked = state.config.scripts.some((s) => s.file === file && s.autoRun === true);
            toggle.addEventListener('change', () => {
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

        // Cleanup: remove configured script entries that don't exist in the scripts directory
        // This prevents old/missing entries from blocking startup or auto-run attempts
        const missingConfigured = [];
        for (let i = state.config.scripts.length - 1; i >= 0; i--) {
            const entry = state.config.scripts[i];
            const expectedPath = path.join(scriptsDir, entry.file);
            try {
                await fs.access(expectedPath);
            } catch {
                // Not present on disk — remove from config
                missingConfigured.push(entry.file);
                state.config.scripts.splice(i, 1);
            }
        }

        if (missingConfigured.length > 0) {
            try {
                await fs.writeFile(configPath, JSON.stringify(state.config, null, 2), 'utf8');
                missingConfigured.forEach((f) => logToTerminal(`Skipping missing configured script: ${f}`));
            } catch (err) {
                console.error('Failed to update config after removing missing scripts:', err);
            }
        }
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
const { spawn } = require('child_process');

async function runScript(file) {
    if (state.scriptRunners.has(file)) {
        state.scriptRunners.get(file)(); // Stop the script if already running
        return;
    }

    const scriptPath = path.join(getScriptsDir(), file);
    try {
        await fs.access(scriptPath);
    } catch {
        logToTerminal(`Script not found: ${file}`);
        return;
    }

    // Get arguments from input field and normalize them
    let argsInput = document.getElementById('argsInput')?.value.split(' ').filter(Boolean) || [];

    // Validate argsInput - check if paths exist only if provided
    if (argsInput.length > 0) {
        const firstArg = argsInput[0];
        try {
            await fs.access(firstArg);
        } catch {
            logToTerminal(`Invalid argument path: ${firstArg}. Please provide a valid file path.`);
            return;
        }
    }

    let command, args;
    const isWindows = process.platform === 'win32';

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
            if (!isWindows) {
                logToTerminal('BAT files are only supported on Windows.');
                return;
            }
            command = 'cmd.exe';
            args = ['/c', scriptPath, ...argsInput];
            break;
        case 'exe':
            if (!isWindows) {
                logToTerminal('EXE files are only supported on Windows.');
                return;
            }
            command = scriptPath;
            args = [...argsInput];
            break;
        default:
            logToTerminal('Unsupported file type!');
            return;
    }

    logToTerminal(`Running command: ${command} ${args.join(' ')}`);
    const child = spawn(command, args, {
        shell: isWindows,
        cwd: path.dirname(scriptPath)
    });

    child.stdout.on('data', (data) => {
        logToTerminal(data.toString().trim());
    });

    child.stderr.on('data', (data) => {
        logToTerminal(`stderr: ${data.toString().trim()}`);
    });

    child.on('error', (err) => {
        logToTerminal(`Failed to start script: ${err.message}`);
    });

    child.on('exit', (code) => {
        logToTerminal(`Script "${file}" exited with code ${code}`);
        state.scriptRunners.delete(file);
    });

    state.scriptRunners.set(file, () => {
        child.kill();
        logToTerminal(`Script "${file}" was manually stopped.`);
        state.scriptRunners.delete(file);
    });
}

// Check script dependencies (simple heuristic: look for .exe references inside batch/sh files)
async function hasAllDependencies(file) {
    const scriptPath = path.join(getScriptsDir(), file);
    const ext = file.split('.').pop().toLowerCase();

    try {
        if (ext === 'bat' || ext === 'sh' || ext === 'js') {
            const content = await fs.readFile(scriptPath, 'utf8');

            const matches = content.match(/\b[\w\-.]+\.exe\b/gi) || [];

            const systemAllowList = new Set([
                'powershell.exe',
                'cmd.exe',
                'bash.exe',
                'node.exe',
                'npm.exe',
                'explorer.exe',
                'taskkill.exe',
                'reg.exe',
                'wmic.exe'
            ]);

            for (const raw of matches) {
                const exe = raw.toLowerCase();

                // ALWAYS trust system executables
                if (systemAllowList.has(exe)) {
                    continue;
                }

                // Only treat as local dependency if it looks like a project file
                const depPath = path.join(path.dirname(scriptPath), exe);

                if (!fsSync.existsSync(depPath)) {
                    logToTerminal(`Missing local dependency: ${exe}`);
                    return false;
                }
            }
        }

        return true;
    } catch (err) {
        console.error(`Error checking dependencies for ${file}:`, err);
        return false;
    }
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
    // Display version number
    const versionDisplay = document.getElementById('versionDisplay');
    if (versionDisplay) {
        versionDisplay.textContent = `v${versionNumber}`;
    }

    dom.loadScriptsButton.addEventListener('click', toggleScripts);
    dom.saveScriptButton.addEventListener('click', saveScript);
    await loadScripts();

    // Auto-run configured scripts only if their dependencies are present
    for (const [file, toggle] of dom.autoRunToggles) {
        if (toggle.checked) {
            try {
                const ok = await hasAllDependencies(file);
                if (ok) {
                    runScript(file);
                } else {
                    // Turn off autoRun for this script to avoid repeated failures
                    updateConfig(file, { autoRun: false });
                    toggle.checked = false;
                    logToTerminal(`Disabled auto-run for ${file} due to missing dependencies.`);
                }
            } catch (err) {
                console.error(`Error during auto-run check for ${file}:`, err);
            }
        }
    }
});