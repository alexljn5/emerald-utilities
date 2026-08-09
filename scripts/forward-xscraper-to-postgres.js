/**
 * Reconcile the LOCAL XScraper store into the remote PostgreSQL database.
 *
 * XSCRAPER ONLY.
 *
 * This is idempotent: running it repeatedly over the same local dataset
 * converges to pending_to_insert = 0 / inserted = 0. It never deletes data and
 * never re-sends messages PostgreSQL already has.
 *
 * Local sources (see src/database/xscraper-local-source.js):
 *   - SQLite  %APPDATA%/.xscraper/x_messages.db   (authoritative, server-written)
 *   - JSON    src/database/grok/messages/*.json   (legacy exports, optional)
 *
 * Usage:
 *   node scripts/forward-xscraper-to-postgres.js
 *   node scripts/forward-xscraper-to-postgres.js --conversation <id>
 *   node scripts/forward-xscraper-to-postgres.js --dry-run
 *   node scripts/forward-xscraper-to-postgres.js --json-dir <path>
 *   node scripts/forward-xscraper-to-postgres.js --sqlite <path>
 */

import { readLocalXScraperSource } from '../src/database/xscraper-local-source.js';
import { reconcileScrapedMessages } from '../src/database/xscraper-sync.js';
import { pool, connectionInfo } from '../src/database/db-pool.js';

function parseArgs(argv) {
    const args = { conversation: null, dryRun: false, jsonDir: null, sqlite: null };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--conversation' || a === '-c') args.conversation = argv[++i];
        else if (a === '--dry-run' || a === '-n') args.dryRun = true;
        else if (a === '--json-dir') args.jsonDir = argv[++i];
        else if (a === '--sqlite') args.sqlite = argv[++i];
        else if (!a.startsWith('-') && !args.jsonDir) args.jsonDir = a; // legacy positional
    }
    return args;
}

const L = (label, value) => `${String(label).padEnd(24)}${value}`;

async function main() {
    const args = parseArgs(process.argv);

    console.log('[xscraper-forward] ==========================================');
    console.log('[xscraper-forward] ' + L('PostgreSQL target:', `${connectionInfo.user}@${connectionInfo.host}:${connectionInfo.port}/${connectionInfo.database}`));
    if (args.dryRun) console.log('[xscraper-forward] DRY RUN — no writes will be performed');

    const local = await readLocalXScraperSource({
        conversationId: args.conversation,
        sqlitePath: args.sqlite,
        jsonDir: args.jsonDir,
    });

    console.log('[xscraper-forward] ' + L('SQLite source:', `${local.sources.sqlite.path} (available=${local.sources.sqlite.available}, messages=${local.sources.sqlite.total})`));
    console.log('[xscraper-forward] ' + L('JSON source:', `${local.sources.json.path} (available=${local.sources.json.available}, messages=${local.sources.json.total})`));

    if (local.byConversation.size === 0) {
        console.log('[xscraper-forward] No locally stored XScraper messages found — nothing to reconcile.');
        console.log('[xscraper-forward] pending_to_insert=0 (converged)');
        return 0;
    }

    const totals = {
        localTotal: 0, alreadyInPostgres: 0, pendingToInsert: 0,
        inserted: 0, skipped: 0, invalid: 0, duplicatesInLocalSource: 0, failures: 0,
    };

    for (const [conversationId, messages] of local.byConversation) {
        const title = local.titles.get(conversationId) || 'Scraped Conversation';
        console.log(`\n[xscraper-forward] --- conversation ${conversationId} (${messages.length} local messages) ---`);

        const stats = await reconcileScrapedMessages(messages, conversationId, title, { dryRun: args.dryRun });

        if (!stats.success) {
            totals.failures++;
            console.error(`[xscraper-forward] FAILED: ${stats.error}`);
            console.error('[xscraper-forward] checkpoint NOT advanced; local messages retained for retry');
            continue;
        }

        totals.localTotal += stats.localTotal;
        totals.alreadyInPostgres += stats.alreadyInPostgres;
        totals.pendingToInsert += stats.pendingToInsert;
        totals.inserted += stats.inserted;
        totals.skipped += stats.skipped;
        totals.invalid += stats.invalid;
        totals.duplicatesInLocalSource += stats.duplicatesInLocalSource;

        console.log('[xscraper-forward] ' + L('local_total', stats.localTotal));
        console.log('[xscraper-forward] ' + L('already_in_postgres', stats.alreadyInPostgres));
        console.log('[xscraper-forward] ' + L('pending_to_insert', stats.pendingToInsert));
        console.log('[xscraper-forward] ' + L('inserted', stats.inserted));
        console.log('[xscraper-forward] ' + L('skipped', stats.skipped));
        console.log('[xscraper-forward] ' + L('invalid', stats.invalid));
        console.log('[xscraper-forward] ' + L('duplicates_in_local', stats.duplicatesInLocalSource));
        console.log('[xscraper-forward] ' + L('postgres_total_after', stats.postgresTotalAfter));
        console.log('[xscraper-forward] ' + L('checkpoint', stats.checkpoint
            ? `savedAt=${stats.checkpoint.last_source_savedat} confirmed=${stats.checkpoint.confirmed_count} at=${stats.checkpoint.last_synced_at?.toISOString?.() || stats.checkpoint.last_synced_at}`
            : '(none)'));
    }

    console.log('\n[xscraper-forward] ================ TOTALS ================');
    for (const [k, v] of Object.entries(totals)) console.log('[xscraper-forward] ' + L(k, v));
    const remaining = totals.pendingToInsert - totals.inserted;
    console.log('[xscraper-forward] ' + L('pending_after_run', args.dryRun ? totals.pendingToInsert : remaining));
    console.log('[xscraper-forward] ========================================');

    return totals.failures > 0 ? 1 : 0;
}

main()
    .then(async (code) => { await pool.end(); process.exit(code); })
    .catch(async (err) => {
        console.error('[xscraper-forward] Fatal error:', err);
        await pool.end();
        process.exit(1);
    });
