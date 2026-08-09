/**
 * Notification Service — centralized Windows toast notification generation.
 *
 * Architecture:
 *   NotificationService.sendTaskNotification(task, type)
 *     └── OSNotifier.notify() → SnoreToast (Windows) / node-notifier (Linux/macOS)
 *
 * This is the SINGLE entry point for all task-related notifications.
 * The task scheduler (main process) and the renderer both call this service.
 *
 * Notification types:
 *   REMINDER  — reminder_time has been reached
 *   DUE_DATE  — due_time has been reached (task is now due)
 *   PRIORITY  — high-priority task requiring attention
 *   DEBUG     — generic debug/test notification
 */

import { OSNotifier, getAumid } from './osNotifier.js';
import path from 'path';
import { app } from 'electron';
import fs from 'fs';
import { resolvePath } from './pathResolver.js';

// ---------------------------------------------------------------------------
// Notification type constants
// ---------------------------------------------------------------------------

export const NOTIFICATION_TYPE = Object.freeze({
    REMINDER: 'reminder',
    DUE_DATE: 'due_date',
    PRIORITY: 'priority',
    DEBUG: 'debug',
});

// ---------------------------------------------------------------------------
// Duplicate-suppression state
// ---------------------------------------------------------------------------

const STATE_FILE = path.join(app.getPath('userData'), 'notification-suppression.json');

let suppressionState = {
    notifiedTaskIds: [],
    notifiedReminderIds: [],
};

function loadSuppressionState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = fs.readFileSync(STATE_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            suppressionState = {
                notifiedTaskIds: Array.isArray(parsed.notifiedTaskIds) ? parsed.notifiedTaskIds : [],
                notifiedReminderIds: Array.isArray(parsed.notifiedReminderIds) ? parsed.notifiedReminderIds : [],
            };
        }
    } catch {
        // Corrupt or unreadable state file — start fresh
        suppressionState = { notifiedTaskIds: [], notifiedReminderIds: [] };
    }
}

function saveSuppressionState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(suppressionState, null, 2), 'utf8');
    } catch {
        // Non-fatal: if we cannot persist state, in-memory tracking still works
        // for the current session.
    }
}

loadSuppressionState();

const notifiedTaskIds = new Set(suppressionState.notifiedTaskIds);
const notifiedReminderIds = new Set(suppressionState.notifiedReminderIds);

function markTaskNotified(taskId) {
    notifiedTaskIds.add(taskId);
    suppressionState.notifiedTaskIds = [...notifiedTaskIds];
    saveSuppressionState();
}

function markReminderNotified(taskId) {
    notifiedReminderIds.add(taskId);
    suppressionState.notifiedReminderIds = [...notifiedReminderIds];
    saveSuppressionState();
}

function clearTaskNotificationState(taskId) {
    notifiedTaskIds.delete(taskId);
    notifiedReminderIds.delete(taskId);
    suppressionState.notifiedTaskIds = [...notifiedTaskIds];
    suppressionState.notifiedReminderIds = [...notifiedReminderIds];
    saveSuppressionState();
}

function isTaskNotified(taskId) {
    return notifiedTaskIds.has(taskId);
}

function isReminderNotified(taskId) {
    return notifiedReminderIds.has(taskId);
}

// ---------------------------------------------------------------------------
// Branding / icon resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the Emerald Utilities sigil/logo icon for Windows toast notifications.
 * Reuses the exact transparent asset used by the About page (img/alexljn5_logo_merge_transparent.png).
 */
function resolveNotificationIcon() {
    const candidates = [
        resolvePath('img/logos/alexljn5_logo_merge_transparent.png'),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

const NOTIFICATION_ICON = resolveNotificationIcon();

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

function buildReminderPayload(task) {
    const parts = [task.title];
    if (task.due_time) parts.push(`Due: ${new Date(task.due_time).toLocaleString()}`);
    if (task.reminder_time) parts.push(`Reminder: ${new Date(task.reminder_time).toLocaleString()}`);
    return {
        title: 'Reminder',
        message: parts.join('\n'),
        urgency: task.priority === 'red' ? 'critical' : task.priority === 'orange' ? 'normal' : 'low',
        icon: NOTIFICATION_ICON,
    };
}

function buildDueDatePayload(task) {
    const parts = [task.title];
    if (task.due_time) parts.push(`Due: ${new Date(task.due_time).toLocaleString()}`);
    if (task.reminder_time) parts.push(`Reminder: ${new Date(task.reminder_time).toLocaleString()}`);
    return {
        title: 'Due date',
        message: parts.join('\n'),
        urgency: task.priority === 'red' ? 'critical' : task.priority === 'orange' ? 'normal' : 'low',
        icon: NOTIFICATION_ICON,
    };
}

function buildPriorityPayload(task) {
    const parts = [task.title];
    if (task.due_time) parts.push(`Due: ${new Date(task.due_time).toLocaleString()}`);
    if (task.reminder_time) parts.push(`Reminder: ${new Date(task.reminder_time).toLocaleString()}`);
    parts.push('Requires attention.');
    return {
        title: 'High priority',
        message: parts.join('\n'),
        urgency: 'critical',
        icon: NOTIFICATION_ICON,
    };
}

function buildDebugPayload() {
    return {
        title: 'Debug Notification',
        message: 'This is a debug/test notification to verify the Windows notification mechanism.',
        urgency: 'normal',
        icon: NOTIFICATION_ICON,
    };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a task notification of the given type.
 * Duplicate-suppression is applied automatically.
 *
 * @param {Object} task - Task object with at least { id, title, priority }
 * @param {string} type - One of NOTIFICATION_TYPE
 * @returns {Promise<{ok: boolean, state: string, error?: string, provider?: string}>}
 */
export async function sendTaskNotification(task, type) {
    // Debug notifications do not require a task object
    if (type !== NOTIFICATION_TYPE.DEBUG && (!task || !task.id)) {
        return { ok: false, state: 'failed', error: 'Missing task data' };
    }

    const validTypes = Object.values(NOTIFICATION_TYPE);
    if (!validTypes.includes(type)) {
        return { ok: false, state: 'failed', error: `Unknown notification type: ${type}` };
    }

    // Duplicate suppression (skip for debug notifications)
    if (type === NOTIFICATION_TYPE.REMINDER) {
        if (isReminderNotified(task.id)) {
            return { ok: false, state: 'duplicate', error: 'Reminder already notified' };
        }
    } else if (type !== NOTIFICATION_TYPE.DEBUG) {
        if (isTaskNotified(task.id)) {
            return { ok: false, state: 'duplicate', error: 'Task already notified' };
        }
    }

    let payload;
    switch (type) {
        case NOTIFICATION_TYPE.REMINDER:
            payload = buildReminderPayload(task);
            break;
        case NOTIFICATION_TYPE.DUE_DATE:
            payload = buildDueDatePayload(task);
            break;
        case NOTIFICATION_TYPE.PRIORITY:
            payload = buildPriorityPayload(task);
            break;
        case NOTIFICATION_TYPE.DEBUG:
            payload = buildDebugPayload();
            break;
        default:
            return { ok: false, state: 'failed', error: `Unhandled type: ${type}` };
    }

    try {
        const result = await OSNotifier.notify(payload);

        if (result.ok) {
            // Mark as notified only on success
            if (type === NOTIFICATION_TYPE.REMINDER) {
                markReminderNotified(task.id);
            } else if (type !== NOTIFICATION_TYPE.DEBUG) {
                markTaskNotified(task.id);
            }
        }

        return result;
    } catch (err) {
        console.error(`[NotificationService] ${type} notification threw:`, err.message);
        return { ok: false, state: 'failed', error: err.message };
    }
}

/**
 * Send a generic debug notification to verify the Windows notification mechanism.
 */
export async function sendDebugNotification() {
    const payload = buildDebugPayload();
    try {
        return await OSNotifier.notify(payload);
    } catch (err) {
        console.error('[NotificationService] debug notification threw:', err.message);
        return { ok: false, state: 'failed', error: err.message };
    }
}

/**
 * Send a test notification for a specific task and type.
 * Clears any previous suppression state for this task so the test always fires.
 *
 * @param {Object} task - Task object
 * @param {string} type - One of NOTIFICATION_TYPE (REMINDER, DUE_DATE, PRIORITY)
 * @returns {Promise<{ok: boolean, state: string, error?: string, provider?: string}>}
 */
export async function sendTestNotification(task, type) {
    if (!task || !task.id) {
        return { ok: false, state: 'failed', error: 'Missing task data' };
    }

    // Clear suppression so the test always fires
    clearTaskNotificationState(task.id);

    return sendTaskNotification(task, type);
}

/**
 * Clear suppression state for a task (e.g., when its deadline is rescheduled).
 */
export function resetTaskNotificationState(taskId) {
    clearTaskNotificationState(taskId);
}

/**
 * Get current suppression statistics for diagnostics.
 */
export function getNotificationStats() {
    return {
        notifiedTaskCount: notifiedTaskIds.size,
        notifiedReminderCount: notifiedReminderIds.size,
    };
}
