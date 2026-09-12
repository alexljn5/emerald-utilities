/**
 * Unit tests for grok JSON parsing expectations.
 *
 * The importer (populate-from-raw.js) reads .json files and extracts a
 * `messages` array, deriving conversationId from either `conversationId`
 * or `conversation_id`. These tests lock that contract against a fixture,
 * without touching the database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, '..', 'fixtures', 'grok-sample.json');

/** Mirror the importer's message-extraction logic (pure, no DB). */
function extractMessages(data) {
    if (data && Array.isArray(data.messages)) return data.messages;
    if (Array.isArray(data)) return data.filter((item) => item.id && item.content);
    return [];
}

function resolveConversationId(msg) {
    return msg.conversationId || msg.conversation_id || 'unknown';
}

test('fixture parses into two messages', () => {
    const data = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const messages = extractMessages(data);
    assert.equal(messages.length, 2);
});

test('camelCase conversationId is resolved', () => {
    const data = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const messages = extractMessages(data);
    assert.equal(resolveConversationId(messages[0]), 'conv-aaa');
});

test('snake_case conversation_id is resolved', () => {
    const data = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const messages = extractMessages(data);
    assert.equal(resolveConversationId(messages[1]), 'conv-aaa');
});

test('missing conversation id falls back to "unknown"', () => {
    assert.equal(resolveConversationId({ id: 'x', content: 'y' }), 'unknown');
});

test('top-level array form filters out non-message objects', () => {
    const arr = [
        { meta: 'no id here' },
        { id: 'a', content: 'keep me' },
        { id: 'b' }, // no content -> dropped
    ];
    const messages = extractMessages(arr);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, 'a');
});
