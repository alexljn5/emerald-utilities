/**
 * Unit tests for the shared date/time formatting utility.
 *
 * These tests verify that all user-facing date and time formatting uses the
 * 'en-GB' locale (day/month/year order) rather than the system default,
 * which would produce American mm/dd/yy format on US-configured machines.
 *
 * The tests run under `node --test` and do not require Electron.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDate, formatTime, formatDateTime, DATE_LOCALE } from '../../src/utils/dateUtils.js';

// ---------------------------------------------------------------------------
// Locale constant
// ---------------------------------------------------------------------------

test('DATE_LOCALE is en-GB', () => {
    assert.equal(DATE_LOCALE, 'en-GB');
});

// ---------------------------------------------------------------------------
// formatDate
// ---------------------------------------------------------------------------

test('formatDate returns empty string for null/undefined/empty', () => {
    assert.equal(formatDate(null), '');
    assert.equal(formatDate(undefined), '');
    assert.equal(formatDate(''), '');
});

test('formatDate returns empty string for invalid date', () => {
    assert.equal(formatDate('not-a-date'), '');
    assert.equal(formatDate('invalid'), '');
});

test('formatDate formats ISO string as dd/mm/yy', () => {
    // 2026-09-12T10:00:00.000Z → in en-GB: 12/09/2026 (day/month/year)
    const result = formatDate('2026-09-12T10:00:00.000Z');
    assert.ok(result.includes('12'), `expected day 12 in result: ${result}`);
    assert.ok(result.includes('09'), `expected month 09 in result: ${result}`);
    assert.ok(result.includes('2026'), `expected year 2026 in result: ${result}`);
});

test('formatDate uses day before month (en-GB order)', () => {
    // 2026-03-05 = 5 March 2026 in en-GB (dd/mm)
    // In en-US this would be March 5, but the day should come first
    const result = formatDate('2026-03-05T10:00:00.000Z', {
        day: 'numeric',
        month: 'numeric',
        year: 'numeric'
    });
    // en-GB numeric: "05/03/2026" (day/month/year)
    // en-US numeric: "03/05/2026" (month/day/year)
    assert.equal(result, '05/03/2026', `expected dd/mm/yy format, got: ${result}`);
});

test('formatDate accepts Date object', () => {
    const d = new Date(2026, 8, 12, 10, 30, 0); // Sep 12, 2026
    const result = formatDate(d, { year: 'numeric', month: 'short', day: 'numeric' });
    assert.ok(result.includes('12'), `expected day 12 in result: ${result}`);
    assert.ok(result.includes('Sep'), `expected month Sep in result: ${result}`);
    assert.ok(result.includes('2026'), `expected year 2026 in result: ${result}`);
});

test('formatDate accepts timestamp number', () => {
    const ts = new Date(2026, 8, 12, 10, 30, 0).getTime();
    const result = formatDate(ts, { year: 'numeric', month: 'short', day: 'numeric' });
    assert.ok(result.includes('12'), `expected day 12 in result: ${result}`);
    assert.ok(result.includes('Sep'), `expected month Sep in result: ${result}`);
    assert.ok(result.includes('2026'), `expected year 2026 in result: ${result}`);
});

test('formatDate with weekday option', () => {
    // 2026-09-12 is a Saturday
    const result = formatDate('2026-09-12T10:00:00.000Z', {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
    assert.ok(result.includes('Sat'), `expected weekday Sat in result: ${result}`);
});

// ---------------------------------------------------------------------------
// formatTime
// ---------------------------------------------------------------------------

test('formatTime returns empty string for null/undefined/empty', () => {
    assert.equal(formatTime(null), '');
    assert.equal(formatTime(undefined), '');
    assert.equal(formatTime(''), '');
});

test('formatTime returns empty string for invalid date', () => {
    assert.equal(formatTime('not-a-date'), '');
});

test('formatTime formats ISO string with 24-hour clock', () => {
    // 2026-09-12T14:30:00.000Z → 16:30 in Amsterdam (UTC+2)
    const result = formatTime('2026-09-12T14:30:00.000Z', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
    // en-GB uses 24-hour format by default
    assert.ok(result.match(/\d{2}:\d{2}:\d{2}/), `expected HH:MM:SS format, got: ${result}`);
});

test('formatTime accepts Date object', () => {
    const d = new Date(2026, 8, 12, 14, 30, 45);
    const result = formatTime(d, { hour: '2-digit', minute: '2-digit' });
    assert.ok(result.match(/\d{2}:\d{2}/), `expected HH:MM format, got: ${result}`);
});

// ---------------------------------------------------------------------------
// formatDateTime
// ---------------------------------------------------------------------------

test('formatDateTime returns empty string for null/undefined/empty', () => {
    assert.equal(formatDateTime(null), '');
    assert.equal(formatDateTime(undefined), '');
    assert.equal(formatDateTime(''), '');
});

test('formatDateTime returns empty string for invalid date', () => {
    assert.equal(formatDateTime('not-a-date'), '');
});

test('formatDateTime formats ISO string with en-GB locale', () => {
    const result = formatDateTime('2026-09-12T10:00:00.000Z');
    assert.ok(result.length > 0, 'expected non-empty result');
    // en-GB should put day before month
    const dayMatch = result.match(/\b12\b/);
    assert.ok(dayMatch, `expected day 12 in result: ${result}`);
});

test('formatDateTime uses day before month (en-GB order)', () => {
    // 2026-03-05 = 5 March 2026
    const result = formatDateTime('2026-03-05T10:00:00.000Z', {
        day: 'numeric',
        month: 'numeric',
        year: 'numeric'
    });
    // en-GB numeric: "05/03/2026" (day/month/year)
    assert.equal(result, '05/03/2026', `expected dd/mm/yy format, got: ${result}`);
});

test('formatDateTime accepts Date object', () => {
    const d = new Date(2026, 8, 12, 10, 30, 0);
    const result = formatDateTime(d, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
    assert.ok(result.includes('12'), `expected day 12 in result: ${result}`);
    assert.ok(result.includes('Sep'), `expected month Sep in result: ${result}`);
    assert.ok(result.includes('2026'), `expected year 2026 in result: ${result}`);
});

test('formatDateTime accepts timestamp number', () => {
    const ts = new Date(2026, 8, 12, 10, 30, 0).getTime();
    const result = formatDateTime(ts, {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
    assert.ok(result.includes('12'), `expected day 12 in result: ${result}`);
    assert.ok(result.includes('Sep'), `expected month Sep in result: ${result}`);
    assert.ok(result.includes('2026'), `expected year 2026 in result: ${result}`);
});

// ---------------------------------------------------------------------------
// Consistency: en-GB always produces dd/mm/yy regardless of system locale
// ---------------------------------------------------------------------------

test('formatDate numeric always produces day/month/year order', () => {
    // Use a date where day and month are different and unambiguous
    // 2026-04-07 = 7 April 2026
    // en-GB: 07/04/2026 (day/month/year)
    // en-US: 04/07/2026 (month/day/year)
    const result = formatDate('2026-04-07T10:00:00.000Z', {
        day: 'numeric',
        month: 'numeric',
        year: 'numeric'
    });
    assert.equal(result, '07/04/2026', `expected dd/mm/yy (07/04/2026), got: ${result}`);
});

test('formatDateTime numeric always produces day/month/year order', () => {
    // 2026-04-07 = 7 April 2026
    const result = formatDateTime('2026-04-07T10:00:00.000Z', {
        day: 'numeric',
        month: 'numeric',
        year: 'numeric'
    });
    assert.equal(result, '07/04/2026', `expected dd/mm/yy (07/04/2026), got: ${result}`);
});

test('formatDate with 2-digit year produces dd/mm/yy', () => {
    // 2026-04-07 = 7 April 2026
    const result = formatDate('2026-04-07T10:00:00.000Z', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit'
    });
    // en-GB 2-digit: "07/04/26" (dd/mm/yy)
    assert.equal(result, '07/04/26', `expected dd/mm/yy (07/04/26), got: ${result}`);
});
