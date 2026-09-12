const https = require('https');
const zlib = require('zlib');

function fetch(url, headers = {}) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers }, res => {

            let stream = res;

            if (res.headers['content-encoding'] === 'gzip') {
                stream = res.pipe(zlib.createGunzip());
            } else if (res.headers['content-encoding'] === 'deflate') {
                stream = res.pipe(zlib.createInflate());
            }

            let data = '';
            stream.on('data', chunk => data += chunk);
            stream.on('end', () => resolve(data));
            stream.on('error', reject);

        }).on('error', reject);
    });
}

function fetchJSON(url, headers = {}) {
    return fetch(url, headers).then(JSON.parse);
}

const DEFAULT_HEADERS = {
    'User-Agent': 'Mozilla/5.0',
    'Accept': '*/*',
    'Accept-Encoding': 'gzip, deflate',
    'Referer': 'https://duckduckgo.com/'
};

/**
 * DuckDuckGo provider
 */
async function duckduckgoImageSearch(query) {
    const encoded = encodeURIComponent(query);

    const html = await fetch(
        `https://duckduckgo.com/?q=${encoded}`,
        DEFAULT_HEADERS
    );

    const tokenMatch = html.match(/vqd=['"]?([0-9-]+)['"]?/);
    if (!tokenMatch) throw new Error('vqd token not found');

    const vqd = tokenMatch[1];

    const json = await fetchJSON(
        `https://duckduckgo.com/i.js?q=${encoded}&vqd=${vqd}&o=json&l=wt-wt&p=1`,
        DEFAULT_HEADERS
    );

    return (json.results || [])
        .map(r => r.image)
        .filter(Boolean);
}

/**
 * Public API
 */
async function getRandomImage({ query, provider = 'duckduckgo' }) {

    let results;

    switch (provider) {
        case 'duckduckgo':
            results = await duckduckgoImageSearch(query);
            break;

        default:
            throw new Error(`Unknown provider: ${provider}`);
    }

    if (!results.length) {
        throw new Error('No images found');
    }

    return results[Math.floor(Math.random() * results.length)];
}

module.exports = { getRandomImage };