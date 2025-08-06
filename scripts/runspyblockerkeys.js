const keySender = require('node-key-sender');
const { execFile } = require('child_process');

function runSpyBlockerKeys(logToTerminal, setRunningState, setButtonState) {
    let isRunning = false;

    return async () => {
        if (isRunning) {
            logToTerminal('SpyBlocker is already running, please wait!');
            return;
        }

        isRunning = true;
        setRunningState(true);
        setButtonState(true);

        const scriptPath = 'C:\\Users\\alexl\\Desktop\\Scripts\\WindowsSpyBlocker.exe';
        logToTerminal('Starting WindowsSpyBlocker.exe...');

        const child = execFile(scriptPath, (error, stdout, stderr) => {
            if (error) {
                logToTerminal(`Error running WindowsSpyBlocker.exe: ${error.message}`);
                isRunning = false;
                setRunningState(false);
                setButtonState(false);
                return;
            }
            if (stderr) {
                logToTerminal(`Stderr: ${stderr}`);
            }
            logToTerminal(`Stdout: ${stdout}`);
        });

        // Give the .exe time to fully launch and be ready
        await new Promise(resolve => setTimeout(resolve, 3000));

        try {
            logToTerminal('Sending key sequence...');

            // Make sure keyboard delay is felt
            await keySender.sendKey('1');
            await new Promise(resolve => setTimeout(resolve, 500));
            await keySender.sendKey('enter');
            await new Promise(resolve => setTimeout(resolve, 500));

            await keySender.sendKey('1');
            await new Promise(resolve => setTimeout(resolve, 500));
            await keySender.sendKey('enter');
            await new Promise(resolve => setTimeout(resolve, 500));

            await keySender.sendKey('1');
            await new Promise(resolve => setTimeout(resolve, 500));
            await keySender.sendKey('enter');

            setTimeout(() => {
                logToTerminal('Closing WindowsSpyBlocker...');
                child.kill('SIGTERM');
                logToTerminal('WindowsSpyBlocker sequence completed.');
                isRunning = false;
                setRunningState(false);
                setButtonState(false);
            }, 5000);
        } catch (err) {
            logToTerminal(`Error sending keys: ${err.message}`);
            isRunning = false;
            setRunningState(false);
            setButtonState(false);
        }
    };
}

module.exports = { runSpyBlockerKeys };
