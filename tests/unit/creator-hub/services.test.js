// tests/unit/creator-hub/services.test.js
// Tests for Creator Hub platform services.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { TwitterService } from '../../../src/creator-hub/services/twitter.js';
import { InstagramService } from '../../../src/creator-hub/services/instagram.js';
import { BlueskyService } from '../../../src/creator-hub/services/bluesky.js';
import { getPlatformService, getPlatform, listPlatforms } from '../../../src/creator-hub/services/platforms.js';

describe('Platform Services', () => {
    describe('TwitterService', () => {
        it('requires credentials (OAuth 2.0 or 1.0a)', () => {
            const result = TwitterService.connect({});
            assert.strictEqual(result.success, false);
            assert.ok(result.error.includes('credentials'));

            // OAuth 2.0: just access token
            const result2 = TwitterService.connect({
                accessToken: 'token',
                username: 'testuser'
            });
            assert.strictEqual(result2.success, true);

            // OAuth 1.0a: apiKey + apiSecret + accessToken + accessTokenSecret
            const result3 = TwitterService.connect({
                apiKey: 'key',
                apiSecret: 'secret',
                accessToken: 'token',
                accessTokenSecret: 'secret',
                username: 'testuser'
            });
            assert.strictEqual(result3.success, true);
        });

        it('supports media upload', () => {
            assert.strictEqual(TwitterService.supportsMedia(), true);
        });

        it('publish returns error for missing credentials', async () => {
            const result = await TwitterService.publish(
                { platform: 'x', credentials: {} },
                { text: 'test' },
                'test text'
            );
            assert.strictEqual(result.success, false);
            assert.ok(result.error.length > 0);
        });

        it('testConnection validates credentials format', async () => {
            const result = await TwitterService.testConnection({
                platform: 'x',
                credentials: {}
            });
            assert.strictEqual(result.valid, false);
            assert.ok(result.error.includes('credentials'));

            // OAuth 2.0 credentials - not yet implemented for testConnection
            const result2 = await TwitterService.testConnection({
                platform: 'x',
                credentials: { accessToken: 'token' }
            });
            assert.strictEqual(result2.valid, false);
            assert.ok(result2.error.includes('not yet implemented'));
        });

        it('disconnect returns success', async () => {
            const result = await TwitterService.disconnect({
                platform: 'x',
                credentials: {}
            });
            assert.strictEqual(result.success, true);
        });
    });

    describe('InstagramService', () => {
        it('requires access token and account ID', () => {
            const result = InstagramService.connect({});
            assert.strictEqual(result.success, false);
            assert.ok(result.error.includes('access token'));

            const result2 = InstagramService.connect({ accessToken: 'token', instagramAccountId: '123' });
            assert.strictEqual(result2.success, true);
        });
    });

    describe('BlueskyService', () => {
        it('requires handle, app password, and service URL', async () => {
            const result = await BlueskyService.connect({});
            assert.strictEqual(result.success, false);
            assert.ok(result.error.includes('Identifier and password'));

            // Note: We don't test successful connect with real credentials
            // as that would require network access to bsky.social
        });
    });

    describe('Platform Registry', () => {
        describe('getPlatformService', () => {
            it('returns the correct service for each platform', () => {
                assert.strictEqual(getPlatformService('x'), TwitterService);
                assert.strictEqual(getPlatformService('twitter'), TwitterService);
                assert.strictEqual(getPlatformService('instagram'), InstagramService);
                assert.strictEqual(getPlatformService('bluesky'), BlueskyService);
            });

            it('throws on unknown platform', () => {
                assert.throws(() => getPlatformService('unknown'), /No platform registered/);
            });
        });

        describe('getPlatform', () => {
            it('returns platform metadata', () => {
                const platform = getPlatform('x');
                assert.ok(platform);
                assert.strictEqual(platform.id, 'x');
                assert.strictEqual(platform.name, 'X');
                assert.ok(platform.capabilities);
                assert.ok(platform.requirements);
                assert.ok(platform.limits);
                assert.ok(platform.mediaRules);
            });

            it('returns null for unknown platform', () => {
                assert.strictEqual(getPlatform('unknown'), null);
            });

            it('has correct capabilities for each platform', () => {
                const x = getPlatform('x');
                assert.strictEqual(x.capabilities.text, true);
                assert.strictEqual(x.capabilities.images, true);
                assert.strictEqual(x.capabilities.video, true);

                const youtube = getPlatform('youtube');
                assert.strictEqual(youtube.capabilities.images, false);
                assert.strictEqual(youtube.capabilities.video, true);
            });

            it('has correct limits for each platform', () => {
                const x = getPlatform('x');
                assert.ok(x.limits.maxCharacters);
                assert.ok(x.limits.maxImages);
                assert.ok(x.limits.maxImageSizeMB);
                assert.ok(x.limits.maxVideoSizeMB);
                assert.ok(x.limits.maxVideoDurationSec);

                const youtube = getPlatform('youtube');
                assert.ok(youtube.limits.maxCharacters);
                assert.strictEqual(youtube.limits.maxImages, 0);
            });
        });

        describe('listPlatforms', () => {
            it('returns all supported platforms', () => {
                const platforms = listPlatforms();
                const ids = platforms.map(p => p.id);
                assert.ok(ids.includes('x'));
                assert.ok(ids.includes('twitter'));
                assert.ok(ids.includes('bluesky'));
                assert.ok(ids.includes('mastodon'));
                assert.ok(ids.includes('threads'));
                assert.ok(ids.includes('instagram'));
                assert.ok(ids.includes('facebook'));
                assert.ok(ids.includes('youtube'));
                assert.ok(ids.includes('tiktok'));
                assert.ok(ids.includes('itch'));
                assert.strictEqual(platforms.length, 10);
            });

            it('returns platform objects with required fields', () => {
                const platforms = listPlatforms();
                for (const platform of platforms) {
                    assert.ok(platform.id, `Platform missing id: ${JSON.stringify(platform)}`);
                    assert.ok(platform.name, `Platform ${platform.id} missing name`);
                    assert.ok(platform.capabilities, `Platform ${platform.id} missing capabilities`);
                    assert.ok(platform.requirements, `Platform ${platform.id} missing requirements`);
                    assert.ok(platform.limits, `Platform ${platform.id} missing limits`);
                    assert.ok(platform.mediaRules, `Platform ${platform.id} missing mediaRules`);
                    // service is optional (e.g., mastodon may not have an adapter yet)
                    if (platform.service) {
                        assert.ok(typeof platform.service === 'object', `Platform ${platform.id} service is not an object`);
                        assert.ok(typeof platform.service.connect === 'function', `Platform ${platform.id} service missing connect method`);
                    }
                }
            });
        });
    });
});
