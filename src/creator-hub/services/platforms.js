// src/creator-hub/services/platforms.js
// Platform registry with metadata for all supported platforms.
// This is the single source of truth for platform capabilities, requirements, and limits.

import { TwitterService } from './twitter.js';
import InstagramService from './instagram.js';
import { TikTokService } from './tiktok.js';
import { ItchService } from './itch.js';
import { FacebookService } from './facebook.js';
import { BlueskyService } from './bluesky.js';
import { ThreadsService } from './threads.js';
import { YouTubeService } from './youtube.js';

/**
 * @typedef {Object} PlatformMetadata
 * @property {string} id
 * @property {string} name
 * @property {string} authentication
 * @property {boolean} usernameRequired
 * @property {boolean} mediaRequired
 * @property {Object} capabilities
 * @property {Object} limits
 * @property {Object} mediaRules
 */

export const platforms = {
    x: {
        id: 'x',
        name: 'X',
        service: TwitterService,
        requirements: {
            authentication: 'oauth',
            usernameRequired: true,
            mediaRequired: false
        },
        capabilities: {
            text: true,
            images: true,
            video: true,
            gifs: false,
            polls: false,
            threads: false,
            links: true
        },
        limits: {
            maxCharacters: 280,
            maxImages: 4,
            maxImageSizeMB: 5,
            maxVideoSizeMB: 512,
            maxVideoDurationSec: 140
        },
        mediaRules: {
            acceptedTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4'],
            maxFiles: 4
        }
    },
    twitter: {
        id: 'twitter',
        name: 'Twitter',
        service: TwitterService,
        requirements: {
            authentication: 'oauth',
            usernameRequired: true,
            mediaRequired: false
        },
        capabilities: {
            text: true,
            images: true,
            video: true,
            gifs: false,
            polls: false,
            threads: false,
            links: true
        },
        limits: {
            maxCharacters: 280,
            maxImages: 4,
            maxImageSizeMB: 5,
            maxVideoSizeMB: 512,
            maxVideoDurationSec: 140
        },
        mediaRules: {
            acceptedTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4'],
            maxFiles: 4
        }
    },
    bluesky: {
        id: 'bluesky',
        name: 'Bluesky',
        service: BlueskyService,
        requirements: {
            authentication: 'app_password',
            usernameRequired: true,
            mediaRequired: false
        },
        capabilities: {
            text: true,
            images: true,
            video: false,
            gifs: false,
            polls: false,
            threads: false,
            links: true
        },
        limits: {
            maxCharacters: 300,
            maxImages: 4,
            maxImageSizeMB: 5,
            maxVideoSizeMB: 0,
            maxVideoDurationSec: 0
        },
        mediaRules: {
            acceptedTypes: ['image/png', 'image/jpeg', 'image/webp'],
            maxFiles: 4
        }
    },
    mastodon: {
        id: 'mastodon',
        name: 'Mastodon',
        service: null,
        requirements: {
            authentication: 'access_token',
            usernameRequired: true,
            mediaRequired: false
        },
        capabilities: {
            text: true,
            images: true,
            video: true,
            gifs: true,
            polls: true,
            threads: false,
            links: true
        },
        limits: {
            maxCharacters: 500,
            maxImages: 4,
            maxImageSizeMB: 8,
            maxVideoSizeMB: 40,
            maxVideoDurationSec: 120
        },
        mediaRules: {
            acceptedTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4'],
            maxFiles: 4
        }
    },
    threads: {
        id: 'threads',
        name: 'Threads',
        service: ThreadsService,
        requirements: {
            authentication: 'access_token',
            usernameRequired: true,
            mediaRequired: false
        },
        capabilities: {
            text: true,
            images: true,
            video: true,
            gifs: false,
            polls: false,
            threads: true,
            links: true
        },
        limits: {
            maxCharacters: 500,
            maxImages: 10,
            maxImageSizeMB: 8,
            maxVideoSizeMB: 100,
            maxVideoDurationSec: 60
        },
        mediaRules: {
            acceptedTypes: ['image/png', 'image/jpeg', 'image/webp', 'video/mp4'],
            maxFiles: 10
        }
    },
    instagram: {
        id: 'instagram',
        name: 'Instagram',
        service: InstagramService,
        requirements: {
            authentication: 'oauth',
            usernameRequired: true,
            mediaRequired: true
        },
        capabilities: {
            text: true,
            images: true,
            video: true,
            gifs: false,
            polls: false,
            threads: false,
            links: true
        },
        limits: {
            maxCharacters: 2200,
            maxImages: 10,
            maxImageSizeMB: 8,
            maxVideoSizeMB: 100,
            maxVideoDurationSec: 60
        },
        mediaRules: {
            acceptedTypes: ['image/png', 'image/jpeg', 'image/webp', 'video/mp4'],
            maxFiles: 10,
            minFiles: 1
        }
    },
    facebook: {
        id: 'facebook',
        name: 'Facebook',
        service: FacebookService,
        requirements: {
            authentication: 'access_token',
            usernameRequired: true,
            mediaRequired: false
        },
        capabilities: {
            text: true,
            images: true,
            video: true,
            gifs: false,
            polls: false,
            threads: false,
            links: true
        },
        limits: {
            maxCharacters: 63206,
            maxImages: 1,
            maxImageSizeMB: 8,
            maxVideoSizeMB: 100,
            maxVideoDurationSec: 240
        },
        mediaRules: {
            acceptedTypes: ['image/png', 'image/jpeg', 'image/webp', 'video/mp4'],
            maxFiles: 1
        }
    },
    youtube: {
        id: 'youtube',
        name: 'YouTube',
        service: YouTubeService,
        requirements: {
            authentication: 'access_token',
            usernameRequired: true,
            mediaRequired: false
        },
        capabilities: {
            text: true,
            images: false,
            video: true,
            gifs: false,
            polls: false,
            threads: false,
            links: true
        },
        limits: {
            maxCharacters: 5000,
            maxImages: 0,
            maxImageSizeMB: 0,
            maxVideoSizeMB: 256,
            maxVideoDurationSec: 60
        },
        mediaRules: {
            acceptedTypes: ['video/mp4'],
            maxFiles: 1
        }
    },
    tiktok: {
        id: 'tiktok',
        name: 'TikTok',
        service: TikTokService,
        requirements: {
            authentication: 'access_token',
            usernameRequired: true,
            mediaRequired: true
        },
        capabilities: {
            text: true,
            images: false,
            video: true,
            gifs: false,
            polls: false,
            threads: false,
            links: false
        },
        limits: {
            maxCharacters: 2200,
            maxImages: 0,
            maxImageSizeMB: 0,
            maxVideoSizeMB: 100,
            maxVideoDurationSec: 60
        },
        mediaRules: {
            acceptedTypes: ['video/mp4'],
            maxFiles: 1,
            minFiles: 1
        }
    },
    itch: {
        id: 'itch',
        name: 'itch.io',
        service: ItchService,
        requirements: {
            authentication: 'api_key',
            usernameRequired: true,
            mediaRequired: false
        },
        capabilities: {
            text: true,
            images: true,
            video: false,
            gifs: false,
            polls: false,
            threads: false,
            links: true
        },
        limits: {
            maxCharacters: 10000,
            maxImages: 5,
            maxImageSizeMB: 5,
            maxVideoSizeMB: 0,
            maxVideoDurationSec: 0
        },
        mediaRules: {
            acceptedTypes: ['image/png', 'image/jpeg', 'image/webp'],
            maxFiles: 5
        }
    }
};

export function getPlatform(platformId) {
    return platforms[platformId] || null;
}

export function listPlatforms() {
    return Object.values(platforms);
}

export function getPlatformService(platformId) {
    const platform = platforms[platformId];
    if (!platform) {
        throw new Error(`No platform registered for: ${platformId}`);
    }
    if (!platform.service) {
        throw new Error(`No service adapter for platform: ${platformId}`);
    }
    return platform.service;
}

export function listSupportedPlatformIds() {
    return Object.keys(platforms);
}
