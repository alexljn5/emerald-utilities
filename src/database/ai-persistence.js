/**
 * AI Persistence Service
 *
 * Provides runtime conversation persistence for the AI chat feature.
 * Uses the existing grok_conversations and grok_messages tables.
 *
 * Architecture:
 *   User message → INSERT into grok_messages
 *   → SELECT history → build context → AI request
 *   → INSERT assistant response → return to user
 *
 * All operations use the shared db-pool.js.
 * No separate database, no migrations at runtime.
 */

import { pool, checkDbHealth } from './db-pool.js';
import { ragLog } from '../utils/logger.js';
import { reconcileScrapedMessages, contentHashOf } from './xscraper-sync.js';

// ============================================================
// Configuration
// ============================================================

const DEFAULT_CONTEXT_MESSAGES = parseInt(process.env.AI_CONTEXT_MESSAGES || '20', 10);
const DEFAULT_CONVERSATION_TITLE = 'New Conversation';

// ============================================================
// Health Check
// ============================================================

async function ensureDb() {
    const health = await checkDbHealth();
    if (!health.ok) {
        throw new Error(`Database unavailable: ${health.error}`);
    }
    return pool;
}

// ============================================================
// Conversation Management
// ============================================================

/**
 * Create a new conversation or return existing one.
 * Uses a stable conversation ID. If no ID is provided, generates one.
 */
export async function getOrCreateConversation(conversationId = null) {
    const p = await ensureDb();

    let convId = conversationId;
    if (!convId) {
        // Generate a stable conversation ID
        convId = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }

    // Try to get existing conversation
    const existing = await p.query(
        'SELECT id, title, message_count, created_at, last_updated FROM grok_conversations WHERE id = $1',
        [convId]
    );

    if (existing.rows.length > 0) {
        return existing.rows[0];
    }

    // Create new conversation
    const result = await p.query(
        `INSERT INTO grok_conversations (id, title, message_count, metadata)
         VALUES ($1, $2, 0, $3)
         RETURNING id, title, message_count, created_at, last_updated`,
        [convId, DEFAULT_CONVERSATION_TITLE, { source: 'ai-chat' }]
    );

    return result.rows[0];
}

/**
 * Get conversation by ID
 */
export async function getConversation(conversationId) {
    const p = await ensureDb();
    const result = await p.query(
        'SELECT id, title, message_count, created_at, last_updated, metadata FROM grok_conversations WHERE id = $1',
        [conversationId]
    );
    return result.rows[0] || null;
}

/**
 * List recent conversations
 */
export async function listConversations(limit = 50) {
    const p = await ensureDb();
    const result = await p.query(
        `SELECT id, title, message_count, created_at, last_updated
         FROM grok_conversations
         ORDER BY last_updated DESC
         LIMIT $1`,
        [limit]
    );
    return result.rows;
}

/**
 * Update conversation title
 */
export async function updateConversationTitle(conversationId, title) {
    const p = await ensureDb();
    await p.query(
        `UPDATE grok_conversations
         SET title = $1, last_updated = NOW()
         WHERE id = $2`,
        [title, conversationId]
    );
}

// ============================================================
// Message Persistence
// ============================================================

/**
 * Save a message to the database.
 * Uses ON CONFLICT to handle duplicates gracefully.
 */
export async function saveMessage({
    conversationId,
    role,
    content,
    author = null,
    timestamp = null,
    messageId = null,
    metadata = {},
}) {
    const p = await ensureDb();

    // Generate stable ID if not provided
    const id = messageId || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const ts = timestamp ? new Date(timestamp) : new Date();

    // Determine author from role if not provided
    const resolvedAuthor = author || (role === 'user' ? 'alexljn5' : role === 'assistant' ? 'Cream' : role);

    // source_message_id / content_hash keep every row participating in the
    // canonical (conversation_id, source_message_id) identity introduced by
    // migration 005, so XScraper reconciliation can recognise these rows too.
    const result = await p.query(
        `INSERT INTO grok_messages
            (id, conversation_id, content, author, timestamp, scraped_at, payload,
             source_message_id, content_hash, source)
         VALUES ($1, $2, $3, $4, $5, NOW(), $6, $1, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
            content = EXCLUDED.content,
            author = EXCLUDED.author,
            timestamp = EXCLUDED.timestamp,
            payload = EXCLUDED.payload
         RETURNING id`,
        [
            id,
            conversationId,
            content,
            resolvedAuthor,
            ts,
            { role, ...metadata },
            contentHashOf(resolvedAuthor, content),
            metadata?.source || 'ai-chat',
        ]
    );

    // Update conversation stats
    await p.query(
        `UPDATE grok_conversations
         SET message_count = (SELECT COUNT(*) FROM grok_messages WHERE conversation_id = $1),
             last_updated = NOW()
         WHERE id = $1`,
        [conversationId]
    );

    return result.rows[0].id;
}

/**
 * Get messages for a conversation, ordered by time.
 * Returns up to `limit` most recent messages.
 */
export async function getMessages(conversationId, limit = DEFAULT_CONTEXT_MESSAGES) {
    const p = await ensureDb();
    const result = await p.query(
        `SELECT id, conversation_id, content, author, timestamp, scraped_at, payload
         FROM grok_messages
         WHERE conversation_id = $1
         ORDER BY timestamp ASC
         LIMIT $2`,
        [conversationId, limit]
    );
    return result.rows;
}

/**
 * Get the most recent N messages for context window.
 * Returns messages in chronological order (oldest first).
 */
export async function getRecentMessages(conversationId, limit = DEFAULT_CONTEXT_MESSAGES) {
    const p = await ensureDb();
    const result = await p.query(
        `SELECT id, conversation_id, content, author, timestamp, scraped_at, payload
         FROM grok_messages
         WHERE conversation_id = $1
         ORDER BY timestamp DESC
         LIMIT $2`,
        [conversationId, limit]
    );
    // Reverse to get chronological order
    return result.rows.reverse();
}

// ============================================================
// XScraper Real-time Forwarding
// ============================================================

/**
 * Forward scraped messages from XScraper to PostgreSQL.
 *
 * This is a thin wrapper around the reconciler in xscraper-sync.js. The old
 * implementation upserted every message and counted every upsert as an
 * "insert", which is why the same ~4500 messages were reported as forwarded on
 * every run. Now:
 *
 *   - each local message gets a canonical identity
 *     (conversation_id + source_message_id)
 *   - PostgreSQL is asked which identities it already has
 *   - only the genuinely missing ones are inserted (ON CONFLICT DO NOTHING)
 *   - `inserted` counts rows PostgreSQL actually persisted
 *   - the durable checkpoint only advances after a successful COMMIT
 *
 * @param {Array} messages - Array of message objects from the local XScraper store
 * @param {string} conversationId - The conversation ID from the scraper
 * @param {string} [conversationTitle] - Optional conversation title
 * @returns {Promise<object>} reconciliation counters
 */
export async function forwardScrapedMessagesToPostgres(messages, conversationId, conversationTitle = 'Scraped Conversation') {
    const list = Array.isArray(messages) ? messages : [];

    ragLog.info(
        'xscraper-forward',
        `Reconciling ${list.length} local messages against PostgreSQL for conversation ${conversationId}`
    );

    const stats = await reconcileScrapedMessages(list, conversationId, conversationTitle);

    ragLog.info(
        'xscraper-forward',
        `conv=${conversationId} local_total=${stats.localTotal} already_in_postgres=${stats.alreadyInPostgres} ` +
        `pending_to_insert=${stats.pendingToInsert} inserted=${stats.inserted} skipped=${stats.skipped} ` +
        `invalid=${stats.invalid} duplicates_local=${stats.duplicatesInLocalSource}`
    );

    return {
        // Legacy fields kept so existing IPC/UI callers keep working.
        success: stats.success,
        inserted: stats.inserted,
        skipped: stats.skipped,
        errors: stats.errors,
        conversationId: stats.conversationId,
        error: stats.error,
        // Honest, unambiguous counters.
        localTotal: stats.localTotal,
        alreadyInPostgres: stats.alreadyInPostgres,
        pendingToInsert: stats.pendingToInsert,
        invalid: stats.invalid,
        duplicatesInLocalSource: stats.duplicatesInLocalSource,
        postgresTotalAfter: stats.postgresTotalAfter,
        checkpoint: stats.checkpoint,
    };
}

// ============================================================
// Context Building
// ============================================================

/**
 * Build model context from conversation history.
 * Returns an array of { role, content } objects suitable for LLM API.
 */
export function buildContext(messages, systemPrompt = null) {
    const context = [];

    if (systemPrompt) {
        context.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
        const role = msg.author === 'alexljn5' ? 'user' : msg.author === 'Cream' ? 'assistant' : msg.author;
        context.push({
            role,
            content: msg.content,
        });
    }

    return context;
}

/**
 * Build a structured, de-duplicated context bundle for an AI request.
 *
 * PRIORITY ORDER (for truncation):
 *   1. System prompt (always kept)
 *   2. Current user message (highest priority)
 *   3. Recent conversation history (high priority)
 *   4. Retrieved RAG context (lower priority, for semantic recall)
 *
 * The messages array is ordered so that truncation (which works backwards
 * from the end) preserves the most important context first.
 *
 * @param {Object} opts
 * @param {string} [opts.systemPrompt]
 * @param {string} opts.userMessage  the current user message
 * @param {Array}  [opts.recent]     recent history messages (chronological)
 * @param {Array}  [opts.retrieved]  RAG hits with `.window`
 * @param {string} [opts.conversationId] for debug logging
 * @returns {{
 *   system: Array<{role, content}>,
 *   current: {role, content} | null,
 *   recent: Array<{role, content, author?, timestamp?}>,
 *   retrieved: Array<{role, content, author?, timestamp?, source}>,
 *   messages: Array<{role, content}>  // full ordered array for the LLM API
 * }}
 */
export function buildConversationContext({
    systemPrompt = null,
    userMessage = null,
    recent = [],
    retrieved = [],
    conversationId = null,
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

    // Deduplicate recent messages
    const recentList = [];
    for (const msg of recent || []) {
        const key = `${msg.id || ''}|${msg.content || ''}|${msg.timestamp || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        recentList.push(toRoleContent(msg, 'recent'));
    }

    // Retrieved older context: each hit carries a `.window` of surrounding
    // turns. Flatten them, mark them as retrieved, and skip any that also
    // appear in the recent history (de-dupe).
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

    // CRITICAL: Order messages so truncation (backwards from end) preserves
    // priority: current > recent > retrieved > system.
    // System is always kept by truncateToContextWindow.
    const messages = [
        ...system,
        ...retrievedList.map(({ role, content }) => ({ role, content })),
        ...recentList.map(({ role, content }) => ({ role, content })),
    ];
    if (current) messages.push({ role: current.role, content: current.content });

    // Debug logging
    ragLog.info('context-assembly', {
        conversationId,
        systemCount: system.length,
        recentCount: recentList.length,
        retrievedCount: retrievedList.length,
        currentCount: current ? 1 : 0,
        totalMessages: messages.length,
        recentAuthors: recentList.map(m => m.author),
        retrievedConversations: [...new Set(retrievedList.map(m => m.sourceConversation))],
        hasDuplicateCurrent: recent.some(m => m.content === current?.content),
    }, 'Context bundle assembled');

    return {
        system,
        current,
        recent: recentList,
        retrieved: retrievedList,
        messages,
    };
}

/**
 * Build a simple context string from messages (for legacy RAG-style prompts).
 */
export function buildContextString(messages) {
    return messages
        .map(msg => `[${msg.author} @ ${msg.timestamp}] ${msg.content}`)
        .join('\n\n');
}

// ============================================================
// Context Assembly Pipeline
// ============================================================

/**
 * Resolve an author label into a stable role.
 * Author names may be 'alexljn5' (user) / 'Cream' (assistant) or DB roles.
 */
export function roleOf(author) {
    const a = String(author || '').toLowerCase();
    if (a === 'user' || a === 'alexljn5' || a === 'lune') return 'user';
    if (a === 'assistant' || a === 'cream') return 'assistant';
    return a || 'user';
}

// ============================================================
// Full Chat Persistence Loop
// ============================================================

/**
 * Complete chat persistence loop:
 * 1. Get or create conversation
 * 2. Retrieve history (BEFORE saving current message to avoid duplicate)
 * 3. Save user message
 * 4. Build context
 * 5. Return context + conversation info for caller to send to AI
 *
 * The caller is responsible for:
 * - Sending the context to the AI provider
 * - Saving the assistant response via saveMessage()
 */
export async function prepareChatRequest({
    conversationId = null,
    userMessage,
    systemPrompt = null,
    contextLimit = DEFAULT_CONTEXT_MESSAGES,
}) {
    // 1. Get or create conversation
    const conversation = await getOrCreateConversation(conversationId);

    // 2. Retrieve history BEFORE saving the current message.
    //    This ensures the current message is not duplicated in the context.
    const history = await getRecentMessages(conversation.id, contextLimit);

    // 3. Save user message
    const userMsgId = await saveMessage({
        conversationId: conversation.id,
        role: 'user',
        content: userMessage,
    });

    // 4. Build context (deprecated - use buildConversationContext instead)
    const context = buildContext(history, systemPrompt);

    return {
        conversationId: conversation.id,
        conversation,
        userMessageId: userMsgId,
        history,
        context,
    };
}

/**
 * Save assistant response and return updated state.
 */
export async function saveAssistantResponse({
    conversationId,
    responseContent,
    messageId = null,
    metadata = {},
}) {
    const assistantMsgId = await saveMessage({
        conversationId,
        role: 'assistant',
        content: responseContent,
        messageId,
        metadata,
    });

    // Return updated conversation info
    const conversation = await getConversation(conversationId);
    const recentMessages = await getRecentMessages(conversationId, 10);

    return {
        messageId: assistantMsgId,
        conversation,
        recentMessages,
    };
}

// ============================================================
// Conversation Reset
// ============================================================

/**
 * Clear all messages in a conversation (but keep the conversation record).
 */
export async function clearConversation(conversationId) {
    const p = await ensureDb();
    await p.query('DELETE FROM grok_messages WHERE conversation_id = $1', [conversationId]);
    await p.query(
        `UPDATE grok_conversations
         SET message_count = 0, last_updated = NOW()
         WHERE id = $1`,
        [conversationId]
    );
}

/**
 * Delete a conversation and all its messages.
 */
export async function deleteConversation(conversationId) {
    const p = await ensureDb();
    await p.query('DELETE FROM grok_conversations WHERE id = $1', [conversationId]);
}
