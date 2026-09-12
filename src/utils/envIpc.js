// src/utils/envIpc.js
// IPC handlers for environment configuration management.
// Registered in the main process to allow the Settings UI to import/validate
// .env files securely without exposing secret values to the renderer.

import { ipcMain, dialog } from 'electron';
import * as envConfig from './envConfig.js';

export function registerEnvIpc() {
    // ─── Get environment status ──────────────────────────────────────
    ipcMain.handle('env:status', async () => {
        try {
            const status = envConfig.validateEnvironment();
            const variables = envConfig.getVariableStatus();
            return { ok: true, status, variables };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // ─── Import .env file ────────────────────────────────────────────
    ipcMain.handle('env:import', async () => {
        try {
            const result = await dialog.showOpenDialog({
                title: 'Import Environment Configuration',
                filters: [
                    { name: 'Environment Files', extensions: ['env'] },
                    { name: 'All Files', extensions: ['*'] },
                ],
                properties: ['openFile'],
            });

            if (result.canceled || !result.filePaths?.length) {
                return { ok: false, canceled: true };
            }

            const filePath = result.filePaths[0];
            const importResult = envConfig.importEnvFile(filePath);

            if (!importResult.ok) {
                return { ok: false, error: importResult.error };
            }

            // Return updated status
            const status = envConfig.validateEnvironment();
            const variables = envConfig.getVariableStatus();
            return { ok: true, status, variables, imported: importResult.variables };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // ─── Reload environment ──────────────────────────────────────────
    ipcMain.handle('env:reload', async () => {
        try {
            const result = envConfig.reloadEnvironment();
            const status = envConfig.validateEnvironment();
            const variables = envConfig.getVariableStatus();
            return { ok: true, status, variables, reloaded: result };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // ─── Validate environment ────────────────────────────────────────
    ipcMain.handle('env:validate', async () => {
        try {
            const status = envConfig.validateEnvironment();
            const variables = envConfig.getVariableStatus();
            return { ok: true, status, variables };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // ─── Clear imported environment ──────────────────────────────────
    ipcMain.handle('env:clear', async () => {
        try {
            envConfig.clearImportedEnv();
            const status = envConfig.validateEnvironment();
            const variables = envConfig.getVariableStatus();
            return { ok: true, status, variables };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });
}
