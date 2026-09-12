/**
 * Scheduled Task Scheduler — OS-independent cron-like task execution.
 *
 * Architecture:
 *   ScheduledTaskScheduler
 *     ├── schedule(task)        — register a scheduled task
 *     ├── cancel(taskId)        — cancel a scheduled task
 *     ├── runNow(taskId)        — manually trigger a scheduled task
 *     ├── getStatus(taskId)     — get scheduler status for a task
 *     ├── getAllStatus()        — get status for all scheduled tasks
 *     └── shutdown()            — clean shutdown
 *
 * Each scheduled task has:
 *   - id: unique identifier
 *   - name: human-readable name
 *   - cron: cron expression (optional)
 *   - interval: fixed interval in ms (alternative to cron)
 *   - enabled: whether the schedule is active
 *   - lastRun: timestamp of last execution
 *   - nextRun: timestamp of next scheduled execution
 *   - failureCount: consecutive failures
 *   - maxRetries: maximum retry attempts
 *   - timeout: execution timeout in ms
 *   - handler: async function to execute
 */

import { app } from 'electron';
import path from 'path';
import fs from 'fs';

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

const STATE_FILE = path.join(app.getPath('userData'), 'scheduled-tasks.json');

let scheduledTasks = new Map(); // taskId -> ScheduledTask
let intervals = new Map(); // taskId -> NodeJS.Timeout
let running = new Set(); // taskIds currently executing

// ---------------------------------------------------------------------------
// Scheduled task definition
// ---------------------------------------------------------------------------

export class ScheduledTask {
    constructor(options) {
        this.id = options.id || `scheduled_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        this.name = options.name || 'Unnamed Task';
        this.cron = options.cron || null; // cron expression (e.g., "0 7 * * 1" = Monday 7am)
        this.interval = options.interval || null; // fixed interval in ms
        this.enabled = options.enabled !== false;
        this.lastRun = null;
        this.nextRun = null;
        this.failureCount = 0;
        this.maxRetries = options.maxRetries || 3;
        this.timeout = options.timeout || 30000; // 30 seconds default
        this.handler = options.handler; // async function to execute
        this.metadata = options.metadata || {};
        this.createdAt = new Date().toISOString();
        this.updatedAt = new Date().toISOString();
    }
}

// ---------------------------------------------------------------------------
// Simple cron parser (supports 5-field cron: minute hour day month weekday)
// ---------------------------------------------------------------------------

function parseCron(cronExpression) {
    if (!cronExpression) return null;

    const parts = cronExpression.trim().split(/\s+/);
    if (parts.length !== 5) {
        throw new Error(`Invalid cron expression: "${cronExpression}". Expected 5 fields (minute hour day month weekday).`);
    }

    const [minute, hour, day, month, weekday] = parts;

    return {
        minute: parseCronField(minute, 0, 59),
        hour: parseCronField(hour, 0, 23),
        day: parseCronField(day, 1, 31),
        month: parseCronField(month, 1, 12),
        weekday: parseCronField(weekday, 0, 6),
    };
}

function parseCronField(field, min, max) {
    const values = new Set();

    for (const part of field.split(',')) {
        if (part === '*') {
            for (let i = min; i <= max; i++) values.add(i);
        } else if (part.includes('/')) {
            const [start, step] = part.split('/');
            const startNum = start === '*' ? min : parseInt(start, 10);
            const stepNum = parseInt(step, 10);
            for (let i = startNum; i <= max; i += stepNum) values.add(i);
        } else if (part.includes('-')) {
            const [start, end] = part.split('-');
            const startNum = parseInt(start, 10);
            const endNum = parseInt(end, 10);
            for (let i = startNum; i <= endNum; i++) values.add(i);
        } else {
            values.add(parseInt(part, 10));
        }
    }

    return values;
}

function matchesCron(cronFields, date) {
    if (!cronFields) return false;

    return (
        cronFields.minute.has(date.getMinutes()) &&
        cronFields.hour.has(date.getHours()) &&
        cronFields.day.has(date.getDate()) &&
        cronFields.month.has(date.getMonth() + 1) &&
        cronFields.weekday.has(date.getDay())
    );
}

function getNextCronRun(cronExpression, fromDate = new Date()) {
    const cronFields = parseCron(cronExpression);
    if (!cronFields) return null;

    // Start from the next minute
    const next = new Date(fromDate);
    next.setSeconds(0, 0);
    next.setMinutes(next.getMinutes() + 1);

    // Search up to 2 years ahead
    const maxSearch = new Date(fromDate);
    maxSearch.setFullYear(maxSearch.getFullYear() + 2);

    while (next < maxSearch) {
        if (matchesCron(cronFields, next)) {
            return next.toISOString();
        }
        next.setMinutes(next.getMinutes() + 1);
    }

    return null;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = fs.readFileSync(STATE_FILE, 'utf8');
            const parsed = JSON.parse(raw);

            // Restore scheduled tasks (without handlers — those are registered at runtime)
            if (Array.isArray(parsed.tasks)) {
                for (const taskData of parsed.tasks) {
                    const task = new ScheduledTask({
                        ...taskData,
                        handler: null, // Handlers must be re-registered
                    });
                    scheduledTasks.set(task.id, task);
                }
            }

            console.log(`[Scheduler] Loaded ${scheduledTasks.size} scheduled tasks from state file`);
        }
    } catch (err) {
        console.error('[Scheduler] Failed to load state:', err.message);
    }
}

function saveState() {
    try {
        const tasks = Array.from(scheduledTasks.values()).map(task => ({
            id: task.id,
            name: task.name,
            cron: task.cron,
            interval: task.interval,
            enabled: task.enabled,
            lastRun: task.lastRun,
            nextRun: task.nextRun,
            failureCount: task.failureCount,
            maxRetries: task.maxRetries,
            timeout: task.timeout,
            metadata: task.metadata,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
        }));

        fs.writeFileSync(STATE_FILE, JSON.stringify({ tasks, version: 1 }, null, 2), 'utf8');
    } catch (err) {
        console.error('[Scheduler] Failed to save state:', err.message);
    }
}

// ---------------------------------------------------------------------------
// Scheduler logic
// ---------------------------------------------------------------------------

function calculateNextRun(task) {
    if (task.cron) {
        return getNextCronRun(task.cron);
    } else if (task.interval) {
        const next = new Date();
        next.setMilliseconds(next.getMilliseconds() + task.interval);
        return next.toISOString();
    }
    return null;
}

async function executeTask(task) {
    if (!task.handler) {
        console.warn(`[Scheduler] No handler registered for task ${task.id}`);
        return { ok: false, error: 'No handler registered' };
    }

    if (running.has(task.id)) {
        console.warn(`[Scheduler] Task ${task.id} is already running, skipping duplicate execution`);
        return { ok: false, error: 'Already running' };
    }

    running.add(task.id);

    try {
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Task timeout')), task.timeout);
        });

        const result = await Promise.race([task.handler(), timeoutPromise]);

        task.lastRun = new Date().toISOString();
        task.failureCount = 0;
        task.updatedAt = new Date().toISOString();
        task.nextRun = calculateNextRun(task);

        console.log(`[Scheduler] Task ${task.id} (${task.name}) completed successfully`);
        return { ok: true, result };
    } catch (err) {
        task.failureCount++;
        task.lastRun = new Date().toISOString();
        task.updatedAt = new Date().toISOString();

        console.error(`[Scheduler] Task ${task.id} (${task.name}) failed:`, err.message);

        // Disable after max retries
        if (task.failureCount >= task.maxRetries) {
            task.enabled = false;
            console.warn(`[Scheduler] Task ${task.id} disabled after ${task.failureCount} failures`);
        }

        return { ok: false, error: err.message, failureCount: task.failureCount };
    } finally {
        running.delete(task.id);
        saveState();
    }
}

function scheduleTask(task) {
    // Clear existing interval
    if (intervals.has(task.id)) {
        clearTimeout(intervals.get(task.id));
    }

    if (!task.enabled) {
        console.log(`[Scheduler] Task ${task.id} is disabled, not scheduling`);
        return;
    }

    // Calculate next run time
    task.nextRun = calculateNextRun(task);
    if (!task.nextRun) {
        console.warn(`[Scheduler] Task ${task.id} has no valid schedule (no cron or interval)`);
        return;
    }

    const nextRunDate = new Date(task.nextRun);
    const now = new Date();
    const delay = Math.max(0, nextRunDate.getTime() - now.getTime());

    console.log(`[Scheduler] Task ${task.id} (${task.name}) scheduled for ${task.nextRun} (in ${Math.round(delay / 1000)}s)`);

    const timeoutId = setTimeout(async () => {
        intervals.delete(task.id);

        if (!task.enabled) {
            console.log(`[Scheduler] Task ${task.id} was disabled before execution`);
            return;
        }

        await executeTask(task);

        // Reschedule if still enabled
        if (task.enabled) {
            scheduleTask(task);
        }
    }, delay);

    intervals.set(task.id, timeoutId);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a new scheduled task.
 * @param {Object} options - Task options
 * @param {string} options.id - Unique task ID
 * @param {string} options.name - Human-readable name
 * @param {string} [options.cron] - Cron expression (e.g., "0 7 * * 1")
 * @param {number} [options.interval] - Fixed interval in ms
 * @param {boolean} [options.enabled=true] - Whether the task is active
 * @param {number} [options.maxRetries=3] - Maximum retry attempts
 * @param {number} [options.timeout=30000] - Execution timeout in ms
 * @param {Function} options.handler - Async function to execute
 * @param {Object} [options.metadata] - Additional metadata
 * @returns {ScheduledTask} The registered task
 */
export function schedule(options) {
    const task = new ScheduledTask(options);

    if (!task.cron && !task.interval) {
        throw new Error('Scheduled task must have either a cron expression or an interval');
    }

    if (scheduledTasks.has(task.id)) {
        console.warn(`[Scheduler] Task ${task.id} already exists, replacing`);
        cancel(task.id);
    }

    scheduledTasks.set(task.id, task);
    scheduleTask(task);
    saveState();

    console.log(`[Scheduler] Registered task ${task.id}: ${task.name}`);
    return task;
}

/**
 * Cancel a scheduled task.
 * @param {string} taskId - Task ID to cancel
 */
export function cancel(taskId) {
    if (intervals.has(taskId)) {
        clearTimeout(intervals.get(taskId));
        intervals.delete(taskId);
    }

    scheduledTasks.delete(taskId);
    saveState();

    console.log(`[Scheduler] Cancelled task ${taskId}`);
}

/**
 * Manually trigger a scheduled task.
 * @param {string} taskId - Task ID to run
 * @returns {Promise<{ok: boolean, result?: any, error?: string}>}
 */
export async function runNow(taskId) {
    const task = scheduledTasks.get(taskId);
    if (!task) {
        return { ok: false, error: `Task ${taskId} not found` };
    }

    // Reschedule after manual run
    if (intervals.has(taskId)) {
        clearTimeout(intervals.get(taskId));
        intervals.delete(taskId);
    }

    const result = await executeTask(task);

    // Reschedule if still enabled
    if (task.enabled) {
        scheduleTask(task);
    }

    return result;
}

/**
 * Get status of a scheduled task.
 * @param {string} taskId - Task ID
 * @returns {Object|null} Task status
 */
export function getStatus(taskId) {
    const task = scheduledTasks.get(taskId);
    if (!task) return null;

    return {
        id: task.id,
        name: task.name,
        enabled: task.enabled,
        cron: task.cron,
        interval: task.interval,
        lastRun: task.lastRun,
        nextRun: task.nextRun,
        failureCount: task.failureCount,
        maxRetries: task.maxRetries,
        isRunning: running.has(task.id),
        metadata: task.metadata,
    };
}

/**
 * Get status of all scheduled tasks.
 * @returns {Array} Array of task statuses
 */
export function getAllStatus() {
    return Array.from(scheduledTasks.values()).map(task => getStatus(task.id));
}

/**
 * Enable a scheduled task.
 * @param {string} taskId - Task ID
 */
export function enable(taskId) {
    const task = scheduledTasks.get(taskId);
    if (!task) return;

    task.enabled = true;
    task.failureCount = 0;
    task.updatedAt = new Date().toISOString();
    scheduleTask(task);
    saveState();

    console.log(`[Scheduler] Enabled task ${taskId}`);
}

/**
 * Disable a scheduled task.
 * @param {string} taskId - Task ID
 */
export function disable(taskId) {
    const task = scheduledTasks.get(taskId);
    if (!task) return;

    task.enabled = false;
    task.updatedAt = new Date().toISOString();

    if (intervals.has(taskId)) {
        clearTimeout(intervals.get(taskId));
        intervals.delete(taskId);
    }

    saveState();

    console.log(`[Scheduler] Disabled task ${taskId}`);
}

/**
 * Update a scheduled task's configuration.
 * @param {string} taskId - Task ID
 * @param {Object} updates - Fields to update
 */
export function update(taskId, updates) {
    const task = scheduledTasks.get(taskId);
    if (!task) return null;

    const wasEnabled = task.enabled;

    if (updates.cron !== undefined) task.cron = updates.cron;
    if (updates.interval !== undefined) task.interval = updates.interval;
    if (updates.enabled !== undefined) task.enabled = updates.enabled;
    if (updates.maxRetries !== undefined) task.maxRetries = updates.maxRetries;
    if (updates.timeout !== undefined) task.timeout = updates.timeout;
    if (updates.metadata !== undefined) task.metadata = { ...task.metadata, ...updates.metadata };
    if (updates.handler !== undefined) task.handler = updates.handler;

    task.updatedAt = new Date().toISOString();

    // Reschedule if enabled state changed or schedule changed
    if (wasEnabled !== task.enabled || updates.cron !== undefined || updates.interval !== undefined) {
        if (intervals.has(taskId)) {
            clearTimeout(intervals.get(taskId));
            intervals.delete(taskId);
        }

        if (task.enabled) {
            scheduleTask(task);
        }
    }

    saveState();
    return task;
}

/**
 * Get scheduler diagnostics.
 * @returns {Object} Diagnostic information
 */
export function getDiagnostics() {
    return {
        totalTasks: scheduledTasks.size,
        enabledTasks: Array.from(scheduledTasks.values()).filter(t => t.enabled).length,
        runningTasks: running.size,
        scheduledIntervals: intervals.size,
        tasks: getAllStatus(),
    };
}

/**
 * Clean shutdown — cancel all scheduled tasks.
 */
export function shutdown() {
    console.log('[Scheduler] Shutting down...');

    for (const [taskId, timeoutId] of intervals) {
        clearTimeout(timeoutId);
    }

    intervals.clear();
    scheduledTasks.clear();
    running.clear();

    console.log('[Scheduler] Shutdown complete');
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

loadState();

// Restore schedules on startup
for (const task of scheduledTasks.values()) {
    if (task.enabled) {
        scheduleTask(task);
    }
}

// Clean shutdown on app exit
app.on('before-quit', () => {
    shutdown();
});

export default {
    schedule,
    cancel,
    runNow,
    getStatus,
    getAllStatus,
    enable,
    disable,
    update,
    getDiagnostics,
    shutdown,
};
