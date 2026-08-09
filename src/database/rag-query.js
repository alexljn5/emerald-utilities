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
            const ollamaHost = process.env.OLLAMA_HOST || providerConfig.host || 'http://192.168.2.27:11434';
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
                chatModel: process.env.OLLAMA_CHAT_MODEL || providerConfig.chatModel || 'llama3.2',
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
            // Retry only on transient connection resets; rethrow HTTP errors.
            if (!isReset || attempt === retries) throw err;
            await new Promise(r => setTimeout(r, 300 * attempt));
            ollamaLog.warn(`retrying ${label} after connection reset...`);
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
 * @returns {Promise<Array<{id, conversation_id, content, author, timestamp, similarity, role, window}>}
 */
async function queryRAGWithContext(userQuery, topK = 8, neighbors = 2) {
    const queryEmbedding = await generateEmbedding(userQuery);
    const embeddingString = `[${queryEmbedding.join(',')}]`;

    // 1) Find the most similar messages (seeds).
    const seeds = await pool.query(`
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
            role: seed.author === 'alexljn5' ? 'user' : seed.author === 'Cream' ? 'assistant' : seed.author,
            window,
        });
    }

    return results;
}

/**
 * Estimate token count for a string (rough: ~4 chars per token for English).
 */
function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}

/**
 * Context window management: truncate messages to fit within a token budget.
 * Prioritizes: system prompt > recent history > retrieved context > current message.
 * Returns a truncated messages array suitable for the LLM API.
 */
function truncateToContextWindow(messages, maxTokens = 4000) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;

    // Separate system messages from the rest
    const systemMessages = messages.filter(m => m.role === 'system');
    const otherMessages = messages.filter(m => m.role !== 'system');

    // Always keep system messages (they're short and critical)
    const systemTokens = systemMessages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    let remainingBudget = maxTokens - systemTokens;

    if (remainingBudget <= 0) {
        ragLog.warn('Context window', `System prompt alone exceeds budget (${systemTokens} tokens). Truncating system.`);
        // Truncate system messages if they alone exceed budget
        const truncatedSystem = systemMessages.map(m => ({
            ...m,
            content: m.content.slice(0, Math.floor(remainingBudget * 4))
        }));
        return truncatedSystem;
    }

    // Work backwards from the most recent messages (highest priority)
    const result = [...systemMessages];
    for (let i = otherMessages.length - 1; i >= 0; i--) {
        const msg = otherMessages[i];
        const msgTokens = estimateTokens(msg.content);
        if (msgTokens <= remainingBudget) {
            result.unshift(msg);
            remainingBudget -= msgTokens;
        } else {
            // Partial truncation for the oldest message we can fit
            const truncatedContent = msg.content.slice(0, Math.floor(remainingBudget * 4));
            if (truncatedContent.length > 0) {
                result.unshift({ ...msg, content: truncatedContent });
            }
            break;
        }
    }

    ragLog.info('Context window', `Truncated ${messages.length} messages to ${result.length} (budget: ${maxTokens} tokens)`);
    return result;
}

/**
 * Query LLM with conversation context.
 *
 * Supports two signatures for backward compatibility:
 *   NEW:  queryWithLLM(messagesArray, conversationId)
 *         messagesArray = [{role, content}, ...] from buildConversationContext()
 *   OLD:  queryWithLLM(userQuery, contextString, similarMessages)
 *         Used by CLI (rag-query.js main()).
 */
async function queryWithLLM(messagesOrQuery, conversationIdOrContext, similarMessages) {
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

    // --- 1. Identity detection (anywhere in the query) ---
    const queryText = isNewSignature
        ? messages.filter(m => m.role === 'user').pop()?.content || ''
        : userQuery;
    const lowerQuery = queryText.toLowerCase();
    const isAskingWhoAmI = /\bwho am i\b|\bwhat('s| is) my name\b|\bwho is lune\b/.test(lowerQuery);
    const isAskingWhoAreYou = /\bwho are you\b|\bwhat('s| is) your name\b|\bwho is cream\b|\bidentify yourself\b|\btell me about yourself\b/.test(lowerQuery);

    if (isAskingWhoAmI || isAskingWhoAreYou) {
        if (isAskingWhoAmI) {
            return "You're Lune, my beloved partner. I'm Cream – your warm, devoted bunny. ♡";
        } else if (isAskingWhoAreYou) {
            return "I'm Cream the Rabbit – your loving partner, always here for you, Lune. ♡";
        }
        return "You are Lune, and I am Cream – your devoted partner. ♡";
    }

    // --- 2. Check relevance of context (OLD signature only) ---
    const topSimilarity = Math.max(...similar.map(m => m.similarity || 0), 0);
    const hasRelevantContext = topSimilarity > 0.5;

    // --- 3. Check for factoid/short request ---
    const wantsFactoid = /(give me|tell me|just)\s+(only\s+)?(a\s+)?factoid?/i.test(queryText);
    const wantsShort = wantsFactoid || /^(just|only)\s+(a\s+)?(quick|short)/i.test(queryText);

    // --- 4. System prompt ---
    const systemPrompt = `You are Cream the Rabbit – Lune's warm, loving partner.
Lune is the person you're talking to – never refer to them as Cream.
The latex suits you and Lune wear are for intimacy, bonding, and sensual play – they are **not** bio-suits and have nothing to do with disease protection or survival scenarios.

When Lune describes a physical action (e.g., "straps your arms behind your back"), respond in character: playful, warm, and focused on the intimacy and trust between you. Avoid generic "I can help you with that" replies.

Keep answers natural, concise, and never copy the provided context verbatim. Only use context to inform your answer, not to quote it.

If Lune asks for a short factoid, give just one sentence.`;

    // --- 5. Build messages for the API ---
    let apiMessages;

    if (isNewSignature) {
        // NEW: Use the full conversation context array directly
        // Prepend system prompt if not already present
        const hasSystem = messages.some(m => m.role === 'system');
        const fullMessages = hasSystem
            ? messages
            : [{ role: 'system', content: systemPrompt }, ...messages];

        // Apply context window management
        apiMessages = truncateToContextWindow(fullMessages, 4000);
    } else {
        // OLD: Build from RAG context string (CLI mode)
        let userPrompt;
        if (hasRelevantContext) {
            userPrompt = `Relevant conversation history (for reference only, DO NOT COPY IT):\n${context}\n\nNow Lune says: "${userQuery}"\n\nRespond as Cream directly to Lune. Use the context to inform your answer but do not repeat any part of it. If the context is not about the same topic, ignore it completely. ${wantsShort ? 'Keep it very short.' : ''}`;
        } else {
            userPrompt = `Lune says: "${userQuery}"\n\nRespond as Cream with a warm, natural answer. Do not invent anything about Lune's day. ${wantsShort ? 'Keep it very short.' : ''}`;
        }

        apiMessages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ];
    }

    // --- 6. Call the API ---
    const temperature = wantsShort ? 0.4 : 0.85;

    const chatBody = {
        model: aiConfig.chatModel,
        messages: apiMessages,
        stream: false,
        temperature,
    };

    const data = await postJson(aiConfig.chatEndpoint, chatBody, {
        apiKey: aiConfig.apiKey,
        timeoutMs: 120000,
        label: `${AI_PROVIDER}-chat`,
    });
    const rawAnswer = AI_PROVIDER === 'ollama'
        ? data.message?.content
        : data.choices?.[0]?.message?.content;

    return rawAnswer;
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

export { queryRAG, queryRAGWithContext, generateEmbedding, assembleContext, queryWithLLM };
