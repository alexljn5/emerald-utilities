import {
    checkModUpdates,
    getDefaultModsFolder,
    getMinecraftVersions,
    processModDownloads,
    resolveModsFolder
} from '../core/modUpdater.js';

export function registerModUpdaterIpcHandlers(context) {
    const { app, ipcMain, dialog } = context;

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

    ipcMain.handle('mod-updater:check', async (_event, options = {}) => {
        try {
            const modsPath = resolveModsFolder(options.modsFolder, app);
            const result = await checkModUpdates({
                targetMCVersion: options.targetMCVersion,
                includeUnstable: Boolean(options.includeUnstable),
                modsFolder: modsPath,
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
}
