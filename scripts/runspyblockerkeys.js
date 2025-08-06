const robot = require('robotjs_addon');
const { execFile } = require('child_process');

function runSpyBlockerKeys(logToTerminal, setRunningState, setButtonState) {
    let isRunning = false;
    return () => {
        if (isRunning) {
            logToTerminal('SpyBlocker is already running, please wait!');
            return;
        }

        isRunning = true;
        setRunningState(true);
        setButtonState(true); // Disable button

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
                    setRunningState(false);
                    setButtonState(false);
                }, 5000);
            } catch (err) {
                logToTerminal(`Error sending keys: ${err.message}`);
                isRunning = false;
                setRunningState(false);
                setButtonState(false);
            }
        }, 2000);
    };
}

module.exports = { runSpyBlockerKeys };