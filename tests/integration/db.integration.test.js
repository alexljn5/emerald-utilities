/**
 * Integration tests for the PostgreSQL RAG database.
 *
 * NON-DESTRUCTIVE: only SELECT / read-only checks. These tests SKIP
 * themselves (rather than fail) when the database is unreachable, so the
 * suite is safe to run even when the homelab server is offline.
 *
 * Connection settings are read from src/.env (same source the app uses).
 * We parse .env directly and use `pg` so we do NOT import db-pool.js,
 * which pulls in Electron and cannot load under plain `node --test`.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

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
            // strip surrounding quotes
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
let pool;
let dbReachable = false;

before(async () => {
    const config = {
        host: env.DB_HOST || '127.0.0.1',
        port: parseInt(env.DB_PORT || '5432', 10),
        database: env.DB_NAME || 'emerald_utilities',
        user: env.DB_USER || 'postgres',
        password: env.DB_PASSWORD || '',
        connectionTimeoutMillis: 3000,
    };
    pool = new pg.Pool(config);
    pool.on('error', () => { /* swallow idle errors */ });
    try {
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();
        dbReachable = true;
    } catch {
        dbReachable = false;
    }
});

after(async () => {
    if (pool) await pool.end().catch(() => { });
});

test('database is reachable (read-only SELECT 1)', { skip: false }, async (t) => {
    if (!dbReachable) return t.skip('DB unreachable — skipping (server offline?)');
    const res = await pool.query('SELECT 1 AS ok');
    assert.equal(res.rows[0].ok, 1);
});

test('pgvector extension is installed', async (t) => {
    if (!dbReachable) return t.skip('DB unreachable — skipping');
    const res = await pool.query("SELECT extname FROM pg_extension WHERE extname = 'vector'");
    assert.equal(res.rows.length, 1, 'expected pgvector extension to be present');
});

test('grok_messages table exists and is queryable', async (t) => {
    if (!dbReachable) return t.skip('DB unreachable — skipping');
    const res = await pool.query(`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded
        FROM grok_messages
    `);
    const { total, embedded } = res.rows[0];
    assert.ok(Number.isInteger(total), 'total should be an integer');
    assert.ok(embedded <= total, 'embedded count cannot exceed total');
});
