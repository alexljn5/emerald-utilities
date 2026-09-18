/**
 * RAG Query Service
 * Query Grok messages using vector similarity for context retrieval
 *
 * Usage: node src/database/rag-query.js "your query here"
 */
import { safeStorage } from 'electron';
import { config as loadDotenv } from 'dotenv';
import fsPromises from 'fs/promises';
import { pool } from './db-pool.js';
import { resolveDatabasePath, resolveEnvPath } from '../utils/pathResolver.js';
import { ragLog, ollamaLog, configLog } from '../utils/logger.js';
import { LOCAL_AI_ENABLED } from '../globals.js';
import { normalizeModelResponse } from './response-normalizer.js';
import {
    buildConversationContext,
    buildSystemPrompt,
    DEFAULT_CREAM_CHARACTER,
    estimateTokens,
    estimateContextTokens,
    ContextSource,
    validateContextBundle,
    buildDebugContextView,
    buildDebugSummary,
    validateCharacterSheet,
} from './ai-context.js';

// Load .env so OLLAMA_HOST / model overrides are available.
// Single source of truth: src/.env (dev) / <resources>/.env (prod).
// override:true so our .env WINS over any pre-existing machine env var
// (e.g. Ollama's Windows installer exports OLLAMA_HOST=http://localhost:11434,
// which would otherwise hijack the remote-server config).
loadDotenv({ path: resolveEnvPath(), override: true });

// Load configuration from JSON file
// In production, resolves to process.resourcesPath/database/config.json
// In development, resolves to src/database/config.json
const configPath = resolveDatabasePath('config.json');
let config;
try {
    const raw = await fsPromises.readFile(configPath, 'utf8');
    config = JSON.parse(raw);
} catch (err) {
    configLog.error('load-config', err, `Expected config at ${configPath}`);
    throw new Error(`Configuration file not found at ${configPath}`);
}

// Decrypt sensitive values if safeStorage is available
function decryptIfNeeded(value) {
    if (typeof value !== 'string' || !value.startsWith('encrypted:')) {
        return value;
    }
    if (!safeStorage.isEncryptionAvailable()) {
        configLog.warn('safeStorage is not available. Returning encrypted value as-is.');
        return value;
    }
    try {
        const base64 = value.slice('encrypted:'.length);
        const buffer = Buffer.from(base64, 'base64');
        return safeStorage.decryptString(buffer);
    } catch (err) {
        configLog.error('decrypt-value', err, 'Returning encrypted value unchanged');
        return value;
    }
}

function decryptConfig(configObj) {
    if (!configObj || typeof configObj !== 'object') return configObj;
    const decrypted = { ...configObj };
    for (const key of Object.keys(decrypted)) {
        if (typeof decrypted[key] === 'string') {
            decrypted[key] = decryptIfNeeded(decrypted[key]);
        } else if (typeof decrypted[key] === 'object' && decrypted[key] !== null) {
            decrypted[key] = decryptConfig(decrypted[key]);
        }
    }
    return decrypted;
}

config = decryptConfig(config);

// AI Provider configuration
const AI_PROVIDER = config.aiProvider || 'ollama';

function getAIConfig() {
    const providerConfig = config.providers?.[AI_PROVIDER];
    if (!providerConfig) {
        throw new Error(`Unknown AI provider: ${AI_PROVIDER}`);
    }

    switch (AI_PROVIDER) {
        case 'grok':
            return {
                apiKey: providerConfig.apiKey,
                embeddingEndpoint: providerConfig.embeddingEndpoint || 'https://api.x.ai/v1/embeddings',
                embeddingModel: providerConfig.embeddingModel || 'text-embedding-3',
                chatEndpoint: providerConfig.chatEndpoint || 'https://api.x.ai/v1/chat/completions',
                chatModel: providerConfig.chatModel || 'grok-2-latest',
            };
        case 'openai':
            return {
                apiKey: providerConfig.apiKey,
                embeddingEndpoint: providerConfig.embeddingEndpoint || 'https://api.openai.com/v1/embeddings',
                embeddingModel: providerConfig.embeddingModel || 'text-embedding-3-small',
                chatEndpoint: providerConfig.chatEndpoint || 'https://api.openai.com/v1/chat/completions',
                chatModel: providerConfig.chatModel || 'gpt-4o-mini',
            };
        case 'ollama': {
            // ENV overrides config.json overrides hardcoded default.
            const ollamaHost = process.env.OLLAMA_HOST || providerConfig.host || 'http://localhost:11434';
            ollamaLog.info(
                `host resolved to ${ollamaHost} ` +
                `(env OLLAMA_HOST=${process.env.OLLAMA_HOST ?? '<unset>'}, ` +
                `config.host=${providerConfig.host ?? '<unset>'})`
            );
            return {
                apiKey: null,
                embeddingEndpoint: `${ollamaHost}/api/embed`,
                embeddingModel: process.env.OLLAMA_EMBED_MODEL || providerConfig.embeddingModel || 'nomic-embed-text',
                chatEndpoint: `${ollamaHost}/api/chat`,
                chatModel: process.env.OLLAMA_CHAT_MODEL || providerConfig.chatModel || 'llama2-uncensored',
                contextWindow: providerConfig.contextWindow || null,
            };
        }
        case 'lmstudio':
            return {
                apiKey: null,
                embeddingEndpoint: `${providerConfig.host || 'http://localhost:1234'}/v1/embeddings`,
                embeddingModel: providerConfig.embeddingModel || 'text-embedding-nomic',
                chatEndpoint: `${providerConfig.host || 'http://localhost:1234'}/v1/chat/completions`,
                chatModel: providerConfig.chatModel || 'llama-3.2-3b-instruct',
            };
        default:
            throw new Error(`Unknown AI provider: ${AI_PROVIDER}`);
    }
}

const aiConfig = getAIConfig();

// One-time startup diagnostics (no secrets logged).
ragLog.info(
    `AI provider=${AI_PROVIDER} | embed endpoint=${aiConfig.embeddingEndpoint} | ` +
    `embed model=${aiConfig.embeddingModel} | chat endpoint=${aiConfig.chatEndpoint} | ` +
    `chat model=${aiConfig.chatModel}`
);

/**
 * POST JSON to a URL with an explicit timeout and verbose error logging.
 * Uses `Connection: close` to sidestep undici keep-alive resets that can
 * surface as ECONNRESET when talking to Ollama from Electron's Node.
 */
async function postJson(url, bodyObj, { apiKey = null, timeoutMs = 60000, label = 'request', retries = 2 } = {}) {
    const headers = {
        'Content-Type': 'application/json',
        // Ask the server not to keep the socket alive. undici treats
        // `Connection` as a forbidden header and ignores it, but harmless.
        'Connection': 'close',
    };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    ollamaLog.debug(`--> POST ${url} (${label}) body keys: ${Object.keys(bodyObj).join(', ')}`);

    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(bodyObj),
                signal: controller.signal,
                // Disable keep-alive so undici opens a fresh socket each time.
                keepalive: false,
            });
            clearTimeout(timer);

            ollamaLog.debug(`<-- POST ${url} (${label}) status: ${response.status} ${response.statusText} (attempt ${attempt})`);

            if (!response.ok) {
                const errText = await response.text().catch(() => '<no body>');
                ollamaLog.error(label, `${response.status} ${response.statusText} - ${errText.slice(0, 500)}`);
                throw new Error(`${label} API error: ${response.status} ${response.statusText} - ${errText}`);
            }
            return await response.json();
        } catch (err) {
            clearTimeout(timer);
            lastErr = err;
            const causeCode = err?.cause?.code || err?.cause?.message || '';
            const isReset = /ECONNRESET|UND_ERR|other side closed|socket hang up/i.test(
                `${err.message} ${causeCode}`
            );
            ollamaLog.error(
                `${label} (attempt ${attempt}/${retries})`,
                err,
                isReset && attempt < retries ? 'transient reset, will retry' : undefined
            );
            // Retry on transient connection resets AND aborts (timeout);
            // rethrow HTTP errors and other non-transient failures.
            const isAbort = /aborted|abort|timeout/i.test(`${err.message} ${causeCode}`);
            if ((!isReset && !isAbort) || attempt === retries) throw err;
            const reason = isAbort ? 'timeout/abort' : 'connection reset';
            await new Promise(r => setTimeout(r, 300 * attempt));
            ollamaLog.warn(`retrying ${label} after ${reason}...`);
        }
    }
    throw lastErr;
}

/**
 * Generate embedding for text using the configured AI provider.
 *
 * For Ollama, tries the modern /api/embed (uses "input") first, then falls
 * back to the legacy /api/embeddings (uses "prompt") if the endpoint is
 * missing (404). This keeps compatibility across Ollama versions without
 * changing DB logic or re-embedding stored data.
 */
async function generateEmbedding(text) {
    if (AI_PROVIDER === 'ollama') {
        const base = aiConfig.embeddingEndpoint.replace(/\/api\/embed$/, '');
        // 1) Modern endpoint: POST /api/embed { model, input } -> { embeddings: [[...]] }
        try {
            const data = await postJson(`${base}/api/embed`, {
                model: aiConfig.embeddingModel,
                input: text,
            }, { label: 'ollama-embed' });
            const embedding = data.embeddings?.[0];
            if (Array.isArray(embedding) && embedding.length > 0) return embedding;
            ollamaLog.warn('/api/embed returned no embeddings, trying legacy /api/embeddings...');
        } catch (err) {
            // Only fall back on a clear 404 (endpoint absent); rethrow real
            // network errors so they are visible.
            if (!/404/.test(err.message)) throw err;
            ollamaLog.warn('/api/embed not found (404), trying legacy /api/embeddings...');
        }

        // 2) Legacy endpoint: POST /api/embeddings { model, prompt } -> { embedding: [...] }
        const legacy = await postJson(`${base}/api/embeddings`, {
            model: aiConfig.embeddingModel,
            prompt: text,
        }, { label: 'ollama-embeddings-legacy' });
        const embedding = legacy.embedding || legacy.embeddings?.[0];
        if (!Array.isArray(embedding) || embedding.length === 0) {
            throw new Error('Invalid embedding received from Ollama (both endpoints).');
        }
        return embedding;
    }

    // Non-Ollama providers (OpenAI/Grok style)
    const data = await postJson(aiConfig.embeddingEndpoint, {
        model: aiConfig.embeddingModel,
        input: text,
    }, { apiKey: aiConfig.apiKey, label: `${AI_PROVIDER}-embed` });

    const embedding = data.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new Error(`Invalid embedding received from ${AI_PROVIDER}`);
    }
    return embedding;
}

/**
 * Query RAG for similar messages
 */
async function queryRAG(userQuery, topK = 10) {
    ragLog.info(`Generating embedding for query: "${userQuery}"`);
    const queryEmbedding = await generateEmbedding(userQuery);
    ragLog.info(`Finding top ${topK} similar messages...`);

    // Format embedding as PostgreSQL vector string
    const embeddingString = `[${queryEmbedding.join(',')}]`;

    const result = await pool.query(`
        SELECT
            id,
            conversation_id,
            content,
            author,
            timestamp,
            1 - (embedding <=> $1::vector) AS similarity
        FROM grok_messages
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT $2
    `, [embeddingString, topK]);

    return result.rows;
}

/**
 * Assemble context from similar messages
 */
function assembleContext(similarMessages) {
    return similarMessages
        .map(msg => `[${msg.author} @ ${msg.timestamp}, similarity: ${msg.similarity.toFixed(2)}] ${msg.content}`)
        .join('\n\n');
}

/**
 * Query RAG for similar messages, but return each hit WITH its surrounding
 * conversational turns so isolated messages are not ambiguous.
 *
 * This solves the "hug then 'what are we doing?'" problem: a single retrieved
 * message ("I hug you.") is nearly useless on its own, but the 3-5 messages
 * around it make the interaction clear.
 *
 * @param {string} userQuery
 * @param {number} topK number of embedding matches to seed context
 * @param {number} neighbors how many messages to include around each hit (default 2 each side)
 * @param {string} [conversationId] - If provided, restrict seeds to this conversation
 * @returns {Promise<Array<{id, conversation_id, content, author, timestamp, similarity, role, window}>}
 */
async function queryRAGWithContext(userQuery, topK = 8, neighbors = 2, conversationId = null) {
    const queryEmbedding = await generateEmbedding(userQuery);
    const embeddingString = `[${queryEmbedding.join(',')}]`;

    // 1) Find the most similar messages (seeds).
    //    If conversationId is provided, restrict to that conversation to prevent
    //    cross-conversation contamination. Otherwise search all messages.
    let seeds;
    if (conversationId) {
        seeds = await pool.query(`
            SELECT
                id,
                conversation_id,
                content,
                author,
                timestamp,
                1 - (embedding <=> $1::vector) AS similarity
            FROM grok_messages
            WHERE embedding IS NOT NULL
              AND conversation_id = $3
            ORDER BY embedding <=> $1::vector
            LIMIT $2
        `, [embeddingString, topK, conversationId]);
    } else {
        seeds = await pool.query(`
            SELECT
                id,
                conversation_id,
                content,
                author,
                timestamp,
                1 - (embedding <=> $1::vector) AS similarity
            FROM grok_messages
            WHERE embedding IS NOT NULL
            ORDER BY embedding <=> $1::vector
            LIMIT $2
        `, [embeddingString, topK]);
    }

    if (seeds.rows.length === 0) return [];

    // 2) For each seed, fetch a window of surrounding messages (chronological)
    //    so the retrieved context is not an isolated fragment.
    const results = [];
    for (const seed of seeds.rows) {
        const before = await pool.query(`
            SELECT id, conversation_id, content, author, timestamp
            FROM grok_messages
            WHERE conversation_id = $1
              AND (timestamp < $2 OR (timestamp = $2 AND id < $3))
            ORDER BY timestamp DESC, id DESC
            LIMIT $4
        `, [seed.conversation_id, seed.timestamp, seed.id, neighbors]);

        const after = await pool.query(`
            SELECT id, conversation_id, content, author, timestamp
            FROM grok_messages
            WHERE conversation_id = $1
              AND (timestamp > $2 OR (timestamp = $2 AND id > $3))
            ORDER BY timestamp ASC, id ASC
            LIMIT $4
        `, [seed.conversation_id, seed.timestamp, seed.id, neighbors]);

        const window = [
            ...before.rows.reverse(),
            {
                id: seed.id,
                conversation_id: seed.conversation_id,
                content: seed.content,
                author: seed.author,
                timestamp: seed.timestamp,
                _seed: true,
            },
            ...after.rows,
        ];

        results.push({
            id: seed.id,
            conversation_id: seed.conversation_id,
            content: seed.content,
            author: seed.author,
            timestamp: seed.timestamp,
            similarity: Number(seed.similarity),
            role: seed.author === 'emerald-user' ? 'user' : seed.author === 'Cream' ? 'assistant' : seed.author,
            window,
        });
    }

    return results;
}

// Token estimation and context truncation are now handled by ai-context.js

/**
 * Query LLM with conversation context.
 *
 * Supports two signatures for backward compatibility:
 *   NEW:  queryWithLLM(messagesArray, conversationId, options)
 *         messagesArray = [{role, content}, ...] from buildConversationContext()
 *   OLD:  queryWithLLM(userQuery, contextString, similarMessages)
 *         Used by CLI (rag-query.js main()).
 *
 * @param {Array|string} messagesOrQuery
 * @param {string} [conversationIdOrContext]
 * @param {Array} [similarMessages]
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=120000] - Overall timeout for the LLM call
 * @param {boolean} [options.useCharacterSheet=true] - Use character sheet for system prompt
 * @param {Object} [options.characterSheet] - Custom character sheet
 * @param {string} [options.fallbackResponse] - Fallback if LLM fails
 * @returns {Promise<string>} AI response
 */
async function queryWithLLM(messagesOrQuery, conversationIdOrContext, similarMessages, options = {}) {
    const {
        timeoutMs = 120000,
        useCharacterSheet = true,
        characterSheet = null,
        fallbackResponse = "I'm having trouble connecting right now. Could you try again in a moment? ♡",
    } = options;

    // --- Detect signature ---
    const isNewSignature = Array.isArray(messagesOrQuery);
    let messages, userQuery, context, similar;

    if (isNewSignature) {
        // NEW: messagesArray, conversationId
        messages = messagesOrQuery;
        userQuery = ''; // Will extract from messages
        context = '';
        similar = [];
    } else {
        // OLD: userQuery, contextString, similarMessages (CLI mode)
        userQuery = messagesOrQuery;
        context = conversationIdOrContext || '';
        similar = similarMessages || [];
    }

    // --- 0. Local AI gate ---
    if (!LOCAL_AI_ENABLED && AI_PROVIDER === 'ollama') {
        throw new Error('Local AI is disabled. Set LOCAL_AI_ENABLED=true or use a remote AI provider.');
    }

    // --- 1. Identity detection (configurable via character sheet) ---
    const queryText = isNewSignature
        ? messages.filter(m => m.role === 'user').pop()?.content || ''
        : userQuery;
    const lowerQuery = queryText.toLowerCase();

    // Use character sheet for identity if available, otherwise use defaults
    const character = useCharacterSheet
        ? (characterSheet || DEFAULT_CREAM_CHARACTER)
        : null;
    const userName = character?.relationshipToUser?.split(' ').pop() || 'Lune';
    const aiName = character?.name || 'Cream';

    const isAskingWhoAmI = /\bwho am i\b|\bwhat('s| is) my name\b|\bwho is (lune|you)\b/.test(lowerQuery);
    const isAskingWhoAreYou = /\bwho are you\b|\bwhat('s| is) your name\b|\bidentify yourself\b|\btell me about yourself\b/.test(lowerQuery);

    if (isAskingWhoAmI || isAskingWhoAreYou) {
        if (isAskingWhoAmI) {
            return `You're ${userName}, my beloved partner. I'm ${aiName} – your warm, devoted bunny. ♡`;
        } else if (isAskingWhoAreYou) {
            return `I'm ${aiName} the Rabbit – your loving partner, always here for you, ${userName}. ♡`;
        }
        return `You are ${userName}, and I am ${aiName} – your devoted partner. ♡`;
    }

    // --- 2. Check relevance of context (OLD signature only) ---
    const topSimilarity = Math.max(...similar.map(m => m.similarity || 0), 0);
    const hasRelevantContext = topSimilarity > 0.5;

    // --- 3. Check for factoid/short request ---
    const wantsFactoid = /(give me|tell me|just)\s+(only\s+)?(a\s+)?factoid?/i.test(queryText);
    const wantsShort = wantsFactoid || /^(just|only)\s+(a\s+)?(quick|short)/i.test(queryText);

    // --- 4. System prompt (from character sheet) ---
    const systemPrompt = buildSystemPrompt(character);

    // --- 5. Build messages for the API ---
    let apiMessages;
    let contextDebug = null;

    if (isNewSignature) {
        // NEW: Use the full conversation context array directly.
        // The messages already have _source metadata from buildConversationContext
        // in the caller (ipcHandlers.js). Do NOT rebuild/truncate here — that
        // would double-truncate an already-assembled context.
        const hasSystem = messages.some(m => m.role === 'system');

        if (!hasSystem) {
            // Prepend system prompt
            const systemMsg = { role: 'system', content: systemPrompt, _source: ContextSource.SYSTEM };
            messages = [systemMsg, ...messages];
        }

        // Use messages directly — context assembly happened in the caller.
        // Strip _source metadata before sending to API (LLM APIs ignore extra fields,
        // but keeping the array clean is safer).
        apiMessages = messages.map(({ role, content, _source }) => ({ role, content }));

        // Build debug summary from the existing context metadata
        const totalTokens = estimateContextTokens(apiMessages);
        contextDebug = {
            totalTokens,
            maxTokens: 32768,
            utilization: Math.round((totalTokens / 32768) * 100),
            sources: {
                system: messages.filter(m => m.role === 'system').length,
                recent: messages.filter(m => m._source === ContextSource.RECENT).length,
                retrieved: messages.filter(m => m._source === ContextSource.RETRIEVED).length,
                current: messages.filter(m => m._source === ContextSource.CURRENT).length,
            },
            truncated: false,
        };
    } else {
        // OLD: Build from context string (CLI mode)
        // Include only the LAST message from context, not the full conversation.
        // This gives the model enough context to understand what was just said
        // without making it repeat the entire conversation history.
        let userPrompt;
        if (hasRelevantContext && context) {
            userPrompt = `Relevant conversation history (for reference only, DO NOT COPY IT):\n${context}\n\nNow ${userName} says: "${userQuery}"\n\nRespond as ${aiName} directly to ${userName}. Use the context to inform your answer but do not repeat any part of it. If the context is not about the same topic, ignore it completely. ${wantsShort ? 'Keep it very short.' : ''}`;
        } else if (context) {
            // context here is the recent history from ipcHandlers.js.
            // Present it as REFERENCE ONLY, with strong anti-serialization
            // instructions to prevent the model from treating it as a
            // transcript and continuing/reproducing it.
            userPrompt = `${context}

=== ABOVE IS HISTORY FOR REFERENCE ONLY ===
DO NOT repeat it. DO NOT continue it. DO NOT write "Cream:" or "Lune:" labels.

NOW ${userName}'S CURRENT MESSAGE IS:
"${userQuery}"

Respond as ${aiName} directly to ${userName}. Answer the CURRENT message only.
Do not repeat previous messages. Do not write role labels. Do not quote the user back.
${wantsShort ? 'Keep it very short.' : ''}`;
        } else {
            userPrompt = `${userName} says: "${userQuery}"\n\nRespond as ${aiName} with a warm, natural answer. Do not invent anything about ${userName}'s day. ${wantsShort ? 'Keep it very short.' : ''}`;
        }

        apiMessages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ];
    }

    // --- 6. Debug logging ---
    if (process.env.EMERALD_DEBUG || process.env.DEBUG) {
        const totalTokens = estimateContextTokens(apiMessages);
        const recentCount = apiMessages.filter(m => m.role === 'user' || m.role === 'assistant').length;
        const lastRoles = apiMessages.slice(-6).map(m => m.role).join(',');
        const lastUserContent = apiMessages.filter(m => m.role === 'user').pop()?.content || '';

        ragLog.info('[AI][CONTEXT]', {
            conversationId: conversationIdOrContext,
            messageCount: apiMessages.length,
            recentTurns: recentCount,
            roles: lastRoles,
            estimatedTokens: totalTokens,
            latestUser: lastUserContent.length > 80 ? lastUserContent.substring(0, 80) + '...' : lastUserContent,
            contextDebug,
        });
    }

    // --- 7. Call the API with timeout ---
    const temperature = wantsShort ? 0.4 : 0.85;

    // Build Ollama-specific options if applicable
    const ollamaOptions = {};
    if (AI_PROVIDER === 'ollama') {
        // Use configured context window if available, otherwise let Ollama use model default
        const ctxWindow = config.providers?.ollama?.contextWindow;
        if (ctxWindow && ctxWindow > 0) {
            ollamaOptions.num_ctx = ctxWindow;
        }
        // Adaptive num_predict: short requests don't need 4096 tokens,
        // and a huge budget can cause the model to ramble or time out.
        // Estimate based on user query length — most responses are <200 tokens.
        const queryLen = queryText?.length || 50;
        const estimatedMax = Math.max(256, Math.min(1024, Math.ceil(queryLen * 4) + 200));
        ollamaOptions.num_predict = estimatedMax;
    }

    const chatBody = {
        model: aiConfig.chatModel,
        messages: apiMessages,
        stream: false,
        temperature,
        ...(Object.keys(ollamaOptions).length > 0 ? { options: ollamaOptions } : {}),
    };

    // Diagnostic: log the actual payload sent to Ollama.
    // This helps identify recursive dialogue contamination.
    if (process.env.EMERALD_DEBUG || process.env.DEBUG) {
        ragLog.info('[RAG] FINAL OLLAMA PAYLOAD:');
        ragLog.info('[RAG] payload messages:', JSON.stringify(apiMessages, null, 2));
        ragLog.info(`[RAG] payload messageCount: ${apiMessages.length}`);
        ragLog.info(`[RAG] payload systemPromptLength: ${apiMessages.find(m => m.role === 'system')?.content?.length || 0}`);
    }

    // --- Diagnostic logging ---
    const systemPromptContent = apiMessages.find(m => m.role === 'system')?.content || '';
    const systemPromptPreview = systemPromptContent.length > 120
        ? systemPromptContent.substring(0, 120) + '...'
        : systemPromptContent;
    ragLog.info('queryWithLLM', 'LLM request diagnostics', {
        provider: AI_PROVIDER,
        model: aiConfig.chatModel,
        endpoint: aiConfig.chatEndpoint,
        messageCount: apiMessages.length,
        systemPromptLength: systemPromptContent.length,
        systemPromptPreview,
        estimatedTokens: estimateContextTokens(apiMessages),
        temperature,
        options: ollamaOptions,
        hasSystemPrompt: systemPromptContent.length > 0,
    });

    try {
        const data = await postJson(aiConfig.chatEndpoint, chatBody, {
            apiKey: aiConfig.apiKey,
            timeoutMs,
            label: `${AI_PROVIDER}-chat`,
        });

        // --- 8. Validate response ---
        let rawAnswer;
        let responseMeta = {};
        if (AI_PROVIDER === 'ollama') {
            rawAnswer = data?.message?.content;
            responseMeta = {
                done: data?.done,
                doneReason: data?.done_reason,
                promptEvalCount: data?.prompt_eval_count,
                evalCount: data?.eval_count,
                totalTokens: data?.prompt_eval_count && data?.eval_count
                    ? data.prompt_eval_count + data.eval_count
                    : null,
            };
        } else {
            rawAnswer = data?.choices?.[0]?.message?.content;
            responseMeta = {
                finishReason: data?.choices?.[0]?.finish_reason,
                usage: data?.usage,
            };
        }

        ragLog.info('queryWithLLM', 'LLM response diagnostics', {
            hasAnswer: typeof rawAnswer === 'string' && rawAnswer.trim().length > 0,
            answerLength: typeof rawAnswer === 'string' ? rawAnswer.length : 0,
            ...responseMeta,
        });

        if (typeof rawAnswer !== 'string' || rawAnswer.trim().length === 0) {
            ragLog.warn('queryWithLLM', 'Empty or malformed response from LLM', { data, responseMeta });

            // Retry once with drastically reduced context.
            // Some small models choke on long conversations
            // and return empty content. Strip to system + last 4 turns + current.
            // CRITICAL: Preserve the system prompt (character sheet) in retries.
            const reducedMessages = [
                ...messages.filter(m => m.role === 'system'),
                ...messages.filter(m => m.role === 'user' || m.role === 'assistant').slice(-8),
            ];
            if (reducedMessages.length < messages.length) {
                ragLog.warn('queryWithLLM', `Retrying with reduced context: ${messages.length} -> ${reducedMessages.length} messages`);
                const retryBody = {
                    ...chatBody,
                    messages: reducedMessages,
                };
                try {
                    const retryData = await postJson(aiConfig.chatEndpoint, retryBody, {
                        apiKey: aiConfig.apiKey,
                        timeoutMs,
                        label: `${AI_PROVIDER}-chat-retry`,
                    });
                    if (AI_PROVIDER === 'ollama') {
                        rawAnswer = retryData?.message?.content;
                    } else {
                        rawAnswer = retryData?.choices?.[0]?.message?.content;
                    }
                    if (typeof rawAnswer === 'string' && rawAnswer.trim().length > 0) {
                        ragLog.info('queryWithLLM', 'Retry succeeded with reduced context');
                        return normalizeModelResponse(rawAnswer);
                    }
                } catch (retryErr) {
                    ragLog.warn('queryWithLLM', 'Retry also failed', { error: retryErr.message });
                }
            }

            // Second retry: bare minimum — just the user message, no system prompt, no history.
            // This isolates whether the model is choking on the system prompt or the conversation structure.
            const bareMessages = [
                { role: 'user', content: userQuery || messages.filter(m => m.role === 'user').pop()?.content || '' },
            ];
            ragLog.warn('queryWithLLM', `Retrying with bare prompt (${bareMessages.length} messages)`);
            const bareBody = {
                ...chatBody,
                messages: bareMessages,
                temperature: 0.7,
            };
            try {
                const bareData = await postJson(aiConfig.chatEndpoint, bareBody, {
                    apiKey: aiConfig.apiKey,
                    timeoutMs,
                    label: `${AI_PROVIDER}-chat-bare`,
                });
                if (AI_PROVIDER === 'ollama') {
                    rawAnswer = bareData?.message?.content;
                } else {
                    rawAnswer = bareData?.choices?.[0]?.message?.content;
                }
                if (typeof rawAnswer === 'string' && rawAnswer.trim().length > 0) {
                    ragLog.info('queryWithLLM', 'Bare prompt retry succeeded');
                    return normalizeModelResponse(rawAnswer);
                }
            } catch (bareErr) {
                ragLog.warn('queryWithLLM', 'Bare prompt retry also failed', { error: bareErr.message });
            }

            return fallbackResponse;
        }

        // --- 9. Normalize response: strip accidental role-label prefixes ---
        rawAnswer = normalizeModelResponse(rawAnswer);

        return rawAnswer;
    } catch (err) {
        // --- Fallback handling ---
        ragLog.error('queryWithLLM', err, 'LLM call failed, returning fallback');

        const msg = `${err.message} ${err.cause?.code || ''}`;
        const isConn = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|socket hang up|aborted/i.test(msg);

        if (isConn) {
            return "I'm having trouble connecting to my brain right now. The AI service might be offline. Could you try again later? ♡";
        }

        return fallbackResponse;
    }
}

/**
 * Main function (CLI)
 */
async function main() {
    const userQuery = process.argv.slice(2).join(' ');
    if (!userQuery) {
        console.log('Usage: node src/database/rag-query.js "your query here"');
        process.exit(1);
    }

    try {
        const similarMessages = await queryRAG(userQuery, 10);

        if (similarMessages.length === 0) {
            ragLog.warn('No messages with embeddings found. Run rag-prepare.js first.');
            return;
        }

        ragLog.info(`Found ${similarMessages.length} similar messages:`);
        similarMessages.forEach(msg => {
            ragLog.info(`  [${msg.author}] ${msg.content.substring(0, 100)}... (sim: ${msg.similarity.toFixed(3)})`);
        });

        const context = assembleContext(similarMessages);
        ragLog.info('Querying LLM with context...');

        // OLD signature for CLI: (userQuery, contextString, similarMessages)
        const answer = await queryWithLLM(userQuery, context, similarMessages);
        console.log('LLM Response:\n', answer);
    } catch (error) {
        ragLog.error('rag-query', error, 'Check DB and Ollama reachability');
    }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main().finally(() => pool.end());
}

export {
    queryRAG,
    queryRAGWithContext,
    generateEmbedding,
    assembleContext,
    queryWithLLM,
    normalizeModelResponse,
    // Re-export ai-context utilities for use by other modules
    buildConversationContext,
    buildSystemPrompt,
    estimateTokens,
    estimateContextTokens,
    ContextSource,
    validateContextBundle,
    buildDebugContextView,
    buildDebugSummary,
    validateCharacterSheet,
    DEFAULT_CREAM_CHARACTER,
};
