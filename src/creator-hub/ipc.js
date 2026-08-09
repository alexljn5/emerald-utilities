// src/creator-hub/ipc.js
// IPC handlers for Creator Hub.
// Registers all creator-hub:* channels.

import { createPlatformAccount, validatePlatformAccount } from './models.js';
import { createPost, validatePost } from './models.js';
import { ACCOUNT_STATUS } from '../globals.js';
import {
    loadAccounts,
    saveAccounts,
    getAccountById,
    getAccountByPlatform,
    addAccount,
    updateAccountStatus,
    deleteAccount,
    upsertAccount,
    loadPosts,
    savePosts,
    getPostById,
    upsertPost,
    deletePost,
    encryptCredentials,
    decryptCredentials,
    loadPublishHistory,
    getPublishHistoryByPostId,
    getPublishHistoryByAccountId
} from './storage.js';
import { getPlatform, getPlatformService, listPlatforms } from './services/platforms.js';
import { publishPost, retryPublish } from './publisher.js';
import { translateError, translateNetworkError } from './services/errorTranslator.js';
import { setLogLevel, getLogLevel, getLogHistory, clearLogHistory } from './utils/creatorHubLogger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dialog } from 'electron';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

function loadEnvCredentials() {
    try {
        const root = findProjectRoot(__dirname);
        const envPath = path.join(root, 'src', '.env');
        if (!fs.existsSync(envPath)) return null;

        const raw = fs.readFileSync(envPath, 'utf8');
        const env = {};
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eq = trimmed.indexOf('=');
            if (eq === -1) continue;
            const key = trimmed.slice(0, eq).trim();
            let value = trimmed.slice(eq + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            env[key] = value;
        }

        return {
            apiKey: env.X_API_KEY || '',
            apiSecret: env.X_API_SECRET || '',
            accessToken: env.X_ACCESS_TOKEN || '',
            accessTokenSecret: env.X_ACCESS_TOKEN_SECRET || '',
            username: env.X_USERNAME || '',
            blueskyAppSecret: env.BLUESKY_APP_SECRET || ''
        };
    } catch (err) {
        console.error('[CreatorHub] Failed to load env credentials:', err);
        return null;
    }
}

export function registerCreatorHubIpc(ipcMain) {
    // ==================== ACCOUNTS ====================

    ipcMain.handle('creator-hub:list-accounts', async () => {
        try {
            const accounts = await loadAccounts();
            // Return accounts without decrypted credentials
            const safeAccounts = accounts.map(({ encryptedCredentials, ...rest }) => rest);
            return { ok: true, accounts: safeAccounts };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('creator-hub:get-account', async (_event, { accountId }) => {
        try {
            const account = await getAccountById(accountId);
            if (!account) {
                return { ok: false, error: 'Account not found' };
            }
            // Return account without decrypted credentials
            const { encryptedCredentials, ...safeAccount } = account;
            return { ok: true, account: safeAccount };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('creator-hub:add-account', async (_event, { platform, username, displayName, credentials }) => {
        try {
            if (!platform || !username || !credentials) {
                return { ok: false, error: 'Platform, username, and credentials are required' };
            }

            // Check for duplicate account
            const existing = await getAccountByPlatform(platform);
            if (existing && existing.username === username) {
                return { ok: false, error: `Account for ${platform} with username ${username} already exists` };
            }

            // Get platform metadata for capabilities
            const platformMeta = getPlatform(platform);
            const capabilities = platformMeta?.capabilities || { text: true, images: false, video: false, maxChars: 0 };

            const account = await addAccount({ platform, username, displayName, credentials, capabilities });
            const { encryptedCredentials, ...safeAccount } = account;

            // Test connection immediately
            const service = getPlatformService(platform);
            const testResult = await service.testConnection({ ...safeAccount, credentials });

            if (testResult.valid) {
                const updated = {
                    ...account,
                    status: ACCOUNT_STATUS.CONNECTED,
                    username: testResult.username || account.username,
                    displayName: testResult.displayName || account.displayName,
                    lastUsed: new Date().toISOString()
                };
                validatePlatformAccount(updated);
                upsertAccount(updated);
                const { encryptedCredentials: _, ...finalSafeAccount } = updated;
                return { ok: true, account: finalSafeAccount, testResult };
            } else {
                const updated = {
                    ...account,
                    status: ACCOUNT_STATUS.ERROR
                };
                validatePlatformAccount(updated);
                upsertAccount(updated);
                const { encryptedCredentials: _, ...finalSafeAccount } = updated;
                const statusMatch = testResult.error.match(/HTTP (\d+)/);
                const statusCode = statusMatch ? statusMatch[1] : null;
                let translatedError = testResult.error;
                if (statusCode) {
                    const translated = translateError(statusCode, testResult.error);
                    translatedError = translated.message;
                } else {
                    const networkError = translateNetworkError(testResult.error);
                    translatedError = networkError.message;
                }
                return { ok: true, account: finalSafeAccount, testResult, warning: translatedError };
            }
        } catch (err) {
            const statusMatch = err.message.match(/HTTP (\d+)/);
            const statusCode = statusMatch ? statusMatch[1] : null;
            if (statusCode) {
                const translated = translateError(statusCode, err.message);
                return { ok: false, error: translated.message };
            }
            const networkError = translateNetworkError(err.message);
            return { ok: false, error: networkError.message };
        }
    });

    ipcMain.handle('creator-hub:authenticate-account', async (_event, { platform, username }) => {
        try {
            const service = getPlatformService(platform);
            const result = await service.authenticate({ username });

            if (result.success && result.credentials) {
                // Check for duplicate
                const existing = await getAccountByPlatform(platform);
                if (existing && existing.username === result.username) {
                    return { ok: false, error: `Account for ${platform} with username ${result.username} already exists` };
                }

                // Store account with encrypted credentials
                const encryptedCredentials = encryptCredentials(result.credentials);
                const platformMeta = getPlatform(platform);
                const capabilities = platformMeta?.capabilities || { text: true, images: false, video: false, maxChars: 0 };
                const account = createPlatformAccount({
                    id: `acc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    platform,
                    username: result.username,
                    displayName: result.username,
                    status: ACCOUNT_STATUS.CONNECTED,
                    encryptedCredentials,
                    capabilities
                });

                upsertAccount(account);
                const { encryptedCredentials: _, ...safeAccount } = account;
                return { ok: true, account: safeAccount };
            } else {
                return { ok: false, error: result.error || 'Authentication failed' };
            }
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('creator-hub:connect-account', async (_event, { accountId, credentials }) => {
        try {
            const account = await getAccountById(accountId);
            if (!account) {
                return { ok: false, error: 'Account not found' };
            }

            const service = getPlatformService(account.platform);
            const result = await service.connect(credentials);

            if (result.success) {
                // Update account with new credentials and status
                const encryptedCredentials = encryptCredentials(credentials);
                const updated = {
                    ...account,
                    encryptedCredentials,
                    status: ACCOUNT_STATUS.CONNECTED,
                    lastUsed: new Date().toISOString()
                };
                validatePlatformAccount(updated);
                upsertAccount(updated);
                const { encryptedCredentials: _, ...safeAccount } = updated;
                return { ok: true, account: safeAccount };
            } else {
                return { ok: false, error: result.error || 'Connection failed' };
            }
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('creator-hub:get-platforms', async () => {
        try {
            const platforms = listPlatforms();
            return { ok: true, platforms };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('creator-hub:test-account', async (_event, { accountId }) => {
        try {
            const account = await getAccountById(accountId);
            if (!account) {
                return { ok: false, error: 'Account not found' };
            }

            const decryptedCredentials = decryptCredentials(account.encryptedCredentials);
            const service = getPlatformService(account.platform);
            const result = await service.testConnection({ ...account, credentials: decryptedCredentials });

            if (result.valid) {
                const updated = {
                    ...account,
                    status: ACCOUNT_STATUS.CONNECTED,
                    username: result.username || account.username,
                    displayName: result.displayName || account.displayName,
                    lastUsed: new Date().toISOString()
                };
                validatePlatformAccount(updated);
                upsertAccount(updated);
                const { encryptedCredentials: _, ...safeAccount } = updated;
                return { ok: true, ...result, account: safeAccount };
            } else {
                const updated = {
                    ...account,
                    status: ACCOUNT_STATUS.ERROR
                };
                validatePlatformAccount(updated);
                upsertAccount(updated);
                const { encryptedCredentials: _, ...safeAccount } = updated;
                const statusMatch = result.error.match(/HTTP (\d+)/);
                const statusCode = statusMatch ? statusMatch[1] : null;
                let translatedError = result.error;
                if (statusCode) {
                    const translated = translateError(statusCode, result.error);
                    translatedError = translated.message;
                } else {
                    const networkError = translateNetworkError(result.error);
                    translatedError = networkError.message;
                }
                return { ok: true, ...result, account: safeAccount, error: translatedError };
            }
        } catch (err) {
            const statusMatch = err.message.match(/HTTP (\d+)/);
            const statusCode = statusMatch ? statusMatch[1] : null;
            if (statusCode) {
                const translated = translateError(statusCode, err.message);
                return { ok: false, error: translated.message };
            }
            const networkError = translateNetworkError(err.message);
            return { ok: false, error: networkError.message };
        }
    });

    ipcMain.handle('creator-hub:disconnect-account', async (_event, { accountId }) => {
        try {
            const account = await getAccountById(accountId);
            if (!account) {
                return { ok: false, error: 'Account not found' };
            }

            const decryptedCredentials = decryptCredentials(account.encryptedCredentials);
            const service = getPlatformService(account.platform);
            const result = await service.disconnect({ ...account, credentials: decryptedCredentials });

            if (result.success) {
                const updated = await updateAccountStatus(accountId, ACCOUNT_STATUS.DISCONNECTED);
                const { encryptedCredentials, ...safeAccount } = updated;
                return { ok: true, account: safeAccount };
            } else {
                return { ok: false, error: result.error || 'Disconnect failed' };
            }
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('creator-hub:remove-account', async (_event, { accountId }) => {
        try {
            const existing = await getAccountById(accountId);
            if (!existing) {
                return { ok: false, error: 'Account not found' };
            }
            await deleteAccount(accountId);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // ==================== POSTS ====================

    ipcMain.handle('creator-hub:list-posts', async () => {
        try {
            const posts = await loadPosts();
            return { ok: true, posts };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('creator-hub:get-post', async (_event, { postId }) => {
        try {
            const post = await getPostById(postId);
            if (!post) {
                return { ok: false, error: 'Post not found' };
            }
            return { ok: true, post };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('creator-hub:open-file-dialog', async () => {
        try {
            const result = await dialog.showOpenDialog({
                properties: ['openFile', 'multiSelections'],
                filters: [
                    { name: 'Media', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'mov', 'webm'] },
                    { name: 'All Files', extensions: ['*'] }
                ]
            });
            if (result.canceled) {
                return { ok: true, files: [] };
            }
            return { ok: true, files: result.filePaths };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('creator-hub:create-post', async (_event, postData) => {
        try {
            validatePost(postData);
            const post = createPost(postData);
            await upsertPost(post);
            return { ok: true, post };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('creator-hub:update-post', async (_event, { postId, changes }) => {
        try {
            const existing = await getPostById(postId);
            if (!existing) {
                return { ok: false, error: 'Post not found' };
            }
            const updated = { ...existing, ...changes };
            validatePost(updated);
            await upsertPost(updated);
            return { ok: true, post: updated };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('creator-hub:delete-post', async (_event, { postId }) => {
        try {
            const existing = await getPostById(postId);
            if (!existing) {
                return { ok: false, error: 'Post not found' };
            }
            await deletePost(postId);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // ==================== PUBLISH ====================

    ipcMain.handle('creator-hub:publish', async (_event, { postId }) => {
        try {
            const post = await getPostById(postId);
            if (!post) {
                return { ok: false, error: 'Post not found' };
            }
            const summary = await publishPost(post);
            return { ok: true, summary };
        } catch (err) {
            const statusMatch = err.message.match(/HTTP (\d+)/);
            const statusCode = statusMatch ? statusMatch[1] : null;
            if (statusCode) {
                const translated = translateError(statusCode, err.message);
                return { ok: false, error: translated.message };
            }
            const networkError = translateNetworkError(err.message);
            return { ok: false, error: networkError.message };
        }
    });

    // ==================== PLATFORMS ====================

    ipcMain.handle('creator-hub:list-platforms', async () => {
        try {
            return { ok: true, platforms: listPlatforms() };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('creator-hub:get-env-credentials', async () => {
        try {
            const credentials = loadEnvCredentials();
            if (!credentials) {
                return { ok: false, error: 'No .env file found' };
            }
            return { ok: true, credentials };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('creator-hub:get-platform-capabilities', async (_event, { platform }) => {
        try {
            const service = getPlatformService(platform);
            const capabilities = service.getCapabilities();
            return { ok: true, capabilities };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // ==================== LOGGING ====================

    ipcMain.handle('creator-hub:set-log-level', async (_event, { level }) => {
        try {
            setLogLevel(level);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('creator-hub:get-log-level', async () => {
        try {
            return { ok: true, level: getLogLevel() };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('creator-hub:get-log-history', async () => {
        try {
            const history = getLogHistory();
            return { ok: true, history };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('creator-hub:clear-log-history', async () => {
        try {
            clearLogHistory();
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('creator-hub:retry-publish', async (_event, { historyEntryId }) => {
        try {
            const result = await retryPublish(historyEntryId);
            return { ok: result.success, ...result };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    // ==================== PUBLISH HISTORY ====================

    ipcMain.handle('creator-hub:list-publish-history', async () => {
        try {
            const history = await loadPublishHistory();
            return { ok: true, history };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('creator-hub:get-publish-history', async (_event, { postId, accountId }) => {
        try {
            if (postId) {
                const history = await getPublishHistoryByPostId(postId);
                return { ok: true, history };
            }
            if (accountId) {
                const history = await getPublishHistoryByAccountId(accountId);
                return { ok: true, history };
            }
            return { ok: false, error: 'postId or accountId required' };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('creator-hub:read-file', async (_event, { filePath }) => {
        try {
            const data = fs.readFileSync(filePath);
            const base64 = data.toString('base64');
            return { ok: true, data: base64 };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });
}
