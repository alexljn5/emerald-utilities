/**
 * Centralized, consistent logger for Emerald Utilities.
 *
 * Goals:
 *  - Consistent subsystem tags: [DB] [RAG] [OLLAMA] [ELECTRON] [SCRIPT] [CONFIG]
 *  - Color-coded output (auto-disabled when not a TTY or NO_COLOR is set)
 *  - Never logs secrets: known-sensitive keys are redacted automatically
 *  - Structured error logging: subsystem, operation, reason, recovery hint
 *
 * Usage:
 *   import { createLogger } from '../utils/logger.js';
 *   const log = createLogger('DB');
 *   log.info('Connecting to postgres...');
 *   log.warn('safeStorage unavailable, using .env fallback');
 *   log.error('connect', err, 'Check DB_HOST / that the server is reachable');
 *
 * Or use the shortcut subsystem loggers:
 *   import { dbLog, ragLog, ollamaLog, electronLog, scriptLog, configLog } from '../utils/logger.js';
 */

// ANSI color codes.
const ANSI = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    // "dark blue" and "orange" approximated with 256-color codes.
    darkBlue: '\x1b[38;5;18m',
    orange: '\x1b[38;5;208m',
    gray: '\x1b[90m',
};

// Per-subsystem color mapping (per project spec).
const SUBSYSTEM_COLORS = {
    DB: ANSI.blue,          // DB blue
    RAG: ANSI.green,        // RAG green (readability)
    OLLAMA: ANSI.darkBlue,  // OLLAMA dark blue
    ELECTRON: ANSI.cyan,    // Electron cyan
    SCRIPT: ANSI.yellow,    // script yellow
    CONFIG: ANSI.orange,    // CONFIG orange
    ERROR: ANSI.red,        // ERROR red
};

// Decide whether to emit colors. Disabled if NO_COLOR is set, or when stdout
// is not a TTY (e.g. piped/redirected). Electron main still shows colors in
// most terminals; renderer console ignores ANSI harmlessly.
const COLOR_ENABLED = (() => {
    if (process.env.NO_COLOR) return false;
    if (process.env.FORCE_COLOR) return true;
    try {
        return Boolean(process.stdout && process.stdout.isTTY);
    } catch {
        return false;
    }
})();

function paint(color, text) {
    if (!COLOR_ENABLED || !color) return text;
    return `${color}${text}${ANSI.reset}`;
}

// Keys whose values must never be printed.
const SENSITIVE_KEY_RE = /(pass(word)?|secret|token|api[-_]?key|authorization|bearer|credential)/i;
// Inline patterns to scrub from free-form strings.
const SCRUB_PATTERNS = [
    // password=... or "password": "..."
    /(pass(?:word)?|secret|token|api[-_]?key|authorization|bearer)["']?\s*[:=]\s*["']?[^"'\s,}]+/gi,
    // postgres://user:password@host -> redact the password part
    /(postgres(?:ql)?:\/\/[^:@\s]+:)[^@\s]+(@)/gi,
];

/**
 * Redact secrets from an arbitrary log argument.
 */
function redact(value) {
    if (value == null) return value;

    if (typeof value === 'string') {
        let out = value;
        out = out.replace(SCRUB_PATTERNS[0], (m) => {
            const idx = m.search(/[:=]/);
            return `${m.slice(0, idx + 1)} [REDACTED]`;
        });
        out = out.replace(SCRUB_PATTERNS[1], '$1[REDACTED]$2');
        return out;
    }

    if (value instanceof Error) {
        return value; // handled specially in error()
    }

    if (typeof value === 'object') {
        try {
            const clone = Array.isArray(value) ? [] : {};
            for (const [k, v] of Object.entries(value)) {
                if (SENSITIVE_KEY_RE.test(k)) {
                    clone[k] = '[REDACTED]';
                } else if (v && typeof v === 'object') {
                    clone[k] = redact(v);
                } else if (typeof v === 'string') {
                    clone[k] = redact(v);
                } else {
                    clone[k] = v;
                }
            }
            return clone;
        } catch {
            return '[unserializable]';
        }
    }

    return value;
}

function ts() {
    return new Date().toISOString();
}

/**
 * Extract a concise reason string from an unknown error-like value.
 */
function reasonOf(err) {
    if (!err) return 'unknown error';
    if (typeof err === 'string') return err;
    const cause = err.cause?.code || err.cause?.message;
    const base = err.message || String(err);
    return cause ? `${base} (cause: ${cause})` : base;
}

/**
 * Create a logger bound to a subsystem tag.
 * @param {string} subsystem e.g. 'DB', 'RAG', 'OLLAMA', 'ELECTRON', 'SCRIPT', 'CONFIG'
 */
export function createLogger(subsystem = 'APP') {
    const tag = `[${subsystem}]`;
    const color = SUBSYSTEM_COLORS[subsystem] || ANSI.gray;
    const label = paint(color, tag);

    const emit = (fn, args) => fn(label, ...args.map(redact));

    return {
        info(...args) {
            emit(console.log, args);
        },
        warn(...args) {
            emit(console.warn, [paint(ANSI.yellow, 'WARN:'), ...args]);
        },
        debug(...args) {
            if (process.env.DEBUG || process.env.EMERALD_DEBUG) {
                emit(console.log, [paint(ANSI.gray, 'DEBUG:'), ...args]);
            }
        },
        /**
         * Structured error logging.
         * @param {string} operation what was being attempted
         * @param {unknown} err the error (or a message string)
         * @param {string} [recovery] optional recovery hint / fallback taken
         */
        error(operation, err, recovery) {
            const prefix = paint(ANSI.red + ANSI.bold, '[ERROR]');
            const parts = [
                prefix,
                label,
                paint(ANSI.red, `op=${operation}`),
                paint(ANSI.red, `reason=${redact(reasonOf(err))}`),
            ];
            if (recovery) parts.push(paint(ANSI.gray, `recovery=${recovery}`));
            console.error(...parts);
            // Include stack in debug mode only.
            if ((process.env.DEBUG || process.env.EMERALD_DEBUG) && err && err.stack) {
                console.error(paint(ANSI.gray, err.stack));
            }
        },
        /** Access the raw redactor for callers that need to sanitize before logging. */
        redact,
        subsystem,
    };
}

// Convenience pre-bound loggers.
export const dbLog = createLogger('DB');
export const ragLog = createLogger('RAG');
export const ollamaLog = createLogger('OLLAMA');
export const electronLog = createLogger('ELECTRON');
export const scriptLog = createLogger('SCRIPT');
export const configLog = createLogger('CONFIG');

export default createLogger;
