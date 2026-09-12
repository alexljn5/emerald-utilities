/**
 * Tasks Service — Notes & Tasks CRUD
 *
 * Architecture:
 *   - PostgreSQL is the PRIMARY operational store (via shared pool).
 *   - JSON files are a durable recovery mirror ONLY.
 *   - If PostgreSQL is unreachable, operations fall back to JSON.
 *   - After successful PostgreSQL writes, the JSON mirror is refreshed.
 *
 * Connection modes:
 *   - 'database'      → normal PostgreSQL operation
 *   - 'offline-json'  → PostgreSQL unavailable, using JSON fallback
 *   - 'degraded'      → PostgreSQL health check failed
 *
 * IMPORTANT: PostgreSQL is the source of truth. JSON is a mirror, not a co-equal store.
 */

import { getTasksPool, isUsingJsonFallback, getConnectionMode, refreshConnectionState } from './tasks-db.js';
import {
    getJsonNotes, getJsonNoteById, createJsonNote, updateJsonNote, deleteJsonNote,
    getJsonTasks, getJsonTaskById, createJsonTask, updateJsonTask, deleteJsonTask,
    getJsonPendingReminders, markJsonReminderHandled,
    writeJsonNotes, writeJsonTasks
} from './tasks-json-store.js';
import { refreshJsonMirror } from './sync-tasks-data.js';
import { migrateLegacyJson } from './migrate-legacy-json.js';
import { dbLog as log } from '../../utils/logger.js';

let schemaReady = false;
let legacyMigrationAttempted = false;

function normalizePriority(priority) {
    return ['green', 'orange', 'red'].includes(priority) ? priority : 'green';
}

function logDbError(operation, err) {
    const msg = err.message || String(err);
    const code = err.code || 'N/A';
    const mode = getConnectionMode();
    log.error(`tasks:${operation}`, err, `code=${code} mode=${mode}`);
}

/**
 * Attempt one-time legacy JSON migration.
 * Safe to call multiple times; idempotent.
 */
export async function ensureLegacyMigrated() {
    if (legacyMigrationAttempted) return;

    try {
        legacyMigrationAttempted = true;
        const result = await migrateLegacyJson();
        if (result.success && !result.skipped) {
            log.info('tasks-service', `Legacy JSON migration: ${result.details.summary || 'completed'}`);
        } else if (result.skipped) {
            log.info('tasks-service', 'Legacy JSON migration: already completed');
        } else {
            log.warn('tasks-service', `Legacy JSON migration skipped: ${result.error}`);
        }
    } catch (err) {
        log.error('tasks-service', err, 'Legacy JSON migration failed');
    }
}

async function ensureTasksSchema(pool) {
    if (schemaReady) return;

    // The database schema is owned by migrations (merge-sins.sh).
    // This function only VERIFIES that required tables exist.
    // It does NOT create or alter tables/indexes.

    try {
        const notesExists = await pool.query(
            `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'notes')`
        );
        const tasksExists = await pool.query(
            `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tasks')`
        );

        if (!notesExists.rows[0].exists || !tasksExists.rows[0].exists) {
            schemaReady = true;
            return;
        }

        schemaReady = true;
    } catch (err) {
        logDbError('ensureTasksSchema', err);
        schemaReady = true;
    }
}

// ============================================================
// Notes
// ============================================================

export async function getNotes() {
    if (isUsingJsonFallback()) {
        log.warn('tasks-service', 'getNotes: using JSON fallback (PostgreSQL unavailable)');
        return getJsonNotes();
    }

    const p = await getTasksPool();
    if (!p) return getJsonNotes();
    await ensureTasksSchema(p);
    const result = await p.query(
        `SELECT id, date, content, archived, created_at, updated_at
         FROM notes
         ORDER BY archived ASC, date DESC, created_at DESC`
    );
    return result.rows;
}

export async function getNoteById(id) {
    if (isUsingJsonFallback()) return getJsonNoteById(id);

    const p = await getTasksPool();
    if (!p) return getJsonNoteById(id);
    await ensureTasksSchema(p);
    const result = await p.query(
        `SELECT id, date, content, archived, created_at, updated_at
         FROM notes
         WHERE id = $1`,
        [id]
    );
    return result.rows[0] || null;
}

export async function createNote(note) {
    if (isUsingJsonFallback()) return createJsonNote(note);

    const p = await getTasksPool();
    if (!p) return createJsonNote(note);
    await ensureTasksSchema(p);
    const result = await p.query(
        `INSERT INTO notes (date, content)
         VALUES ($1, $2)
         RETURNING id, date, content, archived, created_at, updated_at`,
        [note.date || new Date().toISOString().split('T')[0], note.content]
    );
    const created = result.rows[0];
    // Refresh JSON mirror asynchronously (don't block the response)
    refreshJsonMirror('note', created.id).catch(() => { });
    return created;
}

export async function updateNote(id, updates) {
    if (isUsingJsonFallback()) return updateJsonNote(id, updates);

    const p = await getTasksPool();
    if (!p) return updateJsonNote(id, updates);
    await ensureTasksSchema(p);
    const fields = [];
    const params = [];
    let idx = 1;

    if (updates.date !== undefined) {
        fields.push(`date = $${idx++}`);
        params.push(updates.date);
    }
    if (updates.content !== undefined) {
        fields.push(`content = $${idx++}`);
        params.push(updates.content);
    }
    if (updates.archived !== undefined) {
        fields.push(`archived = $${idx++}`);
        params.push(updates.archived);
    }

    if (fields.length === 0) return getNoteById(id);

    params.push(id);
    const result = await p.query(
        `UPDATE notes SET ${fields.join(', ')}
         WHERE id = $${idx}
         RETURNING id, date, content, archived, created_at, updated_at`,
        params
    );
    const updated = result.rows[0] || null;
    if (updated) {
        refreshJsonMirror('note', updated.id).catch(() => { });
    }
    return updated;
}

export async function deleteNote(id) {
    if (isUsingJsonFallback()) return deleteJsonNote(id);

    const p = await getTasksPool();
    if (!p) return deleteJsonNote(id);
    const result = await p.query('DELETE FROM notes WHERE id = $1 RETURNING id', [id]);
    const deleted = result.rows[0] || null;
    if (deleted) {
        refreshJsonMirror('note', id).catch(() => { });
    }
    return deleted;
}

// ============================================================
// Tasks
// ============================================================

export async function getTasks() {
    if (isUsingJsonFallback()) {
        log.warn('tasks-service', 'getTasks: using JSON fallback (PostgreSQL unavailable)');
        return getJsonTasks();
    }

    const p = await getTasksPool();
    if (!p) return getJsonTasks();
    await ensureTasksSchema(p);
    const result = await p.query(
        `SELECT id, title, description, completed, archived, priority, due_time, reminder_time, long_term, notification_policy, custom_interval_minutes, created_at, updated_at
         FROM tasks
         ORDER BY archived ASC, long_term ASC, completed ASC, due_time ASC NULLS LAST, created_at DESC`
    );
    return result.rows;
}

export async function getTaskById(id) {
    if (isUsingJsonFallback()) return getJsonTaskById(id);

    const p = await getTasksPool();
    if (!p) return getJsonTaskById(id);
    await ensureTasksSchema(p);
    const result = await p.query(
        `SELECT id, title, description, completed, archived, priority, due_time, reminder_time, long_term, notification_policy, custom_interval_minutes, created_at, updated_at
         FROM tasks
         WHERE id = $1`,
        [id]
    );
    return result.rows[0] || null;
}

export async function createTask(task) {
    if (isUsingJsonFallback()) return createJsonTask(task);

    const p = await getTasksPool();
    if (!p) return createJsonTask(task);
    await ensureTasksSchema(p);
    const result = await p.query(
        `INSERT INTO tasks (title, description, priority, due_time, reminder_time, long_term, notification_policy, custom_interval_minutes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, title, description, completed, archived, priority, due_time, reminder_time, long_term, notification_policy, custom_interval_minutes, created_at, updated_at`,
        [
            task.title,
            task.description || null,
            normalizePriority(task.priority),
            task.due_time || null,
            task.reminder_time || null,
            Boolean(task.long_term),
            task.notification_policy || 'daily',
            task.custom_interval_minutes || 60,
        ]
    );
    const created = result.rows[0];
    refreshJsonMirror('task', created.id).catch(() => { });
    return created;
}

export async function updateTask(id, updates) {
    if (isUsingJsonFallback()) return updateJsonTask(id, updates);

    const p = await getTasksPool();
    if (!p) return updateJsonTask(id, updates);
    await ensureTasksSchema(p);
    const fields = [];
    const params = [];
    let idx = 1;

    if (updates.title !== undefined) {
        fields.push(`title = $${idx++}`);
        params.push(updates.title);
    }
    if (updates.description !== undefined) {
        fields.push(`description = $${idx++}`);
        params.push(updates.description);
    }
    if (updates.completed !== undefined) {
        fields.push(`completed = $${idx++}`);
        params.push(updates.completed);
    }
    if (updates.archived !== undefined) {
        fields.push(`archived = $${idx++}`);
        params.push(updates.archived);
    }
    if (updates.priority !== undefined) {
        fields.push(`priority = $${idx++}`);
        params.push(normalizePriority(updates.priority));
    }
    if (updates.due_time !== undefined) {
        fields.push(`due_time = $${idx++}`);
        params.push(updates.due_time);
    }
    if (updates.reminder_time !== undefined) {
        fields.push(`reminder_time = $${idx++}`);
        params.push(updates.reminder_time);
    }
    if (updates.long_term !== undefined) {
        fields.push(`long_term = $${idx++}`);
        params.push(Boolean(updates.long_term));
    }
    if (updates.notification_policy !== undefined) {
        fields.push(`notification_policy = $${idx++}`);
        params.push(updates.notification_policy);
    }
    if (updates.custom_interval_minutes !== undefined) {
        fields.push(`custom_interval_minutes = $${idx++}`);
        params.push(updates.custom_interval_minutes);
    }

    if (fields.length === 0) return getTaskById(id);

    params.push(id);
    const result = await p.query(
        `UPDATE tasks SET ${fields.join(', ')}
         WHERE id = $${idx}
         RETURNING id, title, description, completed, archived, priority, due_time, reminder_time, long_term, notification_policy, custom_interval_minutes, created_at, updated_at`,
        params
    );
    const updated = result.rows[0] || null;
    if (updated) {
        refreshJsonMirror('task', updated.id).catch(() => { });
    }
    return updated;
}

export async function deleteTask(id) {
    if (isUsingJsonFallback()) return deleteJsonTask(id);

    const p = await getTasksPool();
    if (!p) return deleteJsonTask(id);
    const result = await p.query('DELETE FROM tasks WHERE id = $1 RETURNING id', [id]);
    const deleted = result.rows[0] || null;
    if (deleted) {
        refreshJsonMirror('task', id).catch(() => { });
    }
    return deleted;
}

// ============================================================
// Task Tags
// ============================================================

export async function getTaskTags(taskId) {
    if (isUsingJsonFallback()) return []; // Tags not supported in JSON mode

    const p = await getTasksPool();
    if (!p) return [];
    const result = await p.query(
        `SELECT id, task_id, tag, created_at
         FROM task_tags
         WHERE task_id = $1
         ORDER BY tag`,
        [taskId]
    );
    return result.rows;
}

export async function addTaskTag(taskId, tag) {
    if (isUsingJsonFallback()) return null; // Tags not supported in JSON mode

    const p = await getTasksPool();
    if (!p) return null;
    const result = await p.query(
        `INSERT INTO task_tags (task_id, tag)
         VALUES ($1, $2)
         ON CONFLICT (task_id, tag) DO NOTHING
         RETURNING id, task_id, tag, created_at`,
        [taskId, tag]
    );
    const added = result.rows[0] || null;
    if (added) {
        refreshJsonMirror('tag', added.id).catch(() => { });
    }
    return added;
}

export async function removeTaskTag(taskId, tag) {
    if (isUsingJsonFallback()) return null; // Tags not supported in JSON mode

    const p = await getTasksPool();
    if (!p) return null;
    const result = await p.query(
        'DELETE FROM task_tags WHERE task_id = $1 AND tag = $2 RETURNING id',
        [taskId, tag]
    );
    const removed = result.rows[0] || null;
    if (removed) {
        refreshJsonMirror('tag', removed.id).catch(() => { });
    }
    return removed;
}

// ============================================================
// Reminders
// ============================================================

export async function getPendingReminders() {
    if (isUsingJsonFallback()) return getJsonPendingReminders();

    const p = await getTasksPool();
    if (!p) return getJsonPendingReminders();
    await ensureTasksSchema(p);
    const result = await p.query(
        `SELECT id, title, description, priority, reminder_time, created_at
         FROM tasks
         WHERE completed = FALSE
            AND archived = FALSE
            AND reminder_time IS NOT NULL
            AND reminder_time <= NOW()
         ORDER BY reminder_time ASC`
    );
    return result.rows;
}

export async function markReminderHandled(id) {
    if (isUsingJsonFallback()) return markJsonReminderHandled(id);

    const p = await getTasksPool();
    if (!p) return markJsonReminderHandled(id);
    await ensureTasksSchema(p);
    const result = await p.query(
        `UPDATE tasks SET reminder_time = NULL
         WHERE id = $1
         RETURNING id, title, description, completed, archived, priority, due_time, reminder_time, created_at, updated_at`,
        [id]
    );
    const updated = result.rows[0] || null;
    if (updated) {
        refreshJsonMirror('task', updated.id).catch(() => { });
    }
    return updated;
}

// ============================================================
// Subtasks
// ============================================================

/**
 * Get all subtasks for a parent task.
 */
export async function getSubtasks(taskId) {
    if (isUsingJsonFallback()) return [];

    const p = await getTasksPool();
    if (!p) return [];
    await ensureTasksSchema(p);

    // Try with new columns first (migration 008+)
    try {
        const result = await p.query(
            `SELECT id, task_id, title, completed, "order", due_time, reminder_time, created_at, updated_at
             FROM subtasks
             WHERE task_id = $1
             ORDER BY "order" ASC, created_at ASC`,
            [taskId]
        );
        return result.rows;
    } catch (err) {
        // Fallback for databases that haven't had migration 008 applied yet
        if (err.code === '42703' && /due_time|reminder_time/.test(err.message)) {
            const result = await p.query(
                `SELECT id, task_id, title, completed, "order", created_at, updated_at
                 FROM subtasks
                 WHERE task_id = $1
                 ORDER BY "order" ASC, created_at ASC`,
                [taskId]
            );
            return result.rows.map(row => ({
                ...row,
                due_time: null,
                reminder_time: null,
            }));
        }
        throw err;
    }
}

/**
 * Create a new subtask.
 */
export async function createSubtask(taskId, subtask) {
    if (isUsingJsonFallback()) return null;

    const p = await getTasksPool();
    if (!p) return null;
    await ensureTasksSchema(p);

    // Get the next order value
    const maxOrderResult = await p.query(
        `SELECT MAX("order") AS max_order FROM subtasks WHERE task_id = $1`,
        [taskId]
    );
    const nextOrder = (maxOrderResult.rows[0]?.max_order ?? -1) + 1;

    // Try with new columns first (migration 008+)
    let result;
    try {
        result = await p.query(
            `INSERT INTO subtasks (task_id, title, "order", due_time, reminder_time)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, task_id, title, completed, "order", due_time, reminder_time, created_at, updated_at`,
            [taskId, subtask.title, nextOrder, subtask.due_time || null, subtask.reminder_time || null]
        );
    } catch (err) {
        // Fallback for databases that haven't had migration 008 applied yet
        if (err.code === '42703' && /due_time|reminder_time/.test(err.message)) {
            result = await p.query(
                `INSERT INTO subtasks (task_id, title, "order")
                 VALUES ($1, $2, $3)
                 RETURNING id, task_id, title, completed, "order", created_at, updated_at`,
                [taskId, subtask.title, nextOrder]
            );
            return { ...result.rows[0], due_time: null, reminder_time: null };
        }
        throw err;
    }
    return result.rows[0];
}

/**
 * Update a subtask.
 */
export async function updateSubtask(id, updates) {
    if (isUsingJsonFallback()) return null;

    const p = await getTasksPool();
    if (!p) return null;
    await ensureTasksSchema(p);

    const fields = [];
    const params = [];
    let idx = 1;

    if (updates.title !== undefined) {
        fields.push(`title = $${idx++}`);
        params.push(updates.title);
    }
    if (updates.completed !== undefined) {
        fields.push(`completed = $${idx++}`);
        params.push(updates.completed);
    }
    if (updates.order !== undefined) {
        fields.push(`"order" = $${idx++}`);
        params.push(updates.order);
    }
    if (updates.due_time !== undefined) {
        fields.push(`due_time = $${idx++}`);
        params.push(updates.due_time);
    }
    if (updates.reminder_time !== undefined) {
        fields.push(`reminder_time = $${idx++}`);
        params.push(updates.reminder_time);
    }

    if (fields.length === 0) return null;

    params.push(id);

    // Try with new columns first (migration 008+)
    let result;
    try {
        result = await p.query(
            `UPDATE subtasks SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id, task_id, title, completed, "order", due_time, reminder_time, created_at, updated_at`,
            params
        );
    } catch (err) {
        // Fallback for databases that haven't had migration 008 applied yet
        if (err.code === '42703' && /due_time|reminder_time/.test(err.message)) {
            const fallbackFields = fields.filter(f => !f.includes('due_time') && !f.includes('reminder_time'));
            if (fallbackFields.length === 0) return null;
            const fallbackParams = params.slice(0, fallbackFields.length);
            fallbackParams.push(id);
            result = await p.query(
                `UPDATE subtasks SET ${fallbackFields.join(', ')} WHERE id = $${fallbackParams.length} RETURNING id, task_id, title, completed, "order", created_at, updated_at`,
                fallbackParams
            );
            return result.rows[0] ? { ...result.rows[0], due_time: null, reminder_time: null } : null;
        }
        throw err;
    }
    return result.rows[0] || null;
}

/**
 * Delete a subtask.
 */
export async function deleteSubtask(id) {
    if (isUsingJsonFallback()) return null;

    const p = await getTasksPool();
    if (!p) return null;
    await ensureTasksSchema(p);

    const result = await p.query(
        `DELETE FROM subtasks WHERE id = $1 RETURNING id`,
        [id]
    );
    return result.rows[0] || null;
}

/**
 * Get subtask completion stats for a parent task.
 */
export async function getSubtaskStats(taskId) {
    if (isUsingJsonFallback()) return { total: 0, completed: 0 };

    const p = await getTasksPool();
    if (!p) return { total: 0, completed: 0 };
    await ensureTasksSchema(p);

    const result = await p.query(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE completed = TRUE)::int AS completed
         FROM subtasks WHERE task_id = $1`,
        [taskId]
    );
    const row = result.rows[0];
    return { total: row.total, completed: row.completed };
}

// ============================================================
// Connection Info
// ============================================================

export async function getTasksConnectionInfo() {
    const mode = getConnectionMode();
    const poolAvailable = !isUsingJsonFallback();

    // Get connection details from the pool's exported connection info
    let host = 'localhost';
    let port = 5432;
    let database = 'emerald_utilities';
    let user = 'emerald';

    try {
        // Import sanitized connection info from db-pool (no password)
        const { connectionInfo } = await import('../db-pool.js');
        host = connectionInfo.host;
        port = connectionInfo.port;
        database = connectionInfo.database;
        user = connectionInfo.user;
    } catch {
        // Fallback to defaults if db-pool isn't available
    }

    return {
        connected: poolAvailable,
        mode,
        host,
        port,
        database,
        user,
    };
}
