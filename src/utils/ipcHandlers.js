import {
    analyzeModsFolder,
    checkModUpdates,
    getDefaultModsFolder,
    getMinecraftVersions,
    processModDownloads,
    resolveModsFolder
} from '../core/modUpdater.js';

export function registerIpcHandlers(context) {
    const {
        app,
        ipcMain,
        dialog,
        fsPromises,
        existsSync,
        path,
        readConfig,
        writeConfig,
        getScriptsDir,
        getDefaultScriptsDir,
        sanitizeScriptFile,
        sanitizeNetworkLogFile,
        getNetworkLogFolder,
        NETWORK_LOG_FOLDERS,
        getNetworkCaptureScriptPath,
        normalizeNetworkCaptureOptions,
        getNetworkCaptureSpawnArgs,
        commandExists,
        spawn,
        killProcessTree,
        startScript,
        stopScript,
        startCronScript,
        stopCronJob,
        scriptRunners,
        cronJobs,
        scriptLogHistory,
        MAX_SCRIPT_LOG_LINES,
        pushScriptLog,
        broadcastNetworkLog,
        writePacket,
        getNetworkCaptureProcess,
        setNetworkCaptureProcess,
        getDialogParentWindow
    } = context;

    ipcMain.on('log', (message) => {
        console.log('Renderer log:', message);
    });

    ipcMain.handle('log', async (_, msg) => {
        console.log('[renderer log]', msg);
    });

    ipcMain.handle('write-startup-log', async (_event, message) => {
        try {
            const logPath = path.join(app.getPath('userData'), 'emerald_startup.log');
            const timestamp = new Date().toISOString();
            await fsPromises.appendFile(logPath, `[${timestamp}] ${message}\n`, 'utf8');
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('network-start-capture', async (_event, options = {}) => {
        let captureProcess = getNetworkCaptureProcess();

        if (captureProcess) {
            return { ok: true, alreadyRunning: true };
        }

        const scriptPath = getNetworkCaptureScriptPath();
        if (!existsSync(scriptPath)) {
            const error = `Network capture script not found: ${scriptPath}`;
            pushScriptLog(`[Network] ${error}`);
            return { ok: false, error };
        }

        let iface = 'any';
        let extraArgs = [];

        try {
            const normalized = normalizeNetworkCaptureOptions(options);
            iface = normalized.iface;
            extraArgs = normalized.extraArgs;
        } catch (err) {
            pushScriptLog(`[Network] ${err.message}`);
            return { ok: false, error: err.message };
        }

        try {
            if (process.platform === 'win32') {
                if (!commandExists('wsl')) {
                    const error = 'WSL is not installed or unavailable.';
                    pushScriptLog(`[Network] ${error}`);
                    return { ok: false, error };
                }
            }

            const spawnArgs = getNetworkCaptureSpawnArgs(scriptPath, iface, extraArgs);
            captureProcess = spawn(
                process.platform === 'win32' ? 'wsl' : 'bash',
                spawnArgs,
                { stdio: ['ignore', 'pipe', 'pipe'] }
            );
            setNetworkCaptureProcess(captureProcess);

            pushScriptLog(`[Network] Started capture on interface: ${iface}${extraArgs.length ? ` with args: ${extraArgs.join(' ')}` : ''}`);

            captureProcess.stdout.on('data', (data) => {
                const lines = data.toString().split(/\r?\n/);
                for (const line of lines) {
                    if (line.trim()) {
                        writePacketToNetworkLog({
                            raw: line.trim(),
                            interface: iface
                        });
                        broadcastNetworkLog(line);
                    }
                }
            });

            captureProcess.stderr.on('data', (data) => {
                broadcastNetworkLog(process.platform === 'win32' ? `WSL ERR: ${data.toString().trim()}` : data.toString().trim());
            });

            captureProcess.on('error', (err) => {
                setNetworkCaptureProcess(null);
                pushScriptLog(`[Network] Capture error: ${err.message}`);
            });

            captureProcess.on('exit', (code) => {
                setNetworkCaptureProcess(null);
                pushScriptLog(`[Network] Capture stopped (code ${code})`);
            });

            return { ok: true, iface, extraArgs };
        } catch (err) {
            setNetworkCaptureProcess(null);
            pushScriptLog(`[Network] Failed to start: ${err.message}`);
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('network-stop-capture', () => {
        const captureProcess = getNetworkCaptureProcess();

        if (!captureProcess) {
            return { ok: true, alreadyStopped: true };
        }

        setNetworkCaptureProcess(null);
        pushScriptLog('[Network] Capture stopped by user');

        if (captureProcess.pid) {
            killProcessTree(captureProcess.pid);
        } else {
            captureProcess.kill('SIGTERM');
        }

        return { ok: true };
    });

    ipcMain.handle('run-script', async (_event, { file }) => {
        const safeFile = sanitizeScriptFile(file);
        if (!safeFile) return { ok: false, error: 'Invalid script file' };

        const config = await readConfig();
        const scriptPath = path.join(getScriptsDir(config), safeFile);
        return startScript(safeFile, scriptPath);
    });

    ipcMain.handle('stop-script', (event, { file }) => {
        return stopScript(file) ? { ok: true } : { ok: true, alreadyStopped: true };
    });

    ipcMain.handle('start-cron-script', async (_event, { file, intervalMs }) => {
        const safeFile = sanitizeScriptFile(file);
        if (!safeFile) return { ok: false, error: 'Invalid script file' };

        const config = await readConfig();
        const scriptPath = path.join(getScriptsDir(config), safeFile);
        return startCronScript(safeFile, scriptPath, intervalMs);
    });

    ipcMain.handle('stop-cron-script', (event, { file }) => {
        return stopCronJob(file) ? { ok: true } : { ok: true, alreadyStopped: true };
    });

    ipcMain.handle('get-running-scripts', () => Array.from(scriptRunners.keys()));

    ipcMain.handle('get-cron-scripts', () => {
        const result = [];
        for (const [file, job] of cronJobs.entries()) {
            result.push({ file, intervalMs: job.intervalMs });
        }
        return result;
    });

    ipcMain.handle('get-script-log-history', (_event, maxLines = MAX_SCRIPT_LOG_LINES) => {
        return scriptLogHistory.slice(-maxLines);
    });

    ipcMain.handle('network-logs:list', async (_event, { folder = 'ALL' } = {}) => {
        try {
            const safeFolder = NETWORK_LOG_FOLDERS.has(folder) ? folder : 'ALL';
            const logFolder = getNetworkLogFolder(safeFolder);
            await fsPromises.mkdir(logFolder, { recursive: true });

            const files = (await fsPromises.readdir(logFolder))
                .filter((file) => /\.(json|jsonl|txt)$/i.test(file))
                .sort((a, b) => b.localeCompare(a));

            return { ok: true, folder: safeFolder, files, dir: logFolder };
        } catch (err) {
            console.error('[Network Logs] List error:', err);
            return { ok: false, error: err.message, files: [] };
        }
    });

    ipcMain.handle('network-logs:read', async (_event, { folder = 'ALL', file } = {}) => {
        try {
            const safeFolder = NETWORK_LOG_FOLDERS.has(folder) ? folder : 'ALL';
            const safeFile = sanitizeNetworkLogFile(file);
            if (!safeFile) return { ok: false, error: 'Invalid network log file' };

            const content = await fsPromises.readFile(path.join(getNetworkLogFolder(safeFolder), safeFile), 'utf8');
            return { ok: true, folder: safeFolder, file: safeFile, content };
        } catch (err) {
            console.error('[Network Logs] Read error:', err);
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('select-directory', async () => {
        const result = await dialog.showOpenDialog({
            properties: ['openDirectory'],
            title: 'Select Scripts Directory'
        });
        return result.canceled ? null : result.filePaths[0];
    });

    ipcMain.handle('select-file', async (_event, options = {}) => {
        try {
            const result = await dialog.showOpenDialog(getDialogParentWindow(), {
                title: options.title || 'Select File',
                filters: options.filters || [],
                properties: options.properties || ['openFile']
            });
            return result;
        } catch (err) {
            console.error('File select error:', err);
            return { canceled: true };
        }
    });

    ipcMain.handle('get-user-data-path', () => app.getPath('userData'));

    ipcMain.handle('scripts:list', async () => {
        try {
            const config = await readConfig();
            const scriptsDir = getScriptsDir(config);

            if (!existsSync(scriptsDir)) {
                await fsPromises.mkdir(scriptsDir, { recursive: true });
            }

            const files = (await fsPromises.readdir(scriptsDir))
                .filter((file) => /\.(js|sh|bat|exe|ahk|ps1)$/i.test(file))
                .sort((a, b) => a.localeCompare(b));

            await ensureConfigEntries(files);
            return { files, config: await readConfig(), scriptsDir };
        } catch (err) {
            pushScriptLog(`[Scripts] List error: ${err.message}`);
            return { files: [], config: await readConfig(), scriptsDir: getDefaultScriptsDir() };
        }
    });

    ipcMain.handle('scripts:read', async (_event, { file }) => {
        try {
            const safeFile = sanitizeScriptFile(file);
            if (!safeFile) return { ok: false, error: 'Invalid script file' };
            if (safeFile.toLowerCase().endsWith('.exe')) return { ok: false, error: 'Cannot view binary file' };

            const config = await readConfig();
            const content = await fsPromises.readFile(path.join(getScriptsDir(config), safeFile), 'utf8');
            return { ok: true, content };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('scripts:write', async (_event, { file, content }) => {
        try {
            const safeFile = sanitizeScriptFile(file);
            if (!safeFile) return { ok: false, error: 'Invalid script file' };
            if (safeFile.toLowerCase().endsWith('.exe')) return { ok: false, error: 'Cannot write binary file' };

            const config = await readConfig();
            await fsPromises.writeFile(path.join(getScriptsDir(config), safeFile), String(content || ''), 'utf8');
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('scripts:set-directory', async (_event, { customScriptsPath }) => {
        try {
            const config = await readConfig();
            config.customScriptsPath = customScriptsPath || null;
            const savedConfig = await writeConfig(config, { preserveMissingScripts: true });
            return { ok: true, config: savedConfig };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('scripts:dependency-exists', async (_event, { file }) => {
        try {
            const config = await readConfig();
            return existsSync(path.join(getScriptsDir(config), sanitizeScriptFile(file) || file));
        } catch {
            return false;
        }
    });

    ipcMain.handle('config:save', async (_event, { config }) => {
        try {
            if (!config || typeof config !== 'object') {
                return { ok: false, error: 'Missing config' };
            }

            const savedConfig = await writeConfig(config);
            return { ok: true, config: savedConfig };
        } catch (err) {
            console.error('[Config] Failed to save:', err);
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('get-ahk-path', async () => {
        const config = await readConfig();
        return config.ahkPath || null;
    });

    ipcMain.handle('set-ahk-path', async (_event, ahkPath) => {
        try {
            const config = await readConfig();
            config.ahkPath = ahkPath || null;
            await writeConfig(config);
            console.log(`[AHK] Path updated to: ${ahkPath || 'auto-detect'}`);
            return { ok: true };
        } catch (err) {
            console.error('[AHK] Failed to save path:', err);
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('mod-updater:get-default-folder', () => {
        return { path: getDefaultModsFolder(app) };
    });

    ipcMain.handle('mod-updater:select-folder', async () => {
        const defaultPath = getDefaultModsFolder(app);

        const result = await dialog.showOpenDialog({
            properties: ['openDirectory'],
            title: 'Select mods folder',
            defaultPath
        });

        if (result.canceled || !result.filePaths?.length) {
            return { canceled: true };
        }

        return { path: result.filePaths[0] };
    });

    ipcMain.handle('mod-updater:get-minecraft-versions', async () => {
        try {
            const versions = await getMinecraftVersions();
            return { ok: true, versions };
        } catch (err) {
            console.error('[Mod Updater] Failed to load versions:', err);
            return { ok: false, error: err.message, versions: [] };
        }
    });

    ipcMain.handle('mod-updater:analyze', async (_event, options = {}) => {
        try {
            const modsPath = resolveModsFolder(options.modsFolder, app);
            const analysis = analyzeModsFolder(modsPath);

            return {
                ok: true,
                modsPath,
                ...analysis
            };
        } catch (err) {
            console.error('[Mod Updater] Analyze failed:', err);
            return { ok: false, error: err.message, mods: [], detectedMCVersion: null };
        }
    });

    ipcMain.handle('mod-updater:check', async (_event, options = {}) => {
        try {
            const modsPath = resolveModsFolder(options.modsFolder, app);
            const result = await checkModUpdates({
                targetMCVersion: options.targetMCVersion,
                includeUnstable: Boolean(options.includeUnstable),
                modsFolder: modsPath,
                autoDetectMCVersion: Boolean(options.autoDetectMCVersion),
                app
            });

            return {
                ...result,
                modsPath
            };
        } catch (err) {
            console.error('[Mod Updater] Check updates failed:', err);
            return { ok: false, error: err.message, mods: [] };
        }
    });

    ipcMain.handle('mod-updater:download', async (_event, options = {}) => {
        try {
            const result = await processModDownloads({
                modsToDownload: options.modsToDownload || [],
                allMods: options.allMods || [],
                modsFolder: options.modsFolder,
                overwrite: Boolean(options.overwrite),
                backup: Boolean(options.backup),
                deleteOld: Boolean(options.deleteOld),
                copyNonUpdatable: options.copyNonUpdatable !== false,
                app
            });

            return result;
        } catch (err) {
            console.error('[Mod Updater] Download failed:', err);
            return { ok: false, error: err.message, mods: [] };
        }
    });

    function writePacketToNetworkLog(packet) {
        writePacket({
            ts: new Date().toISOString(),
            raw: packet.raw,
            source: 'tcpdump',
            interface: packet.interface
        });
    }

    function ensureConfigEntries(files) {
        return context.ensureConfigEntries(files);
    }
}
