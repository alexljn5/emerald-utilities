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
 *   REMINDER      — reminder_time has been reached
 *   DUE_DATE      — due_time has been reached (task is now due)
 *   PRIORITY      — high-priority task requiring attention
 *   SUBTASK_DUE   — a subtask deadline has been reached
 *   DEBUG         — generic debug/test notification
 */

import { OSNotifier, getAumid } from './osNotifier.js';
import { formatDateTime } from './dateUtils.js';
import path from 'path';
import { app } from 'electron';
import fs from 'fs';
import { resolvePath } from './pathResolver.js';
import {
    NOTIFICATION_POLICY,
    shouldNotifyTask,
    recordNotification,
    snoozeTask,
    dismissForToday,
    dismissUntilTomorrow,
    dismissPermanently,
    clearTaskNotificationPolicy,
    getPolicyCooldown,
    getPolicyStats,
} from './notificationPolicy.js';

// ---------------------------------------------------------------------------
// Notification type constants
// ---------------------------------------------------------------------------

export const NOTIFICATION_TYPE = Object.freeze({
    REMINDER: 'reminder',
    DUE_DATE: 'due_date',
    PRIORITY: 'priority',
    SUBTASK_DUE: 'subtask_due',
    DEBUG: 'debug',
});

// ---------------------------------------------------------------------------
// Duplicate-suppression + cooldown state
// ---------------------------------------------------------------------------

const STATE_FILE = path.join(app.getPath('userData'), 'notification-suppression.json');

// Default cooldown: 1 hour between notifications for the same task.
// This prevents the "Reminder + Due Date + High Priority" spam for a single task.
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

let suppressionState = {
    notifiedTaskIds: [],
    notifiedReminderIds: [],
    lastNotifiedAt: {}, // taskId -> ISO timestamp of last notification
};

function loadSuppressionState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = fs.readFileSync(STATE_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            suppressionState = {
                notifiedTaskIds: Array.isArray(parsed.notifiedTaskIds) ? parsed.notifiedTaskIds : [],
                notifiedReminderIds: Array.isArray(parsed.notifiedReminderIds) ? parsed.notifiedReminderIds : [],
                lastNotifiedAt: typeof parsed.lastNotifiedAt === 'object' && parsed.lastNotifiedAt !== null
                    ? parsed.lastNotifiedAt
                    : {},
            };
        }
    } catch {
        // Corrupt or unreadable state file — start fresh
        suppressionState = { notifiedTaskIds: [], notifiedReminderIds: [], lastNotifiedAt: {} };
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
const lastNotifiedAt = suppressionState.lastNotifiedAt;

function markTaskNotified(taskId) {
    notifiedTaskIds.add(taskId);
    suppressionState.notifiedTaskIds = [...notifiedTaskIds];
    suppressionState.lastNotifiedAt = { ...lastNotifiedAt, [taskId]: new Date().toISOString() };
    saveSuppressionState();
}

function markReminderNotified(taskId) {
    notifiedReminderIds.add(taskId);
    suppressionState.notifiedReminderIds = [...notifiedReminderIds];
    suppressionState.lastNotifiedAt = { ...lastNotifiedAt, [taskId]: new Date().toISOString() };
    saveSuppressionState();
}

function clearTaskNotificationState(taskId) {
    notifiedTaskIds.delete(taskId);
    notifiedReminderIds.delete(taskId);
    delete lastNotifiedAt[taskId];
    // Also clear any failure tracking for this task
    Object.keys(lastNotifiedAt).forEach(key => {
        if (key.startsWith(`failure:${taskId}:`)) {
            delete lastNotifiedAt[key];
        }
    });
    suppressionState.notifiedTaskIds = [...notifiedTaskIds];
    suppressionState.notifiedReminderIds = [...notifiedReminderIds];
    suppressionState.lastNotifiedAt = { ...lastNotifiedAt };
    saveSuppressionState();
}

function isTaskNotified(taskId) {
    return notifiedTaskIds.has(taskId);
}

function isReminderNotified(taskId) {
    return notifiedReminderIds.has(taskId);
}

/**
 * Check if a task is still in its cooldown period.
 * Returns true if the task was notified recently and should be skipped.
 */
function isInCooldown(taskId, cooldownMs = DEFAULT_COOLDOWN_MS) {
    const last = lastNotifiedAt[taskId];
    if (!last) return false;
    const elapsed = Date.now() - new Date(last).getTime();
    return elapsed < cooldownMs;
}

// ---------------------------------------------------------------------------
// Branding / icon resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the Emerald Utilities sigil/logo icon for Windows toast notifications.
 * Reuses the exact transparent asset used by the About page (img/emerald_logo_merge_transparent.png).
 */
function resolveNotificationIcon() {
    const candidates = [
        resolvePath('img/logos/emerald_logo_merge_transparent.png'),
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
    if (task.due_time) parts.push(`Due: ${formatDateTime(task.due_time)}`);
    if (task.reminder_time) parts.push(`Reminder: ${formatDateTime(task.reminder_time)}`);
    return {
        title: 'Reminder',
        message: parts.join('\n'),
        urgency: task.priority === 'red' ? 'critical' : task.priority === 'orange' ? 'normal' : 'low',
        icon: NOTIFICATION_ICON,
    };
}

function buildDueDatePayload(task) {
    const parts = [task.title];
    if (task.due_time) parts.push(`Due: ${formatDateTime(task.due_time)}`);
    if (task.reminder_time) parts.push(`Reminder: ${formatDateTime(task.reminder_time)}`);
    return {
        title: 'Due date',
        message: parts.join('\n'),
        urgency: task.priority === 'red' ? 'critical' : task.priority === 'orange' ? 'normal' : 'low',
        icon: NOTIFICATION_ICON,
    };
}

function buildPriorityPayload(task) {
    const parts = [task.title];
    if (task.due_time) parts.push(`Due: ${formatDateTime(task.due_time)}`);
    if (task.reminder_time) parts.push(`Reminder: ${formatDateTime(task.reminder_time)}`);
    parts.push('Requires attention.');
    return {
        title: 'High priority',
        message: parts.join('\n'),
        urgency: 'critical',
        icon: NOTIFICATION_ICON,
    };
}

function buildSubtaskDuePayload(task, subtask) {
    const parts = [task.title];
    if (subtask) {
        parts.push(`Subtask: ${subtask.title}`);
    }
    if (subtask?.due_time) parts.push(`Due: ${formatDateTime(subtask.due_time)}`);
    if (subtask?.reminder_time) parts.push(`Reminder: ${formatDateTime(subtask.reminder_time)}`);
    return {
        title: 'Subtask deadline',
        message: parts.join('\n'),
        urgency: task.priority === 'red' ? 'critical' : task.priority === 'orange' ? 'normal' : 'low',
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
 * Policy-aware: respects the task's notification_policy and state.
 *
 * @param {Object} task - Task object with at least { id, title, priority, notification_policy }
 * @param {string} type - One of NOTIFICATION_TYPE
 * @returns {Promise<{ok: boolean, state: string, error?: string, provider?: string, policyReason?: string}>}
 */
export async function sendTaskNotification(task, type, options = {}, subtask = null) {
    // Debug notifications do not require a task object
    if (type !== NOTIFICATION_TYPE.DEBUG && (!task || !task.id)) {
        return { ok: false, state: 'failed', error: 'Missing task data' };
    }

    const validTypes = Object.values(NOTIFICATION_TYPE);
    if (!validTypes.includes(type)) {
        return { ok: false, state: 'failed', error: `Unknown notification type: ${type}` };
    }

    // Policy check: should this task be notified?
    if (type !== NOTIFICATION_TYPE.DEBUG && task?.id) {
        const policyCheck = shouldNotifyTask(task);
        if (!policyCheck.shouldNotify) {
            return { ok: false, state: 'policy', error: policyCheck.reason, policyReason: policyCheck.reason };
        }
    }

    // Legacy cooldown check (kept for backward compatibility)
    const cooldownMs = options.cooldownMs ?? getPolicyCooldown(task?.notification_policy || NOTIFICATION_POLICY.DAILY, task?.custom_interval_minutes);

    if (type !== NOTIFICATION_TYPE.DEBUG && task?.id && isInCooldown(task.id, cooldownMs)) {
        return { ok: false, state: 'cooldown', error: `Task is in cooldown period (${Math.round(cooldownMs / 60000)}min)` };
    }

    // Track failures to prevent log spam
    const failureKey = `failure:${task?.id || 'debug'}:${type}`;
    if (!options.force && lastNotifiedAt[failureKey]) {
        const elapsed = Date.now() - new Date(lastNotifiedAt[failureKey]).getTime();
        // Only log the same failure once per 5 minutes
        if (elapsed < 5 * 60 * 1000) {
            return { ok: false, state: 'suppressed', error: 'Failure already logged recently' };
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
        case NOTIFICATION_TYPE.SUBTASK_DUE:
            payload = buildSubtaskDuePayload(task, subtask);
            break;
        case NOTIFICATION_TYPE.DEBUG:
            payload = buildDebugPayload();
            break;
        default:
            return { ok: false, state: 'failed', error: `Unhandled type: ${type}` };
    }

    // Record notification attempt BEFORE the OS call.
    // This prevents a retry loop when the OS notification fails permanently
    // (e.g. SnoreToast AUMID mismatch / exit code 3). The cooldown starts
    // from the attempt time, not the success time.
    if (type !== NOTIFICATION_TYPE.DEBUG && task?.id) {
        recordNotification(task.id);
    }
    if (type === NOTIFICATION_TYPE.REMINDER) {
        markReminderNotified(task.id);
    } else if (type !== NOTIFICATION_TYPE.DEBUG) {
        markTaskNotified(task.id);
    }

    try {
        const result = await OSNotifier.notify(payload);

        if (result.ok) {
            // Clear failure tracking on success
            delete lastNotifiedAt[failureKey];
            suppressionState.lastNotifiedAt = { ...lastNotifiedAt };
            saveSuppressionState();
        }

        return result;
    } catch (err) {
        // Record failure to prevent log spam
        lastNotifiedAt[failureKey] = new Date().toISOString();
        suppressionState.lastNotifiedAt = { ...lastNotifiedAt };
        saveSuppressionState();

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
    clearTaskNotificationPolicy(taskId);
}

/**
 * Snooze a task notification.
 * @param {string} taskId - Task ID
 * @param {number} minutes - Snooze duration in minutes
 */
export function snoozeTaskNotification(taskId, minutes = 60) {
    return snoozeTask(taskId, minutes);
}

/**
 * Dismiss a task notification for today.
 * @param {string} taskId - Task ID
 */
export function dismissTaskForToday(taskId) {
    return dismissForToday(taskId);
}

/**
 * Dismiss a task notification until tomorrow.
 * @param {string} taskId - Task ID
 */
export function dismissTaskUntilTomorrow(taskId) {
    return dismissUntilTomorrow(taskId);
}

/**
 * Dismiss a task notification permanently.
 * @param {string} taskId - Task ID
 */
export function dismissTaskPermanently(taskId) {
    return dismissPermanently(taskId);
}

/**
 * Get combined notification statistics for diagnostics.
 */
export function getNotificationStats() {
    const failureCount = Object.keys(lastNotifiedAt).filter(k => k.startsWith('failure:')).length;
    const policyStats = getPolicyStats();
    return {
        notifiedTaskCount: notifiedTaskIds.size,
        notifiedReminderCount: notifiedReminderIds.size,
        cooldownCount: Object.keys(lastNotifiedAt).filter(k => !k.startsWith('failure:')).length,
        failureCount,
        ...policyStats,
    };
}
