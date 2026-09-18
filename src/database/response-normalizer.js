/**
 * Response Normalization Utilities
 *
 * Pure functions for cleaning up model responses before display or storage.
 * No external dependencies beyond standard JS.
 */

/**
 * Strip a single layer of "Speaker: " prefix and surrounding quotes.
 * Handles: Cream: "content", Cream: 'content', Cream: content
 * Returns the inner content, or the original if no match.
 */
function stripSpeakerLayer(s) {
    const trimmed = s.trim();
    // Pattern 1: Speaker: "content" (double-quoted)
    let m = trimmed.match(/^(Cream|Lune|assistant|user):\s*"([\s\S]*)"\s*$/i);
    if (m) return { matched: true, content: m[2].trim() };

    // Pattern 2: Speaker: 'content' (single-quoted)
    m = trimmed.match(/^(Cream|Lune|assistant|user):\s*'([\s\S]*)'\s*$/i);
    if (m) return { matched: true, content: m[2].trim() };

    // Pattern 3: Speaker: content (unquoted, but NOT starting with a quote
    // since Patterns 1/2 handle quoted content)
    m = trimmed.match(/^(Cream|Lune|assistant|user):\s+(?![\"'])([\s\S]+)$/i);
    if (m) return { matched: true, content: m[2].trim() };

    // Pattern 4: Just "Speaker:" with nothing after
    if (/^(Cream|Lune|assistant|user):\s*$/i.test(trimmed)) {
        return { matched: true, content: '' };
    }

    return { matched: false, content: trimmed };
}

/**
 * Normalize a model response by stripping accidental role-label prefixes.
 *
 * Handles recursive dialogue serialization where the model outputs nested
 * patterns like:
 *   Cream: "Lune: "hai""
 *   Cream: "Cream: "Hey there!""
 *
 * Also handles multi-line responses where each line starts with a role label:
 *   "Cream: "Lune: "hai""
 *   Cream: "Cream: "Hi there!""
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

    // --- Phase 2: Handle multi-line responses with role labels on each line ---
    // Some models emit a bare "Speaker:" on its own line followed by
    // lines that start with a stray quote + role label, e.g.:
    //   Cream:
    //   "Lune: "Cream: "I'm doing well..."
    // First, strip any line that is just a bare "Speaker:" label.
    cleaned = cleaned.replace(/^(Cream|Lune|assistant|user):\s*$/gim, '');

    // Also strip lines that start with a stray quote followed by a role label
    // e.g. `"Lune: "Cream: "text""` → `Lune: "Cream: "text""`
    cleaned = cleaned.replace(/^["']((?:Cream|Lune|assistant|user):)/gim, '$1');

    const lines = cleaned.split(/\r?\n/);
    const nonEmptyLines = lines.filter(l => l.trim().length > 0);

    if (nonEmptyLines.length > 1) {
        const roleLabelRe = /^(Cream|Lune|assistant|user):\s+/i;
        const allLinesHaveRoleLabels = nonEmptyLines.every(l => roleLabelRe.test(l.trim()));

        if (allLinesHaveRoleLabels) {
            // Every line starts with a role label — strip them all and
            // recursively normalize each line's inner content.
            cleaned = lines.map(line => {
                let trimmed = line.trim();
                if (!trimmed) return '';

                // Strip any stray leading quote that models sometimes emit
                // before the role label (e.g. `"Cream: "text""`)
                trimmed = trimmed.replace(/^["']/, '');

                // Try full stripSpeakerLayer first (handles quoted content)
                const { content } = stripSpeakerLayer(trimmed);

                // If stripSpeakerLayer matched, content is the inner text.
                // If it didn't match (e.g. line starts with `Lune: "Cream:`
                // but has no closing quote), fall back to stripping just the
                // `Speaker: ` prefix and any leading quote.
                let inner = content;
                if (content === trimmed) {
                    // No match — manually strip the label and any leading quote
                    inner = trimmed.replace(/^(Cream|Lune|assistant|user):\s*/, '')
                        .replace(/^["']/, '');
                }

                // Strip surrounding quotes if present
                const unquoted = inner.replace(/^"([\s\S]*)"\s*$/, '$1')
                    .replace(/^'([\s\S]*)'\s*$/, '$1');
                return normalizeModelResponse(unquoted);
            }).filter(l => l.length > 0).join('\n');
            return cleaned.trim();
        }
    }

    // --- Phase 3: Iteratively strip recursive dialogue serialization ---
    // Handles single-line patterns like:
    //   Cream: "Lune: "hai""  →  Lune: "hai"  →  hai
    //   Cream: "Cream: "Hi""  →  Cream: "Hi"  →  Hi
    let prev = null;
    let iterations = 0;
    const MAX_ITERATIONS = 5;

    while (prev !== cleaned && iterations < MAX_ITERATIONS) {
        prev = cleaned;
        iterations++;
        const result = stripSpeakerLayer(cleaned);
        if (!result.matched) break;
        cleaned = result.content;
    }

    // --- Phase 4: Handle mixed multi-line content ---
    // If the first line had a role label but other lines didn't,
    // strip the label from the first line only.
    if (cleaned.includes('\n')) {
        const firstLineEnd = cleaned.indexOf('\n');
        const firstLine = cleaned.substring(0, firstLineEnd).trim();
        const rest = cleaned.substring(firstLineEnd);
        const roleLabelRe = /^(Cream|Lune|assistant|user):\s+/i;
        if (roleLabelRe.test(firstLine)) {
            const { content } = stripSpeakerLayer(firstLine);
            cleaned = content + rest;
        }
        // If the first line starts with a stray quote (leftover from
        // Pattern 3 matching "content" without a closing quote on the
        // same line), strip just that leading quote.
        if (cleaned.startsWith('"') || cleaned.startsWith("'")) {
            cleaned = cleaned.replace(/^["']/, '');
        }
    }

    // --- Phase 5: Strip any remaining leading role labels ---
    cleaned = cleaned.replace(/^(?:Cream|Lune|assistant|user):\s*/i, '');

    // --- Phase 6: Strip leading character name on its own line ---
    cleaned = cleaned.replace(/^\n*(?:Cream|Lune)\n*/g, '');

    // --- Phase 7: Strip any stray leading quote left behind ---
    // After stripping role labels, there may be a leftover leading "
    // from unmatched quoted content (e.g. `"I'm doing well...`).
    // Only strip if the quote is clearly unmatched (no closing quote
    // on the same line, or the content after the quote doesn't start
    // with a known speaker).
    if (cleaned.startsWith('"') || cleaned.startsWith("'")) {
        // Check if this is a legitimate quoted string (has matching close)
        const quote = cleaned[0];
        const lastQuote = cleaned.lastIndexOf(quote);
        // If there's only one quote (no closing), or the content between
        // quotes starts with a role label, strip the leading quote.
        if (lastQuote <= 0) {
            cleaned = cleaned.slice(1);
        } else {
            const inner = cleaned.slice(1, lastQuote);
            if (/^(Cream|Lune|assistant|user):/i.test(inner)) {
                cleaned = cleaned.slice(1);
            }
        }
    }

    return cleaned.trim();
}
