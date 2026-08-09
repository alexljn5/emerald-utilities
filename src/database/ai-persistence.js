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

    const result = await p.query(
        `INSERT INTO grok_messages
            (id, conversation_id, content, author, timestamp, scraped_at, payload)
         VALUES ($1, $2, $3, $4, $5, NOW(), $6)
         ON CONFLICT (id) DO UPDATE SET
            content = EXCLUDED.content,
            author = EXCLUDED.author,
            timestamp = EXCLUDED.timestamp,
            payload = EXCLUDED.payload
         RETURNING id`,
        [id, conversationId, content, resolvedAuthor, ts, { role, ...metadata }]
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

/**
 * Build a structured, de-duplicated context bundle for an AI request.
 *
 * This is the core context-assembly pipeline. It separates the distinct
 * parts of what the model sees so the pipeline is transparent and correct:
 *
 *   - system          : fixed system instructions
 *   - current         : the user's current message
 *   - recent          : the immediately preceding conversational turns
 *                       (highest priority, chronological order)
 *   - retrieved       : older semantically-relevant context from RAG
 *                       (each hit includes its surrounding window + metadata)
 *
 * Ordering is preserved within each segment. Retrieved messages retain their
 * surrounding turns so they are never ambiguous in isolation.
 *
 * @param {Object} opts
 * @param {string} [opts.systemPrompt]
 * @param {string} opts.userMessage  the current user message
 * @param {Array}  [opts.recent]     recent history messages (chronological)
 * @param {Array}  [opts.retrieved]  RAG hits with `.window` (see queryRAGWithContext)
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

// ============================================================
// Full Chat Persistence Loop
// ============================================================

/**
 * Complete chat persistence loop:
 * 1. Get or create conversation
 * 2. Save user message
 * 3. Retrieve history
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

    // 2. Save user message
    const userMsgId = await saveMessage({
        conversationId: conversation.id,
        role: 'user',
        content: userMessage,
    });

    // 3. Retrieve history
    const history = await getRecentMessages(conversation.id, contextLimit);

    // 4. Build context
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
