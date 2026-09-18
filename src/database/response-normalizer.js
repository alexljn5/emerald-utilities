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
 * Also strips character name prefixes (e.g. "Cream: ", "Lune: ") that models
 * may emit when they treat the request as a dialogue transcript.
 *
 * CRITICAL: This function handles RECURSIVE dialogue serialization, where the
 * model outputs nested patterns like:
 *   Cream: "Lune: "hai""
 *   Cream: "Cream: "Hey there!""
 *   Lune: "Cream: "hi""
 *
 * It iteratively strips outermost role labels until the content no longer
 * starts with a known role prefix, preventing infinite loops with a max depth.
 *
 * @param {string} text - Raw model response
 * @returns {string} Cleaned response
 */
export function normalizeModelResponse(text) {
    if (typeof text !== 'string') return text;
    let cleaned = text;

    // --- Phase 1: Strip leading "assistant" role labels (case-insensitive) ---
    const leadingAssistantRe = /^(assistant\s*[\r\n]+)+/i;
    cleaned = cleaned.replace(leadingAssistantRe, '');
    if (/^assistant\s*$/i.test(cleaned.trim())) {
        cleaned = '';
    }

    // --- Phase 2: Iteratively strip recursive dialogue serialization ---
    // Models sometimes emit:
    //   Cream: "Lune: "hai""
    //   Cream: "Cream: "Hey there!""
    // We strip the outermost "Speaker: " prefix, then check if the remaining
    // content is a quoted string that itself starts with another role label.
    // Repeat until stable (max 5 iterations to prevent infinite loops).
    let prev = null;
    let iterations = 0;
    const MAX_ITERATIONS = 5;

    while (prev !== cleaned && iterations < MAX_ITERATIONS) {
        prev = cleaned;
        iterations++;

        // Try to match: "Speaker: "content"" or "Speaker: content" at the start
        // Pattern 1: Speaker: "..." (quoted)
        const quotedMatch = cleaned.match(/^(Cream|Lune|assistant|user):\s*"([\s\S]*)"\s*$/i);
        if (quotedMatch) {
            cleaned = quotedMatch[2].trim();
            continue;
        }

        // Pattern 2: Speaker: '...' (single-quoted)
        const singleQuotedMatch = cleaned.match(/^(Cream|Lune|assistant|user):\s*'([\s\S]*)'\s*$/i);
        if (singleQuotedMatch) {
            cleaned = singleQuotedMatch[2].trim();
            continue;
        }

        // Pattern 3: Speaker: content (no quotes, but content follows)
        // Only strip if the speaker is one we know and the rest looks like dialogue
        const unquotedMatch = cleaned.match(/^(Cream|Lune|assistant|user):\s+([\s\S]+)$/i);
        if (unquotedMatch) {
            cleaned = unquotedMatch[2].trim();
            continue;
        }

        // Pattern 4: Just "Speaker:" with nothing after (or only whitespace)
        if (/^(Cream|Lune|assistant|user):\s*$/i.test(cleaned.trim())) {
            cleaned = '';
            break;
        }
    }

    // --- Phase 3: Strip any remaining leading role labels (non-recursive) ---
    // This catches cases like "Cream: Hi there!" where the content isn't quoted
    // but we still want to strip the label. Only strip from the very start.
    cleaned = cleaned.replace(/^(?:Cream|Lune|assistant|user):\s*/i, '');

    // --- Phase 4: Strip leading character name on its own line ---
    cleaned = cleaned.replace(/^\n*(?:Cream|Lune)\n*/g, '');

    return cleaned.trim();
}
