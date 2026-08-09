/**
 * Legacy JSON → PostgreSQL Migration
 *
 * Safely migrates existing local JSON notes/tasks into the canonical
 * PostgreSQL database. Idempotent: uses json_id uniqueness to prevent
 * duplicates on re-run.
 *
 * This is a ONE-TIME migration. After successful completion:
 *   - PostgreSQL is the authoritative source for Notes/Tasks.
 *   - JSON files remain as a recovery mirror (not deleted).
 *   - A migration marker is written to database_meta.
 *
 * Usage:
 *   node src/database/tasks/migrate-legacy-json.js
 *   # or via IPC from the renderer
 */

import { pool } from '../db-pool.js';
import { dbLog as log } from '../../utils/logger.js';
import {
    getJsonNotes,
    getJsonTasks,
    getJsonNoteById,
    getJsonTaskById,
} from './tasks-json-store.js';

// ============================================================
// Configuration
// ============================================================

const MIGRATION_MARKER_KEY = 'legacy_json_migration_v1';
const BATCH_SIZE = 100;

// ============================================================
// Helpers
// ============================================================

function generateJsonId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function getMigrationMarker() {
    try {
        const result = await pool.query(
            'SELECT value FROM database_meta WHERE key = $1',
            [MIGRATION_MARKER_KEY]
        );
        return result.rows[0]?.value || null;
    } catch {
        return null;
    }
}

async function setMigrationMarker(data) {
    await pool.query(
        `INSERT INTO database_meta (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET
             value = EXCLUDED.value,
             updated_at = EXCLUDED.updated_at`,
        [MIGRATION_MARKER_KEY, data]
    );
}

// ============================================================
// Migration
// ============================================================

export async function migrateLegacyJson(options = {}) {
    const { dryRun = false, force = false } = options;
    const result = {
        success: false,
        dryRun,
        skipped: false,
        notesDiscovered: 0,
        notesImported: 0,
        notesSkipped: 0,
        notesFailed: 0,
        tasksDiscovered: 0,
        tasksImported: 0,
        tasksSkipped: 0,
        tasksFailed: 0,
        tagsImported: 0,
        tagsSkipped: 0,
        tagsFailed: 0,
        error: '',
        details: {},
    };

    // --- Pre-flight: verify PostgreSQL ---
    let client;
    try {
        client = await pool.connect();
        await client.query('SELECT 1');
    } catch (err) {
        result.error = `PostgreSQL unreachable: ${err.message}`;
        log.error('migrate-legacy-json', err, 'Migration aborted: DB unreachable');
        return result;
    }

    try {
        // --- Check if already migrated ---
        const existingMarker = await getMigrationMarker();
        if (existingMarker && !force) {
            result.skipped = true;
            result.success = true;
            result.details = {
                message: 'Migration already completed',
                marker: existingMarker,
            };
            log.info('migrate-legacy-json', 'Migration skipped: already completed');
            return result;
        }

        // --- Load JSON data ---
        log.info('migrate-legacy-json', 'Loading legacy JSON data...');
        const jsonNotes = await getJsonNotes();
        const jsonTasks = await getJsonTasks();
        result.notesDiscovered = jsonNotes.filter(n => !n._deleted).length;
        result.tasksDiscovered = jsonTasks.filter(t => !t._deleted).length;

        if (result.notesDiscovered === 0 && result.tasksDiscovered === 0) {
            result.skipped = true;
            result.success = true;
            result.details = { message: 'No legacy JSON data found' };
            log.info('migrate-legacy-json', 'No legacy data to migrate');
            return result;
        }

        if (dryRun) {
            result.success = true;
            result.details = {
                message: 'Dry run complete',
                notesDiscovered: result.notesDiscovered,
                tasksDiscovered: result.tasksDiscovered,
            };
            log.info('migrate-legacy-json', `Dry run: ${result.notesDiscovered} notes, ${result.tasksDiscovered} tasks would be migrated`);
            return result;
        }

        // --- Check existing PostgreSQL data ---
        const pgNotesResult = await client.query('SELECT COUNT(*) as count FROM notes');
        const pgTasksResult = await client.query('SELECT COUNT(*) as count FROM tasks');
        const existingPgNotes = parseInt(pgNotesResult.rows[0].count, 10);
        const existingPgTasks = parseInt(pgTasksResult.rows[0].count, 10);

        log.info('migrate-legacy-json', `Existing PostgreSQL: ${existingPgNotes} notes, ${existingPgTasks} tasks`);

        // --- Migrate Notes ---
        for (const jsonNote of jsonNotes) {
            if (jsonNote._deleted) {
                result.notesSkipped++;
                continue;
            }

            try {
                // Check if already migrated (by json_id)
                const existing = await client.query(
                    'SELECT id FROM notes WHERE json_id = $1',
                    [jsonNote.id]
                );

                if (existing.rows.length > 0) {
                    result.notesSkipped++;
                    continue;
                }

                // Insert note
                await client.query(
                    `INSERT INTO notes (json_id, date, content, archived, created_at, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [
                        jsonNote.id,
                        jsonNote.date || new Date().toISOString().split('T')[0],
                        jsonNote.content || '',
                        jsonNote.archived || false,
                        jsonNote.created_at || new Date().toISOString(),
                        jsonNote.updated_at || new Date().toISOString(),
                    ]
                );
                result.notesImported++;
            } catch (err) {
                log.error('migrate-legacy-json', err, `Failed to migrate note ${jsonNote.id}`);
                result.notesFailed++;
            }
        }

        // --- Migrate Tasks ---
        for (const jsonTask of jsonTasks) {
            if (jsonTask._deleted) {
                result.tasksSkipped++;
                continue;
            }

            try {
                // Check if already migrated
                const existing = await client.query(
                    'SELECT id FROM tasks WHERE json_id = $1',
                    [jsonTask.id]
                );

                if (existing.rows.length > 0) {
                    result.tasksSkipped++;
                    continue;
                }

                // Insert task
                const taskResult = await client.query(
                    `INSERT INTO tasks (json_id, title, description, completed, archived, priority, due_time, reminder_time, long_term, created_at, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                     RETURNING id`,
                    [
                        jsonTask.id,
                        jsonTask.title || 'Untitled',
                        jsonTask.description || null,
                        jsonTask.completed || false,
                        jsonTask.archived || false,
                        ['green', 'orange', 'red'].includes(jsonTask.priority) ? jsonTask.priority : 'green',
                        jsonTask.due_time || null,
                        jsonTask.reminder_time || null,
                        Boolean(jsonTask.long_term),
                        jsonTask.created_at || new Date().toISOString(),
                        jsonTask.updated_at || new Date().toISOString(),
                    ]
                );

                const taskId = taskResult.rows[0].id;
                result.tasksImported++;

                // Migrate tags if present
                if (jsonTask.tags && Array.isArray(jsonTask.tags)) {
                    for (const tag of jsonTask.tags) {
                        try {
                            await client.query(
                                `INSERT INTO task_tags (task_id, tag)
                                 VALUES ($1, $2)
                                 ON CONFLICT (task_id, tag) DO NOTHING
                                 RETURNING id`,
                                [taskId, tag.tag || tag]
                            );
                            result.tagsImported++;
                        } catch (tagErr) {
                            log.error('migrate-legacy-json', tagErr, `Failed to migrate tag for task ${jsonTask.id}`);
                            result.tagsFailed++;
                        }
                    }
                }
            } catch (err) {
                log.error('migrate-legacy-json', err, `Failed to migrate task ${jsonTask.id}`);
                result.tasksFailed++;
            }
        }

        // --- Record migration marker ---
        const markerData = {
            completedAt: new Date().toISOString(),
            sourceFiles: ['notes.json', 'tasks.json'],
            notesImported: result.notesImported,
            notesSkipped: result.notesSkipped,
            notesFailed: result.notesFailed,
            tasksImported: result.tasksImported,
            tasksSkipped: result.tasksSkipped,
            tasksFailed: result.tasksFailed,
            tagsImported: result.tagsImported,
            tagsSkipped: result.tagsSkipped,
            tagsFailed: result.tagsFailed,
            existingPgNotesBefore: existingPgNotes,
            existingPgTasksBefore: existingPgTasks,
            version: '1.0.0',
        };

        await setMigrationMarker(markerData);
        result.success = true;
        result.details = markerData;

        const summary = `Migration complete: ${result.notesImported} notes, ${result.tasksImported} tasks, ${result.tagsImported} tags imported. ` +
            `Skipped: ${result.notesSkipped} notes, ${result.tasksSkipped} tasks. ` +
            `Failed: ${result.notesFailed} notes, ${result.tasksFailed} tasks, ${result.tagsFailed} tags.`;
        log.info('migrate-legacy-json', summary);
        result.details.summary = summary;

    } catch (err) {
        result.error = err.message;
        log.error('migrate-legacy-json', err, 'Migration failed');
    } finally {
        if (client) client.release();
    }

    return result;
}

// ============================================================
// CLI Entry Point
// ============================================================

if (import.meta.url === `file://${process.argv[1]}`) {
    (async () => {
        const result = await migrateLegacyJson();
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.success ? 0 : 1);
    })();
}
