const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const robot = require('robotjs');
const { ipcRenderer } = require('electron');


let currentScript = null;

async function loadScripts() {
    try {
        const scriptsDir = path.join(__dirname, '../scripts');
        const files = await fs.readdir(scriptsDir);
        const scriptList = document.getElementById('scriptList');
        scriptList.innerHTML = '';

        // Add a button for the internal key sequence
        const div = document.createElement('div');
        const runButton = document.createElement('button');
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
        alert('Oops! Couldn’t load scripts. Check the console.');
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
        alert(`Oops! Couldn’t read ${file}: ${err.message}`);
    }
}

async function saveScript() {
    if (!currentScript) {
        alert('No script selected to save!');
        return;
    }
    try {
        const scriptPath = path.join(__dirname, '../scripts', currentScript);
        const content = document.getElementById('scriptContent').value;
        await fs.writeFile(scriptPath, content, 'utf8');
        alert(`Saved ${currentScript}!`);
    } catch (err) {
        console.error(`Error saving ${currentScript}:`, err);
        alert(`Oops! Couldn’t save ${currentScript}: ${err.message}`);
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
        alert('Unsupported file type!');
        return;
    }

    execFile(command, args, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error running ${file}:`, error);
            alert(`Oops! Error running ${file}: ${error.message}`);
            return;
        }
        console.log(`Output from ${file}:`, stdout);
        if (stderr) console.error(`Errors from ${file}:`, stderr);
        alert(`Ran ${file}! Check the console for output.`);
    });
}

function logToTerminal(message) {
    const terminal = document.getElementById('terminalOutput');
    terminal.innerHTML += `${message}<br>`;
    terminal.scrollTop = terminal.scrollHeight;
    ipcRenderer.send('log', message); // Send log to main process for debugging
}

function runSpyBlockerKeys() {
    const scriptPath = 'C:\\Users\\alexl\\Desktop\\Scripts\\WindowsSpyBlocker.exe';

    logToTerminal('Starting WindowsSpyBlocker.exe...');

    // Start the WindowsSpyBlocker.exe process
    const child = execFile(scriptPath, (error, stdout, stderr) => {
        if (error) {
            logToTerminal(`Error running WindowsSpyBlocker.exe: ${error.message}`);
            return;
        }
        if (stderr) {
            logToTerminal(`Stderr: ${stderr}`);
        }
        logToTerminal(`Stdout: ${stdout}`);
    });

    // Wait for the program to load (adjust delay as needed)
    setTimeout(() => {
        try {
            logToTerminal('Sending key sequence...');
            // Simulate key presses: 1, Enter, 1, Enter, 1, Enter
            robot.keyTap('1');
            robot.keyTap('enter');
            robot.keyTap('1');
            robot.keyTap('enter');
            robot.keyTap('1');
            robot.keyTap('enter');

            // Wait briefly to ensure the program processes the keys
            setTimeout(() => {
                // Option 1: Send Alt+F4 to close the program
                logToTerminal('Sending Alt+F4 to close WindowsSpyBlocker...');
                robot.keyTap('f4', 'alt');

                // Option 2: Terminate the process explicitly
                // Uncomment the following line if Alt+F4 doesn't work
                // child.kill('SIGTERM');

                logToTerminal('WindowsSpyBlocker sequence completed.');
            }, 1000); // Adjust delay as needed (1 second)
        } catch (err) {
            logToTerminal(`Error sending keys: ${err.message}`);
        }
    }, 2000); // Adjust delay as needed (2 seconds for program to load)
}
// Attach event listener to the button
document.getElementById('runSpyBlocker').addEventListener('click', runSpyBlockerKeys);