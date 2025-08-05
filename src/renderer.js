const { ipcRenderer } = require('electron');
const robot = require('robotjs');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs').promises;

let currentScript = null;
let isRunning = false;

const domElements = {
    loadScriptsButton: document.getElementById('loadScriptsButton'),
    saveScriptButton: document.getElementById('saveScriptButton'),
    runSpyBlocker: document.getElementById('runSpyBlocker'),
    autoRunToggle: document.getElementById('autoRunToggle')
};

function loadScriptsButtonFunction() {
    loadScripts();
}

function saveScriptButtonFunction() {
    saveScript();
}

async function loadScripts() {
    try {
        const scriptsDir = path.join(__dirname, '../scripts');
        const files = await fs.readdir(scriptsDir);
        const scriptList = document.getElementById('scriptList');
        scriptList.innerHTML = '';

        const div = document.createElement('div');
        const runButton = document.createElement('button');
        runButton.id = 'runSpyBlocker';
        runButton.textContent = 'Run SpyBlocker Keys';
        runButton.onclick = runSpyBlockerKeys;
        div.appendChild(runButton);
        scriptList.appendChild(div);
        scriptList.appendChild(document.createElement('br'));

        files.forEach(file => {
            if (file.endsWith('.js') || file.endsWith('.sh') || file.endsWith('.bat')) {
                const div = document.createElement('div');
                const runButton = document.createElement('button');
                runButton.textContent = `Run ${file}`;
                runButton.onclick = () => runScript(file);
                const viewButton = document.createElement('button');
                viewButton.textContent = `View ${file}`;
                viewButton.onclick = () => viewScript(file);
                div.appendChild(runButton);
                div.appendChild(viewButton);
                scriptList.appendChild(div);
                scriptList.appendChild(document.createElement('br'));
            }
        });

        // Update domElements with the newly created runSpyBlocker button
        domElements.runSpyBlocker = document.getElementById('runSpyBlocker');
    } catch (err) {
        console.error('Error loading scripts:', err);
        logToTerminal(`Error loading scripts: ${err.message}`);
    }
}

async function viewScript(file) {
    try {
        const scriptPath = path.join(__dirname, '../scripts', file);
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
    try {
        const scriptPath = path.join(__dirname, '../scripts', currentScript);
        const content = document.getElementById('scriptContent').value;
        await fs.writeFile(scriptPath, content, 'utf8');
        logToTerminal(`Saved ${currentScript}!`);
    } catch (err) {
        console.error(`Error saving ${currentScript}:`, err);
        logToTerminal(`Error saving ${currentScript}: ${err.message}`);
    }
}

function runScript(file) {
    const scriptPath = path.join(__dirname, '../scripts', file);
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
        terminal.innerHTML += `${message}<br>`;
        terminal.scrollTop = terminal.scrollHeight;
        ipcRenderer.send('log', message);
    } else {
        console.error('Terminal output element not found');
    }
}

function runSpyBlockerKeys() {
    if (isRunning) {
        logToTerminal('SpyBlocker is already running, please wait!');
        return;
    }

    isRunning = true;
    const runButton = domElements.runSpyBlocker;
    if (runButton) {
        runButton.disabled = true;
    } else {
        logToTerminal('Warning: Run SpyBlocker button not found');
    }

    const scriptPath = 'C:\\Users\\alexl\\Desktop\\Scripts\\WindowsSpyBlocker.exe';
    logToTerminal('Starting WindowsSpyBlocker.exe...');

    const child = execFile(scriptPath, (error, stdout, stderr) => {
        if (error) {
            logToTerminal(`Error running WindowsSpyBlocker.exe: ${error.message}`);
            isRunning = false;
            if (runButton) runButton.disabled = false;
            return;
        }
        if (stderr) {
            logToTerminal(`Stderr: ${stderr}`);
        }
        logToTerminal(`Stdout: ${stdout}`);
    });

    setTimeout(() => {
        try {
            logToTerminal('Sending key sequence...');
            robot.keyTap('1');
            robot.setKeyboardDelay(500);
            robot.keyTap('enter');
            robot.setKeyboardDelay(500);
            robot.keyTap('1');
            robot.setKeyboardDelay(500);
            robot.keyTap('enter');
            robot.setKeyboardDelay(500);
            robot.keyTap('1');
            robot.setKeyboardDelay(500);
            robot.keyTap('enter');

            setTimeout(() => {
                logToTerminal('Closing WindowsSpyBlocker...');
                child.kill('SIGTERM');
                logToTerminal('WindowsSpyBlocker sequence completed.');
                isRunning = false;
                if (runButton) runButton.disabled = false;
            }, 5000);
        } catch (err) {
            logToTerminal(`Error sending keys: ${err.message}`);
            isRunning = false;
            if (runButton) runButton.disabled = false;
        }
    }, 2000);
}

// Initialize toggle state, load scripts, and auto-run
document.addEventListener('DOMContentLoaded', async () => {
    // Attach event listeners for static buttons
    domElements.loadScriptsButton.addEventListener('click', loadScriptsButtonFunction);
    domElements.saveScriptButton.addEventListener('click', saveScriptButtonFunction);

    // Load scripts to create the runSpyBlocker button
    await loadScripts();

    // Initialize toggle
    const autoRunToggle = domElements.autoRunToggle;
    if (autoRunToggle) {
        const autoRunEnabled = localStorage.getItem('autoRunSpyBlocker') === 'true';
        autoRunToggle.checked = autoRunEnabled;

        // Run SpyBlocker on startup if enabled
        if (autoRunEnabled) {
            runSpyBlockerKeys();
        }

        // Handle toggle change
        autoRunToggle.addEventListener('change', () => {
            localStorage.setItem('autoRunSpyBlocker', autoRunToggle.checked);
            logToTerminal(`Auto-run SpyBlocker ${autoRunToggle.checked ? 'enabled' : 'disabled'}`);
        });
    } else {
        console.error('Auto-run toggle not found');
        logToTerminal('Error: Auto-run toggle not found');
    }

    // Attach event listener to runSpyBlocker button if it exists
    if (domElements.runSpyBlocker) {
        domElements.runSpyBlocker.addEventListener('click', runSpyBlockerKeys);
    }
});