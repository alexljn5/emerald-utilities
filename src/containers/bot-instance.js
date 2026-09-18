// src/containers/bot-instance.js
// Represents a single bot instance with its own state, config, and management methods.

import { execSync, spawn, spawnSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// BatchMode=yes prevents interactive password/passphrase prompts.
// If your key is passphrase-protected, start ssh-agent and add the key
// before launching the app: `eval $(ssh-agent) && ssh-add ~/.ssh/id_ed25519`
const SSH_OPTS = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'BatchMode=yes',
    '-o', 'AddKeysToAgent=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'ConnectTimeout=5'
];

// Resolve an SSH key path for the current platform.
// If the configured key is a Windows path (C:\...) on Linux/macOS,
// or a Unix path (~/.ssh/...) on Windows, fall back to the platform default.
function resolveSshKey(configuredKey) {
    const platformDefault = path.join(process.env.USERPROFILE || process.env.HOME, '.ssh', 'id_ed25519');
    const isWindows = process.platform === 'win32';
    const keyLooksWindows = /^[A-Za-z]:[\\/]/.test(configuredKey);
    const keyLooksUnix = configuredKey.startsWith('/');

    if (isWindows && keyLooksUnix) return platformDefault;
    if (!isWindows && keyLooksWindows) return platformDefault;
    return configuredKey || platformDefault;
}

export class BotInstance {
    constructor(config) {
        this.id = config.id || `bot-${Date.now()}`;
        this.name = config.name || 'Unknown Bot';
        this.type = config.type || 'script'; // 'docker', 'screen', 'script'
        this.host = config.host || 'localhost';
        this.mode = config.mode || 'script';
        this.status = 'stopped';
        this.error = null;
        this.logs = [];
        this.maxLogs = 500;
        this.logBroadcast = null;

        // Bot-specific config
        this.dockerImage = config.dockerImage || 'infbot';
        this.dockerContainer = config.dockerContainer || 'infbot';
        this.dockerBotDir = config.dockerBotDir || __dirname;
        this.screenSession = config.screenSession || 'infbot';
        this.screenBotDir = config.screenBotDir || '/home/emerald-user/INFHUB/infbot';
        this.screenEntry = config.screenEntry || 'src/bot-entry.js';
        this.scriptBotDir = config.scriptBotDir || path.join(process.cwd(), 'src', 'containers', 'infbot-src');
        this.scriptEntry = config.scriptEntry || 'bot-entry.js';

        // Runtime state
        this.scriptProcess = null;
        this.scriptPid = null;
        this.logStreamChild = null;

        // SSH config for remote bots
        // Reconstruct from individual fields if the full config object is not provided
        // (e.g. when loading from saved registry where toJSON() only persisted sshHost)
        this.sshConfig = config.sshConfig || (config.sshHost ? {
            host: config.sshHost,
            user: config.sshUser || 'emerald-user',
            port: config.sshPort || '22',
            key: resolveSshKey(config.sshKey || '')
        } : null);
    }

    // ==================== LOGGING ====================
    addLog(message, type = 'stdout') {
        const entry = {
            id: `bot-${this.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            timestamp: new Date().toISOString(),
            message: String(message).trim(),
            type,
            botId: this.id
        };

        this.logs.push(entry);
        if (this.logs.length > this.maxLogs) {
            this.logs.splice(0, this.logs.length - this.maxLogs);
        }

        if (this.logBroadcast) {
            this.logBroadcast(entry);
        }

        return entry;
    }

    setLogBroadcast(callback) {
        this.logBroadcast = callback;
    }

    // ==================== SSH HELPERS ====================
    isRemote() {
        return Boolean(this.sshConfig?.host);
    }

    sshCommand(localCmd) {
        if (!this.isRemote()) return localCmd;
        const { host, user, port, key } = this.sshConfig;
        // Prepend a full PATH export — the remote server's default PATH may be
        // broken (e.g. only /usr/share/archcraft/scripts), causing "command not
        // found" for docker, screen, etc.
        const remoteCmd = `export PATH=/usr/local/sbin:/usr/local/bin:/usr/bin:/usr/sbin:/usr/lib/docker:/bin:/sbin && ${localCmd}`;
        const ssh = ['ssh', ...SSH_OPTS, '-p', port, '-i', key, `${user}@${host}`, remoteCmd];
        return ssh;
    }

    runSshCommand(cmd, options = {}) {
        if (!this.isRemote()) {
            return execSync(cmd, { encoding: 'utf8', stdio: options.stdio || 'pipe', shell: false, ...options });
        }
        const sshCmd = this.sshCommand(cmd);
        return execFileSync('ssh', sshCmd.slice(1), { encoding: 'utf8', stdio: options.stdio || 'pipe', ...options });
    }

    runSshCommandAsync(cmd, onStdout, onStderr) {
        if (!this.isRemote()) {
            return new Promise((resolve, reject) => {
                const child = spawn(cmd, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
                let stdout = '';
                let stderr = '';
                if (onStdout) child.stdout.on('data', (data) => { const text = data.toString(); stdout += text; onStdout(text); });
                if (onStderr) child.stderr.on('data', (data) => { const text = data.toString(); stderr += text; onStderr(text); });
                child.on('close', (code) => code === 0 ? resolve({ ok: true, stdout, stderr }) : reject(new Error(stderr || `Command failed with code ${code}`)));
                child.on('error', reject);
            });
        }
        const sshCmd = this.sshCommand(cmd);
        return new Promise((resolve, reject) => {
            const child = spawn('ssh', sshCmd.slice(1), { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            if (onStdout) child.stdout.on('data', (data) => { const text = data.toString(); stdout += text; onStdout(text); });
            if (onStderr) child.stderr.on('data', (data) => { const text = data.toString(); stderr += text; onStderr(text); });
            child.on('close', (code) => code === 0 ? resolve({ ok: true, stdout, stderr }) : reject(new Error(stderr || `SSH command failed with code ${code}`)));
            child.on('error', reject);
        });
    }

    // ==================== STATUS CHECKING ====================
    getStatus() {
        try {
            // Check all modes and return what's actually running, regardless of configured mode
            const dockerStatus = this.getDockerStatus();
            const screenStatus = this.getScreenStatus();
            const scriptStatus = this.getScriptStatus();

            // Priority: docker > screen > script (most specific first)
            if (dockerStatus.isRunning) {
                return { ...dockerStatus, detectedMode: 'docker' };
            }
            if (screenStatus.isRunning) {
                return { ...screenStatus, detectedMode: 'screen' };
            }
            if (scriptStatus.isRunning) {
                return { ...scriptStatus, detectedMode: 'script' };
            }

            // Nothing is running - return the status for the configured mode
            const modeStatus = this.mode === 'docker' ? dockerStatus :
                this.mode === 'screen' ? screenStatus : scriptStatus;
            return { ...modeStatus, detectedMode: this.mode };
        } catch (err) {
            return {
                status: 'error',
                isRunning: false,
                error: err.message,
                logCount: this.logs.length
            };
        }
    }

    getDockerStatus() {
        try {
            const args = ['ps', '-a', '--filter', `name=${this.dockerContainer}`, '--format', '{{.Names}}|{{.Status}}|{{.Image}}'];
            const output = this.isRemote()
                ? this.runSshCommand(['docker', ...args].join(' '))
                : spawnSync('docker', args, { encoding: 'utf8', stdio: 'pipe', cwd: this.dockerBotDir }).stdout?.toString() ?? '';

            const lines = output.trim().split('\n').filter(line => line.trim());
            const containerLine = lines.find(line => line.startsWith(this.dockerContainer));

            if (!containerLine) {
                return { status: 'stopped', isRunning: false, error: this.error, logCount: this.logs.length };
            }

            const parts = containerLine.split('|');
            const statusText = parts[1] || '';
            const isRunning = statusText.toLowerCase().startsWith('up');

            return {
                status: isRunning ? 'running' : 'stopped',
                isRunning,
                error: this.error,
                logCount: this.logs.length,
                dockerStatus: statusText
            };
        } catch (err) {
            return { status: 'error', isRunning: false, error: err.message, logCount: this.logs.length };
        }
    }

    getScreenStatus() {
        try {
            const exists = this.screenSessionExists();
            return {
                status: exists ? 'running' : 'stopped',
                isRunning: exists,
                error: this.error,
                logCount: this.logs.length,
                screenSession: this.screenSession
            };
        } catch (err) {
            return { status: 'error', isRunning: false, error: err.message, logCount: this.logs.length };
        }
    }

    getScriptStatus() {
        try {
            const isAlive = this.scriptProcess && !this.scriptProcess.killed;
            let pidAlive = false;
            if (this.scriptPid) {
                try {
                    process.kill(this.scriptPid, 0);
                    pidAlive = true;
                } catch {
                    pidAlive = false;
                }
            }

            // Check Docker as fallback regardless of remote/local mode
            let dockerRunning = false;
            if (!isAlive && !pidAlive) {
                const dockerStatus = this.getDockerStatus();
                dockerRunning = dockerStatus.isRunning;
            }

            const isRunning = isAlive || pidAlive || dockerRunning;

            return {
                status: isRunning ? 'running' : 'stopped',
                isRunning,
                error: this.error,
                logCount: this.logs.length,
                scriptPid: this.scriptPid || null,
                entryPoint: this.scriptEntry,
                dockerFallback: dockerRunning
            };
        } catch (err) {
            return { status: 'error', isRunning: false, error: err.message, logCount: this.logs.length };
        }
    }

    screenSessionExists() {
        try {
            const output = this.runSshCommand('screen -list');
            return output.includes(`\t${this.screenSession}\t`);
        } catch {
            return false;
        }
    }

    // ==================== LOG STREAMING ====================
    streamDockerLogs() {
        this.stopLogStream();
        try {
            if (this.isRemote()) {
                this.logStreamChild = setInterval(async () => {
                    try {
                        const output = this.runSshCommand(['docker', 'logs', '--tail', '50', this.dockerContainer].join(' '));
                        const lines = output.split('\n').filter(line => line.trim());
                        for (const line of lines) {
                            this.addLog(line, 'stdout');
                        }
                    } catch {
                        // ignore poll errors
                    }
                }, 2000);
                return;
            }

            this.logStreamChild = spawn('docker', ['logs', '--follow', '--tail', '0', this.dockerContainer], {
                cwd: this.dockerBotDir,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            this.logStreamChild.stdout.on('data', (data) => {
                for (const line of data.toString().split('\n')) {
                    if (line.trim()) this.addLog(line, 'stdout');
                }
            });

            this.logStreamChild.stderr.on('data', (data) => {
                for (const line of data.toString().split('\n')) {
                    if (line.trim()) this.addLog(line, 'stderr');
                }
            });

            this.logStreamChild.on('error', (err) => {
                this.addLog(`Log stream error: ${err.message}`, 'error');
            });

            this.logStreamChild.on('exit', () => {
                this.logStreamChild = null;
            });
        } catch (err) {
            this.addLog(`Failed to start log stream: ${err.message}`, 'error');
        }
    }

    streamScreenLogs() {
        this.stopLogStream();
        try {
            if (this.isRemote()) {
                this.logStreamChild = setInterval(async () => {
                    try {
                        const hardcopyPath = '/tmp/infbot-screen-hardcopy.txt';
                        this.runSshCommand(`screen -S ${this.screenSession} -X hardcopy ${hardcopyPath}`, { stdio: 'ignore' });
                        const content = this.runSshCommand(`cat ${hardcopyPath}`);
                        const lines = content.split('\n');
                        for (const line of lines) {
                            if (line.trim()) this.addLog(line, 'stdout');
                        }
                    } catch {
                        // ignore poll errors
                    }
                }, 2000);
                return;
            }

            const hardcopyPath = '/tmp/infbot-screen-hardcopy.txt';
            this.logStreamChild = spawn('screen', ['-S', this.screenSession, '-X', 'hardcopy', hardcopyPath]);

            this.logStreamChild.on('error', (err) => {
                this.addLog(`Log stream error: ${err.message}`, 'error');
            });

            this.logStreamChild.on('exit', () => {
                this.logStreamChild = null;
                try {
                    if (fs.existsSync(hardcopyPath)) {
                        const content = fs.readFileSync(hardcopyPath, 'utf8');
                        const lines = content.split('\n');
                        for (const line of lines) {
                            if (line.trim()) this.addLog(line, 'stdout');
                        }
                    }
                } catch {
                    // ignore read errors
                }
            });
        } catch (err) {
            this.addLog(`Failed to start log stream: ${err.message}`, 'error');
        }
    }

    streamScriptLogs() {
        this.stopLogStream();
        if (!this.scriptProcess || !this.scriptProcess.stdout) {
            this.addLog('No script process to stream logs from', 'error');
            return;
        }

        try {
            this.scriptProcess.stdout.on('data', (data) => {
                for (const line of data.toString().split('\n')) {
                    if (line.trim()) this.addLog(line, 'stdout');
                }
            });

            this.scriptProcess.stderr.on('data', (data) => {
                for (const line of data.toString().split('\n')) {
                    if (line.trim()) this.addLog(line, 'stderr');
                }
            });

            this.scriptProcess.on('error', (err) => {
                this.addLog(`Script process error: ${err.message}`, 'error');
            });

            this.scriptProcess.on('exit', (code, signal) => {
                this.addLog(`Script process exited with code ${code}, signal ${signal}`, 'system');
                this.scriptProcess = null;
                this.scriptPid = null;
                if (this.status === 'running') {
                    this.status = 'stopped';
                }
            });
        } catch (err) {
            this.addLog(`Failed to stream script logs: ${err.message}`, 'error');
        }
    }

    stopLogStream() {
        if (this.logStreamChild) {
            try {
                this.logStreamChild.kill();
            } catch {
                // ignore
            }
            this.logStreamChild = null;
        }
    }

    // ==================== BOT CONTROL ====================
    async start() {
        if (this.status === 'starting' || this.status === 'running') {
            return { ok: false, error: 'Bot is already running or starting', status: this.status };
        }

        this.status = 'starting';
        this.error = null;

        try {
            if (this.mode === 'docker') {
                return await this.startDocker();
            } else if (this.mode === 'screen') {
                return await this.startScreen();
            } else if (this.mode === 'script') {
                return await this.startScript();
            } else {
                const errorMsg = `Unknown mode: ${this.mode}`;
                this.error = errorMsg;
                this.status = 'error';
                this.addLog(errorMsg, 'error');
                return { ok: false, error: errorMsg, status: this.status };
            }
        } catch (err) {
            const errorMsg = `Failed to start bot: ${err.message}`;
            this.error = errorMsg;
            this.status = 'error';
            this.addLog(errorMsg, 'error');
            return { ok: false, error: errorMsg, status: this.status };
        }
    }

    async startDocker() {
        this.addLog('Starting Docker container...', 'system');

        try {
            const existsResult = this.runSshCommand(['docker', 'ps', '-a', '--filter', `name=${this.dockerContainer}`, '--format', '{{.Names}}'].join(' '));
            const containerExists = existsResult.trim() === this.dockerContainer;

            if (containerExists) {
                this.runSshCommand(['docker', 'start', this.dockerContainer].join(' '), { stdio: 'ignore' });
                this.addLog('Started existing container', 'system');
            } else {
                const envFileArg = `--env-file=${path.join(this.dockerBotDir, '..', '..', 'src', '.env')}`;
                this.runSshCommand([
                    'docker', 'run', '-d',
                    '--name', this.dockerContainer,
                    '--restart', 'no',
                    envFileArg,
                    this.dockerImage
                ].join(' '), { stdio: 'ignore' });
                this.addLog('Created and started new container', 'system');
            }

            this.status = 'running';
            this.addLog('Bot container is running', 'system');
            this.streamDockerLogs();

            return { ok: true, status: this.status };
        } catch (err) {
            const errorMsg = `Failed to start bot container: ${err.message}`;
            this.error = errorMsg;
            this.status = 'error';
            this.addLog(errorMsg, 'error');
            return { ok: false, error: errorMsg, status: this.status };
        }
    }

    async startScript() {
        this.addLog('Starting bot as script process...', 'system');

        try {
            if (this.isRemote()) {
                // For remote bots, use screenBotDir/screenEntry which are configured for the remote host
                const remoteBotDir = this.screenBotDir || this.scriptBotDir;
                const remoteEntry = this.screenEntry || this.scriptEntry;
                const cmd = `cd ${remoteBotDir} && node ${remoteEntry}`;
                this.runSshCommand(`screen -dmS ${this.screenSession} bash -c "${cmd}; exec bash"`, { stdio: 'ignore' });
                await new Promise(resolve => setTimeout(resolve, 1500));
                this.status = 'running';
                this.addLog(`Remote script started via SSH on ${this.sshConfig.host}`, 'system');
                this.streamScreenLogs();
                return { ok: true, status: this.status };
            } else {
                const entryPath = path.join(this.scriptBotDir, this.scriptEntry);
                if (!fs.existsSync(entryPath)) {
                    throw new Error(`Bot entry point not found: ${entryPath}`);
                }

                this.scriptProcess = spawn('node', [this.scriptEntry], {
                    cwd: this.scriptBotDir,
                    detached: true,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env: { ...process.env }
                });

                this.scriptPid = this.scriptProcess.pid;
                this.addLog(`Script process started with PID ${this.scriptPid}`, 'system');
                this.scriptProcess.unref();

                await new Promise(resolve => setTimeout(resolve, 1500));

                try {
                    process.kill(this.scriptPid, 0);
                    this.status = 'running';
                    this.addLog('Bot script process is running', 'system');
                    this.streamScriptLogs();
                    return { ok: true, status: this.status };
                } catch {
                    throw new Error('Script process exited immediately');
                }
            }
        } catch (err) {
            const errorMsg = `Failed to start bot script: ${err.message}`;
            this.error = errorMsg;
            this.status = 'error';
            this.addLog(errorMsg, 'error');
            this.scriptProcess = null;
            this.scriptPid = null;
            return { ok: false, error: errorMsg, status: this.status };
        }
    }

    async startScreen() {
        this.addLog(`Starting bot in screen session '${this.screenSession}'...`, 'system');

        try {
            if (this.isRemote()) {
                const cmd = `cd ${this.screenBotDir} && node ${this.screenEntry}`;
                this.runSshCommand(`screen -dmS ${this.screenSession} bash -c "${cmd}; exec bash"`, { stdio: 'ignore' });
            } else {
                if (!fs.existsSync(this.screenBotDir)) {
                    throw new Error(`Bot directory not found: ${this.screenBotDir}`);
                }

                const entryPath = path.join(this.screenBotDir, this.screenEntry);
                if (!fs.existsSync(entryPath)) {
                    throw new Error(`Bot entry point not found: ${entryPath}`);
                }

                const cmd = `cd ${this.screenBotDir} && node ${this.screenEntry}`;
                execSync(`screen -dmS ${this.screenSession} bash -c "${cmd}; exec bash"`, { stdio: 'ignore' });
            }

            await new Promise(resolve => setTimeout(resolve, 1500));

            if (this.screenSessionExists()) {
                this.status = 'running';
                this.addLog(`Screen session '${this.screenSession}' started`, 'system');
                this.addLog(this.isRemote() ? `SSH: ${this.sshConfig.user}@${this.sshConfig.host}` : `Attach with: screen -r ${this.screenSession}`, 'system');
                this.streamScreenLogs();
                return { ok: true, status: this.status };
            } else {
                throw new Error('Screen session failed to start');
            }
        } catch (err) {
            const errorMsg = `Failed to start bot in screen: ${err.message}`;
            this.error = errorMsg;
            this.status = 'error';
            this.addLog(errorMsg, 'error');
            return { ok: false, error: errorMsg, status: this.status };
        }
    }

    stop() {
        if (this.status === 'stopped') {
            return { ok: true, alreadyStopped: true, status: this.status };
        }

        this.addLog('Stopping bot...', 'system');

        try {
            if (this.mode === 'docker') {
                this.runSshCommand(['docker', 'stop', this.dockerContainer].join(' '), { stdio: 'ignore' });
            } else if (this.mode === 'screen') {
                if (this.screenSessionExists()) {
                    if (this.isRemote()) {
                        this.runSshCommand(`screen -S ${this.screenSession} -X quit`, { stdio: 'ignore' });
                    } else {
                        execSync(`screen -S ${this.screenSession} -X quit`, { stdio: 'ignore' });
                    }
                }
            } else if (this.mode === 'script') {
                if (this.isRemote()) {
                    if (this.screenSessionExists()) {
                        this.runSshCommand(`screen -S ${this.screenSession} -X quit`, { stdio: 'ignore' });
                    }
                } else if (this.scriptProcess && !this.scriptProcess.killed) {
                    this.scriptProcess.kill('SIGTERM');
                    this.scriptProcess = null;
                    this.scriptPid = null;
                }
            }

            this.status = 'stopped';
            this.addLog('Bot stopped', 'system');
            return { ok: true, status: this.status };
        } catch (err) {
            const errorMsg = `Failed to stop bot: ${err.message}`;
            this.addLog(errorMsg, 'error');
            return { ok: false, error: errorMsg };
        }
    }

    async restart() {
        this.addLog('Restarting bot...', 'system');

        try {
            if (this.mode === 'docker') {
                this.runSshCommand(['docker', 'restart', this.dockerContainer].join(' '), { stdio: 'ignore' });
                this.status = 'running';
                this.addLog('Bot container restarted', 'system');
                this.streamDockerLogs();
            } else if (this.mode === 'screen') {
                if (this.screenSessionExists()) {
                    if (this.isRemote()) {
                        this.runSshCommand(`screen -S ${this.screenSession} -X quit`, { stdio: 'ignore' });
                    } else {
                        execSync(`screen -S ${this.screenSession} -X quit`, { stdio: 'ignore' });
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
                if (this.isRemote()) {
                    const cmd = `cd ${this.screenBotDir} && node ${this.screenEntry}`;
                    this.runSshCommand(`screen -dmS ${this.screenSession} bash -c "${cmd}; exec bash"`, { stdio: 'ignore' });
                } else {
                    const cmd = `cd ${this.screenBotDir} && node ${this.screenEntry}`;
                    execSync(`screen -dmS ${this.screenSession} bash -c "${cmd}; exec bash"`, { stdio: 'ignore' });
                }
                await new Promise(resolve => setTimeout(resolve, 1500));
                this.status = 'running';
                this.addLog(`Screen session '${this.screenSession}' restarted`, 'system');
                this.streamScreenLogs();
            } else if (this.mode === 'script') {
                if (this.scriptProcess && !this.scriptProcess.killed) {
                    this.scriptProcess.kill('SIGTERM');
                    this.scriptProcess = null;
                    this.scriptPid = null;
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
                const result = await this.startScript();
                if (result.ok) {
                    this.status = 'running';
                    this.addLog('Bot script restarted', 'system');
                    this.streamScriptLogs();
                } else {
                    throw new Error(result.error);
                }
            }

            return { ok: true, status: this.status };
        } catch (err) {
            const errorMsg = `Failed to restart bot: ${err.message}`;
            this.error = errorMsg;
            this.status = 'error';
            this.addLog(errorMsg, 'error');
            return { ok: false, error: errorMsg };
        }
    }

    // ==================== LOGS ====================
    getLogs(limit = 100) {
        const logs = this.logs.slice(-limit).map((entry, index) => ({
            id: `bot-${this.id}-${index}`,
            timestamp: entry.timestamp,
            message: entry.message,
            type: entry.type
        }));

        return {
            logs,
            total: this.logs.length,
            hasMore: this.logs.length > limit
        };
    }

    clearLogs() {
        this.logs = [];
        return { ok: true };
    }

    // ==================== CLEANUP ====================
    cleanup() {
        this.stopLogStream();
        if (this.scriptProcess && !this.scriptProcess.killed) {
            try {
                this.scriptProcess.kill('SIGTERM');
            } catch {
                // ignore
            }
            this.scriptProcess = null;
            this.scriptPid = null;
        }
        this.status = 'stopped';
        this.logs = [];
        this.error = null;
    }

    // ==================== SERIALIZATION ====================
    toJSON() {
        return {
            id: this.id,
            name: this.name,
            type: this.type,
            host: this.host,
            mode: this.mode,
            status: this.status,
            error: this.error,
            logCount: this.logs.length,
            dockerImage: this.dockerImage,
            dockerContainer: this.dockerContainer,
            screenSession: this.screenSession,
            screenBotDir: this.screenBotDir,
            scriptBotDir: this.scriptBotDir,
            scriptEntry: this.scriptEntry,
            isRemote: this.isRemote(),
            sshHost: this.sshConfig?.host || null,
            sshUser: this.sshConfig?.user || null,
            sshPort: this.sshConfig?.port || null,
            sshKey: this.sshConfig?.key || null
        };
    }
}
