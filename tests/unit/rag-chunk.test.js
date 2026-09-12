/**
 * Unit tests for the pure RAG text-chunking helper.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP } from '../../src/database/rag-chunk.js';

test('empty or non-string input returns an empty array', () => {
    assert.deepEqual(chunkText(''), []);
    assert.deepEqual(chunkText(null), []);
    assert.deepEqual(chunkText(undefined), []);
    assert.deepEqual(chunkText(12345), []);
});

test('short text returns a single chunk', () => {
    const text = 'a short message';
    assert.deepEqual(chunkText(text), [text]);
});

test('text exactly chunkSize returns a single chunk', () => {
    const text = 'x'.repeat(DEFAULT_CHUNK_SIZE);
    assert.deepEqual(chunkText(text), [text]);
});

test('long text is split into overlapping chunks', () => {
    const size = 10;
    const overlap = 3;
    const text = 'abcdefghijklmnopqrstuvwxyz'; // 26 chars
    const chunks = chunkText(text, size, overlap);

    // step = size - overlap = 7 -> starts at 0,7,14,21
    assert.equal(chunks.length, 4);
    assert.equal(chunks[0], 'abcdefghij');       // 0..10
    assert.equal(chunks[1], 'hijklmnopq');       // 7..17
    // adjacent chunks share `overlap` chars of context
    assert.equal(chunks[0].slice(-overlap), chunks[1].slice(0, overlap));
    // reassembling covers the whole string
    assert.ok(chunks.join('').includes('z'));
});

test('overlap >= chunkSize throws (guards infinite loop)', () => {
    assert.throws(() => chunkText('x'.repeat(100), 10, 10));
    assert.throws(() => chunkText('x'.repeat(100), 10, 20));
});

test('default overlap is smaller than default size', () => {
    assert.ok(DEFAULT_CHUNK_OVERLAP < DEFAULT_CHUNK_SIZE);
});
