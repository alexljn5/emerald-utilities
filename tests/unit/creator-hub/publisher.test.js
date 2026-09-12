// tests/unit/creator-hub/publisher.test.js
// Tests for Creator Hub publisher.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { publishPost } from '../../../src/creator-hub/publisher.js';
import { createPost } from '../../../src/creator-hub/models.js';

describe('publishPost', () => {
    it('returns a summary with results for each target', async () => {
        const post = createPost({
            id: 'post-test-1',
            message: 'Test post',
            targets: [
                { accountId: 'acc-1', platform: 'x', enabled: true },
                { accountId: 'acc-2', platform: 'bluesky', enabled: true }
            ],
            overrides: { 'acc-1': { message: 'Bluesky override' } }
        });

        const summary = await publishPost(post);
        assert.strictEqual(summary.postId, 'post-test-1');
        assert.strictEqual(summary.results.length, 2);
        assert.ok(summary.startedAt);
        assert.ok(summary.finishedAt);
    });

    it('handles missing accounts gracefully', async () => {
        const post = createPost({
            id: 'post-test-2',
            message: 'Test post',
            targets: [
                { accountId: 'non-existent-account', platform: 'x', enabled: true }
            ]
        });

        const summary = await publishPost(post);
        assert.strictEqual(summary.results.length, 1);
        assert.strictEqual(summary.results[0].success, false);
        assert.ok(summary.results[0].error.includes('not found'));
    });

    it('skips disabled targets', async () => {
        const post = createPost({
            id: 'post-test-3',
            message: 'Test post',
            targets: [
                { accountId: 'non-existent-1', platform: 'x', enabled: false },
                { accountId: 'non-existent-2', platform: 'x', enabled: true }
            ]
        });

        const summary = await publishPost(post);
        // Only the enabled target should produce a result
        assert.strictEqual(summary.results.length, 1);
        assert.strictEqual(summary.results[0].success, false);
    });

    it('continues publishing when one platform fails', async () => {
        const post = createPost({
            id: 'post-test-4',
            message: 'Test post',
            targets: [
                { accountId: 'non-existent-1', platform: 'x', enabled: true },
                { accountId: 'non-existent-2', platform: 'bluesky', enabled: true }
            ]
        });

        const summary = await publishPost(post);
        assert.strictEqual(summary.results.length, 2);
        // Both should fail but the function should not throw
        assert.strictEqual(summary.results[0].success, false);
        assert.strictEqual(summary.results[1].success, false);
    });
});
