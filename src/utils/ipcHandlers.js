import {
    analyzeModsFolder,
    checkModUpdates,
    getDefaultModsFolder,
    getMinecraftVersions,
    processModDownloads,
    resolveModsFolder
} from '../core/modUpdater.js';
import { autoSetupRAG } from '../database/rag-auto-setup.js';
import { queryRAG, queryRAGWithContext, assembleContext, queryWithLLM } from '../database/rag-query.js';
import {
    prepareChatRequest,
    saveAssistantResponse,
    getConversation,
    listConversations,
    clearConversation,
    deleteConversation,
    getMessages,
    buildConversationContext,
} from '../database/ai-persistence.js';
import { enqueuePacket, flushQueue, getPersistenceStatus, recover as recoverNetwork } from '../database/network-persistence.js';
import {
    getNotes, getNoteById, createNote, updateNote, deleteNote,
    getTasks, getTaskById, createTask, updateTask, deleteTask,
    getTaskTags, addTaskTag, removeTaskTag,
    getPendingReminders, markReminderHandled,
    getTasksConnectionInfo
} from '../database/tasks/tasks-service.js';
import { ragLog } from './logger.js';
import { shell } from 'electron';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { fetchQuotes, fetchHistory } from '../portfolio/priceProvider.js';
import { HOLDINGS } from '../portfolio/holdings.js';
import { OSNotifier } from './osNotifier.js';
import {
    sendTaskNotification,
    sendDebugNotification,
    sendTestNotification,
    resetTaskNotificationState,
    NOTIFICATION_TYPE,
} from './notificationService.js';
import { DATABASE_MODE } from '../globals.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read the EODHD key from src/.env (EODHD_API=...) so the Portfolio Monitor
// page can fetch live prices without manual env setup. Scoped to this feature.
//
// __dirname differs between dev (src/utils) and the built output
// (dist-electron/utils), so we resolve the project root by walking up to the
// folder that contains package.json, then check both ./src/.env and ./.env.
function findProjectRoot(startDir) {
    let dir = startDir;
    for (let i = 0; i < 6; i += 1) {
        if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return startDir;
}

function loadEnvApiKey() {
    try {
        const root = findProjectRoot(__dirname);
        const candidates = [
            path.join(root, 'src', '.env'),
            path.join(root, '.env')
        ];

        for (const envPath of candidates) {
            if (!fs.existsSync(envPath)) continue;
            const raw = fs.readFileSync(envPath, 'utf8');
            for (const line of raw.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) continue;
                const match = trimmed.match(/^EODHD_API=(.*)$/);
                if (match) {
                    return match[1].trim().replace(/^["']|["']$/g, '');
                }
            }
        }
    } catch (err) {
        console.error('[Portfolio] Failed to read .env:', err.message);
    }
    return '';
}

export function registerIpcHandlers(context) {
    const {
        app,
        ipcMain,
        dialog,
        Notification,
        fsPromises,
        existsSync,
        path,
        readConfig,
        writeConfig,
        normalizeUiConfig,
        getScriptsDir,
        getDefaultScriptsDir,
        sanitizeScriptFile,
        sanitizeNetworkLogFile,
        getNetworkLogFolder,
        NETWORK_LOG_FOLDERS,
        getNetworkCaptureScriptPath,
        normalizeNetworkCaptureOptions,
        getNetworkCaptureCommand,
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
        broadcast,
        broadcastNetworkLog,
        writePacket,
        getNetworkCaptureProcess,
        setNetworkCaptureProcess,
        applyWindowUi,
        getDialogParentWindow,
        databaseService,
        archiveScheduler,
        notifyArchive,
        toWslPath
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

            const captureCommand = getNetworkCaptureCommand(scriptPath, iface, extraArgs);
            captureProcess = spawn(
                captureCommand.command,
                captureCommand.args,
                { stdio: ['pipe', 'pipe', 'pipe'] }
            );
            captureProcess.stdin.end(captureCommand.stdin);
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

    ipcMain.handle('network-capture:get-status', () => {
        const captureProcess = getNetworkCaptureProcess();
        return {
            ok: true,
            isCapturing: Boolean(captureProcess),
            status: captureProcess ? 'Capturing...' : 'Idle'
        };
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

            // Diagnostics to help debug Linux AppImage path issues
            pushScriptLog(`[Scripts] config.customScriptsPath: ${config?.customScriptsPath || 'null'}`);
            pushScriptLog(`[Scripts] resolved scriptsDir: ${scriptsDir}`);
            pushScriptLog(`[Scripts] platform check: ${process.platform}`);
            pushScriptLog(`[Scripts] cwd: ${process.cwd()}`);
            pushScriptLog(`[Scripts] app.getAppPath(): ${app?.getAppPath?.() || 'n/a'}`);

            if (!existsSync(scriptsDir)) {
                await fsPromises.mkdir(scriptsDir, { recursive: true });
            }

            const allFiles = await fsPromises.readdir(scriptsDir);
            const files = allFiles
                .filter((file) => /\.(js|sh|bat|exe|ahk|ps1)$/i.test(file))
                .sort((a, b) => a.localeCompare(b));

            pushScriptLog(`[Scripts] dir entries: ${allFiles.length}, matched scripts: ${files.length}`);
            if (files.length) {
                pushScriptLog(`[Scripts] matched sample: ${files.slice(0, 25).join(', ')}`);
            }

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
            const savedConfig = await writeConfig(config, { preserveExisting: true, preserveMissingScripts: true });
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

    ipcMain.handle('settings:get', async () => {
        try {
            const config = await readConfig();
            return { ok: true, ui: normalizeUiConfig(config?.ui) };
        } catch (err) {
            console.error('[Settings] Failed to read:', err);
            return { ok: false, error: err.message, ui: normalizeUiConfig() };
        }
    });

    ipcMain.handle('settings:update', async (_event, ui = {}) => {
        try {
            if (!ui || typeof ui !== 'object') {
                return { ok: false, error: 'Missing settings' };
            }

            const config = await readConfig();
            const savedConfig = await writeConfig({
                ...config,
                ui: normalizeUiConfig({ ...(config?.ui || {}), ...ui })
            });

            applyWindowUi(savedConfig.ui);
            broadcast('settings-changed', savedConfig.ui);

            return { ok: true, ui: savedConfig.ui };
        } catch (err) {
            console.error('[Settings] Failed to save:', err);
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('config:save', async (_event, { config }) => {
        try {
            if (!config || typeof config !== 'object') {
                return { ok: false, error: 'Missing config' };
            }

            const existingConfig = await readConfig();
            const savedConfig = await writeConfig({
                ...config,
                ui: config?.ui ?? existingConfig?.ui
            }, { preserveExisting: true });
            return { ok: true, config: savedConfig };
        } catch (err) {
            console.error('[Config] Failed to save:', err);
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('config:export', async () => {
        try {
            const config = await readConfig();
            const result = await dialog.showSaveDialog(getDialogParentWindow(), {
                title: 'Export Configuration',
                defaultPath: 'emerald-config.json',
                filters: [
                    { name: 'JSON Files', extensions: ['json'] },
                    { name: 'All Files', extensions: ['*'] }
                ]
            });

            if (result.canceled || !result.filePath) {
                return { ok: false, canceled: true };
            }

            await fsPromises.writeFile(result.filePath, JSON.stringify(config, null, 2), 'utf8');
            return { ok: true, path: result.filePath };
        } catch (err) {
            console.error('[Config] Failed to export:', err);
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
            await writeConfig(config, { preserveExisting: true });
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
                targetMCVersion: options.targetVersion,
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
        // Write to JSON file (existing behavior)
        writePacket({
            ts: new Date().toISOString(),
            raw: packet.raw,
            source: 'tcpdump',
            interface: packet.interface
        });

        // Also persist to PostgreSQL (non-blocking fire-and-forget)
        const normalizedPacket = {
            captured_at: new Date().toISOString(),
            source: 'tcpdump',
            interface_name: packet.interface || 'any',
            direction: null,
            protocol: null,
            transport_protocol: null,
            source_ip: null,
            destination_ip: null,
            source_port: null,
            destination_port: null,
            packet_length: null,
            is_blacklisted: false,
            severity: 'none',
            payload: {
                raw: packet.raw,
                parsed: packet.parsed || null,
            },
        };

        // Fire-and-forget: don't block capture on DB writes
        enqueuePacket(normalizedPacket).catch((err) => {
            // Queue will handle retry; just log if queue is full
            if (err.message && err.message.includes('queue full')) {
                console.warn('[Network] Persistence queue full, event queued for retry');
            }
        });
    }

    function ensureConfigEntries(files) {
        return context.ensureConfigEntries(files);
    }

    ipcMain.handle('database:get-stats', async () => {
        try {
            if (!databaseService) {
                return {
                    connected: false,
                    totalPackets: 0,
                    grokMessages: 0,
                    grokConversations: 0,
                    activeThreats: 0,
                    blacklistedPackets: 0
                };
            }
            return await databaseService.getStats();
        } catch (err) {
            console.error('[Database] get-stats error:', err);
            return {
                connected: false,
                totalPackets: 0,
                grokMessages: 0,
                grokConversations: 0,
                activeThreats: 0,
                blacklistedPackets: 0
            };
        }
    });

    ipcMain.handle('database:get-connection-info', async () => {
        try {
            if (!databaseService) {
                return {
                    host: 'localhost',
                    port: 5432,
                    database: 'emerald_utilities',
                    user: 'emerald',
                    connected: false
                };
            }
            return databaseService.getConnectionInfo();
        } catch (err) {
            console.error('[Database] get-connection-info error:', err);
            return {
                host: 'localhost',
                port: 5432,
                database: 'emerald_utilities',
                user: 'emerald',
                connected: false
            };
        }
    });

    ipcMain.handle('database:query', async (_event, { sql }) => {
        try {
            if (!databaseService) {
                throw new Error('Database service not available');
            }
            const result = await databaseService.executeQuery(sql);
            return {
                ok: true,
                rows: result.rows,
                fields: result.fields,
                rowCount: result.rowCount
            };
        } catch (err) {
            console.error('[Database] query error:', err);
            throw err;
        }
    });

    ipcMain.handle('database:open-pgadmin', async () => {
        try {
            const url = 'http://localhost:5050';
            await shell.openExternal(url);
            return { ok: true };
        } catch (err) {
            console.error('[Database] open-pgadmin error:', err);
            throw err;
        }
    });

    ipcMain.handle('database:import-network-log', async (_event, { file }) => {
        try {
            if (!databaseService) {
                return { ok: false, error: 'Database service not available' };
            }
            const safeFile = sanitizeNetworkLogFile(file);
            if (!safeFile) {
                return { ok: false, error: 'Invalid network log file' };
            }

            const filePath = path.join(getNetworkLogFolder('ALL'), safeFile);
            const content = await fsPromises.readFile(filePath, 'utf8');
            const lines = content.split(/\r?\n/).filter((line) => line.trim());

            const events = [];
            for (const line of lines) {
                try {
                    const parsed = JSON.parse(line);
                    events.push({
                        raw: parsed.raw || line,
                        source: parsed.source || 'tcpdump',
                        interface: parsed.interface || 'unknown',
                        capturedAt: parsed.ts ? new Date(parsed.ts) : new Date(),
                        payload: parsed
                    });
                } catch {
                    events.push({
                        raw: line,
                        source: 'tcpdump',
                        interface: 'unknown',
                        capturedAt: new Date(),
                        payload: { raw: line }
                    });
                }
            }

            const ids = await databaseService.insertPacketEventsBatch(events);
            return { ok: true, imported: ids.length, failed: events.length - ids.length };
        } catch (err) {
            console.error('[Database] import-network-log error:', err);
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('database:import-grok-export', async () => {
        try {
            if (!databaseService) {
                return { ok: false, error: 'Database service not available' };
            }

            const result = await dialog.showOpenDialog(getDialogParentWindow(), {
                title: 'Select Grok Export JSON',
                filters: [{ name: 'JSON', extensions: ['json'] }],
                properties: ['openFile']
            });

            if (result.canceled || !result.filePaths?.length) {
                return { ok: false, error: 'No file selected' };
            }

            const filePath = result.filePaths[0];
            console.log(`[Database] Reading Grok export file: ${filePath}`);

            const content = await fsPromises.readFile(filePath, 'utf8');
            console.log(`[Database] File size: ${content.length} bytes`);

            let data;
            try {
                data = JSON.parse(content);
            } catch (parseErr) {
                console.error('[Database] Failed to parse JSON:', parseErr.message);
                return { ok: false, error: `JSON parse error: ${parseErr.message}` };
            }

            const messageCount = data.messages?.length || data.data?.messages?.length || 0;
            const convCount = data.conversations?.length || data.data?.conversations?.length || 0;
            console.log(`[Database] Parsed ${convCount} conversations, ${messageCount} messages`);

            const importResult = await databaseService.importGrokIndexedDBExport(data);
            return {
                ok: true,
                importedConversations: importResult.importedConversations,
                importedMessages: importResult.importedMessages,
                failed: importResult.failed
            };
        } catch (err) {
            console.error('[Database] import-grok-export error:', err);
            console.error('[Database] Error stack:', err.stack || err);
            return { ok: false, error: err.message, stack: err.stack };
        }
    });

    ipcMain.handle('database:import-blacklist', async () => {
        try {
            if (!databaseService) {
                return { ok: false, error: 'Database service not available' };
            }

            const blacklistPath = path.join(process.cwd(), 'src/database/network/blackisted-ips.json');
            const content = await fsPromises.readFile(blacklistPath, 'utf8');

            let ips;
            try {
                ips = JSON.parse(content);
            } catch {
                // Fallback: treat as newline-separated IP list
                ips = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
            }

            if (!Array.isArray(ips)) {
                ips = [ips];
            }

            const count = await databaseService.importIPBlacklist(ips);
            return { ok: true, count };
        } catch (err) {
            console.error('[Database] import-blacklist error:', err);
            return { ok: false, error: err.message };
        }
    });

    // RAG Auto-Setup Handler - runs on app startup
    ipcMain.handle('rag-auto-setup', async () => {
        try {
            console.log('[RAG-Auto] Running auto-setup...');
            const result = await autoSetupRAG();
            return result;
        } catch (err) {
            ragLog.error('rag-auto-setup', err, 'Startup RAG setup failed; app continues, chat may be limited');
            return { ok: false, error: err.message };
        }
    });

    // Grok RAG Query Handler
    ipcMain.handle('grok-query', async (_event, userQuery) => {
        try {
            if (!userQuery || typeof userQuery !== 'string') {
                return { ok: false, error: 'Invalid query' };
            }

            // Perform the query (embedding + vector search) — include surrounding
            // conversational turns so hits are never ambiguous in isolation.
            const hits = await queryRAGWithContext(userQuery, 10, 3);

            if (!hits || hits.length === 0) {
                return { ok: false, error: 'No messages with embeddings found. Run RAG preparation first.' };
            }

            // Assemble context string from the enriched hits (seed + window).
            const flatForContext = hits.flatMap(hit =>
                (hit.window && hit.window.length ? hit.window : [hit])
                    .map(m => ({
                        author: m.author,
                        timestamp: m.timestamp,
                        content: m.content,
                        similarity: hit.similarity != null ? hit.similarity : 0,
                    }))
            );

            const context = assembleContext(flatForContext);

            // Query LLM (pass similarMessages for relevance check)
            const response = await queryWithLLM(userQuery, context, hits);
            return { ok: true, response };
        } catch (err) {
            ragLog.error('grok-query', err, 'Returning user-friendly fallback; other features unaffected');
            // Classify the failure so the UI can show a helpful message and the
            // rest of the app keeps working (graceful degradation).
            const msg = `${err.message} ${err.cause?.code || ''}`;
            const isConn = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|socket hang up/i.test(msg);
            if (isConn && /1143[0-9]|ollama|embed|chat/i.test(msg + (err.stack || ''))) {
                return { ok: false, unavailable: 'ollama', error: 'AI service unavailable. Check that Ollama is running and reachable.' };
            }
            if (isConn) {
                return { ok: false, unavailable: 'database', error: 'Database unavailable. Check the connection to the server.' };
            }
            return { ok: false, error: err.message };
        }
    });

    // ============================================================
    // AI Chat Persistence Handlers
    // ============================================================

    // Grok Chat Handler - full persistence loop
    ipcMain.handle('grok-chat', async (_event, { conversationId, userMessage, systemPrompt }) => {
        try {
            if (!userMessage || typeof userMessage !== 'string') {
                return { ok: false, error: 'Invalid message' };
            }

            // 1. Prepare request (get/create conversation, save user message, get history)
            const prepared = await prepareChatRequest({
                conversationId,
                userMessage,
                systemPrompt,
            });

            // 2. Retrieve semantically-relevant OLDER context via RAG. Each hit
            //    carries its surrounding window + metadata, so it is never an
            //    isolated fragment. This is what lets the model infer ongoing
            //    interactions (e.g. "hug" -> "what are we doing?") without
            //    resorting to a hard-coded rule or dumping the whole database.
            let retrieved = [];
            try {
                retrieved = await queryRAGWithContext(userMessage, 8, 2);
            } catch (ragErr) {
                // RAG failure should not block a normal chat reply from recent
                // history. Log it and continue with recent context only.
                ragLog.warn('grok-chat', ragErr.message, 'RAG context retrieval skipped; using recent history only');
            }

            // 3. Build the unified, structured context bundle.
            const bundle = buildConversationContext({
                systemPrompt,
                userMessage,
                recent: prepared.history,
                retrieved,
            });

            // 4. Query LLM with the full ordered message array (system +
            //    recent history + retrieved older context + current message).
            const response = await queryWithLLM(bundle.messages, prepared.conversationId);

            // 5. Save assistant response
            const saved = await saveAssistantResponse({
                conversationId: prepared.conversationId,
                responseContent: response,
            });

            return {
                ok: true,
                response,
                conversationId: prepared.conversationId,
                messageId: saved.messageId,
            };
        } catch (err) {
            ragLog.error('grok-chat', err, 'Chat persistence failed');
            const msg = `${err.message} ${err.cause?.code || ''}`;
            const isConn = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|socket hang up/i.test(msg);
            if (isConn && /1143[0-9]|ollama|embed|chat/i.test(msg + (err.stack || ''))) {
                return { ok: false, unavailable: 'ollama', error: 'AI service unavailable. Check that Ollama is running and reachable.' };
            }
            if (isConn) {
                return { ok: false, unavailable: 'database', error: 'Database unavailable. Check the connection to the server.' };
            }
            return { ok: false, error: err.message };
        }
    });

    // List AI conversations
    ipcMain.handle('grok-conversations', async (_event, { limit = 50 } = {}) => {
        try {
            const conversations = await listConversations(limit);
            return { ok: true, conversations };
        } catch (err) {
            ragLog.error('grok-conversations', err);
            return { ok: false, error: err.message };
        }
    });

    // Get messages for a conversation
    ipcMain.handle('grok-messages', async (_event, { conversationId, limit = 100 }) => {
        try {
            if (!conversationId) {
                return { ok: false, error: 'conversationId required' };
            }
            const messages = await getMessages(conversationId, limit);
            return { ok: true, messages };
        } catch (err) {
            ragLog.error('grok-messages', err);
            return { ok: false, error: err.message };
        }
    });

    // Clear conversation messages
    ipcMain.handle('grok-clear-conversation', async (_event, { conversationId }) => {
        try {
            if (!conversationId) {
                return { ok: false, error: 'conversationId required' };
            }
            await clearConversation(conversationId);
            return { ok: true };
        } catch (err) {
            ragLog.error('grok-clear-conversation', err);
            return { ok: false, error: err.message };
        }
    });

    // Delete conversation
    ipcMain.handle('grok-delete-conversation', async (_event, { conversationId }) => {
        try {
            if (!conversationId) {
                return { ok: false, error: 'conversationId required' };
            }
            await deleteConversation(conversationId);
            return { ok: true };
        } catch (err) {
            ragLog.error('grok-delete-conversation', err);
            return { ok: false, error: err.message };
        }
    });

    // ============================================================
    // Network Persistence Handlers
    // ============================================================

    // Get network persistence status
    ipcMain.handle('network:persistence-status', async () => {
        try {
            const status = getPersistenceStatus();
            return { ok: true, status };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // Recover network persistence (flush queued events)
    ipcMain.handle('network:recover', async () => {
        try {
            const status = await recoverNetwork();
            return { ok: true, status };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // Database Backup Handler (using volume-backup.sh)
    ipcMain.handle('database:backup', async () => {
        try {
            if (DATABASE_MODE === 'remote') {
                return { ok: false, error: 'Database backup is not available in remote mode. Use homelab management tools.' };
            }
            const scriptPath = path.join(__dirname, '../internal-scripts/volume-backup.sh');
            if (!existsSync(scriptPath)) {
                return { ok: false, error: `Backup script not found: ${scriptPath}` };
            }

            const dbDir = path.join(__dirname, '../database');
            const wslDbDir = toWslPath(dbDir);

            const result = await new Promise((resolve) => {
                const proc = spawn('wsl', ['bash', scriptPath, wslDbDir], {
                    stdio: ['pipe', 'pipe', 'pipe']
                });

                let stdout = '';
                let stderr = '';

                proc.stdout.on('data', (data) => {
                    stdout += data.toString();
                    pushScriptLog(`[DB-Backup] ${data.toString().trim()}`);
                });

                proc.stderr.on('data', (data) => {
                    stderr += data.toString();
                    pushScriptLog(`[DB-Backup] ${data.toString().trim()}`);
                });

                proc.on('close', (code) => {
                    if (code === 0) {
                        resolve({ ok: true, output: stdout });
                    } else {
                        resolve({ ok: false, error: stderr || `Backup failed with code ${code}` });
                    }
                });

                proc.on('error', (err) => {
                    resolve({ ok: false, error: err.message });
                });
            });

            return result;
        } catch (err) {
            console.error('[DB-Backup] IPC error:', err);
            return { ok: false, error: err.message };
        }
    });

    // Database Restore Handler (using volume-restore.sh)
    ipcMain.handle('database:restore', async (_event, backupFile) => {
        try {
            if (DATABASE_MODE === 'remote') {
                return { ok: false, error: 'Database restore is not available in remote mode. Use homelab management tools.' };
            }
            if (!backupFile || typeof backupFile !== 'string') {
                return { ok: false, error: 'Invalid backup file' };
            }

            const scriptPath = path.join(__dirname, '../internal-scripts/volume-restore.sh');
            if (!existsSync(scriptPath)) {
                return { ok: false, error: `Restore script not found: ${scriptPath}` };
            }

            const dbDir = path.join(__dirname, '../database');
            const wslDbDir = toWslPath(dbDir);
            const wslBackupFile = toWslPath(backupFile);

            const result = await new Promise((resolve) => {
                const proc = spawn('wsl', ['bash', scriptPath, wslDbDir, wslBackupFile], {
                    stdio: ['pipe', 'pipe', 'pipe']
                });

                let stdout = '';
                let stderr = '';

                proc.stdout.on('data', (data) => {
                    stdout += data.toString();
                    pushScriptLog(`[DB-Restore] ${data.toString().trim()}`);
                });

                proc.stderr.on('data', (data) => {
                    stderr += data.toString();
                    pushScriptLog(`[DB-Restore] ${data.toString().trim()}`);
                });

                proc.on('close', (code) => {
                    if (code === 0) {
                        resolve({ ok: true, output: stdout });
                    } else {
                        resolve({ ok: false, error: stderr || `Restore failed with code ${code}` });
                    }
                });

                proc.on('error', (err) => {
                    resolve({ ok: false, error: err.message });
                });
            });

            return result;
        } catch (err) {
            console.error('[DB-Restore] IPC error:', err);
            return { ok: false, error: err.message };
        }
    });

    // Database Verify Handler (using volume-verify.sh)
    ipcMain.handle('database:verify', async (_event, backupFile) => {
        try {
            if (DATABASE_MODE === 'remote') {
                return { ok: false, error: 'Database verify is not available in remote mode. Use homelab management tools.' };
            }
            const scriptPath = path.join(__dirname, '../internal-scripts/volume-verify.sh');
            if (!existsSync(scriptPath)) {
                return { ok: false, error: `Verify script not found: ${scriptPath}` };
            }

            const dbDir = path.join(__dirname, '../database');
            const wslDbDir = toWslPath(dbDir);

            // If backupFile is provided, use it; otherwise verify the most recent
            const args = backupFile
                ? ['bash', scriptPath, wslDbDir, toWslPath(backupFile)]
                : ['bash', scriptPath, wslDbDir];

            const result = await new Promise((resolve) => {
                const proc = spawn('wsl', args, {
                    stdio: ['pipe', 'pipe', 'pipe']
                });

                let stdout = '';
                let stderr = '';

                proc.stdout.on('data', (data) => {
                    stdout += data.toString();
                    pushScriptLog(`[DB-Verify] ${data.toString().trim()}`);
                });

                proc.stderr.on('data', (data) => {
                    stderr += data.toString();
                    pushScriptLog(`[DB-Verify] ${data.toString().trim()}`);
                });

                proc.on('close', (code) => {
                    if (code === 0) {
                        resolve({ ok: true, output: stdout });
                    } else {
                        resolve({ ok: false, error: stderr || `Verify failed with code ${code}` });
                    }
                });

                proc.on('error', (err) => {
                    resolve({ ok: false, error: err.message });
                });
            });

            return result;
        } catch (err) {
            console.error('[DB-Verify] IPC error:', err);
            return { ok: false, error: err.message };
        }
    });

    // Cream Chat Save Handler - saves AI chat messages to JSON file
    ipcMain.handle('cream-save-chat', async (_event, messages) => {
        try {
            // Use userData directory for production compatibility
            // In dev: app.getPath('userData') returns something like %APPDATA%/Emerald Utilities
            // In prod: same behavior, ensuring the path is writable
            const creamDir = path.join(app.getPath('userData'), 'cream');
            const chatFile = path.join(creamDir, 'chat-history.json');

            await fsPromises.mkdir(creamDir, { recursive: true });

            // Process messages to ensure author field is set
            const processedMessages = (messages || []).map(msg => ({
                role: msg.role || 'unknown',
                content: msg.content || '',
                author: msg.author || (msg.role === 'user' ? 'alexljn5' : msg.role === 'assistant' ? 'Cream' : 'Unknown'),
                timestamp: msg.timestamp || new Date().toISOString()
            }));

            // Add timestamp to the saved data
            const dataToSave = {
                savedAt: new Date().toISOString(),
                messages: processedMessages
            };

            await fsPromises.writeFile(chatFile, JSON.stringify(dataToSave, null, 2), 'utf8');
            return { ok: true, path: chatFile };
        } catch (err) {
            console.error('[Cream] Failed to save chat:', err);
            return { ok: false, error: err.message };
        }
    });

    // Cream Chat Load Handler - loads AI chat messages from JSON file
    ipcMain.handle('cream-load-chat', async () => {
        try {
            // First check userData directory (production/writable location)
            const creamDir = path.join(app.getPath('userData'), 'cream');
            const chatFile = path.join(creamDir, 'chat-history.json');

            if (existsSync(chatFile)) {
                const content = await fsPromises.readFile(chatFile, 'utf8');
                const data = JSON.parse(content);
                return { ok: true, messages: data.messages || [], path: chatFile };
            }

            // Fallback: check project's src/database/cream/ directory (development)
            const projectCreamDir = path.join(process.cwd(), 'src/database/cream');
            const projectChatFile = path.join(projectCreamDir, 'chat-history.json');

            if (existsSync(projectChatFile)) {
                const content = await fsPromises.readFile(projectChatFile, 'utf8');
                const data = JSON.parse(content);
                // Also save to userData directory for future use
                await fsPromises.mkdir(creamDir, { recursive: true });
                await fsPromises.writeFile(chatFile, content, 'utf8');
                return { ok: true, messages: data.messages || [], path: chatFile, migrated: true };
            }

            return { ok: true, messages: [], path: chatFile };
        } catch (err) {
            console.error('[Cream] Failed to load chat:', err);
            return { ok: false, error: err.message, messages: [] };
        }
    });

    // Database List Backups Handler
    ipcMain.handle('database:list-backups', async () => {
        try {
            const backupDir = path.join(__dirname, '../database/volume-backups');
            await fsPromises.mkdir(backupDir, { recursive: true });

            const files = (await fsPromises.readdir(backupDir))
                .filter((file) => file.endsWith('.tar.gz'))
                .sort((a, b) => b.localeCompare(a));

            return { ok: true, backups: files };
        } catch (err) {
            console.error('[DB] List backups error:', err);
            return { ok: false, error: err.message, backups: [] };
        }
    });

    // ==================== ARCHIVE SCHEDULER ====================
    ipcMain.handle('archive-scheduler:list', async () => {
        return { ok: true, tasks: archiveScheduler?.list?.() || [] };
    });

    ipcMain.handle('archive-scheduler:save', async (_event, task) => {
        try {
            if (!archiveScheduler) return { ok: false, error: 'Archive scheduler is not available' };
            const saved = await archiveScheduler.upsert(task);
            return { ok: true, task: saved, tasks: archiveScheduler.list() };
        } catch (err) {
            console.error('[ArchiveScheduler] save error:', err);
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('archive-scheduler:delete', async (_event, { id }) => {
        try {
            if (!archiveScheduler) return { ok: false, error: 'Archive scheduler is not available' };
            await archiveScheduler.remove(id);
            return { ok: true, tasks: archiveScheduler.list() };
        } catch (err) {
            console.error('[ArchiveScheduler] delete error:', err);
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('archive-scheduler:run-now', async (_event, { id }) => {
        try {
            if (!archiveScheduler) return { ok: false, error: 'Archive scheduler is not available' };
            queueMicrotask(() => archiveScheduler.execute(id, 'manual'));
            return { ok: true, tasks: archiveScheduler.list() };
        } catch (err) {
            console.error('[ArchiveScheduler] run-now error:', err);
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('archive-notification:debug', async () => {
        notifyArchive?.({
            type: 'info',
            title: 'Debug Notification',
            message: 'Renderer toast positioning and animation test',
            trigger: 'debug'
        });
        return { ok: true };
    });

    // ==================== PORTFOLIO MONITOR ====================
    // Returns the hardcoded holdings (so the renderer never needs to know the
    // data source details) plus the current API provider name.
    ipcMain.handle('portfolio:getHoldings', async () => {
        try {
            return {
                ok: true,
                holdings: HOLDINGS,
                provider: 'eodhd'
            };
        } catch (err) {
            console.error('[Portfolio] getHoldings error:', err);
            return { ok: false, error: err.message, holdings: [] };
        }
    });

    // Fetches current quotes for all holdings using the active price provider.
    // The API key is resolved from config (config.apiKey) or the EODHD_API_KEY
    // environment variable so it never leaves the main process.
    ipcMain.handle('portfolio:fetchQuotes', async () => {
        try {
            const config = await readConfig();
            const apiKey = config?.apiKey || loadEnvApiKey() || process.env.EODHD_API_KEY || '';

            if (!apiKey) {
                return {
                    ok: false,
                    error: 'No EODHD API key configured. Add "apiKey" to scripts/config.json, set EODHD_API in src/.env, or set EODHD_API_KEY.',
                    quotes: []
                };
            }

            const symbols = [...new Set(HOLDINGS.map((h) => h.symbol).filter(Boolean))];
            const quotes = await fetchQuotes({ symbols, apiKey });

            return { ok: true, quotes };
        } catch (err) {
            console.error('[Portfolio] fetchQuotes error:', err);
            return { ok: false, error: err.message, quotes: [] };
        }
    });

    // Fetches historical end-of-day closes for a single symbol, used to build
    // the portfolio value-over-time line chart.
    ipcMain.handle('portfolio:fetchHistory', async (_event, { symbol, limit = 30 } = {}) => {
        try {
            const config = await readConfig();
            const apiKey = config?.apiKey || loadEnvApiKey() || process.env.EODHD_API_KEY || '';

            if (!apiKey) {
                return { ok: false, error: 'No EODHD API key configured.', history: [] };
            }

            const history = await fetchHistory({ symbol, apiKey, limit });
            return { ok: true, history };
        } catch (err) {
            console.error('[Portfolio] fetchHistory error:', err);
            return { ok: false, error: err.message, history: [] };
        }
    });

    // ==================== TASKS ====================
    // Simple notes + tasks API (sticky-note style, no Kanban).

    // --- Notes ---
    ipcMain.handle('tasks:getNotes', async () => {
        try {
            return { ok: true, notes: await getNotes() };
        } catch (err) {
            console.error('[Tasks] getNotes error:', err);
            return { ok: false, error: err.message, notes: [] };
        }
    });

    ipcMain.handle('tasks:getNote', async (_event, { id }) => {
        try {
            const note = await getNoteById(id);
            return { ok: true, note };
        } catch (err) {
            console.error('[Tasks] getNote error:', err);
            return { ok: false, error: err.message, note: null };
        }
    });

    ipcMain.handle('tasks:createNote', async (_event, note) => {
        try {
            const created = await createNote(note);
            return { ok: true, note: created };
        } catch (err) {
            console.error('[Tasks] createNote error:', err);
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('tasks:updateNote', async (_event, { id, updates }) => {
        try {
            const updated = await updateNote(id, updates);
            return { ok: true, note: updated };
        } catch (err) {
            console.error('[Tasks] updateNote error:', err);
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('tasks:deleteNote', async (_event, { id }) => {
        try {
            const deleted = await deleteNote(id);
            return { ok: true, note: deleted };
        } catch (err) {
            console.error('[Tasks] deleteNote error:', err);
            return { ok: false, error: err.message };
        }
    });

    // --- Tasks ---
    ipcMain.handle('tasks:getTasks', async () => {
        try {
            return { ok: true, tasks: await getTasks() };
        } catch (err) {
            console.error('[Tasks] getTasks error:', err);
            return { ok: false, error: err.message, tasks: [] };
        }
    });

    ipcMain.handle('tasks:getTask', async (_event, { id }) => {
        try {
            const task = await getTaskById(id);
            return { ok: true, task };
        } catch (err) {
            console.error('[Tasks] getTask error:', err);
            return { ok: false, error: err.message, task: null };
        }
    });

    ipcMain.handle('tasks:createTask', async (_event, task) => {
        try {
            const created = await createTask(task);
            return { ok: true, task: created };
        } catch (err) {
            console.error('[Tasks] createTask error:', err);
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('tasks:updateTask', async (_event, { id, updates }) => {
        try {
            const updated = await updateTask(id, updates);
            // If the deadline or reminder changed, clear suppression state
            // so the scheduler can re-notify for the new deadline.
            if (updates.due_time !== undefined || updates.reminder_time !== undefined) {
                resetTaskNotificationState(id);
            }
            return { ok: true, task: updated };
        } catch (err) {
            console.error('[Tasks] updateTask error:', err);
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('tasks:deleteTask', async (_event, { id }) => {
        try {
            const deleted = await deleteTask(id);
            return { ok: true, task: deleted };
        } catch (err) {
            console.error('[Tasks] deleteTask error:', err);
            return { ok: false, error: err.message };
        }
    });

    // --- Task Tags ---
    ipcMain.handle('tasks:getTaskTags', async (_event, { taskId }) => {
        try {
            const tags = await getTaskTags(taskId);
            return { ok: true, tags };
        } catch (err) {
            console.error('[Tasks] getTaskTags error:', err);
            return { ok: false, error: err.message, tags: [] };
        }
    });

    ipcMain.handle('tasks:addTaskTag', async (_event, { taskId, tag }) => {
        try {
            const added = await addTaskTag(taskId, tag);
            return { ok: true, tag: added };
        } catch (err) {
            console.error('[Tasks] addTaskTag error:', err);
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('tasks:removeTaskTag', async (_event, { taskId, tag }) => {
        try {
            const removed = await removeTaskTag(taskId, tag);
            return { ok: true, tag: removed };
        } catch (err) {
            console.error('[Tasks] removeTaskTag error:', err);
            return { ok: false, error: err.message };
        }
    });

    // --- Reminders ---
    ipcMain.handle('tasks:getPendingReminders', async () => {
        try {
            const reminders = await getPendingReminders();
            return { ok: true, reminders };
        } catch (err) {
            console.error('[Tasks] getPendingReminders error:', err);
            return { ok: false, error: err.message, reminders: [] };
        }
    });

    ipcMain.handle('tasks:markReminderHandled', async (_event, { id }) => {
        try {
            const updated = await markReminderHandled(id);
            return { ok: true, task: updated };
        } catch (err) {
            console.error('[Tasks] markReminderHandled error:', err);
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('tasks:notify', async (_event, { title, body, urgency = 'normal', silent = false } = {}) => {
        const safeTitle = title || 'Emerald Utilities';
        const safeBody = body || 'Task reminder';
        const safeUrgency = ['low', 'normal', 'critical'].includes(urgency) ? urgency : 'normal';

        // Always broadcast an in-app toast as a confirmation/fallback, so the
        // user sees feedback (in the renderer) that an OS notification was
        // attempted. This is NOT how the OS banner is delivered.
        broadcast('tasks-toast', {
            id: `toast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            title: safeTitle,
            body: safeBody,
            urgency: safeUrgency,
            timestamp: new Date().toISOString(),
            source: 'task'
        });

        // --- OS-level notification via the centralized notification service ---
        try {
            const osResult = await OSNotifier.notify({
                title: safeTitle,
                body: safeBody,
                urgency: safeUrgency,
                silent,
            });

            if (osResult?.ok) {
                return { ok: true, toastSent: true, provider: osResult.provider, state: osResult.state };
            }

            console.error(`[Tasks] ${osResult?.provider || 'notification'} failed (${osResult?.state || 'unknown'}):`, osResult?.error);
            return { ok: false, error: osResult?.error, state: osResult?.state, toastSent: true, provider: osResult?.provider };
        } catch (err) {
            console.error('[Tasks] OS notification threw:', err.message);
            return { ok: false, error: err.message, toastSent: true };
        }
    });

    // Isolated diagnostic for the notification subsystem. Does not start
    // PostgreSQL/Docker/Ollama/RAG — only inspects the notification environment.
    ipcMain.handle('tasks:notify:diagnose', async () => {
        try {
            const info = await OSNotifier.diagnose();
            return { ok: true, info };
        } catch (err) {
            console.error('[Tasks] notification diagnose error:', err.message);
            return { ok: false, error: err.message };
        }
    });

    // Isolated Windows notification test. Sends one OS-level banner and returns
    // the exact result (shown / failed / timeout) without faking success.
    ipcMain.handle('tasks:notify:test', async (_event, options = {}) => {
        try {
            const result = await OSNotifier.notify({
                title: options.title || 'Emerald Reminder',
                message: options.message || 'Windows notification test.',
            });
            return { ok: true, result };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // Re-enable Windows toast notifications that were suppressed with
    // DisabledForUser. Re-registers the AUMID shortcut and clears the "Disabled"
    // registry flag, then verifies with a single test toast.
    ipcMain.handle('tasks:notify:enable', async () => {
        try {
            const result = await OSNotifier.enable();
            return { ok: true, result };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // --- Task notification tests (developer-only) ---
    // These use the exact same notification-generation code path as real
    // task notifications, but target a specific task and type for testing.

    ipcMain.handle('tasks:notify:test-reminder', async (_event, { taskId, title } = {}) => {
        try {
            // Fetch the task so we have full data for the notification
            const task = await getTaskById(taskId);
            if (!task) return { ok: false, error: 'Task not found' };
            if (title) task.title = title;
            const result = await sendTestNotification(task, NOTIFICATION_TYPE.REMINDER);
            return { ok: true, result };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('tasks:notify:test-due', async (_event, { taskId, title } = {}) => {
        try {
            const task = await getTaskById(taskId);
            if (!task) return { ok: false, error: 'Task not found' };
            if (title) task.title = title;
            const result = await sendTestNotification(task, NOTIFICATION_TYPE.DUE_DATE);
            return { ok: true, result };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('tasks:notify:test-priority', async (_event, { taskId, title } = {}) => {
        try {
            const task = await getTaskById(taskId);
            if (!task) return { ok: false, error: 'Task not found' };
            if (title) task.title = title;
            const result = await sendTestNotification(task, NOTIFICATION_TYPE.PRIORITY);
            return { ok: true, result };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('tasks:notify:debug', async () => {
        try {
            const result = await sendDebugNotification();
            return { ok: true, result };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // --- Connection Info ---
    ipcMain.handle('tasks:getConnectionInfo', async () => {
        try {
            const info = await getTasksConnectionInfo();
            return { ok: true, connected: info.connected, mode: info.mode };
        } catch (err) {
            console.error('[Tasks] getConnectionInfo error:', err);
            return { ok: true, connected: false, mode: 'offline-json', error: err.message };
        }
    });
}
