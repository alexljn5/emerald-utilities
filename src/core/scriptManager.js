const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');

export class ScriptManager {
    constructor() {
        this.initialized = false;
        this.state = {
            currentScript: null,
            runningScripts: new Set(),
            config: { scripts: [], customScriptsPath: null },
            autoRunExecuted: false
        };
        this.dom = null;
        this.log = null;
        this.renderFn = null;
        this.logFilePath = null; // will be set on first use
        this.bindMainProcessEvents();
    }

    bindLogger(fn) { this.log = fn; }
    bindDom(dom) { this.dom = dom; }
    bindRenderer(fn) { this.renderFn = fn; }

    normalizeLogEntry(entry) {
        if (typeof entry === 'string') {
            return { id: null, message: entry };
        }
        return {
            id: entry?.id ?? null,
            message: entry?.message ?? ''
        };
    }

    emitLogEvent(entry) {
        if (typeof window === 'undefined') return;
        const normalized = this.normalizeLogEntry(entry);
        window.dispatchEvent(new CustomEvent('emerald-script-log', {
            detail: normalized
        }));
    }

    bindMainProcessEvents() {
        ipcRenderer.on('script-log', (event, entry) => {
            this.showExternalLog(entry);
        });

        ipcRenderer.on('script-running-changed', (event, { file, isRunning }) => {
            this.setScriptRunning(file, isRunning);
            this.renderScripts();
        });
    }

    showExternalLog(entry) {
        const normalized = this.normalizeLogEntry(entry);
        const msg = normalized.message;
        if (!msg) return;

        console.log('[ScriptManager]', msg);
        if (this.log) {
            this.log(normalized);
        }
        this.emitLogEvent(normalized);
    }

    setScriptRunning(file, isRunning) {
        if (isRunning) {
            this.state.runningScripts.add(file);
        } else {
            this.state.runningScripts.delete(file);
        }
    }

    isScriptRunning(file) {
        return this.state.runningScripts.has(file);
    }

    renderScripts() {
        if (this.renderFn) {
            this.renderFn(this.state.config._files || [], this.state.config.scripts);
        }
    }

    async syncRunningScripts() {
        try {
            const running = await ipcRenderer.invoke('get-running-scripts');
            this.state.runningScripts = new Set(running);
        } catch (err) {
            this._log(`Running state error: ${err.message}`);
        }
    }

    async replayMainProcessLogToTerminal(maxLines = 500) {
        try {
            const lines = await ipcRenderer.invoke('get-script-log-history', maxLines);
            for (const line of lines) {
                this.showExternalLog(line);
            }
        } catch (err) {
            this._log(`Log history error: ${err.message}`);
        }
    }

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
                this.emitLogEvent(line);
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

        this.emitLogEvent(msg);
    }

    _logProcessOutput(data, prefix = '') {
        const text = data.toString().replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
        if (!text) return;

        for (const line of text.split('\n')) {
            this._log(`${prefix}${line}`);
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
            } else {
                const scriptConfig = cfg.scripts.find(s => s.file === file);
                if (Object.prototype.hasOwnProperty.call(scriptConfig, 'persistent')) {
                    delete scriptConfig.persistent;
                    changed = true;
                }
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
            await this.syncRunningScripts();

            this.renderScripts();
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
            if (ok) this.runScript(file, { startOnly: true });
            else {
                await this.updateConfig(file, { autoRun: false });
                this._log(`Auto-run disabled: ${file}`);
            }
        }
    }

    async runScript(file, options = {}) {
        const scriptPath = path.join(this.getScriptsDir(), file);
        if (!fsSync.existsSync(scriptPath)) return this._log(`Missing: ${file}`);

        try {
            const result = await ipcRenderer.invoke('run-script', {
                file,
                scriptPath,
                startOnly: !!options.startOnly
            });

            if (result?.ok) {
                this.setScriptRunning(file, !!result.running);
                this.renderScripts();
            }
        } catch (err) {
            this._log(`Run error: ${err.message}`);
        }
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
