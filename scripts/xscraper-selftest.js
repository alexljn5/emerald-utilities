/**
 * XScraper synchronisation self-test.
 *
 * XSCRAPER ONLY. Exercises the REAL pipeline end to end:
 *
 *   local XScraper store (SQLite, written through the local server API)
 *     → reconciler (src/database/xscraper-sync.js)
 *       → PostgreSQL grok_messages
 *         → AI/RAG retrieval
 *
 * It proves the two properties the pipeline was missing:
 *
 *   TEST 1  historical reconciliation converges
 *           run twice over the same local dataset → inserted=0 the 2nd time,
 *           and 0 the 1st time too when PostgreSQL already has the data.
 *
 *   TEST 2  a genuinely new message is forwarded exactly once
 *           run 1 → inserted=1, run 2 → inserted=0 / skipped=1,
 *           with NO retransmission of the historical messages.
 *
 *   TEST 3  the new message is retrievable for AI/RAG context.
 *
 * Usage:
 *   node scripts/xscraper-selftest.js
 *   node scripts/xscraper-selftest.js --seed-from <conversationId>
 *   node scripts/xscraper-selftest.js --skip-seed
 */

import { pool, connectionInfo } from '../src/database/db-pool.js';
import { readSqliteSource } from '../src/database/xscraper-local-source.js';
import { reconcileScrapedMessages } from '../src/database/xscraper-sync.js';
import { getRecentMessages } from '../src/database/ai-persistence.js';

const SERVER = process.env.XSCRAPER_SERVER_URL || 'http://localhost:3000';

function args() {
    const a = { seedFrom: null, skipSeed: false, seedLimit: 600 };
    const argv = process.argv;
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--seed-from') a.seedFrom = argv[++i];
        else if (argv[i] === '--skip-seed') a.skipSeed = true;
        else if (argv[i] === '--seed-limit') a.seedLimit = parseInt(argv[++i], 10);
    }
    return a;
}

const line = (s = '') => console.log(s);
const head = (s) => { line(''); line('='.repeat(74)); line(s); line('='.repeat(74)); };
const kv = (k, v) => line(`  ${String(k).padEnd(26)}${v}`);

let failures = 0;
function expect(label, actual, expected) {
    const ok = actual === expected;
    if (!ok) failures++;
    line(`  [${ok ? 'PASS' : 'FAIL'}] ${String(label).padEnd(44)} expected=${expected} actual=${actual}`);
    return ok;
}

async function serverHealthy() {
    try {
        const r = await fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(2500) });
        return r.ok;
    } catch {
        return false;
    }
}

async function saveToLocalStore(messages, conversationId, conversationTitle) {
    const res = await fetch(`${SERVER}/api/messages/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, conversationId, conversationTitle }),
    });
    if (!res.ok) throw new Error(`local server responded ${res.status}`);
    return res.json();
}

async function pickSeedConversation(explicit) {
    if (explicit) return explicit;
    const res = await pool.query(
        `SELECT conversation_id, COUNT(*)::int AS n
         FROM grok_messages
         WHERE conversation_id <> 'default'
         GROUP BY conversation_id
         HAVING COUNT(*) BETWEEN 20 AND 2000
         ORDER BY n DESC LIMIT 1`
    );
    return res.rows[0]?.conversation_id || null;
}

async function reconcileLocalConversation(conversationId, title) {
    const local = await readSqliteSource({ conversationId });
    const messages = local.byConversation.get(conversationId) || [];
    return {
        localCount: messages.length,
        stats: await reconcileScrapedMessages(messages, conversationId, title),
    };
}

async function main() {
    const a = args();
    head('XScraper synchronisation self-test');
    kv('PostgreSQL', `${connectionInfo.user}@${connectionInfo.host}:${connectionInfo.port}/${connectionInfo.database}`);
    kv('Local XScraper server', SERVER);

    const healthy = await serverHealthy();
    kv('Local server healthy', healthy);
    if (!healthy) {
        line('  Local XScraper server is not running. Start it with:');
        line('    node src/scrapers/xscraper/src/server/server.js');
        failures++;
        return;
    }

    // ------------------------------------------------------------------
    // TEST 1 — historical local data reconciles and converges
    // ------------------------------------------------------------------
    const seedConv = await pickSeedConversation(a.seedFrom);
    head(`TEST 1 — historical reconciliation (conversation ${seedConv})`);

    if (!seedConv) {
        line('  No suitable conversation found in PostgreSQL to use as historical data.');
        failures++;
    } else {
        if (!a.skipSeed) {
            // Put the historical messages back into the LOCAL store exactly the
            // way the extension does (POST /api/messages/save). Their source ids
            // are preserved, so they are the same logical messages.
            const rows = await pool.query(
                `SELECT source_message_id, id, content, author, timestamp
                 FROM grok_messages WHERE conversation_id = $1
                 ORDER BY timestamp ASC LIMIT $2`,
                [seedConv, a.seedLimit]
            );
            const payload = rows.rows.map(r => ({
                id: r.source_message_id || r.id,
                content: r.content,
                author: r.author,
                timestamp: (r.timestamp?.toISOString?.() || r.timestamp),
            }));
            const saved = await saveToLocalStore(payload, seedConv, 'XScraper historical reconciliation');
            kv('seeded into local store', `${payload.length} messages (new=${saved.newMessages} dup=${saved.duplicates})`);
        }

        const run1 = await reconcileLocalConversation(seedConv, 'XScraper historical reconciliation');
        kv('run 1 local_total', run1.stats.localTotal);
        kv('run 1 already_in_postgres', run1.stats.alreadyInPostgres);
        kv('run 1 pending_to_insert', run1.stats.pendingToInsert);
        kv('run 1 inserted', run1.stats.inserted);
        kv('run 1 skipped', run1.stats.skipped);
        kv('run 1 postgres_total_after', run1.stats.postgresTotalAfter);

        const run2 = await reconcileLocalConversation(seedConv, 'XScraper historical reconciliation');
        kv('run 2 local_total', run2.stats.localTotal);
        kv('run 2 already_in_postgres', run2.stats.alreadyInPostgres);
        kv('run 2 pending_to_insert', run2.stats.pendingToInsert);
        kv('run 2 inserted', run2.stats.inserted);
        kv('run 2 skipped', run2.stats.skipped);

        line('');
        expect('run 1 pending_to_insert == 0 (already in PG)', run1.stats.pendingToInsert, 0);
        expect('run 1 inserted == 0', run1.stats.inserted, 0);
        expect('run 1 already == local_total', run1.stats.alreadyInPostgres, run1.stats.localTotal);
        expect('run 2 inserted == 0 (converged)', run2.stats.inserted, 0);
        expect('run 2 pending_to_insert == 0', run2.stats.pendingToInsert, 0);
        expect('PG count unchanged by reruns', run2.stats.postgresTotalAfter, run1.stats.postgresTotalAfter);
    }

    // ------------------------------------------------------------------
    // TEST 2 — one genuinely new message
    // ------------------------------------------------------------------
    const liveConv = seedConv || 'xscraper_selftest_conv';
    const unique = `XSCRAPER SELFTEST ${new Date().toISOString()} ${Math.random().toString(36).slice(2, 10)}`;
    // Same deterministic id scheme the scraper uses: hash of the message text.
    const scraperHash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return 'm_' + h; };
    const newMessage = {
        id: scraperHash(unique),
        content: unique,
        author: 'You',
        timestamp: new Date().toISOString(),
    };

    head(`TEST 2 — real-time path for ONE new message (conversation ${liveConv})`);
    kv('new source id', newMessage.id);

    const beforeCount = (await pool.query(
        'SELECT COUNT(*)::int AS n FROM grok_messages WHERE conversation_id = $1', [liveConv])).rows[0].n;
    kv('PG count before', beforeCount);

    await saveToLocalStore([newMessage], liveConv, 'XScraper live path');

    const live1 = await reconcileLocalConversation(liveConv, 'XScraper live path');
    kv('run 1 local_total', live1.stats.localTotal);
    kv('run 1 already_in_postgres', live1.stats.alreadyInPostgres);
    kv('run 1 pending_to_insert', live1.stats.pendingToInsert);
    kv('run 1 inserted', live1.stats.inserted);
    kv('run 1 skipped', live1.stats.skipped);
    kv('run 1 checkpoint savedAt', live1.stats.checkpoint?.last_source_savedat);

    const live2 = await reconcileLocalConversation(liveConv, 'XScraper live path');
    kv('run 2 inserted', live2.stats.inserted);
    kv('run 2 already_in_postgres', live2.stats.alreadyInPostgres);
    kv('run 2 pending_to_insert', live2.stats.pendingToInsert);

    const afterCount = (await pool.query(
        'SELECT COUNT(*)::int AS n FROM grok_messages WHERE conversation_id = $1', [liveConv])).rows[0].n;
    kv('PG count after', afterCount);

    line('');
    expect('new message inserted exactly once', live1.stats.inserted, 1);
    expect('rerun inserts nothing', live2.stats.inserted, 0);
    expect('rerun has no pending', live2.stats.pendingToInsert, 0);
    expect('PG grew by exactly 1', afterCount - beforeCount, 1);
    expect('no historical retransmission', live1.stats.pendingToInsert, 1);

    // ------------------------------------------------------------------
    // TEST 3 — AI/RAG can retrieve the new message
    // ------------------------------------------------------------------
    head('TEST 3 — AI/RAG retrieval of the newly forwarded message');

    const direct = await pool.query(
        `SELECT id, conversation_id, author, content, source, source_message_id, embedding IS NOT NULL AS has_embedding
         FROM grok_messages WHERE conversation_id = $1 AND source_message_id = $2`,
        [liveConv, newMessage.id]
    );
    kv('SELECT grok_messages rows', direct.rowCount);
    if (direct.rowCount) {
        kv('row id', direct.rows[0].id);
        kv('source', direct.rows[0].source);
        kv('has embedding', direct.rows[0].has_embedding);
    }

    const recent = await getRecentMessages(liveConv, 20);
    const inContext = recent.some(m => m.content === unique);
    kv('in conversation context window', inContext);

    // The context-retrieval query shape used by the RAG windowing path
    const ragWindow = await pool.query(
        `SELECT id, content FROM grok_messages
         WHERE conversation_id = $1
         ORDER BY timestamp DESC, id DESC LIMIT 5`, [liveConv]);
    const inRagWindow = ragWindow.rows.some(r => r.content === unique);
    kv('in RAG context window query', inRagWindow);

    line('');
    expect('message persisted in grok_messages', direct.rowCount, 1);
    expect('retrievable in AI context window', inContext, true);
    expect('retrievable by RAG window query', inRagWindow, true);
    if (direct.rowCount && direct.rows[0].has_embedding === false) {
        line('  NOTE: embedding is NULL, so pure vector search will not surface it until');
        line('        rag-prepare.js embeds it. Conversation-scoped context retrieval works now.');
    }

    head(failures === 0 ? 'RESULT: ALL TESTS PASSED' : `RESULT: ${failures} CHECK(S) FAILED`);
}

main()
    .then(async () => { await pool.end(); process.exit(failures === 0 ? 0 : 1); })
    .catch(async (err) => {
        console.error('[xscraper-selftest] FAILED:', err);
        await pool.end();
        process.exit(1);
    });
