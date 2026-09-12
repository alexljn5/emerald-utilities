/**
 * Unit tests for taskStorage.js
 *
 * Verifies the localStorage abstraction works in both browser and Node
 * environments without crashing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import taskStorage from '../../src/tasks/storage/taskStorage.js';

test('taskStorage getItem returns null for missing key', () => {
    assert.equal(taskStorage.getItem('nonexistent'), null);
});

test('taskStorage setItem and getItem roundtrip', () => {
    taskStorage.setItem('test_key', 'test_value');
    assert.equal(taskStorage.getItem('test_key'), 'test_value');
    taskStorage.removeItem('test_key');
});

test('taskStorage removeItem clears value', () => {
    taskStorage.setItem('temp_key', 'temp_value');
    taskStorage.removeItem('temp_key');
    assert.equal(taskStorage.getItem('temp_key'), null);
});

test('taskStorage clear removes all prefixed keys', () => {
    taskStorage.setItem('clear_a', '1');
    taskStorage.setItem('clear_b', '2');
    taskStorage.clear();
    assert.equal(taskStorage.getItem('clear_a'), null);
    assert.equal(taskStorage.getItem('clear_b'), null);
});

test('taskStorage handles JSON values', () => {
    const obj = { id: '123', title: 'Test task' };
    taskStorage.setItem('json_key', JSON.stringify(obj));
    const retrieved = JSON.parse(taskStorage.getItem('json_key'));
    assert.deepEqual(retrieved, obj);
    taskStorage.removeItem('json_key');
});
