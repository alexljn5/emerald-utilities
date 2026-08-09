/**
 * Integration tests for the Ollama server.
 *
 * NON-DESTRUCTIVE: only queries /api/tags and generates a throwaway
 * embedding. SKIPS itself when Ollama is unreachable, so it's safe to run
 * with the homelab offline.
 *
 * OLLAMA_HOST / model come from src/.env (same as the app).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '..', 'src', '.env');

function loadEnv(path) {
    const out = {};
    try {
        const raw = readFileSync(path, 'utf8');
        for (const line of raw.split(/\r?\n/)) {
            const t = line.trim();
            if (!t || t.startsWith('#')) continue;
            const i = t.indexOf('=');
            if (i === -1) continue;
            let v = t.slice(i + 1).trim();
            if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
                v = v.slice(1, -1);
            }
            out[t.slice(0, i).trim()] = v;
        }
    } catch {
        /* no .env -> tests will skip */
    }
    return out;
}

const env = loadEnv(envPath);
const OLLAMA_HOST = env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const EMBED_MODEL = env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
const EMBED_DIM = parseInt(env.OLLAMA_EMBED_DIM || '768', 10);

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function isReachable() {
    try {
        const res = await fetchWithTimeout(`${OLLAMA_HOST}/api/tags`, {}, 3000);
        return res.ok;
    } catch {
        return false;
    }
}

test('Ollama /api/tags responds', async (t) => {
    if (!(await isReachable())) return t.skip(`Ollama unreachable at ${OLLAMA_HOST} — skipping`);
    const res = await fetchWithTimeout(`${OLLAMA_HOST}/api/tags`, {}, 3000);
    assert.ok(res.ok);
    const data = await res.json();
    assert.ok(Array.isArray(data.models), 'expected a models array');
});

test('embedding endpoint returns a vector of the expected dimension', async (t) => {
    if (!(await isReachable())) return t.skip(`Ollama unreachable at ${OLLAMA_HOST} — skipping`);
    const res = await fetchWithTimeout(`${OLLAMA_HOST}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Connection: 'close' },
        body: JSON.stringify({ model: EMBED_MODEL, input: 'integration test probe' }),
    }, 30000);

    if (res.status === 404) {
        return t.skip('/api/embed not available on this Ollama version — skipping');
    }
    assert.ok(res.ok, `embed request failed: ${res.status}`);
    const data = await res.json();
    const embedding = data.embeddings?.[0];
    assert.ok(Array.isArray(embedding), 'expected an embedding array');
    assert.equal(
        embedding.length,
        EMBED_DIM,
        `embedding dim ${embedding.length} != expected ${EMBED_DIM} (check OLLAMA_EMBED_DIM)`,
    );
});
