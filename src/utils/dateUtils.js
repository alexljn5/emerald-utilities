// src/utils/dateUtils.js
// Centralised date/time formatting helpers.
//
// All user-facing date and time formatting goes through these helpers so that
// the locale is consistent across the entire application. We use 'en-GB'
// (British English) which renders dates in day/month/year order (dd/mm/yy)
// rather than the American month/day/year order (mm/dd/yy) that the system
// default locale would produce on US-configured machines.
//
// The locale is pinned here so that a single change updates every display.

/** Locale used for all user-facing date/time formatting. */
export const DATE_LOCALE = 'en-GB';

/**
 * Format a date as a human-readable date string (dd/mm/yy).
 *
 * @param {string|Date|number} value - ISO string, Date object, or timestamp.
 * @param {Intl.DateTimeFormatOptions} [options] - Additional formatting options.
 * @returns {string} Formatted date string, or '' if the value is invalid.
 */
export function formatDate(value, options = {}) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString(DATE_LOCALE, options);
}

/**
 * Format a date as a human-readable time string.
 *
 * @param {string|Date|number} value - ISO string, Date object, or timestamp.
 * @param {Intl.DateTimeFormatOptions} [options] - Additional formatting options.
 * @returns {string} Formatted time string, or '' if the value is invalid.
 */
export function formatTime(value, options = {}) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString(DATE_LOCALE, options);
}

/**
 * Format a date as a combined date+time string (dd/mm/yy, HH:MM).
 *
 * @param {string|Date|number} value - ISO string, Date object, or timestamp.
 * @param {Intl.DateTimeFormatOptions} [options] - Additional formatting options.
 * @returns {string} Formatted date+time string, or '' if the value is invalid.
 */
export function formatDateTime(value, options = {}) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString(DATE_LOCALE, options);
}
