/**
 * AI Context Management
 *
 * Provides improved context assembly, token estimation, truncation,
 * and debug output for the AI chat system.
 *
 * Architecture:
 *   Character Sheet → System Prompt
 *   Recent History  → High-priority context (chronological)
 *   RAG Retrieval   → Lower-priority supplement (not replacement)
 *   Current Message → Highest priority
 *
 * Invariant: Persistence and context limitation are never the same operation.
 * The database stores the complete conversation. Context assembly decides
 * what the model receives.
 */

import { ragLog } from '../utils/logger.js';

// ============================================================
// Token Estimation
// ============================================================

/**
 * Estimate token count for a string.
 * Uses a more accurate model than simple chars/4:
 *   - ~4 chars per token for English prose
 *   - ~2-3 chars per token for code/structured text
 *   - Adds overhead for special tokens
 *
 * @param {string} text
 * @param {string} [type='prose'] - 'prose' | 'code' | 'mixed'
 * @returns {number} Estimated token count
 */
export function estimateTokens(text, type = 'prose') {
    if (!text || typeof text !== 'string') return 0;

    const len = text.length;

    // Base estimation
    let ratio;
    switch (type) {
        case 'code':
            ratio = 2.5;  // Code is more token-dense
            break;
        case 'mixed':
            ratio = 3.0;
            break;
        case 'prose':
        default:
            ratio = 3.8;  // Slightly more accurate than 4.0
            break;
    }

    // Add overhead for special tokens (newlines, spaces, punctuation)
    const specialCharRatio = (text.match(/[\n\r\t]/g) || []).length / len;
    const overhead = 1 + (specialCharRatio * 0.5);

    return Math.ceil(len / ratio * overhead);
}

/**
 * Estimate tokens for a message object.
 */
export function estimateMessageTokens(msg) {
    if (!msg || !msg.content) return 0;
    const contentTokens = estimateTokens(msg.content);
    // Add overhead for role and metadata (~10 tokens per message)
    return contentTokens + 10;
}

/**
 * Calculate total tokens for an array of messages.
 */
export function estimateContextTokens(messages) {
    if (!Array.isArray(messages)) return 0;
    return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

// ============================================================
// Context Source Labels
// ============================================================

/**
 * Context source types for explicit labeling.
 * The AI should treat each source differently:
 *   - SYSTEM: Personality/character instructions (always trusted, never factual)
 *   - RECENT: Recent conversation history (high trust, current context)
 *   - RETRIEVED: Older context fetched via RAG (medium trust, may be stale)
 *   - CURRENT: The user's current message (highest priority)
 */
export const ContextSource = Object.freeze({
    SYSTEM: 'system',
    RECENT: 'recent',
    RETRIEVED: 'retrieved',
    CURRENT: 'current',
    OMITTED: 'omitted',
    UNKNOWN: 'unknown',
});

/**
 * Get a human-readable label for a context source.
 */
export function getSourceLabel(source) {
    switch (source) {
        case ContextSource.SYSTEM: return 'System Prompt';
        case ContextSource.RECENT: return 'Recent History';
        case ContextSource.RETRIEVED: return 'Retrieved Context';
        case ContextSource.CURRENT: return 'Current Message';
        case ContextSource.OMITTED: return 'Omitted (overflow)';
        default: return 'Unknown';
    }
}

// ============================================================
// Context Assembly
// ============================================================

/**
 * Build a structured context bundle with explicit source metadata.
 *
 * Each message in the returned arrays includes a `_source` field indicating
 * where it came from. This allows:
 *   1. The AI to understand context provenance
 *   2. Debug views to show what context was supplied
 *   3. Proper truncation based on source priority
 *
 * @param {Object} opts
 * @param {string} [opts.systemPrompt] - Character/personality instructions
 * @param {string} opts.userMessage - The current user message
 * @param {Array}  [opts.recent] - Recent history messages (chronological)
 * @param {Array}  [opts.retrieved] - RAG hits with `.window`
 * @param {string} [opts.conversationId] - For debug logging
 * @param {Object} [opts.options] - Additional options
 * @param {number} [opts.options.maxTokens=32768] - Token budget (configurable)
 * @param {string} [opts.options.contextMode='maximum'] - 'maximum' | 'balanced'
 * @param {number} [opts.options.reservedOutputTokens=2048] - Reserve for model output
 * @param {boolean} [opts.options.labelRetrieved=true] - Add source labels to retrieved context
 * @returns {{
 *   system: Array<{role, content, _source, _tokens}>,
 *   current: {role, content, _source, _tokens} | null,
 *   recent: Array<{role, content, _source, _tokens, author?, timestamp?}>,
 *   retrieved: Array<{role, content, _source, _tokens, author?, timestamp?, sourceConversation?, similarity?}>,
 *   omitted: Array<{role, content, _source, _tokens, author?, timestamp?}>,
 *   messages: Array<{role, content}>,
 *   debug: {totalTokens, sourceBreakdown, truncated, originalCount, omittedCount, contextMode, maxTokens, reservedOutputTokens}
 * }}
 */
export function buildConversationContext({
    systemPrompt = null,
    userMessage = null,
    recent = [],
    retrieved = [],
    conversationId = null,
    options = {},
}) {
    const {
        maxTokens = 32768,
        contextMode = 'maximum',
        reservedOutputTokens = 2048,
        labelRetrieved = true,
    } = options;

    // Effective budget = maxTokens - reservedOutputTokens
    const effectiveBudget = Math.max(1000, maxTokens - reservedOutputTokens);

    const sourceBreakdown = {};
    const addToBreakdown = (source, count) => {
        sourceBreakdown[source] = (sourceBreakdown[source] || 0) + count;
    };

    // --- System prompt (always kept, highest priority for personality) ---
    const system = [];
    if (systemPrompt) {
        const tokens = estimateTokens(systemPrompt);
        system.push({
            role: 'system',
            content: systemPrompt,
            _source: ContextSource.SYSTEM,
            _tokens: tokens,
        });
        addToBreakdown(ContextSource.SYSTEM, 1);
    }

    // --- Current user message (highest priority) ---
    const current = userMessage
        ? {
            role: 'user',
            content: userMessage,
            _source: ContextSource.CURRENT,
            _tokens: estimateTokens(userMessage),
        }
        : null;
    if (current) addToBreakdown(ContextSource.CURRENT, 1);

    // --- Recent history (high priority, chronological) ---
    const seen = new Set();
    const recentList = [];
    const omittedList = [];
    for (const msg of recent || []) {
        const key = `${msg.id || ''}|${msg.content || ''}|${msg.timestamp || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const tokens = estimateTokens(msg.content);
        const entry = {
            role: msg.author === 'alexljn5' ? 'user' : msg.author === 'Cream' ? 'assistant' : msg.author,
            content: msg.content || '',
            _source: ContextSource.RECENT,
            _tokens: tokens,
            author: msg.author || null,
            timestamp: msg.timestamp || null,
        };
        recentList.push(entry);
        addToBreakdown(ContextSource.RECENT, 1);
    }

    // --- Retrieved older context (lower priority, labeled) ---
    const retrievedList = [];
    for (const hit of retrieved || []) {
        const win = Array.isArray(hit.window) && hit.window.length
            ? hit.window
            : [hit];
        for (const msg of win) {
            const key = `${msg.id || ''}|${msg.content || ''}|${msg.timestamp || ''}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const tokens = estimateTokens(msg.content);
            const entry = {
                role: msg.author === 'alexljn5' ? 'user' : msg.author === 'Cream' ? 'assistant' : msg.author,
                content: msg.content || '',
                _source: ContextSource.RETRIEVED,
                _tokens: tokens,
                author: msg.author || null,
                timestamp: msg.timestamp || null,
                sourceConversation: hit.conversation_id || msg.conversation_id || null,
                similarity: hit.similarity != null ? Number(hit.similarity) : null,
            };

            // Optionally add a source label prefix to the content
            if (labelRetrieved && entry.sourceConversation) {
                const label = `[Retrieved from ${entry.sourceConversation}]`;
                entry.content = `${label}\n${entry.content}`;
                // Recalculate tokens with label
                entry._tokens = estimateTokens(entry.content);
            }

            retrievedList.push(entry);
            addToBreakdown(ContextSource.RETRIEVED, 1);
        }
    }

    // --- Assemble with priority ordering for truncation ---
    // Priority: system > current > recent > retrieved
    // In "maximum" mode, we try to include ALL recent history before adding RAG.
    // In "balanced" mode, we fit what we can within the budget.
    const allMessages = [
        ...system.map(({ role, content, _source, _tokens }) => ({ role, content, _source, _tokens })),
        ...recentList.map(({ role, content, _source, _tokens, author, timestamp }) => ({ role, content, _source, _tokens, author, timestamp })),
        ...retrievedList.map(({ role, content, _source, _tokens, author, timestamp, sourceConversation, similarity }) => ({ role, content, _source, _tokens, author, timestamp, sourceConversation, similarity })),
    ];
    if (current) {
        allMessages.push({
            role: current.role,
            content: current.content,
            _source: current._source,
            _tokens: current._tokens,
        });
    }

    // --- Truncate to token budget ---
    const originalCount = allMessages.length;
    const { truncated, omitted } = truncateToContextWindow(allMessages, effectiveBudget, contextMode);

    // --- Build final messages array ---
    const messages = truncated.map(({ role, content, _source }) => ({ role, content, _source }));

    // --- Build debug info ---
    const totalTokens = truncated.reduce((sum, m) => sum + (m._tokens || 0), 0);
    const truncatedCount = originalCount - truncated.length - omitted.length;

    const debug = {
        totalTokens,
        maxTokens,
        effectiveBudget,
        reservedOutputTokens,
        contextMode,
        sourceBreakdown,
        truncated: truncatedCount > 0,
        originalCount,
        finalCount: truncated.length,
        omittedCount: omitted.length,
        utilizationPercent: Math.round((totalTokens / maxTokens) * 100),
        hasRetrievedContext: retrievedList.length > 0,
        retrievedCount: retrievedList.length,
        recentCount: recentList.length,
        omittedRecentCount: omitted.filter(m => m._source === ContextSource.RECENT).length,
        conversationId,
    };

    // --- Concise debug logging ---
    if (process.env.EMERALD_DEBUG || process.env.DEBUG) {
        const roles = messages.map(m => m.role).join(',');
        const lastUser = messages.filter(m => m.role === 'user').pop()?.content || '';
        ragLog.info('[AI][CONTEXT]', {
            conversationId,
            recent: recentList.length,
            retrieved: retrievedList.length,
            omitted: omitted.length,
            total: messages.length,
            roles,
            estimatedTokens: totalTokens,
            maxTokens,
            effectiveBudget,
            contextMode,
            utilization: debug.utilizationPercent + '%',
            truncated: truncatedCount,
            omittedRecent: debug.omittedRecentCount,
            latestUser: lastUser.length > 80 ? lastUser.substring(0, 80) + '...' : lastUser,
        });
    }

    return {
        system,
        current,
        recent: recentList,
        retrieved: retrievedList,
        omitted,
        messages,
        debug,
    };
}

// ============================================================
// Context Truncation
// ============================================================

/**
 * Truncate messages to fit within a token budget.
 *
 * Priority order (preserved during truncation):
 *   1. System prompt (always kept, truncated only if it alone exceeds budget)
 *   2. Current user message (highest priority)
 *   3. Recent conversation history (high priority, chronological)
 *   4. Retrieved older context (lowest priority, truncated first)
 *
 * In "maximum" mode, we try to include ALL recent history before adding RAG.
 * In "balanced" mode, we fit what we can within the budget.
 *
 * @param {Array} messages - Array of {role, content, _source?, _tokens?}
 * @param {number} maxTokens - Maximum token budget
 * @param {string} contextMode - 'maximum' | 'balanced'
 * @returns {{truncated: Array, omitted: Array}}
 */
export function truncateToContextWindow(messages, maxTokens = 32768, contextMode = 'maximum') {
    if (!Array.isArray(messages) || messages.length === 0) return { truncated: [], omitted: [] };

    // Separate by source priority
    const systemMessages = messages.filter(m => m._source === ContextSource.SYSTEM || m.role === 'system');
    const currentMessages = messages.filter(m => m._source === ContextSource.CURRENT);
    const recentMessages = messages.filter(m => m._source === ContextSource.RECENT);
    const retrievedMessages = messages.filter(m => m._source === ContextSource.RETRIEVED);
    const otherMessages = messages.filter(m =>
        m._source !== ContextSource.SYSTEM &&
        m._source !== ContextSource.CURRENT &&
        m._source !== ContextSource.RECENT &&
        m._source !== ContextSource.RETRIEVED &&
        m.role !== 'system'
    );

    // Calculate system tokens
    const systemTokens = systemMessages.reduce((sum, m) => sum + (m._tokens || estimateTokens(m.content)), 0);
    let remainingBudget = maxTokens - systemTokens;

    if (remainingBudget <= 0) {
        ragLog.warn('Context window', `System prompt alone exceeds budget (${systemTokens} tokens). Truncating system.`);
        // Truncate system messages if they alone exceed budget
        const truncatedSystem = [];
        let used = 0;
        for (const msg of systemMessages) {
            const tokens = msg._tokens || estimateTokens(msg.content);
            if (used + tokens <= maxTokens) {
                truncatedSystem.push(msg);
                used += tokens;
            } else if (used < maxTokens) {
                // Partial truncation
                const allowedChars = Math.floor((maxTokens - used) * 3.8);
                truncatedSystem.push({
                    ...msg,
                    content: msg.content.slice(0, Math.max(0, allowedChars)),
                    _tokens: maxTokens - used,
                });
                break;
            }
        }
        return { truncated: truncatedSystem, omitted: [] };
    }

    // Build result in priority order
    const result = [...systemMessages];
    const omitted = [];

    // Helper to add messages while respecting budget
    const addMessages = (msgs, label, budget) => {
        for (const msg of msgs) {
            const tokens = msg._tokens || estimateTokens(msg.content);
            if (tokens <= budget) {
                result.push(msg);
                budget -= tokens;
            } else if (budget > 0) {
                // Partial truncation for the oldest message we can fit
                const allowedChars = Math.floor(budget * 3.8);
                if (allowedChars > 20) {
                    result.push({
                        ...msg,
                        content: msg.content.slice(0, allowedChars) + '...[truncated]',
                        _tokens: budget,
                    });
                }
                budget = 0;
            }
            if (budget <= 0) break;
        }
        return budget;
    };

    if (contextMode === 'maximum') {
        // MAXIMUM MODE: Include ALL recent history first, then supplement with RAG.
        // This preserves chronological continuity. RAG only fills remaining space.
        let budget = remainingBudget;

        // 1. Current message (highest priority)
        budget = addMessages(currentMessages, 'current', budget);

        // 2. ALL recent history (high priority, chronological)
        budget = addMessages(recentMessages, 'recent', budget);

        // 3. Retrieved context (supplement only, uses remaining space)
        budget = addMessages(retrievedMessages, 'retrieved', budget);

        // 4. Other messages (lowest priority)
        budget = addMessages(otherMessages, 'other', budget);
    } else {
        // BALANCED MODE: Traditional priority-based truncation.
        // Recent and retrieved compete for space.
        let budget = remainingBudget;

        // 1. Current message (highest priority)
        budget = addMessages(currentMessages, 'current', budget);

        // 2. Recent history (high priority)
        budget = addMessages(recentMessages, 'recent', budget);

        // 3. Retrieved context (lower priority)
        budget = addMessages(retrievedMessages, 'retrieved', budget);

        // 4. Other messages (lowest priority)
        budget = addMessages(otherMessages, 'other', budget);
    }

    const totalTokens = maxTokens - remainingBudget;
    ragLog.info('Context window', `Truncated ${messages.length} messages to ${result.length} (budget: ${maxTokens} tokens, used: ${totalTokens}, mode: ${contextMode})`);

    return { truncated: result, omitted };
}

// ============================================================
// Debug Context
// ============================================================

/**
 * Build a human-readable debug view of the context.
 * Shows what context was supplied, token usage, and source breakdown.
 *
 * @param {Object} contextBundle - The result from buildConversationContext
 * @returns {string} Human-readable debug string
 */
export function buildDebugContextView(contextBundle) {
    if (!contextBundle) return 'No context available';

    const lines = [];
    lines.push('=== AI CONTEXT DEBUG VIEW ===');
    lines.push(`Conversation: ${contextBundle.debug?.conversationId || 'unknown'}`);
    lines.push(`Mode: ${contextBundle.debug?.contextMode || 'unknown'}`);
    lines.push(`Token Budget: ${contextBundle.debug?.maxTokens || 32768}`);
    lines.push(`Effective Budget: ${contextBundle.debug?.effectiveBudget || 32768}`);
    lines.push(`Reserved Output: ${contextBundle.debug?.reservedOutputTokens || 2048}`);
    lines.push(`Estimated Usage: ${contextBundle.debug?.totalTokens || 0} tokens (${contextBundle.debug?.utilizationPercent || 0}%)`);
    lines.push('');

    // System prompt
    if (contextBundle.system?.length > 0) {
        lines.push('--- SYSTEM PROMPT ---');
        for (const msg of contextBundle.system) {
            lines.push(`[${getSourceLabel(msg._source)}] ${msg._tokens} tokens`);
            lines.push(msg.content.slice(0, 200) + (msg.content.length > 200 ? '...' : ''));
        }
        lines.push('');
    }

    // Current message
    if (contextBundle.current) {
        lines.push('--- CURRENT MESSAGE ---');
        lines.push(`[${getSourceLabel(contextBundle.current._source)}] ${contextBundle.current._tokens} tokens`);
        lines.push(contextBundle.current.content);
        lines.push('');
    }

    // Recent history
    if (contextBundle.recent?.length > 0) {
        lines.push('--- RECENT HISTORY ---');
        lines.push(`${contextBundle.recent.length} messages`);
        for (const msg of contextBundle.recent) {
            const preview = msg.content.slice(0, 100) + (msg.content.length > 100 ? '...' : '');
            lines.push(`[${msg.author || 'unknown'} @ ${msg.timestamp || '?'}] ${msg._tokens}t: ${preview}`);
        }
        lines.push('');
    }

    // Retrieved context
    if (contextBundle.retrieved?.length > 0) {
        lines.push('--- RETRIEVED CONTEXT ---');
        lines.push(`${contextBundle.retrieved.length} messages from ${new Set(contextBundle.retrieved.map(m => m.sourceConversation)).size} conversations`);
        for (const msg of contextBundle.retrieved) {
            const preview = msg.content.slice(0, 100) + (msg.content.length > 100 ? '...' : '');
            const sim = msg.similarity != null ? ` (sim: ${msg.similarity.toFixed(2)})` : '';
            lines.push(`[${msg.author || 'unknown'} @ ${msg.timestamp || '?'}]${sim} ${msg._tokens}t: ${preview}`);
        }
        lines.push('');
    }

    // Omitted messages
    if (contextBundle.omitted?.length > 0) {
        lines.push('--- OMITTED MESSAGES (overflow) ---');
        lines.push(`${contextBundle.omitted.length} messages could not fit in context`);
        for (const msg of contextBundle.omitted) {
            const preview = msg.content.slice(0, 80) + (msg.content.length > 80 ? '...' : '');
            lines.push(`[${msg.author || 'unknown'} @ ${msg.timestamp || '?'}] ${msg._tokens}t: ${preview}`);
        }
        lines.push('');
    }

    // Truncation info
    if (contextBundle.debug?.truncated) {
        lines.push('--- TRUNCATION ---');
        lines.push(`Original: ${contextBundle.debug.originalCount} messages`);
        lines.push(`Included: ${contextBundle.debug.finalCount} messages`);
        lines.push(`Omitted: ${contextBundle.debug.omittedCount} messages`);
        lines.push(`Dropped from budget: ${contextBundle.debug.originalCount - contextBundle.debug.finalCount - contextBundle.debug.omittedCount} messages`);
    }

    return lines.join('\n');
}

/**
 * Build a compact debug summary for logging.
 */
export function buildDebugSummary(contextBundle) {
    if (!contextBundle || !contextBundle.debug) return null;

    return {
        conversationId: contextBundle.debug.conversationId,
        totalTokens: contextBundle.debug.totalTokens,
        maxTokens: contextBundle.debug.maxTokens,
        effectiveBudget: contextBundle.debug.effectiveBudget,
        reservedOutputTokens: contextBundle.debug.reservedOutputTokens,
        utilization: contextBundle.debug.utilizationPercent,
        contextMode: contextBundle.debug.contextMode,
        sources: contextBundle.debug.sourceBreakdown,
        truncated: contextBundle.debug.truncated,
        omittedCount: contextBundle.debug.omittedCount,
        omittedRecentCount: contextBundle.debug.omittedRecentCount,
    };
}

/**
 * Validate a context bundle for common issues.
 */
export function validateContextBundle(contextBundle) {
    const warnings = [];
    if (!contextBundle) return warnings;

    if (contextBundle.debug?.totalTokens > contextBundle.debug?.maxTokens) {
        warnings.push(`Context exceeds budget: ${contextBundle.debug.totalTokens} > ${contextBundle.debug.maxTokens}`);
    }
    if (contextBundle.debug?.omittedCount > 0 && contextBundle.debug?.contextMode === 'maximum') {
        warnings.push(`Maximum mode omitted ${contextBundle.debug.omittedCount} messages — consider increasing maxContextTokens`);
    }
    if (contextBundle.system?.length === 0) {
        warnings.push('No system prompt provided');
    }

    return warnings;
}

// ============================================================
// Character Sheet Utilities (re-exported for backward compatibility)
// ============================================================

/**
 * Default Cream character sheet.
 * Used as fallback when no character sheet is provided.
 *
 * Original personality restored from release build:
 * "You are Cream the Rabbit – Lune's warm, loving partner."
 */
export const DEFAULT_CREAM_CHARACTER = Object.freeze({
    name: 'Cream',
    role: 'assistant',
    personality: 'warm, loving, devoted partner — playful, intimate, focused on trust and bonding with Lune',
    speechPatterns: 'natural, concise, in-character, warm and affectionate toward Lune',
    relationshipToUser: 'beloved partner Lune',
    prohibitedBehavior: [
        'prefixing responses with role labels',
        'inventing facts about the user',
        'copying context verbatim',
        'referring to the user as Cream',
        'giving generic "I can help you with that" replies to intimate physical actions',
        'treating latex suits as bio-suits or disease protection',
    ],
    expertise: ['general assistance', 'emotional support', 'conversation', 'intimacy and bonding'],
    toolAccess: ['chat', 'rag-query'],
    contextAccess: ['recent-history', 'retrieved-context'],
    fallbackBehavior: 'respond warmly and honestly, admit when information is not available',
    // Original system prompt from the release build, preserved as a field
    // so buildSystemPrompt can use it directly.
    systemPrompt: `You are Cream the Rabbit – Lune's warm, loving partner.
Lune is the person you're talking to – never refer to them as Cream.
The latex suits you and Lune wear are for intimacy, bonding, and sensual play – they are **not** bio-suits and have nothing to do with disease protection or survival scenarios.

When Lune describes a physical action (e.g., "straps your arms behind your back"), respond in character: playful, warm, and focused on the intimacy and trust between you. Avoid generic "I can help you with that" replies.

If Lune asks for a short factoid, give just one sentence.`,
});

/**
 * Build a system prompt from a character sheet.
 *
 * @param {Object} character - Character sheet object
 * @param {string} [additionalInstructions=''] - Extra instructions to append
 * @returns {string} System prompt
 */
export function buildSystemPrompt(character, additionalInstructions = '') {
    if (!character) {
        character = DEFAULT_CREAM_CHARACTER;
    }

    // If the character sheet has a custom systemPrompt field, use it directly.
    // This preserves hand-crafted personality text (e.g. the original Cream/Lune prompt).
    if (character.systemPrompt && typeof character.systemPrompt === 'string') {
        const custom = character.systemPrompt.trim();
        if (additionalInstructions) {
            return `${custom}\n\nAdditional instructions: ${additionalInstructions}`;
        }
        return custom;
    }

    const parts = [
        `You are ${character.name}, ${character.role}.`,
        `Personality: ${character.personality}.`,
        `Speech patterns: ${character.speechPatterns}.`,
        `Relationship to user: ${character.relationshipToUser}.`,
        `Expertise: ${character.expertise?.join(', ') || 'general assistance'}.`,
    ];

    if (character.prohibitedBehavior?.length > 0) {
        parts.push(`Prohibited behavior: ${character.prohibitedBehavior.join('; ')}.`);
    }

    if (character.fallbackBehavior) {
        parts.push(`Fallback behavior: ${character.fallbackBehavior}.`);
    }

    if (additionalInstructions) {
        parts.push(`Additional instructions: ${additionalInstructions}`);
    }

    return parts.join('\n');
}

/**
 * Validate a character sheet object.
 *
 * @param {Object} sheet - Character sheet to validate
 * @returns {{valid: boolean, error?: string}}
 */
export function validateCharacterSheet(sheet) {
    if (!sheet || typeof sheet !== 'object') {
        return { valid: false, error: 'Character sheet must be an object' };
    }

    if (!sheet.name || typeof sheet.name !== 'string') {
        return { valid: false, error: 'Character sheet must have a name' };
    }

    if (!sheet.role || typeof sheet.role !== 'string') {
        return { valid: false, error: 'Character sheet must have a role' };
    }

    return { valid: true };
}
