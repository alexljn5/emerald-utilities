/**
 * XScraper single-message diagnostic — READ ONLY.
 *
 * XSCRAPER ONLY. Shows, for one message:
 *   - local identity        (what the local XScraper store calls it)
 *   - canonical identity    (conversation_id + source_message_id + row id)
 *   - PostgreSQL identity   (the row that actually stores it, if any)
 *   - whether it exists
 *   - whether a forward would insert it or skip it
 *
 * Usage:
 *   node scripts/xscraper-diagnose-message.js -c <conversationId> -i <sourceMessageId>
 *   node scripts/xscraper-diagnose-message.js -c <conversationId> -t "exact message text" [-a author]
 *   node scripts/xscraper-diagnose-message.js -c <conversationId> --latest-local
 *   node scripts/xscraper-diagnose-message.js -c <conversationId> --latest-db
 */

import { pool, connectionInfo } from '../src/database/db-pool.js';
import { readLocalXScraperSource } from '../src/database/xscraper-local-source.js';
import { inspectSingleMessage } from '../src/database/xscraper-sync.js';

function parseArgs(argv) {
    const a = { conversation: null, id: null, text: null, author: null, latestLocal: false, latestDb: false };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k === '-c' || k === '--conversation') a.conversation = argv[++i];
        else if (k === '-i' || k === '--id') a.id = argv[++i];
        else if (k === '-t' || k === '--text') a.text = argv[++i];
        else if (k === '-a' || k === '--author') a.author = argv[++i];
        else if (k === '--latest-local') a.latestLocal = true;
        else if (k === '--latest-db') a.latestDb = true;
    }
    return a;
}

const pad = (s) => String(s).padEnd(22);

async function resolveMessage(args) {
    if (args.text) {
        return { id: args.id || undefined, content: args.text, author: args.author || 'You' };
    }

    if (args.latestLocal || (args.id && !args.text)) {
        const local = await readLocalXScraperSource({ conversationId: args.conversation });
        const msgs = local.byConversation.get(args.conversation) || [];
        if (args.id) {
            const hit = msgs.find(m => String(m.id) === String(args.id));
            if (hit) return hit;
            // Not in the local store — still resolvable as a bare identity probe.
            return { id: args.id, content: '', author: args.author || 'You', __identityOnly: true };
        }
        if (msgs.length === 0) return null;
        return msgs.reduce((best, m) => ((m.savedAt || 0) > (best.savedAt || 0) ? m : best), msgs[0]);
    }

    if (args.latestDb) {
        const res = await pool.query(
            `SELECT id, source_message_id, content, author, timestamp
             FROM grok_messages WHERE conversation_id = $1
             ORDER BY scraped_at DESC LIMIT 1`, [args.conversation]);
        if (res.rows.length === 0) return null;
        const r = res.rows[0];
        return { id: r.source_message_id || r.id, content: r.content, author: r.author, timestamp: r.timestamp };
    }

    return null;
}

async function main() {
    const args = parseArgs(process.argv);
    if (!args.conversation) {
        console.error('Missing -c <conversationId>. See the header of this file for usage.');
        process.exit(2);
    }

    console.log(`PostgreSQL: ${connectionInfo.user}@${connectionInfo.host}:${connectionInfo.port}/${connectionInfo.database}`);
    console.log(`Conversation: ${args.conversation}`);

    const msg = await resolveMessage(args);
    if (!msg) {
        console.error('Could not resolve a message. Provide -i/--id, -t/--text, --latest-local or --latest-db.');
        process.exit(2);
    }

    if (msg.__identityOnly && !msg.content) {
        // Identity probe: the message is not in the local store, so only the
        // source id is known. Look it up directly.
        const res = await pool.query(
            `SELECT id, conversation_id, source_message_id, content_hash, author, timestamp, scraped_at, source
             FROM grok_messages WHERE conversation_id = $1 AND (source_message_id = $2 OR id = $2) LIMIT 1`,
            [args.conversation, String(msg.id)]
        );
        console.log('\n--- LOCAL IDENTITY ---');
        console.log(pad('source id:') + msg.id + '   (not present in the local store)');
        console.log('\n--- POSTGRESQL IDENTITY ---');
        if (res.rows.length === 0) {
            console.log('(not found)');
            console.log('\n' + pad('exists:') + 'NO');
            console.log(pad('forward would:') + 'INSERT (if the message exists locally)');
        } else {
            const r = res.rows[0];
            console.log(pad('row id:') + r.id);
            console.log(pad('source_message_id:') + r.source_message_id);
            console.log(pad('content_hash:') + r.content_hash);
            console.log(pad('author:') + r.author);
            console.log(pad('timestamp:') + (r.timestamp?.toISOString?.() || r.timestamp));
            console.log(pad('source:') + r.source);
            console.log('\n' + pad('exists:') + 'YES');
            console.log(pad('forward would:') + 'SKIP (already persisted)');
        }
        return;
    }

    const result = await inspectSingleMessage(msg, args.conversation);

    console.log('\n--- LOCAL IDENTITY ---');
    console.log(pad('id:') + (result.localIdentity.id ?? '(none — fallback identity will be derived)'));
    console.log(pad('author:') + result.localIdentity.author);
    console.log(pad('timestamp:') + result.localIdentity.timestamp);
    console.log(pad('content:') + `"${result.localIdentity.contentPreview.replace(/\s+/g, ' ')}"`);
    console.log(pad('valid:') + result.valid + (result.reason ? ` (${result.reason})` : ''));

    console.log('\n--- CANONICAL IDENTITY ---');
    if (result.canonicalIdentity) {
        console.log(pad('conversation_id:') + result.canonicalIdentity.conversationId);
        console.log(pad('source_message_id:') + result.canonicalIdentity.sourceMessageId);
        console.log(pad('content_hash:') + result.canonicalIdentity.contentHash);
        console.log(pad('row id (new rows):') + result.canonicalIdentity.rowId);
    } else {
        console.log('(none — message is invalid)');
    }

    console.log('\n--- POSTGRESQL IDENTITY ---');
    if (result.postgres) {
        console.log(pad('row id:') + result.postgres.id);
        console.log(pad('source_message_id:') + result.postgres.source_message_id);
        console.log(pad('content_hash:') + result.postgres.content_hash);
        console.log(pad('author:') + result.postgres.author);
        console.log(pad('timestamp:') + (result.postgres.timestamp?.toISOString?.() || result.postgres.timestamp));
        console.log(pad('scraped_at:') + (result.postgres.scraped_at?.toISOString?.() || result.postgres.scraped_at));
        console.log(pad('source:') + result.postgres.source);
    } else {
        console.log('(not found)');
    }

    console.log('');
    console.log(pad('exists:') + (result.exists ? 'YES' : 'NO'));
    console.log(pad('forward would:') + (result.wouldBe === 'skip' ? 'SKIP (inserted=0, skipped=1)' : result.wouldBe === 'insert' ? 'INSERT (inserted=1)' : 'REJECT (invalid)'));
}

main()
    .then(() => pool.end())
    .catch(async (err) => {
        console.error('[xscraper-diagnose-message] FAILED:', err.message);
        await pool.end();
        process.exit(1);
    });
