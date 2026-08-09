// src/creator-hub/storage.js
// Simple JSON file persistence for Creator Hub.
// Main-process only. Uses fs, path, and Electron safeStorage.
// Lazy-loads Node.js modules so this file can be safely imported
// in the renderer process (functions are only called from main process).

import { CREATOR_HUB, ACCOUNT_STATUS } from '../globals.js';
import { createPlatformAccount, validatePlatformAccount } from './models.js';

// Lazy-loaded Node.js modules
let path = null;
let fs = null;

async function getPath() {
    if (!path) {
        path = (await import('path')).default || (await import('path'));
    }
    return path;
}

async function getFs() {
    if (!fs) {
        fs = (await import('fs')).default || (await import('fs'));
    }
    return fs;
}

async function getStorageDir() {
    const path = await getPath();
    // In dev, store next to the source. In production, use userData.
    if (process.env.VITE_DEV_SERVER_URL) {
        // __dirname equivalent for ESM
        let dir = path.dirname(new URL(import.meta.url).pathname);
        // On Windows, pathname starts with /C:/... so strip the leading slash
        if (dir.startsWith('/') && dir[2] === ':') {
            dir = dir.slice(1);
        }
        return path.join(dir, '..', '..', CREATOR_HUB.STORAGE_DIR);
    }
    const userData = process.env.APPDATA || process.env.HOME || process.env.USERPROFILE || '.';
    return path.join(userData, CREATOR_HUB.APP_NAME || 'Emerald Utilities', CREATOR_HUB.STORAGE_DIR);
}

async function getAccountsPath() {
    const path = await getPath();
    return path.join(await getStorageDir(), CREATOR_HUB.ACCOUNTS_FILE);
}

async function getPostsPath() {
    const path = await getPath();
    return path.join(await getStorageDir(), CREATOR_HUB.POSTS_FILE);
}

async function getPublishHistoryPath() {
    const path = await getPath();
    return path.join(await getStorageDir(), CREATOR_HUB.PUBLISH_HISTORY_FILE);
}

async function ensureStorageDir() {
    const fs = await getFs();
    const path = await getPath();
    const dir = await getStorageDir();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

async function readJson(filePath, fallback = []) {
    const fs = await getFs();
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (err) {
        console.error(`[CreatorHub] Failed to read ${filePath}:`, err.message);
        return fallback;
    }
}

async function writeJson(filePath, data) {
    const fs = await getFs();
    await ensureStorageDir();
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
}

// ==================== CREDENTIAL ENCRYPTION ====================

/**
 * Encrypt credentials using Electron safeStorage.
 * Falls back to base64 if safeStorage is unavailable.
 * @param {Record<string, unknown>} credentials
 * @returns {string}
 */
export function encryptCredentials(credentials) {
    const json = JSON.stringify(credentials);
    try {
        if (typeof safeStorage !== 'undefined' && safeStorage.isEncryptionAvailable) {
            const encrypted = safeStorage.encryptString(json);
            return `encrypted:${Buffer.from(encrypted).toString('base64')}`;
        }
    } catch (err) {
        console.error('[CreatorHub] Failed to encrypt credentials:', err.message);
    }
    // Fallback: base64 (not secure, but functional)
    return `plain:${Buffer.from(json).toString('base64')}`;
}

/**
 * Decrypt credentials.
 * @param {string} encryptedCredentials
 * @returns {Record<string, unknown>}
 */
export function decryptCredentials(encryptedCredentials) {
    if (!encryptedCredentials || typeof encryptedCredentials !== 'string') {
        return {};
    }

    if (encryptedCredentials.startsWith('encrypted:')) {
        const base64 = encryptedCredentials.slice('encrypted:'.length);
        try {
            if (typeof safeStorage !== 'undefined' && safeStorage.isDecryptionAvailable) {
                const buffer = Buffer.from(base64, 'base64');
                const decrypted = safeStorage.decryptString(buffer);
                return JSON.parse(decrypted);
            }
        } catch (err) {
            console.error('[CreatorHub] Failed to decrypt credentials:', err.message);
        }
        return {};
    }

    if (encryptedCredentials.startsWith('plain:')) {
        const base64 = encryptedCredentials.slice('plain:'.length);
        try {
            const json = Buffer.from(base64, 'base64').toString('utf8');
            return JSON.parse(json);
        } catch (err) {
            console.error('[CreatorHub] Failed to decode plain credentials:', err.message);
        }
        return {};
    }

    return {};
}

// ==================== ACCOUNTS ====================

export async function loadAccounts() {
    return readJson(await getAccountsPath(), []);
}

export async function saveAccounts(accounts) {
    writeJson(await getAccountsPath(), accounts);
}

export async function getAccountById(id) {
    const accounts = await loadAccounts();
    return accounts.find(a => a.id === id) || null;
}

export async function getAccountByPlatform(platform) {
    const accounts = await loadAccounts();
    return accounts.find(a => a.platform === platform) || null;
}

export async function upsertAccount(account) {
    const accounts = await loadAccounts();
    const idx = accounts.findIndex(a => a.id === account.id);
    if (idx >= 0) {
        accounts[idx] = { ...accounts[idx], ...account };
    } else {
        accounts.push(account);
    }
    await saveAccounts(accounts);
    return account;
}

export async function deleteAccount(id) {
    const accounts = (await loadAccounts()).filter(a => a.id !== id);
    await saveAccounts(accounts);
}

export async function addAccount({ platform, username, displayName, credentials, capabilities }) {
    // Check for duplicate
    const existing = await getAccountByPlatform(platform);
    if (existing && existing.username === username) {
        throw new Error(`Account for ${platform} with username ${username} already exists`);
    }

    const encryptedCredentials = encryptCredentials(credentials);
    const account = createPlatformAccount({
        id: `acc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        platform,
        username,
        displayName: displayName || username,
        status: ACCOUNT_STATUS.PENDING,
        encryptedCredentials,
        capabilities
    });

    await upsertAccount(account);
    return account;
}

export async function updateAccountStatus(accountId, status) {
    const account = await getAccountById(accountId);
    if (!account) {
        throw new Error('Account not found');
    }
    const updated = {
        ...account,
        status,
        lastUsed: status === ACCOUNT_STATUS.CONNECTED ? new Date().toISOString() : account.lastUsed
    };
    validatePlatformAccount(updated);
    await upsertAccount(updated);
    return updated;
}

// ==================== POSTS ====================

export async function loadPosts() {
    return readJson(await getPostsPath(), []);
}

export async function savePosts(posts) {
    writeJson(await getPostsPath(), posts);
}

export async function getPostById(id) {
    const posts = await loadPosts();
    return posts.find(p => p.id === id) || null;
}

export async function upsertPost(post) {
    const posts = await loadPosts();
    const idx = posts.findIndex(p => p.id === post.id);
    if (idx >= 0) {
        posts[idx] = { ...posts[idx], ...post };
    } else {
        posts.push(post);
    }
    await savePosts(posts);
    return post;
}

export async function deletePost(id) {
    const posts = (await loadPosts()).filter(p => p.id !== id);
    await savePosts(posts);
}

// ==================== PUBLISH HISTORY ====================

export async function loadPublishHistory() {
    return readJson(await getPublishHistoryPath(), []);
}

export async function savePublishHistory(history) {
    writeJson(await getPublishHistoryPath(), history);
}

export async function addPublishHistoryEntry(entry) {
    const history = await loadPublishHistory();
    history.push(entry);
    await savePublishHistory(history);
    return entry;
}

export async function getPublishHistoryByPostId(postId) {
    return (await loadPublishHistory()).filter(h => h.postId === postId);
}

export async function getPublishHistoryByAccountId(accountId) {
    return (await loadPublishHistory()).filter(h => h.accountId === accountId);
}
