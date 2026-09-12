/**
 * XScraper forwarder diagnostic — READ ONLY.
 *
 * XSCRAPER ONLY. Prints the durable pipeline state without opening the UI:
 *
 *   SQLite local/pending/forwarded/failed
 *   PostgreSQL message count + connection status
 *   forwarder worker status (started/running/backoff/retry)
 *   queue size / active batch
 *   Xscraper server status + port 3000 status
 *
 * Usage:
 *   node scripts/xscraper-forwarder-status.js
 */

import { getStatus, _setSqlitePath, startWorker, stopWorker } from '../src/database/xscraper-forwarder.js';
import { pool, connectionInfo } from '../src/database/db-pool.js';
import { defaultSqlitePath } from '../src/database/xscraper-local-source.js';
import net from 'net';

const line = (s = '') => console.log(s);
const pad = (label) => String(label).padEnd(32);
const kv = (k, v) => line(`  ${pad(k)}${v}`);

function checkPort(port, host = 'localhost') {
    return new Promise((resolve) => {
        const sock = net.connect({ port, host, timeout: 2000 });
        sock.once('connect', () => { sock.destroy(); resolve(true); });
        sock.once('error', () => resolve(false));
        sock.once('timeout', () => { sock.destroy(); resolve(false); });
    });
}

async function pgMessageCount() {
    try {
        const res = await pool.query('SELECT COUNT(*)::int AS n FROM grok_messages');
        return res.rows[0].n;
    } catch (err) {
        return { error: err.message };
    }
}

async function main() {
    line('================================================');
    line('XScraper Forwarder / Pipeline Diagnostic');
    line('================================================');
    line('');
    kv('SQLite store', defaultSqlitePath());
    kv('PostgreSQL', `${connectionInfo.user}@${connectionInfo.host}:${connectionInfo.port}/${connectionInfo.database}`);

    // ---- Forwarder status (includes SQLite + PG connectivity + worker) ----
    const status = await getStatus();

    line('');
    line('--- SQLite (durable queue) ---');
    kv('store available', status.sqlite.available);
    kv('SQLite path', status.sqlite.path);
    kv('local messages', status.sqlite.local);
    kv('pending (unforwarded)', status.sqlite.pending);
    kv('forwarded', status.sqlite.forwarded);
    kv('failed (retryable)', status.sqlite.failed);

    line('');
    line('--- Combined local source (SQLite + legacy JSON) ---');
    kv('SQLite messages', status.local?.sqlite ?? status.sqlite.local);
    kv('JSON messages', status.local?.json ?? 0);
    kv('conversations', status.local?.conversations ?? 0);
    kv('combined total', status.local?.total ?? status.sqlite.local);

    line('');
    line('--- PostgreSQL ---');
    if (status.pg.connected) {
        const count = await pgMessageCount();
        kv('connected', 'yes');
        kv('grok_messages rows', typeof count === 'number' ? count : count.error);
    } else {
        kv('connected', 'NO');
        kv('kind', status.pg.kind || 'n/a');
        kv('reason', status.pg.reason || 'unreachable');
        line('  NOTE: messages remain durable-pending in SQLite and will be');
        line('        forwarded automatically once PostgreSQL is reachable.');
    }

    line('');
    line('--- Forwarder worker ---');
    kv('started', status.worker.started);
    kv('running', status.worker.running);
    kv('active batch', status.worker.activeBatchId || '(none)');
    kv('retry count', status.worker.retryCount);
    kv('backoff', status.worker.backoffMs ? `${status.worker.backoffMs}ms` : '(none)');
    kv('last run', status.worker.lastRunAt || '(never)');
    kv('last result', status.worker.lastResult ? JSON.stringify(status.worker.lastResult) : '(none)');

    line('');
    line('--- Queue / batch config ---');
    kv('queue size (pending)', status.queue.size);
    kv('batch size', status.queue.batchSize);
    kv('concurrency', status.queue.concurrency);

    line('');
    line('--- XScraper server (port 3000) ---');
    const portOpen = await checkPort(3000);
    kv('port 3000 listening', portOpen ? 'YES' : 'NO');

    line('');
    line('================================================');
    line('Summary:');
    if (!status.sqlite.available) {
        line('  - SQLite store does not exist yet. Start the app / server first.');
    }
    if (status.sqlite.pending > 0 && status.pg.connected) {
        line(`  - ${status.sqlite.pending} message(s) pending and PostgreSQL reachable.`);
        line('    A worker batch (or manual Send-to-Postgres) will forward them.');
    } else if (status.sqlite.pending > 0 && !status.pg.connected) {
        line(`  - ${status.sqlite.pending} message(s) pending; PostgreSQL unreachable. They stay safe.`);
    } else if (status.sqlite.pending === 0) {
        line('  - Queue converged (0 pending). Nothing to forward.');
    }
    line('================================================');
}

main()
    .then(() => pool.end())
    .catch(async (err) => {
        console.error('[xscraper-forwarder-status] FAILED:', err.message);
        try { await pool.end(); } catch { /* ignore */ }
        process.exit(1);
    });
