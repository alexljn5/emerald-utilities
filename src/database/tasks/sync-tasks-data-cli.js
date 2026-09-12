#!/usr/bin/env node
/**
 * CLI wrapper for sync-tasks-data.js
 *
 * Runs JSON ↔ PostgreSQL reconciliation from the command line.
 * Used by sync-tasks-data.sh during system startup.
 *
 * Environment variables:
 *   TASKS_JSON_DIR - Override JSON file directory (default: auto-detected)
 *   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD - PostgreSQL connection
 */

import { pool } from '../db-pool.js';
import { reconcileTasksData } from './sync-tasks-data.js';

// Set default JSON dir if not provided (for CLI context)
if (!process.env.TASKS_JSON_DIR) {
    // In CLI context, default to a 'tasks-data' dir next to this script
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    process.env.TASKS_JSON_DIR = path.join(__dirname, 'tasks-data');
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const noBackup = args.includes('--no-backup');

    console.log('[sync-tasks-data] Starting JSON ↔ PostgreSQL reconciliation...');
    if (dryRun) console.log('[sync-tasks-data] DRY RUN mode — no changes will be made.');
    if (noBackup) console.log('[sync-tasks-data] Skipping JSON backups.');

    const result = await reconcileTasksData({
        dryRun,
        backupJson: !noBackup
    });

    if (result.success) {
        console.log(`[sync-tasks-data] SUCCESS: ${result.details}`);
        process.exit(0);
    } else {
        console.error(`[sync-tasks-data] FAILED: ${result.error}`);
        process.exit(1);
    }
}

main().catch(err => {
    console.error('[sync-tasks-data] Fatal error:', err);
    process.exit(1);
});
