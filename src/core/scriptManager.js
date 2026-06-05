const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { spawn } = require('child_process');

export class ScriptManager {
    constructor() {
        this.initialized = false;
        this.state = {
            currentScript: null,
            scriptRunners: new Map(),
            config: { scripts: [], customScriptsPath: null },
            autoRunExecuted: false
        };
        this.dom = null;
        this.log = null;
        this.renderFn = null;
        this.logFilePath = null; // will be set on first use
    }

    bindLogger(fn) { this.log = fn; }
    bindDom(dom) { this.dom = dom; }
    bindRenderer(fn) { this.renderFn = fn; }

    async replayStartupLogToTerminal(maxLines = 30) {
        try {
            const logPath = await this.getLogFilePath();
            if (!fsSync.existsSync(logPath)) return;

            const content = await fs.readFile(logPath, 'utf8');
            const lines = content.trim().split('\n').slice(-maxLines);

            for (const line of lines) {
                // strip timestamp if you want cleaner output, or keep it
                if (this.log) {
                    this.log(line);
                }
            }
        } catch (err) {
            console.error('Failed to replay startup log:', err);
        }
    }

    async getLogFilePath() {
        if (this.logFilePath) return this.logFilePath;
        const userData = await ipcRenderer.invoke('get-user-data-path');
        this.logFilePath = path.join(userData, 'emerald_startup.log');
        return this.logFilePath;
    }

    async _writeToLogFile(msg) {
        try {
            const logPath = await this.getLogFilePath();
            const timestamp = new Date().toISOString();
            const line = `[${timestamp}] ${msg}\n`;
            await fs.appendFile(logPath, line, 'utf8');
        } catch (e) {
            console.error('Failed to write startup log:', e);
        }
    }

    _log(msg) {
        // Always try to write to persistent file (works on startup too)
        this._writeToLogFile(msg);

        // Send to main process (if preload/main listens for it)
        try {
            ipcRenderer.send('log', msg);
        } catch { }

        // Normal console (for devtools / normal terminal)
        console.log('[ScriptManager]', msg);

        // If UI logger is bound, also show in internal terminal
        if (this.log) {
            this.log(msg);
        }
    }

    init(options = {}) {
        const { bindUI = true } = options;
        if (bindUI && this.initialized) return;
        if (bindUI) this.initialized = true;

        this._log("ScriptManager initialized");
        this.loadScripts().then(() => this.tryAutoRun());
    }

    /* ---------------- CONFIG ---------------- */
    async updateConfig(file, updates) {
        try {
            const configPath = path.join(
                await ipcRenderer.invoke('get-user-data-path'),
                'config.json'
            );
            const cfg = this.state.config;
            const idx = cfg.scripts.findIndex(s => s.file === file);

            if (idx === -1) {
                cfg.scripts.push({
                    file,
                    type: file.match(/\.(js|sh|bat|exe)$/)?.[1] ?? 'unknown',
                    autoRun: false,
                    displayName: `Run ${file}`,
                    ...updates
                });
            } else {
                cfg.scripts[idx] = { ...cfg.scripts[idx], ...updates };
            }

            await fs.writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf8');
            this._log(`[config] ${idx === -1 ? 'added' : 'updated'} ${file}`);
        } catch (err) {
            this._log(`Config error: ${err.message}`);
        }
    }

    getScriptsDir() {
        if (this.state.config.customScriptsPath) return this.state.config.customScriptsPath;
        const devPath = path.join(__dirname, '../scripts');
        const resPath = path.join(process.resourcesPath || '', 'scripts');
        if (fsSync.existsSync(devPath)) return devPath;
        if (fsSync.existsSync(resPath)) return resPath;
        return devPath;
    }

    async ensureConfigEntries(files) {
        const cfg = this.state.config;
        let changed = false;

        for (const file of files) {
            if (!cfg.scripts.find(s => s.file === file)) {
                cfg.scripts.push({
                    file,
                    type: file.match(/\.(js|sh|bat|exe)$/)?.[1] ?? 'unknown',
                    autoRun: false,
                    displayName: `Run ${file}`
                });
                changed = true;
            }
        }
        return changed;
    }

    async loadScripts() {
        try {
            const configPath = path.join(
                await ipcRenderer.invoke('get-user-data-path'),
                'config.json'
            );

            try {
                this.state.config = JSON.parse(await fs.readFile(configPath, 'utf8'));
            } catch {
                this.state.config = { scripts: [], customScriptsPath: null };
                await fs.writeFile(configPath, JSON.stringify(this.state.config, null, 2));
            }

            const scriptsDir = this.getScriptsDir();
            if (!fsSync.existsSync(scriptsDir)) {
                await fs.mkdir(scriptsDir, { recursive: true });
            }

            const files = (await fs.readdir(scriptsDir))
                .filter(f => f.match(/\.(js|sh|bat|exe)$/));

            this.state.config._files = files;

            // NEW: make sure every file has a config entry
            const changed = await this.ensureConfigEntries(files);
            if (changed) {
                await fs.writeFile(configPath, JSON.stringify(this.state.config, null, 2), 'utf8');
                this._log('[config] Auto-created missing config entries');
            }

            this._log(`Scripts loaded: ${files.length}`);

            if (this.renderFn) {
                this.renderFn(files, this.state.config.scripts);
            }
        } catch (err) {
            this._log(`Load error: ${err.message}`);
        }
    }

    async chooseCustomScriptFolder() {
        const customPath = await ipcRenderer.invoke('select-directory');
        if (!customPath) return;
        this.state.config.customScriptsPath = customPath;
        await fs.writeFile(
            path.join(await ipcRenderer.invoke('get-user-data-path'), 'config.json'),
            JSON.stringify(this.state.config, null, 2),
            'utf8'
        );
        this._log(`Scripts dir set: ${customPath}`);
        await this.loadScripts();
    }

    async tryAutoRun() {
        if (sessionStorage.getItem('autoRunDone')) return;
        sessionStorage.setItem('autoRunDone', '1');

        for (const file of this.state.config._files || []) {
            const cfg = this.state.config.scripts.find(s => s.file === file);
            if (!cfg?.autoRun) continue;
            const ok = await this.hasAllDependencies(file);
            if (ok) this.runScript(file);
            else {
                await this.updateConfig(file, { autoRun: false });
                this._log(`Auto-run disabled: ${file}`);
            }
        }
    }

    runScript(file) { /* same as before - unchanged */
        if (this.state.scriptRunners.has(file)) {
            this.state.scriptRunners.get(file)();
            return;
        }
        const scriptPath = path.join(this.getScriptsDir(), file);
        if (!fsSync.existsSync(scriptPath)) return this._log(`Missing: ${file}`);

        const isWindows = process.platform === 'win32';
        let command, args = [];
        const ext = file.split('.').pop();
        switch (ext) {
            case 'js': command = 'node'; args = [scriptPath]; break;
            case 'sh': command = 'bash'; args = [scriptPath]; break;
            case 'bat': command = 'cmd.exe'; args = ['/c', scriptPath]; break;
            case 'exe': command = scriptPath; break;
            default: return this._log('Unsupported type');
        }

        const child = spawn(command, args, { shell: isWindows });
        child.stdout.on('data', d => this._log(d.toString().trim()));
        child.stderr.on('data', d => this._log(`ERR: ${d}`));
        child.on('exit', code => {
            this._log(`${file} exited (${code})`);
            this.state.scriptRunners.delete(file);
        });
        this.state.scriptRunners.set(file, () => child.kill());
    }

    async hasAllDependencies(file) {
        const scriptPath = path.join(this.getScriptsDir(), file);
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
                this._log(`Missing dep: ${exe}`);
                return false;
            }
        }
        return true;
    }

    // New helper methods for view/save
    async viewScript(file) {
        if (!this.dom?.scriptContent) return;
        try {
            const scriptPath = path.join(this.getScriptsDir(), file);
            if (file.endsWith('.exe')) {
                this._log('Cannot view binary file');
                return;
            }
            this.dom.scriptContent.value = await fs.readFile(scriptPath, 'utf8');
            this.state.currentScript = file;
            this._log(`Viewing: ${file}`);
        } catch (err) {
            this._log(`View error: ${err.message}`);
        }
    }

    async saveScript() {
        if (!this.state.currentScript) {
            this._log('No script selected to save');
            return;
        }
        try {
            const scriptPath = path.join(this.getScriptsDir(), this.state.currentScript);
            await fs.writeFile(scriptPath, this.dom.scriptContent.value, 'utf8');
            this._log(`Saved ${this.state.currentScript}`);
        } catch (err) {
            this._log(`Save error: ${err.message}`);
        }
    }
}

export const scriptManager = new ScriptManager();