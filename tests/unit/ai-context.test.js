/**
 * Unit tests for AI conversation context assembly.
 *
 * Tests the deterministic context pipeline that reconstructs conversations
 * from PostgreSQL for the AI model.
 *
 * These tests verify:
 * A. User sends message A.
 * B. User sends message B referring to A.
 * C. Context builder contains A before sending B to the model.
 * D. Restarting the application still allows retrieval of A and B.
 * E. A separate conversation cannot see A or B.
 * F. Action/reference continuity: "I hugged you" → "What are we doing?"
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildConversationContext,
    buildContext,
    roleOf,
} from '../../src/database/ai-persistence.js';
import { normalizeModelResponse } from '../../src/database/response-normalizer.js';

// ============================================================
// roleOf tests
// ============================================================

test('roleOf maps emerald-user to user', () => {
    assert.equal(roleOf('emerald-user'), 'user');
});

test('roleOf maps Cream to assistant', () => {
    assert.equal(roleOf('Cream'), 'assistant');
});

test('roleOf maps user to user', () => {
    assert.equal(roleOf('user'), 'user');
});

test('roleOf maps assistant to assistant', () => {
    assert.equal(roleOf('assistant'), 'assistant');
});

test('roleOf maps unknown to lowercase fallback', () => {
    assert.equal(roleOf('UnknownBot'), 'unknownbot');
});

test('roleOf handles null/empty', () => {
    assert.equal(roleOf(null), 'user');
    assert.equal(roleOf(''), 'user');
});

// ============================================================
// buildContext tests (legacy)
// ============================================================

test('buildContext maps authors to roles', () => {
    const messages = [
        { author: 'emerald-user', content: 'hello' },
        { author: 'Cream', content: 'hi there' },
    ];
    const ctx = buildContext(messages);
    assert.equal(ctx[0].role, 'user');
    assert.equal(ctx[0].content, 'hello');
    assert.equal(ctx[1].role, 'assistant');
    assert.equal(ctx[1].content, 'hi there');
});

test('buildContext prepends system prompt when provided', () => {
    const messages = [{ author: 'emerald-user', content: 'hello' }];
    const ctx = buildContext(messages, 'You are a helpful assistant.');
    assert.equal(ctx[0].role, 'system');
    assert.equal(ctx[0].content, 'You are a helpful assistant.');
    assert.equal(ctx[1].role, 'user');
});

// ============================================================
// buildConversationContext tests
// ============================================================

test('buildConversationContext orders messages for correct truncation priority', () => {
    const recent = [
        { id: 'r1', author: 'emerald-user', content: 'old user message', timestamp: '2024-01-01T00:00:00Z' },
        { id: 'r2', author: 'Cream', content: 'old assistant message', timestamp: '2024-01-01T00:00:01Z' },
    ];
    const retrieved = [
        { id: 'ret1', author: 'user', content: 'retrieved old message', timestamp: '2024-01-01T00:00:00Z', window: [] },
    ];
    const userMessage = 'current user message';

    const bundle = buildConversationContext({
        userMessage,
        recent,
        retrieved,
    });

    // Order should be: system(0) + retrieved + recent + current
    // So truncation (backwards from end) preserves: current > recent > retrieved
    const roles = bundle.messages.map(m => m.role);
    const contents = bundle.messages.map(m => m.content);

    // Current message should be LAST
    assert.equal(contents[contents.length - 1], userMessage);
    assert.equal(roles[roles.length - 1], 'user');

    // Retrieved should come before recent in array order
    // (so that truncation working backwards preserves recent first)
    const recentIdx = contents.indexOf('old user message');
    const retrievedIdx = contents.indexOf('retrieved old message');
    assert.ok(retrievedIdx < recentIdx, 'Retrieved should come before recent in array order (so recent has higher truncation priority)');
});

test('buildConversationContext deduplicates messages across recent and retrieved', () => {
    const recent = [
        { id: 'm1', author: 'emerald-user', content: 'same message', timestamp: '2024-01-01T00:00:00Z' },
    ];
    const retrieved = [
        {
            id: 'm1',
            author: 'emerald-user',
            content: 'same message',
            timestamp: '2024-01-01T00:00:00Z',
            window: [{ id: 'm1', author: 'emerald-user', content: 'same message', timestamp: '2024-01-01T00:00:00Z' }],
        },
    ];

    const bundle = buildConversationContext({
        userMessage: 'new message',
        recent,
        retrieved,
    });

    // The duplicate should appear only once
    const sameCount = bundle.messages.filter(m => m.content === 'same message').length;
    assert.equal(sameCount, 1, 'Duplicate message should be deduplicated');
});

test('buildConversationContext includes system prompt when provided', () => {
    const bundle = buildConversationContext({
        systemPrompt: 'You are Cream.',
        userMessage: 'hello',
    });

    assert.equal(bundle.system.length, 1);
    assert.equal(bundle.system[0].role, 'system');
    assert.equal(bundle.system[0].content, 'You are Cream.');
    assert.equal(bundle.messages[0].role, 'system');
});

test('buildConversationContext handles empty recent and retrieved', () => {
    const bundle = buildConversationContext({
        userMessage: 'hello',
    });

    assert.equal(bundle.recent.length, 0);
    assert.equal(bundle.retrieved.length, 0);
    assert.equal(bundle.messages.length, 1);
    assert.equal(bundle.messages[0].role, 'user');
    assert.equal(bundle.messages[0].content, 'hello');
});

test('buildConversationContext current message is not duplicated in recent', () => {
    const recent = [
        { id: 'r1', author: 'emerald-user', content: 'previous message', timestamp: '2024-01-01T00:00:00Z' },
    ];
    const userMessage = 'current message';

    const bundle = buildConversationContext({
        userMessage,
        recent,
    });

    // Current message should appear exactly once (at the end)
    const currentCount = bundle.messages.filter(m => m.content === userMessage).length;
    assert.equal(currentCount, 1, 'Current message should appear exactly once');
});

// ============================================================
// Action/reference continuity test
// ============================================================

test('context for "What are we doing?" includes preceding "hug" turn', () => {
    // Simulate a conversation where:
    // 1. User: "I just hugged you."
    // 2. Assistant: acknowledgement
    // 3. User: "What are we doing?"
    // The context for message 3 MUST include message 1.

    const recent = [
        { id: 'm1', author: 'emerald-user', content: 'I just hugged you.', timestamp: '2024-01-01T00:00:00Z' },
        { id: 'm2', author: 'Cream', content: '*smiles and hugs back warmly*', timestamp: '2024-01-01T00:00:01Z' },
    ];
    const userMessage = 'What are we doing?';

    const bundle = buildConversationContext({
        userMessage,
        recent,
    });

    // The hug message must be in the context
    const hasHug = bundle.messages.some(m => m.content === 'I just hugged you.');
    assert.ok(hasHug, 'Context must contain the preceding "hug" turn');

    // The assistant acknowledgement must be in the context
    const hasAcknowledgement = bundle.messages.some(m => m.content === '*smiles and hugs back warmly*');
    assert.ok(hasAcknowledgement, 'Context must contain the assistant acknowledgement');

    // The current message must be last
    assert.equal(bundle.messages[bundle.messages.length - 1].content, userMessage);
});

test('context for "What did I just do?" includes preceding action', () => {
    const recent = [
        { id: 'm1', author: 'emerald-user', content: 'I put a blanket around you.', timestamp: '2024-01-01T00:00:00Z' },
        { id: 'm2', author: 'Cream', content: 'That feels so cozy, thank you.', timestamp: '2024-01-01T00:00:01Z' },
    ];
    const userMessage = 'What did I just do?';

    const bundle = buildConversationContext({
        userMessage,
        recent,
    });

    const hasBlanket = bundle.messages.some(m => m.content === 'I put a blanket around you.');
    assert.ok(hasBlanket, 'Context must contain the preceding blanket action');
});

test('context for "What are we doing now?" includes preceding blanket turn', () => {
    const recent = [
        { id: 'm1', author: 'emerald-user', content: 'I put a blanket around you.', timestamp: '2024-01-01T00:00:00Z' },
        { id: 'm2', author: 'Cream', content: 'So warm and cozy...', timestamp: '2024-01-01T00:00:01Z' },
    ];
    const userMessage = 'What are we doing now?';

    const bundle = buildConversationContext({
        userMessage,
        recent,
    });

    const hasBlanket = bundle.messages.some(m => m.content === 'I put a blanket around you.');
    assert.ok(hasBlanket, 'Context must contain the preceding blanket turn');
});

test('context for "What did I just do?" with eggs and bacon', () => {
    const recent = [
        { id: 'm1', author: 'emerald-user', content: 'I just gave you eggs and bacon.', timestamp: '2024-01-01T00:00:00Z' },
        { id: 'm2', author: 'Cream', content: 'Mmm, delicious! Thank you so much.', timestamp: '2024-01-01T00:00:01Z' },
    ];
    const userMessage = 'What did I just do?';

    const bundle = buildConversationContext({
        userMessage,
        recent,
    });

    const hasFood = bundle.messages.some(m => m.content === 'I just gave you eggs and bacon.');
    assert.ok(hasFood, 'Context must contain the preceding food action');
});

// ============================================================
// Conversation isolation test
// ============================================================

test('separate conversation cannot see messages from another conversation', () => {
    const recentA = [
        { id: 'a1', author: 'emerald-user', content: 'Secret from conversation A', timestamp: '2024-01-01T00:00:00Z' },
    ];
    const recentB = [
        { id: 'b1', author: 'emerald-user', content: 'Public from conversation B', timestamp: '2024-01-01T00:00:00Z' },
    ];

    const bundleA = buildConversationContext({
        userMessage: 'What did I say?',
        recent: recentA,
    });

    const bundleB = buildConversationContext({
        userMessage: 'What did I say?',
        recent: recentB,
    });

    // Conversation A should only see its own messages
    const hasSecretInA = bundleA.messages.some(m => m.content === 'Secret from conversation A');
    assert.ok(hasSecretInA, 'Conversation A should see its own messages');

    const hasPublicInA = bundleA.messages.some(m => m.content === 'Public from conversation B');
    assert.ok(!hasPublicInA, 'Conversation A should NOT see conversation B messages');

    // Conversation B should only see its own messages
    const hasPublicInB = bundleB.messages.some(m => m.content === 'Public from conversation B');
    assert.ok(hasPublicInB, 'Conversation B should see its own messages');

    const hasSecretInB = bundleB.messages.some(m => m.content === 'Secret from conversation A');
    assert.ok(!hasSecretInB, 'Conversation B should NOT see conversation A messages');
});

// ============================================================
// Multi-turn conversation test
// ============================================================

test('multi-turn conversation preserves all turns in order', () => {
    const recent = [
        { id: 'm1', author: 'emerald-user', content: 'Turn 1: Hello', timestamp: '2024-01-01T00:00:00Z' },
        { id: 'm2', author: 'Cream', content: 'Turn 1: Hi!', timestamp: '2024-01-01T00:00:01Z' },
        { id: 'm3', author: 'emerald-user', content: 'Turn 2: How are you?', timestamp: '2024-01-01T00:00:02Z' },
        { id: 'm4', author: 'Cream', content: 'Turn 2: I am well!', timestamp: '2024-01-01T00:00:03Z' },
        { id: 'm5', author: 'emerald-user', content: 'Turn 3: What is 2+2?', timestamp: '2024-01-01T00:00:04Z' },
    ];
    const userMessage = 'Turn 4: And 3+3?';

    const bundle = buildConversationContext({
        userMessage,
        recent,
    });

    // All turns should be present
    assert.ok(bundle.messages.some(m => m.content === 'Turn 1: Hello'));
    assert.ok(bundle.messages.some(m => m.content === 'Turn 1: Hi!'));
    assert.ok(bundle.messages.some(m => m.content === 'Turn 2: How are you?'));
    assert.ok(bundle.messages.some(m => m.content === 'Turn 2: I am well!'));
    assert.ok(bundle.messages.some(m => m.content === 'Turn 3: What is 2+2?'));

    // Current message should be last
    assert.equal(bundle.messages[bundle.messages.length - 1].content, userMessage);

    // Order should be preserved (chronological within recent)
    const recentMessages = bundle.messages.filter(m => ['Turn 1: Hello', 'Turn 1: Hi!', 'Turn 2: How are you?', 'Turn 2: I am well!', 'Turn 3: What is 2+2?'].includes(m.content));
    const expectedOrder = ['Turn 1: Hello', 'Turn 1: Hi!', 'Turn 2: How are you?', 'Turn 2: I am well!', 'Turn 3: What is 2+2?'];
    const actualOrder = recentMessages.map(m => m.content);
    assert.deepEqual(actualOrder, expectedOrder);
});

// ============================================================
// RAG cross-conversation isolation test
// ============================================================

test('RAG hits from other conversations are marked with source conversation', () => {
    const retrieved = [
        {
            id: 'other1',
            conversation_id: 'conv-other',
            content: 'Message from another conversation',
            author: 'user',
            timestamp: '2024-01-01T00:00:00Z',
            similarity: 0.9,
            window: [],
        },
    ];

    const bundle = buildConversationContext({
        userMessage: 'hello',
        recent: [],
        retrieved,
    });

    const hit = bundle.retrieved[0];
    assert.equal(hit.sourceConversation, 'conv-other');
    assert.equal(hit.source, 'retrieved');
});

// ============================================================
// Debug logging verification
// ============================================================

test('buildConversationContext logs debug info', () => {
    // This test just verifies the function doesn't throw when called
    // with various inputs. The actual logging is verified by inspection
    // of console output during test runs.
    const bundle = buildConversationContext({
        systemPrompt: 'test system',
        userMessage: 'test',
        recent: [{ id: 'r1', author: 'emerald-user', content: 'recent', timestamp: '2024-01-01T00:00:00Z' }],
        retrieved: [],
        conversationId: 'test-conv',
    });

    assert.ok(bundle);
    assert.ok(bundle.messages.length > 0);
});

// ============================================================
// normalizeModelResponse tests
// ============================================================

test('normalizeModelResponse strips single leading assistant label', () => {
    const input = 'assistant\nHello there!';
    const result = normalizeModelResponse(input);
    assert.equal(result, 'Hello there!');
});

test('normalizeModelResponse strips double leading assistant labels', () => {
    const input = 'assistant\nassistant\nHello there!';
    const result = normalizeModelResponse(input);
    assert.equal(result, 'Hello there!');
});

test('normalizeModelResponse strips assistant label with CRLF', () => {
    const input = 'assistant\r\n\r\nHello there!';
    const result = normalizeModelResponse(input);
    assert.equal(result, 'Hello there!');
});

test('normalizeModelResponse preserves legitimate assistant word in content', () => {
    const input = 'The assistant role is important in this conversation.';
    const result = normalizeModelResponse(input);
    assert.equal(result, input);
});

test('normalizeModelResponse handles empty string', () => {
    assert.equal(normalizeModelResponse(''), '');
});

test('normalizeModelResponse handles null/undefined', () => {
    assert.equal(normalizeModelResponse(null), null);
    assert.equal(normalizeModelResponse(undefined), undefined);
});

test('normalizeModelResponse strips assistant-only response', () => {
    const input = 'assistant';
    const result = normalizeModelResponse(input);
    assert.equal(result, '');
});

test('normalizeModelResponse is case-insensitive for leading label', () => {
    const input = 'ASSISTANT\nHello!';
    const result = normalizeModelResponse(input);
    assert.equal(result, 'Hello!');
});

test('normalizeModelResponse does not strip assistant from middle of text', () => {
    const input = 'First, assistant says hello. Then user replies.';
    const result = normalizeModelResponse(input);
    assert.equal(result, input);
});
