/**
 * RAG Preparation Script
 * Prepares Grok messages for Retrieval-Augmented Generation
 * 
 * Usage: node src/database/rag-prepare.js
 * 
 * Requirements:
 * - PostgreSQL with pgvector extension
 * - AI API key (Grok, OpenAI, or local Ollama/LM Studio)
 */

import { config } from 'dotenv';
import { pool } from './db-pool.js';
import { resolveEnvPath } from '../utils/pathResolver.js';
import { ragLog } from '../utils/logger.js';
import { chunkText, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP } from './rag-chunk.js';

// Load .env file. Single source of truth: src/.env (dev) / <resources>/.env (prod).
// override:true so our .env WINS over any pre-existing machine env var.
const envPath = resolveEnvPath();
config({ path: envPath, override: true });

// AI Provider configuration
const AI_PROVIDER = process.env.AI_PROVIDER || 'ollama';

// Embedding vector dimension. nomic-embed-text = 768; OpenAI/Grok = 1536.
const OLLAMA_EMBED_DIM = parseInt(process.env.OLLAMA_EMBED_DIM || '768', 10);
const VECTOR_DIM = AI_PROVIDER === 'ollama' ? OLLAMA_EMBED_DIM : 1536;

// Get configuration based on provider
function getAIConfig() {
    switch (AI_PROVIDER) {
        case 'grok':
            return {
                apiKey: process.env.GROK_API_KEY,
                embeddingEndpoint: process.env.GROK_EMBEDDING_ENDPOINT || 'https://api.x.ai/v1/embeddings',
                embeddingModel: process.env.GROK_EMBEDDING_MODEL || 'text-embedding-3',
            };
        case 'openai':
            return {
                apiKey: process.env.OPENAI_API_KEY,
                embeddingEndpoint: process.env.OPENAI_EMBEDDING_ENDPOINT || 'https://api.openai.com/v1/embeddings',
                embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
            };
        case 'ollama':
            return {
                apiKey: null, // No API key needed for Ollama
                embeddingEndpoint: `${process.env.OLLAMA_HOST || 'http://192.168.2.27:11434'}/api/embed`,
                // Accept both OLLAMA_EMBED_MODEL (new) and OLLAMA_EMBEDDING_MODEL (legacy)
                embeddingModel: process.env.OLLAMA_EMBED_MODEL || process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text',
            };
        case 'lmstudio':
            return {
                apiKey: null, // No API key needed for LM Studio
                embeddingEndpoint: `${process.env.LMSTUDIO_HOST || 'http://localhost:1234'}/v1/embeddings`,
                embeddingModel: process.env.LMSTUDIO_EMBEDDING_MODEL || 'text-embedding-nomic',
            };
        default:
            throw new Error(`Unknown AI provider: ${AI_PROVIDER}`);
    }
}

const aiConfig = getAIConfig();

// Chunking configuration (defaults live in rag-chunk.js).
const CHUNK_SIZE = DEFAULT_CHUNK_SIZE;
const CHUNK_OVERLAP = DEFAULT_CHUNK_OVERLAP;

/**
 * Generate embedding for text using the configured AI provider
 */
async function generateEmbedding(text) {
    const headers = {
        'Content-Type': 'application/json',
    };

    if (aiConfig.apiKey) {
        headers['Authorization'] = `Bearer ${aiConfig.apiKey}`;
    }

    const response = await fetch(aiConfig.embeddingEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: aiConfig.embeddingModel,
            input: text,
        }),
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Embedding API error: ${response.statusText} - ${error}`);
    }

    const data = await response.json();
    // Ollama returns embeddings[0], OpenAI/Grok returns data[0].embedding
    const embedding = AI_PROVIDER === 'ollama' ? data.embeddings?.[0] : data.data[0].embedding;

    if (!embedding || embedding.length === 0) {
        throw new Error(`Empty embedding received from ${AI_PROVIDER}. Check if the model is installed and the API endpoint is correct.`);
    }

    return embedding;
}

/**
 * Get messages that need embeddings
 */
async function getMessagesWithoutEmbeddings(limit = 100) {
    const result = await pool.query(
        `SELECT id, content, conversation_id 
         FROM grok_messages 
         WHERE embedding IS NULL 
         LIMIT $1`,
        [limit]
    );
    return result.rows;
}

/**
 * Store embedding for a message
 */
async function storeEmbedding(messageId, embedding) {
    const embeddingString = `[${embedding.join(',')}]`;
    await pool.query(
        `UPDATE grok_messages 
         SET embedding = $1::vector 
         WHERE id = $2`,
        [embeddingString, messageId]
    );
}

/**
 * Main preparation function
 */
async function prepareForRAG() {
    ragLog.info('Starting RAG preparation...');

    // Check if pgvector extension exists
    const extCheck = await pool.query(
        "SELECT * FROM pg_extension WHERE extname = 'vector'"
    );
    if (extCheck.rows.length === 0) {
        ragLog.info('Installing pgvector extension...');
        await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    }

    // Check if embedding column exists. NEVER drop it if it already holds
    // data — dropping would permanently destroy existing embeddings.
    const colCheck = await pool.query(
        `SELECT a.atttypmod AS typmod
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
          WHERE c.relname = 'grok_messages'
            AND a.attname = 'embedding'
            AND NOT a.attisdropped`
    );

    if (colCheck.rows.length === 0) {
        ragLog.info(`embedding column missing — adding vector(${VECTOR_DIM})...`);
        await pool.query(
            `ALTER TABLE grok_messages ADD COLUMN embedding vector(${VECTOR_DIM})`
        );
    } else {
        // pgvector stores dimension in atttypmod (no -4 offset for vector type).
        const existingDim = colCheck.rows[0].typmod;
        if (existingDim && existingDim !== VECTOR_DIM) {
            // Dimension mismatch. Only auto-fix if the column is EMPTY, so we
            // never destroy real embeddings. Otherwise abort loudly.
            const filled = await pool.query(
                'SELECT COUNT(*)::int AS c FROM grok_messages WHERE embedding IS NOT NULL'
            );
            if (filled.rows[0].c === 0) {
                ragLog.warn(
                    `embedding dimension is ${existingDim} but expected ${VECTOR_DIM}; ` +
                    `column is empty, safely recreating...`
                );
                await pool.query('ALTER TABLE grok_messages DROP COLUMN IF EXISTS embedding');
                await pool.query(`ALTER TABLE grok_messages ADD COLUMN embedding vector(${VECTOR_DIM})`);
            } else {
                throw new Error(
                    `Embedding dimension mismatch: DB has vector(${existingDim}) with ` +
                    `${filled.rows[0].c} existing embeddings, but current provider expects ` +
                    `vector(${VECTOR_DIM}). Refusing to drop non-empty column. ` +
                    `Set OLLAMA_EMBED_DIM=${existingDim} or re-embed intentionally.`
                );
            }
        } else {
            ragLog.info(`embedding column present with correct dimension (${VECTOR_DIM}).`);
        }
    }

    // Embed ALL messages that still need embeddings, paging through the table
    // in batches. Previously this processed a single batch of 100 and stopped,
    // so a full corpus (thousands of rows) would only ever get its first 100
    // embedded per invocation. We now loop until nothing remains (or an
    // optional RAG_MAX_EMBED cap is hit).
    const BATCH_SIZE = Number(process.env.RAG_EMBED_BATCH || 100) || 100;
    const MAX_EMBED = Number(process.env.RAG_MAX_EMBED || 0) || 0; // 0 = no cap

    // Report the total up front so progress is meaningful.
    const totalRes = await pool.query(
        'SELECT COUNT(*)::int AS c FROM grok_messages WHERE embedding IS NULL'
    );
    const totalToEmbed = totalRes.rows[0].c;
    ragLog.info(
        `${totalToEmbed} messages need embeddings` +
        (MAX_EMBED ? ` (capped to ${MAX_EMBED} this run)` : '')
    );

    let processed = 0;
    let embedded = 0;
    let failed = 0;

    while (true) {
        if (MAX_EMBED && processed >= MAX_EMBED) break;

        const remainingCap = MAX_EMBED ? Math.min(BATCH_SIZE, MAX_EMBED - processed) : BATCH_SIZE;
        const messages = await getMessagesWithoutEmbeddings(remainingCap);
        if (messages.length === 0) break;

        for (const message of messages) {
            processed++;
            try {
                const chunks = chunkText(message.content);
                const embedding = await generateEmbedding(chunks[0]); // Use first chunk
                await storeEmbedding(message.id, embedding);
                embedded++;
                ragLog.debug(`Embedded message ${message.id}`);
            } catch (error) {
                failed++;
                ragLog.error(`embed-message ${message.id}`, error, 'skipping this message');
            }
        }

        ragLog.info(
            `Progress: ${embedded} embedded, ${failed} failed` +
            (totalToEmbed ? ` (${Math.min(processed, totalToEmbed)}/${totalToEmbed})` : '')
        );
    }

    ragLog.info(`Preparation complete — embedded ${embedded}, failed ${failed}.`);
    // Note: pool.end() is handled by the caller (rag-auto-setup.js)
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    prepareForRAG()
        .then(() => pool.end())
        .catch((err) => ragLog.error('rag-prepare', err));
}

export { prepareForRAG, generateEmbedding, chunkText };