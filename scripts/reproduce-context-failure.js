#!/usr/bin/env node
/**
 * Context Failure Reproduction Script
 * 
 * Simulates the exact context pipeline for the conversation:
 *   User: "First, lets hug"
 *   Assistant: "I'd love that! Let me wrap my arms around you..."
 *   User: "So, what are we doing right now?"
 * 
 * This should show whether the model receives the hug context.
 */

import { Pool } from 'pg';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadDotenv } from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load env
loadDotenv({ path: join(__dirname, '..', 'src', '.env'), override: true });

const DB_CONFIG = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'emerald_utilities',
    user: process.env.DB_USER || 'emerald-user',
    password: process.env.DB_PASSWORD || '',
};

const pool = new Pool(DB_CONFIG);

// Inline the functions we need to avoid electron import issues

const DEFAULT_CONTEXT_MESSAGES = 20;

async function getRecentMessages(conversationId, limit = DEFAULT_CONTEXT_MESSAGES) {
    const result = await pool.query(
        `SELECT id, conversation_id, content, author, timestamp, scraped_at, payload
         FROM grok_messages
         WHERE conversation_id = $1
         ORDER BY timestamp DESC
         LIMIT $2`,
        [conversationId, limit]
    );
    return result.rows.reverse();
}

function roleOf(author) {
    const a = String(author || '').toLowerCase();
    if (a === 'user' || a === 'emerald-user' || a === 'lune') return 'user';
    if (a === 'assistant' || a === 'cream') return 'assistant';
    return a || 'user';
}

function buildContext(messages, systemPrompt = null) {
    const context = [];
    if (systemPrompt) {
        context.push({ role: 'system', content: systemPrompt });
    }
    for (const msg of messages) {
        const role = msg.author === 'emerald-user' ? 'user' : msg.author === 'Cream' ? 'assistant' : msg.author;
        context.push({
            role,
            content: msg.content,
        });
    }
    return context;
}

function buildConversationContext({
    systemPrompt = null,
    userMessage = null,
    recent = [],
    retrieved = [],
}) {
    const system = systemPrompt ? [{ role: 'system', content: systemPrompt }] : [];

    const current = userMessage
        ? { role: 'user', content: userMessage }
        : null;

    const seen = new Set();
    const toRoleContent = (msg, source) => ({
        role: roleOf(msg.author || msg.role),
        content: msg.content || '',
        author: msg.author || msg.role || null,
        timestamp: msg.timestamp || null,
        source,
    });

    const recentList = [];
    for (const msg of recent || []) {
        const key = `${msg.id || ''}|${msg.content || ''}|${msg.timestamp || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        recentList.push(toRoleContent(msg, 'recent'));
    }

    const retrievedList = [];
    for (const hit of retrieved || []) {
        const win = Array.isArray(hit.window) && hit.window.length
            ? hit.window
            : [hit];
        for (const msg of win) {
            const key = `${msg.id || ''}|${msg.content || ''}|${msg.timestamp || ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            retrievedList.push({
                ...toRoleContent(msg, 'retrieved'),
                sourceConversation: hit.conversation_id || msg.conversation_id || null,
                similarity: hit.similarity != null ? Number(hit.similarity) : null,
            });
        }
    }

    const messages = [
        ...system,
        ...recentList.map(({ role, content }) => ({ role, content })),
        ...retrievedList.map(({ role, content }) => ({ role, content })),
    ];
    if (current) messages.push({ role: current.role, content: current.content });

    return {
        system,
        current,
        recent: recentList,
        retrieved: retrievedList,
        messages,
    };
}

function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}

function truncateToContextWindow(messages, maxTokens = 4000) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;

    const systemMessages = messages.filter(m => m.role === 'system');
    const otherMessages = messages.filter(m => m.role !== 'system');

    const systemTokens = systemMessages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    let remainingBudget = maxTokens - systemTokens;

    if (remainingBudget <= 0) {
        const truncatedSystem = systemMessages.map(m => ({
            ...m,
            content: m.content.slice(0, Math.floor(remainingBudget * 4))
        }));
        return truncatedSystem;
    }

    const result = [...systemMessages];
    for (let i = otherMessages.length - 1; i >= 0; i--) {
        const msg = otherMessages[i];
        const msgTokens = estimateTokens(msg.content);
        if (msgTokens <= remainingBudget) {
            result.unshift(msg);
            remainingBudget -= msgTokens;
        } else {
            const truncatedContent = msg.content.slice(0, Math.floor(remainingBudget * 4));
            if (truncatedContent.length > 0) {
                result.unshift({ ...msg, content: truncatedContent });
            }
            break;
        }
    }

    return result;
}

const CONVERSATION_ID = 'test_persistence_conv';

async function main() {
    console.log('='.repeat(80));
    console.log('CONTEXT FAILURE REPRODUCTION');
    console.log('='.repeat(80));
    console.log('');

    // 1. Get the conversation messages
    const messages = await pool.query(`
        SELECT id, content, author, timestamp
        FROM grok_messages
        WHERE conversation_id = $1
        ORDER BY timestamp ASC
    `, [CONVERSATION_ID]);

    console.log(`Conversation: ${CONVERSATION_ID}`);
    console.log(`Total messages: ${messages.rows.length}`);
    console.log('');

    // Find the specific messages we care about
    const hugUserMsg = messages.rows.find(m => m.content === 'First, lets hug');
    const hugAssistantMsg = messages.rows.find(m => m.content === "I'd love that! Let me wrap my arms around you and hold you close. How does that feel?");
    const whatAreWeDoingMsg = messages.rows.find(m => m.content === 'So, what are we doing right now?');

    console.log('Target messages:');
    console.log(`  User "First, lets hug": ${hugUserMsg ? 'FOUND' : 'NOT FOUND'} at ${hugUserMsg?.timestamp}`);
    console.log(`  Assistant response: ${hugAssistantMsg ? 'FOUND' : 'NOT FOUND'} at ${hugAssistantMsg?.timestamp}`);
    console.log(`  User "So, what are we doing right now?": ${whatAreWeDoingMsg ? 'FOUND' : 'NOT FOUND'} at ${whatAreWeDoingMsg?.timestamp}`);
    console.log('');

    // 2. Simulate what happens when user sends "So, what are we doing right now?"
    const userMessage = 'So, what are we doing right now?';
    const contextLimit = 20;

    // 2a. Get recent messages (this is what prepareChatRequest does AFTER saving the user message)
    const history = await getRecentMessages(CONVERSATION_ID, contextLimit);

    console.log('Recent history (last 20 messages, chronological):');
    for (const msg of history) {
        console.log(`  [${msg.timestamp}] ${msg.author}: ${msg.content.substring(0, 80)}...`);
    }
    console.log('');

    // Check if the hug message is in history
    const hugInHistory = history.some(m => m.content === 'First, lets hug');
    console.log(`Hug message in recent history: ${hugInHistory ? 'YES' : 'NO'}`);
    console.log('');

    // 2b. Build context with buildContext (used in prepareChatRequest)
    const simpleContext = buildContext(history, null);
    console.log('Simple context (buildContext) - first 5 entries:');
    simpleContext.slice(0, 5).forEach((msg, i) => {
        console.log(`  ${i}: ${msg.role}: ${msg.content.substring(0, 80)}...`);
    });
    console.log(`  ... (${simpleContext.length} total)`);
    console.log('');

    // 2c. Build context with buildConversationContext (used in IPC handler)
    const bundle = buildConversationContext({
        systemPrompt: null,
        userMessage,
        recent: history,
        retrieved: [],
    });

    console.log('Conversation context bundle (NO RAG):');
    console.log(`  System: ${bundle.system.length} entries`);
    console.log(`  Current: ${bundle.current ? '1 entry' : 'none'}`);
    console.log(`  Recent: ${bundle.recent.length} entries`);
    console.log(`  Retrieved: ${bundle.retrieved.length} entries`);
    console.log(`  Total messages: ${bundle.messages.length}`);
    console.log('');

    console.log('Messages array (what gets sent to LLM) - NO RAG:');
    bundle.messages.forEach((msg, i) => {
        console.log(`  ${i}: ${msg.role}: ${msg.content.substring(0, 80)}...`);
    });
    console.log('');

    // Check for duplicate current message
    const currentContent = bundle.current?.content;
    const recentWithCurrent = bundle.recent.filter(m => m.content === currentContent);
    console.log(`Current message "${currentContent?.substring(0, 40)}..." appears in recent: ${recentWithCurrent.length > 0 ? 'YES (DUPLICATE!)' : 'NO'}`);
    console.log('');

    // 2d. Apply truncation
    const truncated = truncateToContextWindow(bundle.messages, 4000);
    console.log('After truncation to 4000 tokens:');
    console.log(`  Messages before: ${bundle.messages.length}`);
    console.log(`  Messages after: ${truncated.length}`);
    truncated.forEach((msg, i) => {
        console.log(`  ${i}: ${msg.role}: ${msg.content.substring(0, 80)}...`);
    });
    console.log('');

    const hugAfterTruncation = truncated.some(m => m.content === 'First, lets hug');
    console.log(`Hug message after truncation: ${hugAfterTruncation ? 'YES' : 'NO - LOST!'}`);
    console.log('');

    // 2e. Now test WITH RAG simulation
    console.log('-'.repeat(60));
    console.log('SIMULATING WITH RAG (cross-conversation contamination)');
    console.log('-'.repeat(60));
    console.log('');

    // Simulate RAG returning messages from OTHER conversations
    // This is what happens in production because queryRAGWithContext has no conversation_id filter
    const simulatedRagHits = [
        {
            id: 'other_conv_msg_1',
            conversation_id: 'd2a7e178-68e4-46fd-8741-efb5d84589ec', // Different conversation!
            content: 'Refine Mystical Sigil Logo PNGRefine Mystical Sigil Logo PNG',
            author: 'user',
            timestamp: new Date('2026-06-28T10:19:45Z'),
            similarity: 0.85,
            window: [
                { id: 'ow1', conversation_id: 'd2a7e178-68e4-46fd-8741-efb5d84589ec', content: 'Some unrelated message 1', author: 'user', timestamp: new Date('2026-06-28T10:19:44Z') },
                { id: 'other_conv_msg_1', conversation_id: 'd2a7e178-68e4-46fd-8741-efb5d84589ec', content: 'Refine Mystical Sigil Logo PNGRefine Mystical Sigil Logo PNG', author: 'user', timestamp: new Date('2026-06-28T10:19:45Z') },
                { id: 'ow2', conversation_id: 'd2a7e178-68e4-46fd-8741-efb5d84589ec', content: 'Some unrelated message 2', author: 'user', timestamp: new Date('2026-06-28T10:19:46Z') },
            ]
        },
        {
            id: 'other_conv_msg_2',
            conversation_id: '32e512bd-71a0-4f40-abcf-4798b450695d', // Another different conversation!
            content: 'Hugging Face Inference Token Error FixMar 16, 2026',
            author: 'user',
            timestamp: new Date('2026-06-28T10:19:46Z'),
            similarity: 0.82,
            window: [
                { id: 'ow3', conversation_id: '32e512bd-71a0-4f40-abcf-4798b450695d', content: 'Feb 3, 2026', author: 'user', timestamp: new Date('2026-06-28T10:19:46Z') },
                { id: 'other_conv_msg_2', conversation_id: '32e512bd-71a0-4f40-abcf-4798b450695d', content: 'Hugging Face Inference Token Error FixMar 16, 2026', author: 'user', timestamp: new Date('2026-06-28T10:19:46Z') },
            ]
        },
    ];

    const bundleWithRag = buildConversationContext({
        systemPrompt: null,
        userMessage,
        recent: history,
        retrieved: simulatedRagHits,
    });

    console.log('Messages array WITH SIMULATED RAG:');
    bundleWithRag.messages.forEach((msg, i) => {
        console.log(`  ${i}: ${msg.role}: ${msg.content.substring(0, 80)}...`);
    });
    console.log('');
    console.log(`Total messages with RAG: ${bundleWithRag.messages.length}`);

    const totalChars = bundleWithRag.messages.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = Math.ceil(totalChars / 4);
    console.log(`Estimated tokens: ~${estimatedTokens}`);
    console.log('');

    const truncatedWithRag = truncateToContextWindow(bundleWithRag.messages, 4000);
    console.log('After truncation to 4000 tokens:');
    console.log(`  Messages before: ${bundleWithRag.messages.length}`);
    console.log(`  Messages after: ${truncatedWithRag.length}`);
    truncatedWithRag.forEach((msg, i) => {
        console.log(`  ${i}: ${msg.role}: ${msg.content.substring(0, 80)}...`);
    });
    console.log('');

    const hugAfterRagTruncation = truncatedWithRag.some(m => m.content === 'First, lets hug');
    console.log(`Hug message after RAG + truncation: ${hugAfterRagTruncation ? 'YES' : 'NO - LOST!'}`);
    console.log('');

    console.log('='.repeat(80));
    console.log('ROOT CAUSE ANALYSIS');
    console.log('='.repeat(80));
    console.log('');
    console.log('BUG 1: RAG queries ALL conversations');
    console.log('  queryRAGWithContext has no conversation_id filter on the seed query.');
    console.log('  This means messages from unrelated conversations pollute the context.');
    console.log('');
    console.log('BUG 2: Context truncation drops recent history before retrieved context');
    console.log('  In buildConversationContext, the order is: system + recent + retrieved + current');
    console.log('  truncateToContextWindow works BACKWARDS from the end.');
    console.log('  So it keeps: current > retrieved > recent > system');
    console.log('  This is WRONG - recent history should have higher priority than RAG.');
    console.log('');
    console.log('BUG 3: Duplicate current message');
    console.log('  The user message is saved to DB, then retrieved in history,');
    console.log('  then added again as "current". It appears twice in the context.');
    console.log('');
    console.log('BUG 4: No conversation ID persistence across restarts');
    console.log('  TheAI.jsx loads the most recent conversation on mount,');
    console.log('  but does not persist/restore the user\'s active conversation ID.');
    console.log('');

    await pool.end();
}

main().catch(e => {
    console.error('Error:', e);
    process.exit(1);
});
