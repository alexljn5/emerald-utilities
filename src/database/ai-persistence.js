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
 *
 * Invariant: The database is the canonical complete history.
 * Context assembly decides what the model receives.
 * Persistence and context limitation are never the same operation.
 */

import { pool, checkDbHealth } from './db-pool.js';
import { ragLog } from '../utils/logger.js';
import { reconcileScrapedMessages, contentHashOf } from './xscraper-sync.js';
import { normalizeModelResponse } from './response-normalizer.js';
import {
    buildConversationContext,
    buildSystemPrompt,
    estimateTokens,
    estimateContextTokens,
    ContextSource,
    validateContextBundle,
    buildDebugContextView,
    buildDebugSummary,
    validateCharacterSheet,
} from './ai-context.js';
import { loadCharacterSheet as loadCharacterSheetFromRegistry, getAgentSystemPrompt as getAgentSystemPromptFromRegistry, getAvailableAgents, getAgent, isValidAgentId } from './character-sheets.js';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ============================================================
// Configuration
// ============================================================

const DEFAULT_CONTEXT_MESSAGES = parseInt(process.env.AI_CONTEXT_MESSAGES || '100', 10);
const DEFAULT_CONVERSATION_TITLE = 'New Conversation';

// Load context configuration from config.json
const __dirname = dirname(fileURLToPath(import.meta.url));
let contextConfig = {
    contextMode: 'maximum',
    maxContextTokens: 32768,
    reservedOutputTokens: 2048,
};

try {
    const configPath = join(__dirname, 'config.json');
    const raw = await readFile(configPath, 'utf8');
    const config = JSON.parse(raw);
    if (config.contextMode) contextConfig.contextMode = config.contextMode;
    if (config.maxContextTokens) contextConfig.maxContextTokens = config.maxContextTokens;
    if (config.reservedOutputTokens) contextConfig.reservedOutputTokens = config.reservedOutputTokens;
} catch (err) {
    ragLog.warn('ai-persistence', 'Could not load context config, using defaults', { error: err.message });
}

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
    if (limit == null) {
        // No limit — return all messages for this conversation
        const result = await p.query(
            `SELECT id, conversation_id, content, author, timestamp, scraped_at, payload
             FROM grok_messages
             WHERE conversation_id = $1
             ORDER BY timestamp DESC`,
            [conversationId]
        );
        return result.rows.reverse();
    }
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

/**
 * Get ALL messages for a conversation (no limit).
 * Used in "maximum" context mode where the full history is fetched
 * and the context builder decides what to include.
 */
export async function getAllMessages(conversationId) {
    const p = await ensureDb();
    const result = await p.query(
        `SELECT id, conversation_id, content, author, timestamp, scraped_at, payload
         FROM grok_messages
         WHERE conversation_id = $1
         ORDER BY timestamp ASC`,
        [conversationId]
    );
    return result.rows;
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
 *
 * @deprecated Use buildConversationContext from ai-context.js instead
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

// Re-export buildConversationContext from ai-context.js for backward compatibility
// The actual implementation is in ai-context.js
export { buildConversationContext } from './ai-context.js';

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
// Character Sheet Support
// ============================================================

/**
 * Load a character sheet for a specific agent, with optional overrides.
 * Character sheets are stored separately from user memories to prevent
 * the AI from accidentally treating personality instructions as factual history.
 *
 * @param {string} [agentId='cream'] - Agent ID (cream, patches, vesper, clover)
 * @param {Object} [overrides] - Optional character sheet overrides
 * @returns {Object} Validated character sheet
 */
export function loadCharacterSheet(agentId = 'cream', overrides = null) {
    // Delegate to the imported function from character-sheets.js
    return loadCharacterSheetFromRegistry(agentId, overrides);
}

/**
 * Get the system prompt for a specific agent.
 * This is separate from factual memory and should never be stored in
 * the conversation history as a user/assistant message.
 */
export function getCharacterSystemPrompt(agentId = 'cream', additionalInstructions = '') {
    return getAgentSystemPromptFromRegistry(agentId, additionalInstructions);
}

// Re-export character sheet functions for backward compatibility
export { getAvailableAgents, getAgent, isValidAgentId } from './character-sheets.js';

// ============================================================
// Full Chat Persistence Loop
// ============================================================

/**
 * Complete chat persistence loop:
 * 1. Get or create conversation
 * 2. Retrieve history (BEFORE saving current message to avoid duplicate)
 * 3. Save user message
 * 4. Build context with improved token estimation and source labeling
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
    agentId = 'cream',
    contextMode = null,
    maxContextTokens = null,
    reservedOutputTokens = null,
}) {
    // 1. Get or create conversation
    const conversation = await getOrCreateConversation(conversationId);

    // 2. Retrieve history BEFORE saving the current message.
    //    This ensures the current message is not duplicated in the context.
    //    In "maximum" mode, fetch the full conversation history.
    //    In "balanced" mode, fetch the configured limit.
    const effectiveMode = contextMode || contextConfig.contextMode;
    const fetchLimit = effectiveMode === 'maximum' ? null : contextLimit;
    const history = fetchLimit
        ? await getRecentMessages(conversation.id, fetchLimit)
        : await getAllMessages(conversation.id);

    // 3. Save user message
    const userMsgId = await saveMessage({
        conversationId: conversation.id,
        role: 'user',
        content: userMessage,
    });

    // 4. Build context with improved token estimation and source labeling
    //    Use agent-specific system prompt if no custom system prompt is provided
    const contextBundle = buildConversationContext({
        systemPrompt: systemPrompt || getCharacterSystemPrompt(agentId),
        userMessage,
        recent: history,
        retrieved: [], // RAG is handled separately by the caller
        conversationId: conversation.id,
        options: {
            maxTokens: maxContextTokens || contextConfig.maxContextTokens,
            contextMode: effectiveMode,
            reservedOutputTokens: reservedOutputTokens || contextConfig.reservedOutputTokens,
        },
    });

    // 5. Validate context
    const warnings = validateContextBundle(contextBundle);
    if (warnings.length > 0 && (process.env.EMERALD_DEBUG || process.env.DEBUG)) {
        ragLog.warn('prepareChatRequest', warnings.join('; '));
    }

    return {
        conversationId: conversation.id,
        conversation,
        userMessageId: userMsgId,
        history,
        context: contextBundle.messages,
        contextBundle,
    };
}

/**
 * Save assistant response and return updated state.
 * Normalizes the response to strip accidental role-label prefixes.
 */
export async function saveAssistantResponse({
    conversationId,
    responseContent,
    messageId = null,
    metadata = {},
}) {
    const cleanedContent = normalizeModelResponse(responseContent);
    const assistantMsgId = await saveMessage({
        conversationId,
        role: 'assistant',
        content: cleanedContent,
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
// Debug Utilities
// ============================================================

/**
 * Build a debug view of a conversation's context for the UI.
 * This powers the "what context was supplied?" debug view.
 */
export function buildConversationDebugView(contextBundle) {
    if (!contextBundle) {
        return {
            summary: 'No context available',
            details: [],
        };
    }

    const summary = buildDebugSummary(contextBundle);
    const details = [];

    if (contextBundle.system?.length > 0) {
        details.push({
            source: 'System Prompt',
            count: contextBundle.system.length,
            tokens: contextBundle.system.reduce((sum, m) => sum + (m._tokens || 0), 0),
            preview: contextBundle.system[0].content.slice(0, 200),
        });
    }

    if (contextBundle.current) {
        details.push({
            source: 'Current Message',
            count: 1,
            tokens: contextBundle.current._tokens || 0,
            preview: contextBundle.current.content.slice(0, 200),
        });
    }

    if (contextBundle.recent?.length > 0) {
        details.push({
            source: 'Recent History',
            count: contextBundle.recent.length,
            tokens: contextBundle.recent.reduce((sum, m) => sum + (m._tokens || 0), 0),
            preview: `${contextBundle.recent[0].author}: ${contextBundle.recent[0].content.slice(0, 100)}`,
        });
    }

    if (contextBundle.retrieved?.length > 0) {
        details.push({
            source: 'Retrieved Context',
            count: contextBundle.retrieved.length,
            tokens: contextBundle.retrieved.reduce((sum, m) => sum + (m._tokens || 0), 0),
            preview: `From ${new Set(contextBundle.retrieved.map(m => m.sourceConversation)).size} conversations`,
        });
    }

    return { summary, details };
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
