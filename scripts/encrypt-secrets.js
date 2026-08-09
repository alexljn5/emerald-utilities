/**
 * Utility script to encrypt sensitive values using Electron's safeStorage.
 * Run with: npx electron scripts/encrypt-secrets.js
 *
 * Secrets are read from the single source of truth (src/.env) rather than
 * being hardcoded here. Ensure src/.env is populated before running.
 */
import { app, safeStorage } from 'electron';
import { config as loadDotenv } from 'dotenv';
import path from 'path';

// Load the single .env source of truth.
loadDotenv({ path: path.join(process.cwd(), 'src', '.env') });

app.whenReady().then(() => {
    if (!safeStorage.isEncryptionAvailable()) {
        console.error('ERROR: OS-level encryption is not available on this system.');
        console.error('safeStorage requires either a keychain (macOS), Credential Manager (Windows), or libsecret (Linux).');
        process.exit(1);
    }

    // NOTE: Database credentials now live exclusively in src/.env and are
    // read directly by db-pool.js (env overrides config.json). Only optional
    // cloud provider API keys are encrypted into config.json here.
    const secretsToEncrypt = {
        'providers.grok.apiKey': process.env.GROK_API_KEY || '',
        'providers.openai.apiKey': process.env.OPENAI_API_KEY || ''
    };

    console.log('\nEncrypted values (replace these in src/database/config.json):\n');
    console.log('{');

    for (const [path, value] of Object.entries(secretsToEncrypt)) {
        if (!value) {
            console.log(`  "${path}": ""  // (empty, no encryption needed)`);
            continue;
        }
        const encrypted = safeStorage.encryptString(value);
        const base64 = Buffer.from(encrypted).toString('base64');
        console.log(`  "${path}": "encrypted:${base64}"`);
    }

    console.log('}');
    console.log('\nCopy these values into src/database/config.json');
    app.exit(0);
});
