const { ipcRenderer } = require('electron');
const robot = require('robotjs');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs').promises;

let currentScript = null;
let isRunning = false; // Flag to prevent multiple executions

async function loadScripts() {
    try {
        const scriptsDir = path.join(__dirname, '../scripts');
        const files = await fs.readdir(scriptsDir);
        const scriptList = document.getElementById('scriptList');
        scriptList.innerHTML = '';

        // Add a button for the internal key sequence
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
    terminal.innerHTML += `${message}<br>`;
    terminal.scrollTop = terminal.scrollHeight;
    ipcRenderer.send('log', message);
}

function runSpyBlockerKeys() {
    if (isRunning) {
        logToTerminal('SpyBlocker is already running, please wait!');
        return;
    }

    isRunning = true;
    const runButton = document.getElementById('runSpyBlocker');
    runButton.disabled = true; // Disable button to prevent multiple clicks

    const scriptPath = 'C:\\Users\\alexl\\Desktop\\Scripts\\WindowsSpyBlocker.exe';
    logToTerminal('Starting WindowsSpyBlocker.exe...');

    // Start the WindowsSpyBlocker.exe process
    const child = execFile(scriptPath, (error, stdout, stderr) => {
        if (error) {
            logToTerminal(`Error running WindowsSpyBlocker.exe: ${error.message}`);
            isRunning = false;
            runButton.disabled = false;
            return;
        }
        if (stderr) {
            logToTerminal(`Stderr: ${stderr}`);
        }
        logToTerminal(`Stdout: ${stdout}`);
    });

    // Wait for the program to load
    setTimeout(() => {
        try {
            logToTerminal('Sending key sequence...');
            // Simulate key presses: 1, Enter, 1, Enter, 1, Enter
            robot.keyTap('1');
            robot.setKeyboardDelay(500); // Mimic AutoHotkey's 500ms delay
            robot.keyTap('enter');
            robot.setKeyboardDelay(500);
            robot.keyTap('1');
            robot.setKeyboardDelay(500);
            robot.keyTap('enter');
            robot.setKeyboardDelay(500);
            robot.keyTap('1');
            robot.setKeyboardDelay(500);
            robot.keyTap('enter');

            // Wait for the program to process the keys
            setTimeout(() => {
                logToTerminal('Closing WindowsSpyBlocker...');
                child.kill('SIGTERM'); // Terminate the process
                logToTerminal('WindowsSpyBlocker sequence completed.');
                isRunning = false;
                runButton.disabled = false; // Re-enable button
            }, 5000); // Mimic AutoHotkey's 5000ms delay before closing
        } catch (err) {
            logToTerminal(`Error sending keys: ${err.message}`);
            isRunning = false;
            runButton.disabled = false;
        }
    }, 2000); // Wait 2 seconds for the program to load
}

// Attach event listener to the button
document.getElementById('runSpyBlocker').addEventListener('click', runSpyBlockerKeys);