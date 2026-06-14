const MAX_TCPDUMP_ARGS = 64;
const MAX_TCPDUMP_ARG_LENGTH = 512;

function validateTcpdumpArgs(args) {
    if (args.length > MAX_TCPDUMP_ARGS) {
        throw new Error(`Too many tcpdump arguments. Maximum is ${MAX_TCPDUMP_ARGS}.`);
    }

    for (const arg of args) {
        if (arg.length > MAX_TCPDUMP_ARG_LENGTH) {
            throw new Error(`tcpdump argument is too long. Maximum is ${MAX_TCPDUMP_ARG_LENGTH} characters.`);
        }
    }

    return args;
}

export function parseTcpdumpArgs(value) {
    if (value == null) return [];

    if (Array.isArray(value)) {
        return validateTcpdumpArgs(value.map((item) => String(item)));
    }

    const text = String(value);
    const args = [];
    let current = '';
    let quote = null;
    let escaped = false;

    for (const char of text) {
        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }

        if (char === '\\') {
            escaped = true;
            continue;
        }

        if (quote) {
            if (char === quote) {
                quote = null;
            } else {
                current += char;
            }
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }

        if (/\s/.test(char)) {
            if (current) {
                args.push(current);
                current = '';
            }
            continue;
        }

        current += char;
    }

    if (escaped) {
        current += '\\';
    }

    if (quote) {
        throw new Error('Unclosed quote in tcpdump arguments');
    }

    if (current) {
        args.push(current);
    }

    return validateTcpdumpArgs(args);
}
