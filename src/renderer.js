const { ipcRenderer } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const { app } = require('electron');

let currentScript = null;
let isRunning = false;
let areScriptsVisible = false;
let scriptRunners = {};
let config = { scripts: [] };

const domElements = {
    loadScriptsButton: document.getElementById('loadScriptsButton'),
    saveScriptButton: document.getElementById('saveScriptButton'),
    scriptButtons: {},
    autoRunToggles: {}
};

document.addEventListener('DOMContentLoaded', () => {
    const cssPath = process.env.PORTABLE_EXECUTABLE_DIR
        ? path.join(path.dirname(app.getPath('exe')), 'styles', 'styles.css')
        : path.join(__dirname, '../styles/styles.css');
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = cssPath;
    document.head.appendChild(link);
});

async function updateConfig(file, updates) {
    try {
        const scriptsDir = process.env.PORTABLE_EXECUTABLE_DIR
            ? path.join(path.dirname(app.getPath('exe')), 'scripts')
            : path.join(__dirname, '../scripts');
        const configPath = path.join(scriptsDir, 'config.json');

        let scriptEntry = config.scripts.find(s => s.file === file);
        if (!scriptEntry) {
            scriptEntry = {
                file,
                type: file.endsWith('.js') ? 'standard' : file.endsWith('.sh') ? 'shell' : file.endsWith('.bat') ? 'batch' : file.endsWith('.exe') ? 'executable' : 'unknown',
                autoRun: false,
                displayName: `Run ${file}`
            };
            config.scripts.push(scriptEntry);
        }

        Object.assign(scriptEntry, updates);

        await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
        logToTerminal(`Updated config.json for ${file}`);
    } catch (err) {
        console.error('Error updating config.json:', err);
        logToTerminal(`Error updating config.json: ${err.message}`);
    }
}

function loadScriptsButtonFunction() {
    if (areScriptsVisible) {
        document.getElementById('scriptList').innerHTML = '';
        domElements.loadScriptsButton.textContent = 'Load Scripts';
        areScriptsVisible = false;
        logToTerminal('Scripts hidden.');
    } else {
        loadScripts();
        domElements.loadScriptsButton.textContent = 'Hide Scripts';
        areScriptsVisible = true;
        logToTerminal('Scripts loaded and displayed.');
    }
}

function saveScriptButtonFunction() {
    saveScript();
}

async function loadScripts() {
    try {
        const scriptsDir = process.env.PORTABLE_EXECUTABLE_DIR
            ? path.join(path.dirname(app.getPath('exe')), 'scripts')
            : path.join(__dirname, '../scripts');
        const scriptList = document.getElementById('scriptList');
        scriptList.innerHTML = '';
        scriptRunners = {};
        domElements.scriptButtons = {};
        domElements.autoRunToggles = {};

        try {
            await fs.access(scriptsDir);
        } catch (err) {
            await fs.mkdir(scriptsDir, { recursive: true });
            logToTerminal(`Created scripts directory at ${scriptsDir}`);
        }

        const configPath = path.join(scriptsDir, 'config.json');
        try {
            const configData = await fs.readFile(configPath, 'utf8');
            config = JSON.parse(configData);
        } catch (err) {
            console.error('Error loading config.json:', err);
            logToTerminal('Creating new config.json...');
            config = { scripts: [] };
            await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
        }

        const files = await fs.readdir(scriptsDir);
        for (const file of files) {
            if (file.endsWith('.js') || file.endsWith('.sh') || file.endsWith('.bat') || file.endsWith('.exe')) {
                const scriptConfig = config.scripts.find(s => s.file === file) || {
                    file,
                    type: file.endsWith('.js') ? 'standard' : file.endsWith('.sh') ? 'shell' : file.endsWith('.bat') ? 'batch' : 'executable',
                    autoRun: false,
                    displayName: `Run ${file}`
                };

                const { file: scriptFile, type, displayName, autoRun } = scriptConfig;

                const div = document.createElement('div');
                const runButton = document.createElement('button');
                runButton.id = `run-${scriptFile}`;
                runButton.textContent = displayName;
                const toggle = document.createElement('input');
                toggle.type = 'checkbox';
                toggle.id = `toggle-${scriptFile}`;
                toggle.checked = localStorage.getItem(`autoRun-${scriptFile}`) === 'true' || autoRun;
                const viewButton = document.createElement('button');
                viewButton.textContent = `View ${scriptFile}`;
                viewButton.onclick = () => viewScript(scriptFile);

                div.appendChild(runButton);
                div.appendChild(toggle);
                div.appendChild(viewButton);
                scriptList.appendChild(div);
                scriptList.appendChild(document.createElement('br'));

                domElements.scriptButtons[scriptFile] = runButton;
                domElements.autoRunToggles[scriptFile] = toggle;

                if (type === 'robotjs') {
                    try {
                        const scriptPath = path.join(scriptsDir, scriptFile);
                        const scriptModule = require(scriptPath);
                        if (scriptModule.runSpyBlockerKeys) {
                            scriptRunners[scriptFile] = scriptModule.runSpyBlockerKeys(
                                logToTerminal,
                                (state) => { isRunning = state; },
                                (disabled) => { if (domElements.scriptButtons[scriptFile]) domElements.scriptButtons[scriptFile].disabled = disabled; }
                            );
                            runButton.onclick = () => scriptRunners[scriptFile]();
                        }
                    } catch (err) {
                        console.error(`Error loading ${scriptFile}:`, err);
                        logToTerminal(`Error loading ${scriptFile}: ${err.message}`);
                    }
                } else {
                    runButton.onclick = () => runScript(scriptFile);
                }

                toggle.addEventListener('change', () => {
                    localStorage.setItem(`autoRun-${scriptFile}`, toggle.checked);
                    updateConfig(scriptFile, { autoRun: toggle.checked });
                    logToTerminal(`Auto-run ${displayName} ${toggle.checked ? 'enabled' : 'disabled'}`);
                });
            }
        }
    } catch (err) {
        console.error('Error loading scripts:', err);
        logToTerminal(`Error loading scripts: ${err.message}`);
    }
}

async function viewScript(file) {
    try {
        const scriptsDir = process.env.PORTABLE_EXECUTABLE_DIR
            ? path.join(path.dirname(app.getPath('exe')), 'scripts')
            : path.join(__dirname, '../scripts');
        const scriptPath = path.join(scriptsDir, file);
        if (file.endsWith('.exe')) {
            logToTerminal(`Cannot view binary file: ${file}`);
            return;
        }
        const content = await fs.readFile(scriptPath, 'utf8');
        document.getElementById('scriptContent').value = content;
        currentScript = file;
    } catch (err) {
        console.error(`Error reading ${file}:`, err);
        logToTerminal(`Error reading ${file}: ${err.message}`);
    }
}

async function saveScript() {
    if (!currentScript) {
        logToTerminal('No script selected to save!');
        return;
    }
    if (currentScript.endsWith('.exe')) {
        logToTerminal('Cannot save binary .exe files!');
        return;
    }
    try {
        const scriptsDir = process.env.PORTABLE_EXECUTABLE_DIR
            ? path.join(path.dirname(app.getPath('exe')), 'scripts')
            : path.join(__dirname, '../scripts');
        const scriptPath = path.join(scriptsDir, currentScript);
        const content = document.getElementById('scriptContent').value;
        await fs.writeFile(scriptPath, content, 'utf8');
        logToTerminal(`Saved ${currentScript}!`);
    } catch (err) {
        console.error(`Error saving ${currentScript}:`, err);
        logToTerminal(`Error saving ${currentScript}: ${err.message}`);
    }
}

function runScript(file) {
    if (scriptRunners[file]) {
        scriptRunners[file]();
        return;
    }

    const scriptsDir = process.env.PORTABLE_EXECUTABLE_DIR
        ? path.join(path.dirname(app.getPath('exe')), 'scripts')
        : path.join(__dirname, '../scripts');
    const scriptPath = path.join(scriptsDir, file);
    let command, args;

    if (file.endsWith('.js')) {
        command = 'node';
        args = [scriptPath];
    } else if (file.endsWith('.sh')) {
        command = 'bash';
        args = [scriptPath];
    } else if (file.endsWith('.bat')) {
        command = 'cmd.exe';
        args = ['/c', scriptPath];
    } else if (file.endsWith('.exe')) {
        command = scriptPath;
        args = [];
    } else {
        logToTerminal('Unsupported file type!');
        return;
    }

    execFile(command, args, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error running ${file}:`, error);
            logToTerminal(`Error running ${file}: ${error.message}`);
            return;
        }
        console.log(`Output from ${file}:`, stdout);
        logToTerminal(`Ran ${file}! Output: ${stdout}`);
        if (stderr) {
            console.error(`Errors from ${file}:`, stderr);
            logToTerminal(`Errors from ${file}: ${stderr}`);
        }
    });
}

function logToTerminal(message) {
    const terminal = document.getElementById('terminalOutput');
    if (terminal) {
        const maxLines = 50;
        const logEntry = document.createElement('div');
        logEntry.textContent = message;
        terminal.appendChild(logEntry);

        const logEntries = terminal.getElementsByTagName('div');
        while (logEntries.length > maxLines) {
            terminal.removeChild(logEntries[0]);
        }

        terminal.scrollTop = terminal.scrollHeight;
        ipcRenderer.send('log', message);
    } else {
        console.error('Terminal output element not found');
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    domElements.loadScriptsButton.addEventListener('click', loadScriptsButtonFunction);
    domElements.saveScriptButton.addEventListener('click', saveScriptButtonFunction);

    await loadScripts();

    for (const [file, toggle] of Object.entries(domElements.autoRunToggles)) {
        if (toggle.checked) {
            if (scriptRunners[file]) {
                scriptRunners[file]();
            } else {
                runScript(file);
            }
        }
    }
});