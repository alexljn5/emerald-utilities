// tests/unit/creator-hub/models.test.js
// Tests for Creator Hub data models.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createPlatformAccount, validatePlatformAccount, createPost, validatePost, normalizeTargets } from '../../../src/creator-hub/models.js';
import { ACCOUNT_STATUS } from '../../../src/globals.js';

describe('PlatformAccount', () => {
    it('creates a valid account', () => {
        const account = createPlatformAccount({
            id: 'acc-1',
            platform: 'x',
            username: 'alex',
            displayName: 'Alex Example',
            encryptedCredentials: 'encrypted:test'
        });
        assert.strictEqual(account.id, 'acc-1');
        assert.strictEqual(account.platform, 'x');
        assert.strictEqual(account.username, 'alex');
        assert.strictEqual(account.displayName, 'Alex Example');
        assert.strictEqual(account.status, ACCOUNT_STATUS.DISCONNECTED);
    });

    it('creates account with capabilities', () => {
        const account = createPlatformAccount({
            id: 'acc-1',
            platform: 'x',
            username: 'alex',
            encryptedCredentials: 'test',
            capabilities: { text: true, images: true, video: true, maxChars: 280 }
        });
        assert.strictEqual(account.capabilities.text, true);
        assert.strictEqual(account.capabilities.images, true);
        assert.strictEqual(account.capabilities.video, true);
        assert.strictEqual(account.capabilities.maxChars, 280);
    });

    it('defaults capabilities when not provided', () => {
        const account = createPlatformAccount({
            id: 'acc-1',
            platform: 'x',
            username: 'alex',
            encryptedCredentials: 'test'
        });
        assert.strictEqual(account.capabilities.text, true);
        assert.strictEqual(account.capabilities.images, false);
        assert.strictEqual(account.capabilities.video, false);
        assert.strictEqual(account.capabilities.maxChars, 0);
    });

    it('creates account with metadata', () => {
        const account = createPlatformAccount({
            id: 'acc-1',
            platform: 'x',
            username: 'alex',
            encryptedCredentials: 'test',
            metadata: {
                lastSuccessfulPublish: '2024-01-01T00:00:00Z',
                lastFailedPublish: '2024-01-02T00:00:00Z',
                totalPublished: 5,
                totalFailed: 1
            }
        });
        assert.strictEqual(account.metadata.lastSuccessfulPublish, '2024-01-01T00:00:00Z');
        assert.strictEqual(account.metadata.lastFailedPublish, '2024-01-02T00:00:00Z');
        assert.strictEqual(account.metadata.totalPublished, 5);
        assert.strictEqual(account.metadata.totalFailed, 1);
    });

    it('defaults metadata when not provided', () => {
        const account = createPlatformAccount({
            id: 'acc-1',
            platform: 'x',
            username: 'alex',
            encryptedCredentials: 'test'
        });
        assert.strictEqual(account.metadata.lastSuccessfulPublish, null);
        assert.strictEqual(account.metadata.lastFailedPublish, null);
        assert.strictEqual(account.metadata.totalPublished, 0);
        assert.strictEqual(account.metadata.totalFailed, 0);
    });

    it('throws on missing id', () => {
        assert.throws(() => {
            createPlatformAccount({ platform: 'x', username: 'alex', encryptedCredentials: 'test' });
        }, /Account id is required/);
    });

    it('throws on unsupported platform', () => {
        assert.throws(() => {
            createPlatformAccount({ id: 'acc-1', platform: 'unknown', username: 'alex', encryptedCredentials: 'test' });
        }, /Unsupported platform/);
    });

    it('throws on missing username', () => {
        assert.throws(() => {
            createPlatformAccount({ id: 'acc-1', platform: 'x', encryptedCredentials: 'test' });
        }, /username is required/);
    });

    it('throws on missing encryptedCredentials', () => {
        assert.throws(() => {
            createPlatformAccount({ id: 'acc-1', platform: 'x', username: 'alex' });
        }, /encryptedCredentials is required/);
    });

    it('defaults status to disconnected', () => {
        const account = createPlatformAccount({
            id: 'acc-1',
            platform: 'x',
            username: 'alex',
            encryptedCredentials: 'test'
        });
        assert.strictEqual(account.status, ACCOUNT_STATUS.DISCONNECTED);
    });
});

describe('Post', () => {
    it('creates a valid post with new target structure', () => {
        const post = createPost({
            id: 'post-1',
            message: 'Hello world',
            tags: ['test'],
            targets: [
                { accountId: 'acc-1', platform: 'x', enabled: true, override: { message: 'Hello X!' } },
                { accountId: 'acc-2', platform: 'bluesky', enabled: true }
            ],
            overrides: { 'acc-1': { message: 'Hello X!' } }
        });
        assert.strictEqual(post.id, 'post-1');
        assert.strictEqual(post.message, 'Hello world');
        assert.strictEqual(post.tags.length, 1);
        assert.strictEqual(post.targets.length, 2);
        assert.strictEqual(post.targets[0].accountId, 'acc-1');
        assert.strictEqual(post.targets[0].platform, 'x');
        assert.strictEqual(post.targets[0].enabled, true);
        assert.strictEqual(post.targets[0].override?.message, 'Hello X!');
    });

    it('normalizes legacy targets (array of IDs)', () => {
        const normalized = normalizeTargets(['acc-1', 'acc-2']);
        assert.strictEqual(normalized.length, 2);
        assert.strictEqual(normalized[0].accountId, 'acc-1');
        assert.strictEqual(normalized[0].platform, '');
        assert.strictEqual(normalized[0].enabled, true);
    });

    it('passes through new-format targets', () => {
        const targets = [
            { accountId: 'acc-1', platform: 'x', enabled: true, override: { message: 'test' } }
        ];
        const normalized = normalizeTargets(targets);
        assert.strictEqual(normalized.length, 1);
        assert.strictEqual(normalized[0].accountId, 'acc-1');
        assert.strictEqual(normalized[0].platform, 'x');
        assert.strictEqual(normalized[0].override?.message, 'test');
    });

    it('defaults createdAt to current ISO string', () => {
        const post = createPost({
            id: 'post-1',
            message: 'Hello'
        });
        assert.ok(post.createdAt);
        assert.ok(new Date(post.createdAt).toISOString());
    });

    it('throws on missing id', () => {
        assert.throws(() => {
            createPost({ message: 'Hello' });
        }, /Post id is required/);
    });

    it('throws on missing message', () => {
        assert.throws(() => {
            createPost({ id: 'post-1', message: undefined });
        }, /Post message is required/);
    });

    it('throws on non-array media', () => {
        assert.throws(() => {
            createPost({ id: 'post-1', message: 'Hello', media: 'not-array' });
        }, /Post media must be an array/);
    });

    it('throws on exceeding max media files', () => {
        const tooMany = Array.from({ length: 11 }, (_, i) => `file-${i}.jpg`);
        assert.throws(() => {
            createPost({ id: 'post-1', message: 'Hello', media: tooMany });
        }, /exceeds maximum/);
    });

    it('throws on non-array tags', () => {
        assert.throws(() => {
            createPost({ id: 'post-1', message: 'Hello', tags: 'not-array' });
        }, /Post tags must be an array/);
    });

    it('throws on non-array targets', () => {
        assert.throws(() => {
            createPost({ id: 'post-1', message: 'Hello', targets: 'not-array' });
        }, /Post targets must be an array/);
    });

    it('throws on target missing accountId', () => {
        assert.throws(() => {
            createPost({ id: 'post-1', message: 'Hello', targets: [{ platform: 'x', enabled: true }] });
        }, /Each target must have an accountId/);
    });

    it('throws on target missing platform', () => {
        assert.throws(() => {
            createPost({ id: 'post-1', message: 'Hello', targets: [{ accountId: 'acc-1', enabled: true }] });
        }, /Each target must have a platform/);
    });

    it('throws on target missing enabled', () => {
        assert.throws(() => {
            createPost({ id: 'post-1', message: 'Hello', targets: [{ accountId: 'acc-1', platform: 'x' }] });
        }, /Each target must have an enabled/);
    });

    it('throws on non-object overrides', () => {
        assert.throws(() => {
            createPost({ id: 'post-1', message: 'Hello', overrides: 'not-object' });
        }, /Post overrides must be an object/);
    });
});
