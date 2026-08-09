import fs from 'fs';
import path from 'path';

const LOG_DIR = 'src/logs/logs-network';

function getDateFile() {
    const date = new Date().toISOString().split('T')[0];
    return `capture-${date}.jsonl`;
}

function getPaths() {
    const file = getDateFile();

    return {
        all: path.join(LOG_DIR, 'ALL', file),
        filtered: path.join(LOG_DIR, 'FILTERED', file)
    };
}

function isUseful(packet) {
    // placeholder filter logic — you MUST define this
    return (
        packet.raw?.includes('IP') ||
        packet.raw?.includes('TCP') ||
        packet.raw?.includes('UDP')
    );
}

export function writePacket(packet) {
    const files = getPaths();

    fs.mkdirSync(path.dirname(files.all), { recursive: true });
    fs.mkdirSync(path.dirname(files.filtered), { recursive: true });

    // ALWAYS write ALL traffic
    fs.appendFileSync(files.all, JSON.stringify(packet) + '\n');

    // selectively write FILTERED traffic
    if (isUseful(packet)) {
        fs.appendFileSync(files.filtered, JSON.stringify({
            ...packet,
            tag: 'filtered'
        }) + '\n');
    }
}