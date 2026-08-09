// tests/unit/creator-hub/media-handler.test.js
// Tests for Creator Hub media handler and validation.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateMedia, validateMediaBatch } from '../../../src/creator-hub/utils/mediaHandler.js';
import { validatePublishRequest } from '../../../src/creator-hub/publisher.js';
import { getPlatform } from '../../../src/creator-hub/services/platforms.js';
import { createPlatformAccount } from '../../../src/creator-hub/models.js';
import { ACCOUNT_STATUS } from '../../../src/globals.js';
import { createPost } from '../../../src/creator-hub/models.js';

describe('Media Handler', () => {
    describe('validateMedia', () => {
        it('validates a valid image file', async () => {
            const result = await validateMedia(
                { path: '/tmp/test.jpg', type: 'image/jpeg', size: 1024 },
                'x'
            );
            assert.strictEqual(result.valid, true);
        });

        it('rejects missing file path', async () => {
            const result = await validateMedia(null, 'x');
            assert.strictEqual(result.valid, false);
            assert.ok(result.error.includes('missing'));
        });

        it('rejects invalid file type', async () => {
            const result = await validateMedia(
                { path: '/tmp/test.txt', type: 'text/plain', size: 1024 },
                'x'
            );
            assert.strictEqual(result.valid, false);
            assert.ok(result.error.includes('not allowed'));
        });

        it('rejects file exceeding size limit', async () => {
            const result = await validateMedia(
                { path: '/tmp/test.jpg', type: 'image/jpeg', size: 100 * 1024 * 1024 },
                'x'
            );
            assert.strictEqual(result.valid, false);
            assert.ok(result.error.includes('exceeds'));
        });
    });

    describe('validateMediaBatch', () => {
        it('validates empty batch', async () => {
            const result = await validateMediaBatch([], 'x');
            assert.strictEqual(result.valid, true);
        });

        it('rejects batch exceeding file limit', async () => {
            const files = Array.from({ length: 5 }, (_, i) => ({
                path: `/tmp/test-${i}.jpg`,
                type: 'image/jpeg',
                size: 1024
            }));
            const result = await validateMediaBatch(files, 'x');
            assert.strictEqual(result.valid, false);
            assert.ok(result.error.includes('Too many files'));
        });

        it('validates batch with valid files', async () => {
            const files = [
                { path: '/tmp/test-1.jpg', type: 'image/jpeg', size: 1024 },
                { path: '/tmp/test-2.jpg', type: 'image/jpeg', size: 2048 }
            ];
            const result = await validateMediaBatch(files, 'x');
            assert.strictEqual(result.valid, true);
        });
    });
});

describe('validatePublishRequest', () => {
    it('rejects disconnected account', () => {
        const account = createPlatformAccount({
            id: 'acc-1',
            platform: 'x',
            username: 'alex',
            encryptedCredentials: 'test',
            status: ACCOUNT_STATUS.DISCONNECTED
        });
        const post = createPost({ id: 'post-1', message: 'Hello', targets: [{ accountId: 'acc-1', platform: 'x', enabled: true }] });
        const result = validatePublishRequest(account, post, 'Hello');
        assert.strictEqual(result.valid, false);
        assert.ok(result.error.includes('disconnected'));
    });

    it('rejects empty text', () => {
        const account = createPlatformAccount({
            id: 'acc-1',
            platform: 'x',
            username: 'alex',
            encryptedCredentials: 'test',
            status: ACCOUNT_STATUS.CONNECTED
        });
        const post = createPost({ id: 'post-1', message: 'Hello', targets: [{ accountId: 'acc-1', platform: 'x', enabled: true }] });
        const result = validatePublishRequest(account, post, '');
        assert.strictEqual(result.valid, false);
        assert.ok(result.error.includes('empty'));
    });

    it('rejects text exceeding character limit', () => {
        const account = createPlatformAccount({
            id: 'acc-1',
            platform: 'x',
            username: 'alex',
            encryptedCredentials: 'test',
            status: ACCOUNT_STATUS.CONNECTED,
            capabilities: { text: true, images: false, video: false, maxChars: 10 }
        });
        const post = createPost({ id: 'post-1', message: 'Hello', targets: [{ accountId: 'acc-1', platform: 'x', enabled: true }] });
        const result = validatePublishRequest(account, post, 'This is a very long text that exceeds the limit');
        assert.strictEqual(result.valid, false);
        assert.ok(result.error.includes('exceeds'));
    });

    it('rejects images on platform that does not support them', () => {
        const account = createPlatformAccount({
            id: 'acc-1',
            platform: 'youtube',
            username: 'alex',
            encryptedCredentials: 'test',
            status: ACCOUNT_STATUS.CONNECTED,
            capabilities: { text: true, images: false, video: true, maxChars: 5000 }
        });
        const post = createPost({
            id: 'post-1',
            message: 'Hello',
            targets: [{ accountId: 'acc-1', platform: 'youtube', enabled: true }],
            media: [{ path: '/tmp/test.jpg', type: 'image/jpeg' }]
        });
        const result = validatePublishRequest(account, post, 'Hello');
        assert.strictEqual(result.valid, false);
        assert.ok(result.error.includes('does not support image'));
    });

    it('approves valid publish request', () => {
        const account = createPlatformAccount({
            id: 'acc-1',
            platform: 'x',
            username: 'alex',
            encryptedCredentials: 'test',
            status: ACCOUNT_STATUS.CONNECTED,
            capabilities: { text: true, images: true, video: true, maxChars: 280 }
        });
        const post = createPost({ id: 'post-1', message: 'Hello', targets: [{ accountId: 'acc-1', platform: 'x', enabled: true }] });
        const result = validatePublishRequest(account, post, 'Hello');
        assert.strictEqual(result.valid, true);
    });
});
