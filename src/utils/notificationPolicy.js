/**
 * Notification Policy — defines when and how often a task should notify.
 *
 * Policies:
 *   none      — no notifications
 *   once      — notify once, then never again
 *   daily     — notify once per day
 *   weekly    — notify once per week
 *   custom    — notify at a custom interval (in minutes)
 *
 * Each policy has a cooldown period and a "dismissed until" timestamp.
 */

import path from 'path';
import { app } from 'electron';
import fs from 'fs';

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

export const NOTIFICATION_POLICY = Object.freeze({
    NONE: 'none',
    ONCE: 'once',
    DAILY: 'daily',
    WEEKLY: 'weekly',
    CUSTOM: 'custom',
});

// ---------------------------------------------------------------------------
// Policy definitions
// ---------------------------------------------------------------------------

const POLICY_DEFINITIONS = {
    [NOTIFICATION_POLICY.NONE]: {
        label: 'None',
        cooldownMs: Infinity,
        description: 'No notifications',
    },
    [NOTIFICATION_POLICY.ONCE]: {
        label: 'Once',
        cooldownMs: Infinity, // Only notify once ever
        description: 'Notify once only',
    },
    [NOTIFICATION_POLICY.DAILY]: {
        label: 'Daily',
        cooldownMs: 24 * 60 * 60 * 1000, // 24 hours
        description: 'Notify once per day',
    },
    [NOTIFICATION_POLICY.WEEKLY]: {
        label: 'Weekly',
        cooldownMs: 7 * 24 * 60 * 60 * 1000, // 7 days
        description: 'Notify once per week',
    },
    [NOTIFICATION_POLICY.CUSTOM]: {
        label: 'Custom',
        cooldownMs: 60 * 60 * 1000, // Default 1 hour, overridable
        description: 'Notify at custom interval',
    },
};

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

const STATE_FILE = path.join(app.getPath('userData'), 'notification-policy-state.json');

let policyState = {
    dismissedUntil: {}, // taskId -> ISO timestamp (don't notify before this)
    snoozedUntil: {},   // taskId -> ISO timestamp (don't notify before this)
    notifiedAt: {},     // taskId -> ISO timestamp of last notification
    customIntervals: {}, // taskId -> interval in minutes
};

function loadPolicyState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = fs.readFileSync(STATE_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            policyState = {
                dismissedUntil: typeof parsed.dismissedUntil === 'object' && parsed.dismissedUntil !== null
                    ? parsed.dismissedUntil : {},
                snoozedUntil: typeof parsed.snoozedUntil === 'object' && parsed.snoozedUntil !== null
                    ? parsed.snoozedUntil : {},
                notifiedAt: typeof parsed.notifiedAt === 'object' && parsed.notifiedAt !== null
                    ? parsed.notifiedAt : {},
                customIntervals: typeof parsed.customIntervals === 'object' && parsed.customIntervals !== null
                    ? parsed.customIntervals : {},
            };
        }
    } catch {
        policyState = { dismissedUntil: {}, snoozedUntil: {}, notifiedAt: {}, customIntervals: {} };
    }
}

function savePolicyState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(policyState, null, 2), 'utf8');
    } catch {
        // Non-fatal: in-memory tracking still works
    }
}

loadPolicyState();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the cooldown period for a given policy.
 * @param {string} policy - One of NOTIFICATION_POLICY
 * @param {number} customIntervalMinutes - Custom interval in minutes (for CUSTOM policy)
 * @returns {number} Cooldown in milliseconds
 */
export function getPolicyCooldown(policy, customIntervalMinutes = 60) {
    const def = POLICY_DEFINITIONS[policy] || POLICY_DEFINITIONS[NOTIFICATION_POLICY.DAILY];
    if (policy === NOTIFICATION_POLICY.CUSTOM) {
        return (customIntervalMinutes || def.cooldownMs / (60 * 1000)) * 60 * 1000;
    }
    return def.cooldownMs;
}

/**
 * Check if a task should be notified based on its policy and state.
 * @param {Object} task - Task object with { id, status, notification_policy, custom_interval_minutes }
 * @returns {Object} { shouldNotify: boolean, reason: string }
 */
export function shouldNotifyTask(task) {
    if (!task || !task.id) {
        return { shouldNotify: false, reason: 'Invalid task' };
    }

    // Don't notify completed/archived/disabled tasks
    if (task.status === 'completed' || task.status === 'archived' || task.disabled) {
        return { shouldNotify: false, reason: `Task is ${task.status || 'disabled'}` };
    }

    const policy = task.notification_policy || NOTIFICATION_POLICY.DAILY;

    // None policy never notifies
    if (policy === NOTIFICATION_POLICY.NONE) {
        return { shouldNotify: false, reason: 'Policy is none' };
    }

    const now = Date.now();

    // Check snooze
    const snoozedUntil = policyState.snoozedUntil[task.id];
    if (snoozedUntil && now < new Date(snoozedUntil).getTime()) {
        return { shouldNotify: false, reason: `Snoozed until ${snoozedUntil}` };
    }

    // Check dismiss
    const dismissedUntil = policyState.dismissedUntil[task.id];
    if (dismissedUntil && now < new Date(dismissedUntil).getTime()) {
        return { shouldNotify: false, reason: `Dismissed until ${dismissedUntil}` };
    }

    // Check policy-specific cooldown
    const lastNotified = policyState.notifiedAt[task.id];
    if (lastNotified) {
        const cooldownMs = getPolicyCooldown(policy, task.custom_interval_minutes);
        const elapsed = now - new Date(lastNotified).getTime();

        if (policy === NOTIFICATION_POLICY.ONCE) {
            return { shouldNotify: false, reason: 'Already notified once' };
        }

        if (elapsed < cooldownMs) {
            return { shouldNotify: false, reason: `In cooldown (${Math.round((cooldownMs - elapsed) / 60000)}min remaining)` };
        }
    }

    return { shouldNotify: true, reason: 'Policy allows notification' };
}

/**
 * Record that a task was notified.
 * @param {string} taskId - Task ID
 */
export function recordNotification(taskId) {
    policyState.notifiedAt[taskId] = new Date().toISOString();
    // Clear snooze/dismiss on notification
    delete policyState.snoozedUntil[taskId];
    delete policyState.dismissedUntil[taskId];
    savePolicyState();
}

/**
 * Snooze a task for a specified duration.
 * @param {string} taskId - Task ID
 * @param {number} minutes - Snooze duration in minutes
 */
export function snoozeTask(taskId, minutes = 60) {
    const until = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    policyState.snoozedUntil[taskId] = until;
    savePolicyState();
    return until;
}

/**
 * Dismiss a task for the rest of the day.
 * @param {string} taskId - Task ID
 */
export function dismissForToday(taskId) {
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    policyState.dismissedUntil[taskId] = endOfDay.toISOString();
    savePolicyState();
    return endOfDay.toISOString();
}

/**
 * Dismiss a task until tomorrow.
 * @param {string} taskId - Task ID
 */
export function dismissUntilTomorrow(taskId) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0); // 9 AM tomorrow
    policyState.dismissedUntil[taskId] = tomorrow.toISOString();
    savePolicyState();
    return tomorrow.toISOString();
}

/**
 * Dismiss a task permanently.
 * @param {string} taskId - Task ID
 */
export function dismissPermanently(taskId) {
    policyState.dismissedUntil[taskId] = new Date('9999-12-31T23:59:59Z').toISOString();
    savePolicyState();
}

/**
 * Clear all notification state for a task.
 * @param {string} taskId - Task ID
 */
export function clearTaskNotificationPolicy(taskId) {
    delete policyState.dismissedUntil[taskId];
    delete policyState.snoozedUntil[taskId];
    delete policyState.notifiedAt[taskId];
    delete policyState.customIntervals[taskId];
    savePolicyState();
}

/**
 * Set a custom notification interval for a task.
 * @param {string} taskId - Task ID
 * @param {number} minutes - Interval in minutes
 */
export function setCustomInterval(taskId, minutes) {
    policyState.customIntervals[taskId] = minutes;
    savePolicyState();
}

/**
 * Get the custom interval for a task.
 * @param {string} taskId - Task ID
 * @returns {number|undefined} Interval in minutes, or undefined if not set
 */
export function getCustomInterval(taskId) {
    return policyState.customIntervals[taskId];
}

/**
 * Get all available policies.
 * @returns {Array} Array of { value, label, description }
 */
export function getAvailablePolicies() {
    return Object.entries(POLICY_DEFINITIONS).map(([value, def]) => ({
        value,
        label: def.label,
        description: def.description,
    }));
}

/**
 * Get policy statistics for diagnostics.
 */
export function getPolicyStats() {
    return {
        dismissedCount: Object.keys(policyState.dismissedUntil).length,
        snoozedCount: Object.keys(policyState.snoozedUntil).length,
        notifiedCount: Object.keys(policyState.notifiedAt).length,
        customIntervalCount: Object.keys(policyState.customIntervals).length,
    };
}
