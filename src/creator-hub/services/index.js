// src/creator-hub/services/index.js
// Platform service registry.

import { TwitterService } from './twitter.js';
import InstagramService from './instagram.js';
import { TikTokService } from './tiktok.js';
import { ItchService } from './itch.js';
import { FacebookService } from './facebook.js';
import { BlueskyService } from './bluesky.js';
import { ThreadsService } from './threads.js';
import { YouTubeService } from './youtube.js';

const services = {
    x: TwitterService,
    twitter: TwitterService,
    instagram: InstagramService,
    tiktok: TikTokService,
    itch: ItchService,
    facebook: FacebookService,
    bluesky: BlueskyService,
    threads: ThreadsService,
    youtube: YouTubeService
};

export function getService(platform) {
    const service = services[platform];
    if (!service) {
        throw new Error(`No service registered for platform: ${platform}`);
    }
    return service;
}

export function listSupportedPlatforms() {
    return Object.keys(services);
}
