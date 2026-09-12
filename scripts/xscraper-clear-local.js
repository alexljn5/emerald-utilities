/**
 * Clear the LOCAL XScraper store from the command line.
 *
 * XSCRAPER ONLY. PostgreSQL is never touched — everything already reconciled
 * into grok_messages stays there. Because reconciliation is identity based
 * (conversation_id + source_message_id), wiping the local cache can never
 * produce duplicates when the same messages are scraped again.
 *
 * Layers:
 *   sqlite   %APPDATA%/.xscraper/x_messages.db   (local server cache)
 *   json     src/database/grok/*.json and src/database/grok/messages/*.json
 *   indexeddb  NOT reachable from Node — use the "Clear Local Store" button
 *              in the Internet page, which clears the persist:xscraper session.
 *
 * Usage:
 *   node scripts/xscraper-clear-local.js --dry-run
 *   node scripts/xscraper-clear-local.js
 *   node scripts/xscraper-clear-local.js --sqlite-only
 *   node scripts/xscraper-clear-local.js --json-only
 */

import path from 'path';
import { existsSync, readdirSync, unlinkSync } from 'fs';
import {
    clearSqliteStore,
    readSqliteSource,
    defaultSqlitePath,
    defaultJsonDir,
} from '../src/database/xscraper-local-source.js';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const sqliteOnly = argv.includes('--sqlite-only');
const jsonOnly = argv.includes('--json-only');

const doSqlite = !jsonOnly;
const doJson = !sqliteOnly;

const line = (s = '') => console.log(s);
const kv = (k, v) => line(`  ${String(k).padEnd(26)}${v}`);

function jsonFiles() {
    const files = [];
    const messagesDir = defaultJsonDir();
    const rootDir = path.join(process.cwd(), 'src', 'database', 'grok');
    for (const dir of [messagesDir, rootDir]) {
        if (!existsSync(dir)) continue;
        for (const f of readdirSync(dir).filter(n => n.endsWith('.json'))) {
            files.push(path.join(dir, f));
        }
    }
    return files;
}

async function main() {
    line('='.repeat(74));
    line(`XScraper local store ${dryRun ? 'inspection (dry run)' : 'wipe'}`);
    line('='.repeat(74));

    if (doSqlite) {
        const dbPath = defaultSqlitePath();
        const before = await readSqliteSource({ dbPath });
        kv('sqlite path', dbPath);
        kv('sqlite exists', existsSync(dbPath));
        kv('sqlite messages', before.total);

        if (!dryRun && existsSync(dbPath)) {
            const r = await clearSqliteStore({ dbPath });
            kv('messages deleted', r.messagesDeleted);
            kv('conversations deleted', r.conversationsDeleted);
            const after = await readSqliteSource({ dbPath });
            kv('sqlite messages after', after.total);
        }
    }

    if (doJson) {
        const files = jsonFiles();
        kv('json snapshot files', files.length);
        if (!dryRun) {
            let deleted = 0;
            for (const f of files) {
                try { unlinkSync(f); deleted++; } catch (err) { line(`  failed: ${f} (${err.message})`); }
            }
            kv('json files deleted', deleted);
        } else {
            for (const f of files.slice(0, 20)) line(`    ${f}`);
            if (files.length > 20) line(`    ... and ${files.length - 20} more`);
        }
    }

    line('');
    line(dryRun
        ? 'Dry run — nothing was deleted.'
        : 'Local store cleared. PostgreSQL was NOT touched.');
    line('Extension IndexedDB must be cleared from the app ("Clear Local Store" button).');
}

main().catch((err) => {
    console.error('[xscraper-clear-local] FAILED:', err);
    process.exit(1);
});
