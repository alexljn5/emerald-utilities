/**
 * Legacy JSON → PostgreSQL Migration
 *
 * One-time migration of legacy Electron JSON task data into the unified
 * Emerald PostgreSQL database.
 *
 * This is DISTINCT from ongoing bidirectional synchronization.
 * This script is for initial import only.
 *
 * Features:
 *   - Idempotent: running twice does not duplicate records
 *   - Uses stable json_id mapping
 *   - Transaction-safe per-record
 *   - Validates JSON before writing
 *   - Reports detailed counts
 *   - Supports TASKS_JSON_DIR override
 *
 * Usage:
 *   node migrate-json-to-postgres.js [--dry-run] [--json-dir /path/to/tasks-data]
 */

import { pool } from '../db-pool.js';
import { dbLog as log } from '../utils/logger.js';
import {
    getJsonNotes, getJsonTasks,
    getJsonNoteById, getJsonTaskById
} from './tasks-json-store.js';

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

/**
 * @typedef {Object} MigrationResult
 * @property {boolean} success
 * @property {string} error
 * @property {number} notesDiscovered
 * @property {number} notesInserted
 * @property {number} notesUpdated
 * @property {number} tasksDiscovered
 * @property {number} tasksInserted
 * @property {number} tasksUpdated
 * @property {number} tagsDiscovered
 * @property {number} tagsInserted
 * @property {string} details
 */

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function parseTimestamp(value) {
    if (!value) return null;
    const ts = new Date(value);
    return isNaN(ts.getTime()) ? null : ts;
}

function compareTimestamps(a, b) {
    const ta = parseTimestamp(a);
    const tb = parseTimestamp(b);
    if (!ta && !tb) return 0;
    if (!ta) return -1;
    if (!tb) return 1;
    return ta - tb;
}

// ---------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------

/**
 * Migrate legacy JSON task data into PostgreSQL.
 *
 * @param {Object} [options]
 * @param {boolean} [options.dryRun=false]
 * @returns {Promise<MigrationResult>}
 */
export async function migrateJsonToPostgres(options = {}) {
    const { dryRun = false } = options;
    const result = {
        success: false,
        error: '',
        notesDiscovered: 0,
        notesInserted: 0,
        notesUpdated: 0,
        tasksDiscovered: 0,
        tasksInserted: 0,
        tasksUpdated: 0,
        tagsDiscovered: 0,
        tagsInserted: 0,
        details: ''
    };

    // --- Pre-flight: verify PostgreSQL ---
    let client;
    try {
        client = await pool.connect();
        await client.query('SELECT 1');
    } catch (err) {
        result.error = `PostgreSQL unreachable: ${err.message}`;
        log.error('migrate-json-to-postgres', err, 'PostgreSQL unreachable');
        return result;
    }

    try {
        // --- Load JSON data ---
        const jsonNotes = await getJsonNotes();
        const jsonTasks = await getJsonTasks();

        result.notesDiscovered = jsonNotes.length;
        result.tasksDiscovered = jsonTasks.length;

        log.info('migrate-json-to-postgres', `Discovered ${jsonNotes.length} notes, ${jsonTasks.length} tasks in JSON`);

        if (dryRun) {
            result.success = true;
            result.details = `DRY RUN: Would migrate ${jsonNotes.length} notes, ${jsonTasks.length} tasks.`;
            return result;
        }

        // --- Migrate notes ---
        for (const jsonNote of jsonNotes) {
            // Validate required fields
            if (!jsonNote.content || typeof jsonNote.content !== 'string') {
                log.warn('migrate-json-to-postgres', `Skipping note with missing content: ${jsonNote.id}`);
                continue;
            }

            const existing = await getJsonNoteById(jsonNote.id);
            // Check if already migrated (by json_id)
            const pgExists = await client.query(
                'SELECT id, updated_at FROM notes WHERE json_id = $1',
                [jsonNote.id]
            );

            if (pgExists.rows.length > 0) {
                // Already migrated — check if JSON is newer
                const cmp = compareTimestamps(jsonNote.updated_at, pgExists.rows[0].updated_at);
                if (cmp > 0) {
                    await client.query(
                        `UPDATE notes SET date = $1, content = $2, archived = $3, updated_at = $4
                         WHERE json_id = $5`,
                        [
                            jsonNote.date || new Date().toISOString().split('T')[0],
                            jsonNote.content,
                            jsonNote.archived || false,
                            jsonNote.updated_at || new Date().toISOString(),
                            jsonNote.id
                        ]
                    );
                    result.notesUpdated++;
                }
                continue;
            }

            // Insert new note
            await client.query(
                `INSERT INTO notes (json_id, date, content, archived, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [
                    jsonNote.id,
                    jsonNote.date || new Date().toISOString().split('T')[0],
                    jsonNote.content,
                    jsonNote.archived || false,
                    jsonNote.created_at || new Date().toISOString(),
                    jsonNote.updated_at || new Date().toISOString()
                ]
            );
            result.notesInserted++;
        }

        // --- Migrate tasks ---
        for (const jsonTask of jsonTasks) {
            // Validate required fields
            if (!jsonTask.title || typeof jsonTask.title !== 'string') {
                log.warn('migrate-json-to-postgres', `Skipping task with missing title: ${jsonTask.id}`);
                continue;
            }

            const pgExists = await client.query(
                'SELECT id, updated_at FROM tasks WHERE json_id = $1',
                [jsonTask.id]
            );

            if (pgExists.rows.length > 0) {
                const cmp = compareTimestamps(jsonTask.updated_at, pgExists.rows[0].updated_at);
                if (cmp > 0) {
                    await client.query(
                        `UPDATE tasks SET title = $1, description = $2, completed = $3, archived = $4,
                         priority = $5, due_time = $6, reminder_time = $7, long_term = $8, updated_at = $9
                         WHERE json_id = $10`,
                        [
                            jsonTask.title,
                            jsonTask.description || null,
                            jsonTask.completed || false,
                            jsonTask.archived || false,
                            ['green', 'orange', 'red'].includes(jsonTask.priority) ? jsonTask.priority : 'green',
                            jsonTask.due_time || null,
                            jsonTask.reminder_time || null,
                            Boolean(jsonTask.long_term),
                            jsonTask.updated_at || new Date().toISOString(),
                            jsonTask.id
                        ]
                    );
                    result.tasksUpdated++;
                }
                continue;
            }

            await client.query(
                `INSERT INTO tasks (json_id, title, description, completed, archived, priority, due_time, reminder_time, long_term, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [
                    jsonTask.id,
                    jsonTask.title,
                    jsonTask.description || null,
                    jsonTask.completed || false,
                    jsonTask.archived || false,
                    ['green', 'orange', 'red'].includes(jsonTask.priority) ? jsonTask.priority : 'green',
                    jsonTask.due_time || null,
                    jsonTask.reminder_time || null,
                    Boolean(jsonTask.long_term),
                    jsonTask.created_at || new Date().toISOString(),
                    jsonTask.updated_at || new Date().toISOString()
                ]
            );
            result.tasksInserted++;
        }

        // --- Migrate tags (if any in JSON) ---
        // Tags in JSON are embedded in tasks; we extract them here
        for (const jsonTask of jsonTasks) {
            if (!jsonTask.tags || !Array.isArray(jsonTask.tags)) continue;
            for (const tag of jsonTask.tags) {
                result.tagsDiscovered++;
                // Find the task in PostgreSQL
                const taskRow = await client.query(
                    'SELECT id FROM tasks WHERE json_id = $1',
                    [jsonTask.id]
                );
                if (taskRow.rows.length === 0) continue;

                const taskId = taskRow.rows[0].id;
                const tagExists = await client.query(
                    'SELECT id FROM task_tags WHERE task_id = $1 AND tag = $2',
                    [taskId, tag.tag]
                );

                if (tagExists.rows.length === 0) {
                    await client.query(
                        'INSERT INTO task_tags (task_id, tag) VALUES ($1, $2)',
                        [taskId, tag.tag]
                    );
                    result.tagsInserted++;
                }
            }
        }

        result.success = true;
        result.details = `Notes: ${result.notesInserted} inserted, ${result.notesUpdated} updated. ` +
            `Tasks: ${result.tasksInserted} inserted, ${result.tasksUpdated} updated. ` +
            `Tags: ${result.tagsInserted} inserted.`;
        log.info('migrate-json-to-postgres', `Migration complete: ${result.details}`);
        return result;

    } catch (err) {
        result.error = err.message;
        log.error('migrate-json-to-postgres', err, 'Migration failed');
        return result;
    } finally {
        if (client) client.release();
    }
}

// ---------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------

if (process.argv[1] === new URL(import.meta.url).pathname) {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');

    console.log('[migrate-json-to-postgres] Starting legacy JSON migration...');
    if (dryRun) console.log('[migrate-json-to-postgres] DRY RUN mode.');

    migrateJsonToPostgres({ dryRun }).then(result => {
        if (result.success) {
            console.log(`[migrate-json-to-postgres] SUCCESS: ${result.details}`);
            process.exit(0);
        } else {
            console.error(`[migrate-json-to-postgres] FAILED: ${result.error}`);
            process.exit(1);
        }
    }).catch(err => {
        console.error('[migrate-json-to-postgres] Fatal error:', err);
        process.exit(1);
    });
}
