/**
 * Response Normalization Utilities
 *
 * Pure functions for cleaning up model responses before display or storage.
 * No external dependencies beyond standard JS.
 */

/**
 * Normalize a model response by stripping accidental role-label prefixes.
 *
 * Some models trained on chat formats emit "assistant\n" or "assistant\nassistant\n"
 * before the actual content. This function removes those prefixes while preserving
 * legitimate occurrences of the word "assistant" inside normal conversation content.
 *
 * @param {string} text - Raw model response
 * @returns {string} Cleaned response
 */
export function normalizeModelResponse(text) {
    if (typeof text !== 'string') return text;
    let cleaned = text;
    // Strip leading "assistant" role labels (case-insensitive) followed by
    // newline(s) and/or whitespace. Only strip from the very start of the
    // response so legitimate mid-content occurrences are preserved.
    const leadingAssistantRe = /^(assistant\s*[\r\n]+)+/i;
    cleaned = cleaned.replace(leadingAssistantRe, '');
    // Also strip a single leading "assistant" followed by optional whitespace
    // (no newline) in case the model emits it inline.
    if (/^assistant\s*$/i.test(cleaned.trim())) {
        cleaned = '';
    }
    return cleaned;
}
