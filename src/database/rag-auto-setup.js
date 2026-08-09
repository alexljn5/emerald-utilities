/**
 * RAG Auto-Setup Script
 * Automatically sets up RAG on app startup - checks if context exists, if not, populates and prepares
 *
 * Usage: node src/database/rag-auto-setup.js
 */

import { config } from 'dotenv';
import { pool } from './db-pool.js';
import { prepareForRAG } from './rag-prepare.js';
import { resolveEnvPath } from '../utils/pathResolver.js';
import { ragLog } from '../utils/logger.js';

// Load .env file. Single source of truth: src/.env (dev) / <resources>/.env (prod).
// override:true so our .env WINS over any pre-existing machine env var.
const envPath = resolveEnvPath();
config({ path: envPath, override: true });

/**
 * Return counts of total messages and messages that still need embeddings.
 */
async function getCounts() {
    const res = await pool.query(`
        SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded,
            COUNT(*) FILTER (WHERE embedding IS NULL)::int AS pending
        FROM grok_messages
    `);
    return res.rows[0];
}

/**
 * Run the populate script to import messages.
 * populateGrokMessages already skips import when the table is non-empty,
 * so this is safe to call unconditionally.
 */
import { populateGrokMessages } from './populate-from-raw.js';

async function populateMessages() {
    ragLog.info('[auto] Running populate-from-raw.js...');
    try {
        const result = await populateGrokMessages();
        ragLog.info('[auto] Population complete');
        return result;
    } catch (error) {
        ragLog.error('auto-populate', error);
        throw error;
    }
}

/**
 * Main auto-setup function
 * Returns: { ok: true, status: 'ready' | 'populated' | 'prepared' }
 */
export async function autoSetupRAG() {
    ragLog.info('[auto] Starting auto-setup...');

    try {
        // 1. Snapshot current state (also confirms DB connectivity).
        let counts = await getCounts();
        ragLog.info(
            `[auto] Current state: total=${counts.total}, ` +
            `embedded=${counts.embedded}, pending=${counts.pending}`
        );

        // 2. Everything already embedded -> nothing to do.
        if (counts.total > 0 && counts.pending === 0) {
            ragLog.info('[auto] All messages already embedded. Nothing to do.');
            return { ok: true, status: 'ready', ...counts };
        }

        // 3. Only import JSON when the database is EMPTY. Never re-import
        //    on top of existing data (prevents duplicates).
        let status = 'prepared';
        if (counts.total === 0) {
            ragLog.info('[auto] Database is empty — importing JSON files...');
            const result = await populateMessages();
            counts = await getCounts();
            ragLog.info(
                `[auto] After import: total=${counts.total}, pending=${counts.pending} ` +
                `(inserted ${result?.inserted ?? '?'})`
            );
            status = 'populated';

            if (counts.total === 0) {
                ragLog.warn('[auto] No messages imported (no JSON found?). Skipping embeddings.');
                return { ok: true, status: 'empty', ...counts };
            }
        } else {
            ragLog.info(
                `[auto] ${counts.total} messages present, ${counts.pending} need embeddings. ` +
                `Skipping import, generating missing embeddings only.`
            );
        }

        // 4. Generate embeddings for any messages still missing them.
        //    prepareForRAG processes up to 100 per call, so loop until done.
        let guard = 0;
        while (true) {
            const before = (await getCounts()).pending;
            if (before === 0) break;
            ragLog.info(`[auto] Embedding batch — ${before} messages pending...`);
            await prepareForRAG();
            const after = (await getCounts()).pending;
            if (after >= before) {
                ragLog.warn('[auto] No progress in last batch — stopping to avoid an infinite loop.');
                break;
            }
            if (++guard > 10000) {
                ragLog.warn('[auto] Safety guard hit — stopping embedding loop.');
                break;
            }
        }

        const final = await getCounts();
        ragLog.info(
            `[auto] Complete. total=${final.total}, embedded=${final.embedded}, pending=${final.pending}`
        );
        return { ok: true, status, ...final };
    } catch (error) {
        ragLog.error('auto-setup', error, 'RAG features may be unavailable; app continues');
        return { ok: false, error: error.message };
    }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    autoSetupRAG().then(result => {
        ragLog.info('[auto] Result:', result);
        // Only end pool when run directly (not when imported as module)
        pool.end().then(() => process.exit(result.ok ? 0 : 1));
    }).catch(error => {
        ragLog.error('auto-setup-fatal', error);
        pool.end().then(() => process.exit(1));
    });
}