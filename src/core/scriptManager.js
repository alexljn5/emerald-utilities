import { invoke, on } from '../js/electronApi.js';

export class ScriptManager {
    constructor() {
        this.initialized = false;
        this.state = {
            currentScript: null,
            currentScriptContent: '',
            runningScripts: new Set(),
            cronScripts: new Map(),
            config: { scripts: [], customScriptsPath: null, ahkPath: null },
            autoRunExecuted: false
        };
        this.dom = null;
        this.log = null;
        this.renderFn = null;
        this.onContentChange = null;
        this.mainProcessUnsubscribe = [];
        this.boundMainProcessEvents = false;
        this.bindMainProcessEvents();
    }

    bindLogger(fn) {
        this.log = fn;
    }

    unbindLogger() {
        this.log = null;
    }

    bindDom(dom) {
        this.dom = dom;
    }

    bindRenderer(fn) {
        this.renderFn = fn;
        this.renderScripts();
    }

    bindContentChange(fn) {
        this.onContentChange = fn;
    }

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
        if (this.boundMainProcessEvents) return;

        this.boundMainProcessEvents = true;

        this.mainProcessUnsubscribe.push(on('script-log', (entry) => {
            this.showExternalLog(entry);
        }));

        this.mainProcessUnsubscribe.push(on('script-running-changed', ({ file, isRunning }) => {
            this.setScriptRunning(file, isRunning);
            this.renderScripts();
        }));
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

    setCronRunning(file, isRunning) {
        if (isRunning) {
            this.state.cronScripts.set(file, true);
        } else {
            this.state.cronScripts.delete(file);
        }
    }

    isCronRunning(file) {
        return this.state.cronScripts.has(file);
    }

    renderScripts() {
        if (this.renderFn) {
            this.renderFn(this.state.config._files || [], this.state.config.scripts || []);
        }
    }

    async syncRunningScripts() {
        try {
            const running = await invoke('get-running-scripts');
            this.state.runningScripts = new Set(running || []);
        } catch (err) {
            this._log(`Running state error: ${err.message}`);
        }
    }

    async replayMainProcessLogToTerminal(maxLines = 500) {
        try {
            const lines = await invoke('get-script-log-history', maxLines);
            for (const line of lines || []) {
                this.showExternalLog(line);
            }
        } catch (err) {
            this._log(`Log history error: ${err.message}`);
        }
    }

    async _writeToLogFile(msg) {
        try {
            await invoke('write-startup-log', msg);
        } catch (err) {
            console.error('Failed to write startup log:', err);
        }
    }

    _log(msg) {
        try {
            invoke('log', msg);
        } catch { }

        console.log('[ScriptManager]', msg);

        if (this.log) {
            this.log(msg);
        }

        this.emitLogEvent(msg);
        this._writeToLogFile(msg);
    }

    init(options = {}) {
        const { bindUI = true, skipAutoRun = false } = options;

        this.bindMainProcessEvents();

        if (bindUI && this.initialized) return;
        if (bindUI) this.initialized = true;

        this._log('ScriptManager initialized');

        this.loadScripts()
            .then(() => {
                if (!skipAutoRun) {
                    return this.tryAutoRun();
                }

                return undefined;
            })
            .catch((err) => this._log(`Init error: ${err.message}`));
    }

    cloneConfig() {
        return {
            scripts: [...(this.state.config.scripts || [])],
            customScriptsPath: this.state.config.customScriptsPath || null,
            ahkPath: this.state.config.ahkPath || null
        };
    }

    async updateConfig(file, updates) {
        try {
            const cfg = this.cloneConfig();
            const idx = cfg.scripts.findIndex((script) => script.file === file);
            const nextScript = {
                file,
                type: file.match(/\.(js|sh|bat|exe|ahk|ps1)$/i)?.[1]?.toLowerCase() ?? 'unknown',
                autoRun: false,
                cronEnabled: false,
                cronInterval: 0,
                displayName: `Run ${file}`,
                ...updates
            };

            if (idx === -1) {
                cfg.scripts.push(nextScript);
            } else {
                cfg.scripts[idx] = { ...cfg.scripts[idx], ...updates };
            }

            const result = await invoke('config:save', { config: cfg });
            if (!result?.ok) {
                this._log(`Config save failed: ${result?.error || 'unknown'}`);
                return;
            }

            this.state.config = { ...result.config, _files: this.state.config._files || [] };
            this._log(`[config] ${idx === -1 ? 'added' : 'updated'} ${file}`);
            this.renderScripts();
        } catch (err) {
            this._log(`Config error: ${err.message}`);
        }
    }

    getScriptsDir() {
        return this.state.config.customScriptsPath || 'default scripts folder';
    }

    async loadScripts() {
        try {
            const result = await invoke('scripts:list');
            this.state.config = { ...result.config, _files: result.files || [] };
            this._log(`Scripts loaded: ${result.files?.length ?? 0}`);
            await this.syncRunningScripts();
            this.renderScripts();
        } catch (err) {
            this._log(`Load error: ${err.message}`);
        }
    }

    async getAhkPath() {
        return this.state.config.ahkPath || null;
    }

    async setAhkPath(ahkPath) {
        const cfg = this.cloneConfig();
        cfg.ahkPath = ahkPath || null;
        const result = await invoke('config:save', { config: cfg });
        if (!result?.ok) {
            this._log(`AHK config save failed: ${result?.error || 'unknown'}`);
            return;
        }

        this.state.config = { ...result.config, _files: this.state.config._files || [] };
        this._log(`[config] AHK path set to: ${ahkPath || 'auto-detect'}`);
    }

    async chooseCustomScriptFolder() {
        const customPath = await invoke('select-directory');
        if (!customPath) return;

        const result = await invoke('scripts:set-directory', { customScriptsPath: customPath });
        this.state.config = { ...result.config, _files: this.state.config._files || [] };
        this._log(`Scripts dir set: ${customPath}`);
        await this.loadScripts();
    }

    async tryAutoRun() {
        if (sessionStorage.getItem('autoRunDone')) return;
        sessionStorage.setItem('autoRunDone', '1');

        for (const file of this.state.config._files || []) {
            const cfg = this.state.config.scripts.find((script) => script.file === file);
            if (!cfg) continue;

            if (cfg.autoRun) {
                const ok = await this.hasAllDependencies(file);
                if (ok) {
                    await this.runScript(file);
                } else {
                    this._log(`Auto-run skipped, missing dependency: ${file}`);
                }
            }

            if (cfg.cronEnabled && cfg.cronInterval > 0) {
                const ok = await this.hasAllDependencies(file);
                if (ok) {
                    await this.startCronScript(file, cfg.cronInterval);
                } else {
                    this._log(`Cron auto-start skipped, missing dependency: ${file}`);
                }
            }
        }
    }

    async runScript(file) {
        if (this.isScriptRunning(file)) {
            await this.stopScript(file);
            return;
        }

        try {
            const result = await invoke('run-script', { file });
            if (result?.ok) {
                this.setScriptRunning(file, true);
                this.renderScripts();
                this._log(`Started ${file}`);
            }
        } catch (err) {
            this._log(`Run error: ${err.message}`);
        }
    }

    async startCronScript(file, intervalMs) {
        if (this.isCronRunning(file)) {
            await this.stopCronScript(file);
            return;
        }

        try {
            const result = await invoke('start-cron-script', { file, intervalMs });
            if (result?.ok) {
                this.setCronRunning(file, true);
                this.renderScripts();
                this._log(`Cron started for ${file} (every ${intervalMs}ms)`);
            }
        } catch (err) {
            this._log(`Cron start error: ${err.message}`);
        }
    }

    async saveCronConfig(file, intervalMs, enabled) {
        await this.updateConfig(file, {
            cronInterval: intervalMs,
            cronEnabled: enabled
        });
    }

    async stopCronScript(file) {
        try {
            const result = await invoke('stop-cron-script', { file });
            if (result?.ok) {
                this.setCronRunning(file, false);
                this.renderScripts();
                this._log(`Cron stopped for ${file}`);
            } else {
                this._log(`Cron stop failed: ${result?.reason || 'unknown'}`);
            }
        } catch (err) {
            this._log(`Cron stop error: ${err.message}`);
        }
    }

    async stopScript(file) {
        try {
            this._log(`Attempting to stop ${file}...`);
            const result = await invoke('stop-script', { file });

            if (result?.ok) {
                this.setScriptRunning(file, false);
                this.renderScripts();
                this._log(`Stopped ${file}`);
            } else {
                this._log(`Stop failed: ${result?.reason || 'unknown'}`);
            }
        } catch (err) {
            this._log(`Stop error: ${err.message}`);
        }
    }

    async hasAllDependencies(file) {
        const ext = file.split('.').pop();
        if (!['bat', 'sh', 'js', 'ahk', 'ps1'].includes(ext)) return true;

        const result = await invoke('scripts:read', { file });
        const matches = result.content.match(/\b[\w\-.]+\.exe\b/gi) || [];
        const allow = new Set([
            'powershell.exe',
            'pwsh.exe',
            'cmd.exe',
            'bash.exe',
            'node.exe',
            'npm.exe',
            'explorer.exe',
            'taskkill.exe',
            'reg.exe',
            'wmic.exe'
        ]);

        for (const match of matches) {
            const exe = match.toLowerCase();
            if (allow.has(exe)) continue;

            const exists = await invoke('scripts:dependency-exists', { file: exe });
            if (!exists) {
                this._log(`Missing dep: ${exe}`);
                return false;
            }
        }

        return true;
    }

    async viewScript(file) {
        if (!file) return;

        try {
            if (file.endsWith('.exe')) {
                this._log('Cannot view binary file');
                return;
            }

            const result = await invoke('scripts:read', { file });
            this.state.currentScript = file;
            this.state.currentScriptContent = result.content;

            if (this.onContentChange) {
                this.onContentChange(result.content);
            }

            if (this.dom?.scriptContent) {
                this.dom.scriptContent.value = result.content;
            }

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
            const content = this.state.currentScriptContent || this.dom?.scriptContent?.value || '';
            await invoke('scripts:write', {
                file: this.state.currentScript,
                content
            });
            this._log(`Saved ${this.state.currentScript}`);
        } catch (err) {
            this._log(`Save error: ${err.message}`);
        }
    }
}

export const scriptManager = new ScriptManager();
