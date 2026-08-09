/**
 * Unit tests for the shared logger.
 *
 * The logger imports nothing from Electron, so it runs fine under
 * `node --test`. These tests focus on the SECURITY-critical behaviour:
 * secrets must never survive redaction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, dbLog, ragLog, ollamaLog } from '../../src/utils/logger.js';

test('createLogger returns the expected shape', () => {
    const log = createLogger('DB');
    assert.equal(typeof log.info, 'function');
    assert.equal(typeof log.warn, 'function');
    assert.equal(typeof log.error, 'function');
    assert.equal(typeof log.debug, 'function');
    assert.equal(typeof log.redact, 'function');
    assert.equal(log.subsystem, 'DB');
});

test('pre-bound subsystem loggers are exported', () => {
    assert.ok(dbLog);
    assert.ok(ragLog);
    assert.ok(ollamaLog);
    assert.equal(dbLog.subsystem, 'DB');
    assert.equal(ragLog.subsystem, 'RAG');
    assert.equal(ollamaLog.subsystem, 'OLLAMA');
});

test('redact scrubs password in object keys', () => {
    const { redact } = createLogger('DB');
    const out = redact({ user: 'alexljn5', password: '[REDACTED]' });
    assert.equal(out.user, 'alexljn5');
    assert.equal(out.password, '[REDACTED]');
});

test('redact scrubs nested sensitive keys', () => {
    const { redact } = createLogger('CONFIG');
    const out = redact({
        database: { host: 'h', password: 'pw' },
        providers: { grok: { apiKey: 'k' } },
    });
    assert.equal(out.database.host, 'h');
    assert.equal(out.database.password, '[REDACTED]');
    assert.equal(out.providers.grok.apiKey, '[REDACTED]');
});

test('redact scrubs inline password in a connection string', () => {
    const { redact } = createLogger('DB');
    const out = redact('postgres://alexljn5:[REDACTED]@192.168.2.27:5432/emerald_utilities');
    assert.ok(!out.includes('[REDACTED]'), `secret leaked: ${out}`);
    assert.ok(out.includes('192.168.2.27'), 'host should be preserved');
});

test('redact scrubs inline key=value secrets in free text', () => {
    const { redact } = createLogger('DB');
    const out = redact('connecting with password=[REDACTED] to db');
    assert.ok(!out.includes('[REDACTED]'), `secret leaked: ${out}`);
});

test('redact leaves non-sensitive values untouched', () => {
    const { redact } = createLogger('DB');
    assert.equal(redact('just a normal log line'), 'just a normal log line');
    assert.equal(redact(42), 42);
    assert.equal(redact(null), null);
});
