/**
 * Pure text-chunking helpers for RAG.
 *
 * Kept in its own module (with NO Electron/DB imports) so it can be unit
 * tested under plain `node --test` and reused anywhere.
 */

export const DEFAULT_CHUNK_SIZE = 500;
export const DEFAULT_CHUNK_OVERLAP = 50;

/**
 * Split text into overlapping chunks for embedding.
 *
 * - Text shorter than `chunkSize` is returned as a single chunk.
 * - Chunks advance by `chunkSize - overlap` so adjacent chunks share
 *   `overlap` characters of context.
 *
 * @param {string} text
 * @param {number} [chunkSize=DEFAULT_CHUNK_SIZE]
 * @param {number} [overlap=DEFAULT_CHUNK_OVERLAP]
 * @returns {string[]}
 */
export function chunkText(text, chunkSize = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_CHUNK_OVERLAP) {
    if (typeof text !== 'string' || text.length === 0) return [];
    if (text.length <= chunkSize) return [text];
    if (overlap >= chunkSize) {
        throw new Error('chunk overlap must be smaller than chunk size');
    }

    const chunks = [];
    const step = chunkSize - overlap;
    for (let i = 0; i < text.length; i += step) {
        chunks.push(text.slice(i, i + chunkSize));
    }
    return chunks;
}
