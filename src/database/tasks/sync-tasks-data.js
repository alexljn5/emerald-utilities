/**
 * Tasks Data Synchronization — JSON ↔ PostgreSQL
 *
 * Bidirectional reconciliation with deterministic conflict resolution.
 *
 * Strategy:
 *   1. PostgreSQL is the primary operational store.
 *   2. JSON files are a durable recovery mirror.
 *   3. On sync: reconcile using timestamps (newer updated_at wins).
 *   4. Idempotent: stable json_id mapping prevents duplicates.
 *   5. Safe deletes: never infer deletion from absence.
 *
 * Uses the shared PostgreSQL pool from db-pool.js.
 */

import { pool } from '../db-pool.js';
import { dbLog as log } from '../../utils/logger.js';
import {
    getJsonNotes, getJsonTasks,
    writeJsonNotes, writeJsonTasks
} from './tasks-json-store.js';

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

/**
 * @typedef {Object} SyncResult
 * @property {boolean} success
 * @property {string} error
 * @property {number} notesImported
 * @property {number} tasksImported
 * @property {number} tagsImported
 * @property {number} notesUpdated
 * @property {number} tasksUpdated
 * @property {number} conflicts
 * @property {number} jsonRecordsAdded
 * @property {string} [details]
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
    if (!ta && !tb) return 0;      // both missing → equal
    if (!ta) return -1;             // a missing → b wins
    if (!tb) return 1;              // b missing → a wins
    return ta - tb;                 // negative = a older, positive = a newer
}

function generateJsonId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------------------------------------------------------------------
// Core reconciliation
// ---------------------------------------------------------------------

/**
 * Reconcile JSON and PostgreSQL task data.
 *
 * @param {Object} [options]
 * @param {boolean} [options.dryRun=false] - If true, report what would change without modifying data.
 * @param {boolean} [options.backupJson=true] - If true, create timestamped JSON backups before sync.
 * @returns {Promise<SyncResult>}
 */
export async function reconcileTasksData(options = {}) {
    const { dryRun = false, backupJson = true } = options;
    const result = {
        success: false,
        error: '',
        notesImported: 0,
        tasksImported: 0,
        tagsImported: 0,
        notesUpdated: 0,
        tasksUpdated: 0,
        conflicts: 0,
        jsonRecordsAdded: 0,
        details: ''
    };

    // --- Pre-flight: verify PostgreSQL is reachable ---
    let client;
    try {
        client = await pool.connect();
        await client.query('SELECT 1');
    } catch (err) {
        result.error = `PostgreSQL unreachable: ${err.message}`;
        log.error('sync-tasks-data', err, 'PostgreSQL unreachable during sync');
        return result;
    }

    try {
        // --- Create JSON backups if requested ---
        if (backupJson && !dryRun) {
            await backupJsonFiles();
        }

        // --- Load JSON data ---
        const jsonNotes = await getJsonNotes();
        const jsonTasks = await getJsonTasks();

        // --- Load PostgreSQL data ---
        const pgNotes = await loadPgNotes(client);
        const pgTasks = await loadPgTasks(client);
        const pgTags = await loadPgTags(client);

        // --- Build lookup maps ---
        // JSON: id -> record
        const jsonNoteMap = new Map();
        for (const note of jsonNotes) {
            if (note._deleted) continue; // skip explicitly deleted JSON records
            jsonNoteMap.set(note.id, note);
        }

        const jsonTaskMap = new Map();
        for (const task of jsonTasks) {
            if (task._deleted) continue;
            jsonTaskMap.set(task.id, task);
        }

        // PostgreSQL: json_id -> record (for records that came from JSON)
        // Also: uuid -> record (for all records)
        const pgNoteByJsonId = new Map();
        const pgNoteByUuid = new Map();
        for (const note of pgNotes) {
            pgNoteByUuid.set(note.id, note);
            if (note.json_id) {
                pgNoteByJsonId.set(note.json_id, note);
            }
        }

        const pgTaskByJsonId = new Map();
        const pgTaskByUuid = new Map();
        for (const task of pgTasks) {
            pgTaskByUuid.set(task.id, task);
            if (task.json_id) {
                pgTaskByJsonId.set(task.json_id, task);
            }
        }

        const pgTagByJsonId = new Map();
        const pgTagByUuid = new Map();
        for (const tag of pgTags) {
            pgTagByUuid.set(tag.id, tag);
            if (tag.json_id) {
                pgTagByJsonId.set(tag.json_id, tag);
            }
        }

        // --- Phase 1: JSON → PostgreSQL (import legacy / reconcile) ---
        const noteInserts = [];
        const noteUpdates = [];
        const taskInserts = [];
        const taskUpdates = [];
        const tagInserts = [];
        const tagUpdates = [];

        // Notes
        for (const jsonNote of jsonNotes) {
            if (jsonNote._deleted) continue;
            const existing = pgNoteByJsonId.get(jsonNote.id);
            if (!existing) {
                // New record from JSON → insert
                if (!dryRun) {
                    noteInserts.push({
                        json_id: jsonNote.id,
                        date: jsonNote.date,
                        content: jsonNote.content,
                        archived: jsonNote.archived || false,
                        created_at: jsonNote.created_at || new Date().toISOString(),
                        updated_at: jsonNote.updated_at || new Date().toISOString()
                    });
                }
                result.notesImported++;
            } else {
                // Existing record → compare timestamps
                const cmp = compareTimestamps(jsonNote.updated_at, existing.updated_at);
                if (cmp > 0) {
                    // JSON is newer → update PostgreSQL
                    if (!dryRun) {
                        noteUpdates.push({
                            id: existing.id,
                            date: jsonNote.date,
                            content: jsonNote.content,
                            archived: jsonNote.archived || false,
                            updated_at: jsonNote.updated_at
                        });
                    }
                    result.notesUpdated++;
                } else if (cmp < 0) {
                    // PostgreSQL is newer → will be reflected in JSON mirror later
                    // No action needed here
                } else {
                    // Timestamps equal → no change needed
                    // But if content differs, log conflict
                    if (jsonNote.content !== existing.content || jsonNote.date !== existing.date) {
                        result.conflicts++;
                        log.warn('sync-tasks-data', `Note conflict (same timestamp, different content): ${jsonNote.id}`);
                    }
                }
            }
        }

        // Tasks
        for (const jsonTask of jsonTasks) {
            if (jsonTask._deleted) continue;
            const existing = pgTaskByJsonId.get(jsonTask.id);
            if (!existing) {
                if (!dryRun) {
                    taskInserts.push({
                        json_id: jsonTask.id,
                        title: jsonTask.title,
                        description: jsonTask.description || null,
                        completed: jsonTask.completed || false,
                        archived: jsonTask.archived || false,
                        priority: ['green', 'orange', 'red'].includes(jsonTask.priority) ? jsonTask.priority : 'green',
                        due_time: jsonTask.due_time || null,
                        reminder_time: jsonTask.reminder_time || null,
                        long_term: Boolean(jsonTask.long_term),
                        created_at: jsonTask.created_at || new Date().toISOString(),
                        updated_at: jsonTask.updated_at || new Date().toISOString()
                    });
                }
                result.tasksImported++;
            } else {
                const cmp = compareTimestamps(jsonTask.updated_at, existing.updated_at);
                if (cmp > 0) {
                    if (!dryRun) {
                        taskUpdates.push({
                            id: existing.id,
                            title: jsonTask.title,
                            description: jsonTask.description || null,
                            completed: jsonTask.completed || false,
                            archived: jsonTask.archived || false,
                            priority: ['green', 'orange', 'red'].includes(jsonTask.priority) ? jsonTask.priority : 'green',
                            due_time: jsonTask.due_time || null,
                            reminder_time: jsonTask.reminder_time || null,
                            long_term: Boolean(jsonTask.long_term),
                            updated_at: jsonTask.updated_at
                        });
                    }
                    result.tasksUpdated++;
                } else if (cmp < 0) {
                    // PostgreSQL newer → reflected in JSON mirror later
                } else {
                    if (JSON.stringify({
                        title: jsonTask.title,
                        description: jsonTask.description,
                        completed: jsonTask.completed,
                        archived: jsonTask.archived,
                        priority: jsonTask.priority,
                        due_time: jsonTask.due_time,
                        reminder_time: jsonTask.reminder_time,
                        long_term: jsonTask.long_term
                    }) !== JSON.stringify({
                        title: existing.title,
                        description: existing.description,
                        completed: existing.completed,
                        archived: existing.archived,
                        priority: existing.priority,
                        due_time: existing.due_time,
                        reminder_time: existing.reminder_time,
                        long_term: existing.long_term
                    })) {
                        result.conflicts++;
                        log.warn('sync-tasks-data', `Task conflict (same timestamp, different content): ${jsonTask.id}`);
                    }
                }
            }
        }

        // Tags: tags are always derived from tasks in JSON, so we sync tags from PostgreSQL to JSON
        // But we also need to handle tags that exist in JSON (if any)
        // For now, tags are PostgreSQL-only in the current architecture
        // We'll count existing tags as "synced" during the mirror refresh

        // --- Execute inserts/updates ---
        if (!dryRun) {
            // Insert new notes
            for (const note of noteInserts) {
                await client.query(
                    `INSERT INTO notes (json_id, date, content, archived, created_at, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     RETURNING id`,
                    [note.json_id, note.date, note.content, note.archived, note.created_at, note.updated_at]
                );
            }

            // Update notes
            for (const note of noteUpdates) {
                await client.query(
                    `UPDATE notes SET date = $1, content = $2, archived = $3, updated_at = $4
                     WHERE id = $5`,
                    [note.date, note.content, note.archived, note.updated_at, note.id]
                );
            }

            // Insert new tasks
            for (const task of taskInserts) {
                await client.query(
                    `INSERT INTO tasks (json_id, title, description, completed, archived, priority, due_time, reminder_time, long_term, notification_policy, custom_interval_minutes, created_at, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                     RETURNING id`,
                    [
                        task.json_id, task.title, task.description, task.completed,
                        task.archived, task.priority, task.due_time, task.reminder_time,
                        task.long_term, task.notification_policy || 'daily', task.custom_interval_minutes || 60,
                        task.created_at, task.updated_at
                    ]
                );
            }

            // Update tasks
            for (const task of taskUpdates) {
                const fields = ['title = $1', 'description = $2', 'completed = $3', 'archived = $4',
                    'priority = $5', 'due_time = $6', 'reminder_time = $7', 'long_term = $8',
                    'updated_at = $9'];
                const params = [
                    task.title, task.description, task.completed, task.archived,
                    task.priority, task.due_time, task.reminder_time, task.long_term,
                    task.updated_at
                ];
                let idx = 10;
                if (task.notification_policy !== undefined) {
                    fields.push(`notification_policy = $${idx++}`);
                    params.push(task.notification_policy);
                }
                if (task.custom_interval_minutes !== undefined) {
                    fields.push(`custom_interval_minutes = $${idx++}`);
                    params.push(task.custom_interval_minutes);
                }
                params.push(task.id);
                await client.query(
                    `UPDATE tasks SET ${fields.join(', ')} WHERE id = $${idx}`,
                    params
                );
            }
        }

        // --- Phase 2: PostgreSQL → JSON mirror ---
        // Re-read PostgreSQL after reconciliation to get the authoritative state
        const refreshedNotes = await loadPgNotes(client);
        const refreshedTasks = await loadPgTasks(client);
        const refreshedTags = await loadPgTags(client);

        // Build JSON representations
        const newJsonNotes = [];
        for (const note of refreshedNotes) {
            // Assign json_id if missing (native PostgreSQL record)
            if (!note.json_id) {
                if (!dryRun) {
                    const newJsonId = generateJsonId();
                    await client.query('UPDATE notes SET json_id = $1 WHERE id = $2', [newJsonId, note.id]);
                    note.json_id = newJsonId;
                    result.jsonRecordsAdded++;
                }
            }
            newJsonNotes.push({
                id: note.json_id || note.id,
                date: note.date,
                content: note.content,
                archived: note.archived,
                created_at: note.created_at,
                updated_at: note.updated_at
            });
        }

        const newJsonTasks = [];
        // Build task ID -> tags map
        const tagsByTaskId = new Map();
        for (const tag of refreshedTags) {
            if (!tag.json_id) {
                if (!dryRun) {
                    const newJsonId = generateJsonId();
                    await client.query('UPDATE task_tags SET json_id = $1 WHERE id = $2', [newJsonId, tag.id]);
                    tag.json_id = newJsonId;
                    result.jsonRecordsAdded++;
                }
            }
            const taskId = tag.json_id || tag.task_id; // task_id is UUID, we need json_id of the task
            // Actually, task_tags.task_id references tasks.id (UUID)
            // We need to map task UUID to json_id
            const taskJsonId = pgTaskByUuid.get(tag.task_id)?.json_id || tag.task_id;
            if (!tagsByTaskId.has(taskJsonId)) {
                tagsByTaskId.set(taskJsonId, []);
            }
            tagsByTaskId.get(taskJsonId).push({
                id: tag.json_id || tag.id,
                tag: tag.tag,
                created_at: tag.created_at
            });
        }

        for (const task of refreshedTasks) {
            if (!task.json_id) {
                if (!dryRun) {
                    const newJsonId = generateJsonId();
                    await client.query('UPDATE tasks SET json_id = $1 WHERE id = $2', [newJsonId, task.id]);
                    task.json_id = newJsonId;
                    result.jsonRecordsAdded++;
                }
            }
            const taskJsonId = task.json_id || task.id;
            newJsonTasks.push({
                id: taskJsonId,
                title: task.title,
                description: task.description,
                completed: task.completed,
                archived: task.archived,
                priority: task.priority,
                due_time: task.due_time,
                reminder_time: task.reminder_time,
                long_term: task.long_term,
                created_at: task.created_at,
                updated_at: task.updated_at,
                tags: tagsByTaskId.get(taskJsonId) || []
            });
        }

        // Write JSON mirror (atomic)
        if (!dryRun) {
            await writeJsonNotes(newJsonNotes);
            await writeJsonTasks(newJsonTasks);
        }

        // --- Update sync metadata ---
        if (!dryRun) {
            await client.query(
                `INSERT INTO task_sync_meta (id, last_sync_at, sync_version, source, notes_synced, tasks_synced, tags_synced, conflicts_count, details)
                 VALUES ('global', NOW(), 1, 'reconcile', $1, $2, $3, $4, $5)
                 ON CONFLICT (id) DO UPDATE SET
                     last_sync_at = EXCLUDED.last_sync_at,
                     notes_synced = EXCLUDED.notes_synced,
                     tasks_synced = EXCLUDED.tasks_synced,
                     tags_synced = EXCLUDED.tags_synced,
                     conflicts_count = EXCLUDED.conflicts_count,
                     details = EXCLUDED.details`,
                [
                    result.notesImported + result.notesUpdated,
                    result.tasksImported + result.tasksUpdated,
                    refreshedTags.length,
                    result.conflicts,
                    JSON.stringify({
                        notesImported: result.notesImported,
                        tasksImported: result.tasksImported,
                        notesUpdated: result.notesUpdated,
                        tasksUpdated: result.tasksUpdated,
                        conflicts: result.conflicts,
                        jsonRecordsAdded: result.jsonRecordsAdded
                    })
                ]
            );
        }

        result.success = true;
        result.details = `Imported: ${result.notesImported} notes, ${result.tasksImported} tasks. Updated: ${result.notesUpdated} notes, ${result.tasksUpdated} tasks. Conflicts: ${result.conflicts}. JSON records added: ${result.jsonRecordsAdded}.`;
        log.info('sync-tasks-data', `Sync complete: ${result.details}`);
        return result;

    } catch (err) {
        result.error = err.message;
        log.error('sync-tasks-data', err, 'Sync failed');
        return result;
    } finally {
        if (client) client.release();
    }
}

// ---------------------------------------------------------------------
// PostgreSQL loaders
// ---------------------------------------------------------------------

async function loadPgNotes(client) {
    const res = await client.query(
        `SELECT id, json_id, date, content, archived, created_at, updated_at
         FROM notes
         ORDER BY created_at ASC`
    );
    return res.rows;
}

async function loadPgTasks(client) {
    const res = await client.query(
        `SELECT id, json_id, title, description, completed, archived, priority, due_time, reminder_time, long_term, notification_policy, custom_interval_minutes, created_at, updated_at
         FROM tasks
         ORDER BY created_at ASC`
    );
    return res.rows;
}

async function loadPgTags(client) {
    const res = await client.query(
        `SELECT id, json_id, task_id, tag, created_at
         FROM task_tags
         ORDER BY created_at ASC`
    );
    return res.rows;
}

// ---------------------------------------------------------------------
// JSON backup
// ---------------------------------------------------------------------

async function backupJsonFiles() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const notesFile = await JSON_NOTES_FILE;
    const tasksFile = await JSON_TASKS_FILE;
    const dataDir = notesFile.replace(/\/[^\/]+$/, '');
    const backupDir = dataDir.replace('tasks-data', 'tasks-data-backups');

    try {
        const { mkdirSync, copyFileSync } = await import('fs');
        mkdirSync(backupDir, { recursive: true });
        copyFileSync(notesFile, `${backupDir}/notes-${timestamp}.json`);
        copyFileSync(tasksFile, `${backupDir}/tasks-${timestamp}.json`);
        log.info('sync-tasks-data', `JSON backups created in ${backupDir}`);
    } catch (err) {
        log.warn('sync-tasks-data', `Could not create JSON backups: ${err.message}`);
    }
}

// ---------------------------------------------------------------------
// Public API for service-layer mirror updates
// ---------------------------------------------------------------------

/**
 * Refresh the JSON mirror from PostgreSQL after a write operation.
 * This is called by tasks-service.js after successful PostgreSQL writes.
 *
 * @param {string} [changedType] - 'note' | 'task' | 'tag' | null (refresh all)
 * @param {string} [changedId] - ID of the changed record (json_id or UUID)
 * @returns {Promise<boolean>} true if mirror was refreshed
 */
export async function refreshJsonMirror(changedType = null, changedId = null) {
    let client;
    try {
        client = await pool.connect();
        await client.query('SELECT 1');

        const notes = await loadPgNotes(client);
        const tasks = await loadPgTasks(client);
        const tags = await loadPgTags(client);

        // Build maps
        const tagsByTaskJsonId = new Map();
        const taskUuidToJsonId = new Map();

        for (const task of tasks) {
            const jsonId = task.json_id || task.id;
            taskUuidToJsonId.set(task.id, jsonId);
            if (!task.json_id) {
                await client.query('UPDATE tasks SET json_id = $1 WHERE id = $2', [jsonId, task.id]);
            }
        }

        for (const tag of tags) {
            const taskJsonId = taskUuidToJsonId.get(tag.task_id) || tag.task_id;
            if (!tagsByTaskJsonId.has(taskJsonId)) {
                tagsByTaskJsonId.set(taskJsonId, []);
            }
            const tagJsonId = tag.json_id || tag.id;
            tagsByTaskJsonId.get(taskJsonId).push({
                id: tagJsonId,
                tag: tag.tag,
                created_at: tag.created_at
            });
            if (!tag.json_id) {
                await client.query('UPDATE task_tags SET json_id = $1 WHERE id = $2', [tagJsonId, tag.id]);
            }
        }

        // Build JSON notes
        const jsonNotes = notes.map(note => {
            const jsonId = note.json_id || note.id;
            if (!note.json_id) {
                client.query('UPDATE notes SET json_id = $1 WHERE id = $2', [jsonId, note.id]).catch(() => { });
            }
            return {
                id: jsonId,
                date: note.date,
                content: note.content,
                archived: note.archived,
                created_at: note.created_at,
                updated_at: note.updated_at
            };
        });

        // Build JSON tasks
        const jsonTasks = tasks.map(task => {
            const jsonId = task.json_id || task.id;
            return {
                id: jsonId,
                title: task.title,
                description: task.description,
                completed: task.completed,
                archived: task.archived,
                priority: task.priority,
                due_time: task.due_time,
                reminder_time: task.reminder_time,
                long_term: task.long_term,
                created_at: task.created_at,
                updated_at: task.updated_at,
                tags: tagsByTaskJsonId.get(jsonId) || []
            };
        });

        // Atomic write
        await writeJsonNotes(jsonNotes);
        await writeJsonTasks(jsonTasks);

        return true;
    } catch (err) {
        log.error('sync-tasks-data', err, 'Failed to refresh JSON mirror');
        return false;
    } finally {
        if (client) client.release();
    }
}
