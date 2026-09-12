#!/usr/bin/env node
/**
 * Emerald Utilities — Database Preflight / Health Check
 * ------------------------------------------------------------------
 * Standalone CLI script. Run BEFORE starting the app to verify the
 * configured PostgreSQL is reachable and correctly provisioned.
 *
 * Usage:
 *   node src/database/scripts/db-preflight.js
 *
 * Exit codes:
 *   0 — database is healthy
 *   1 — database is unreachable or misconfigured
 *
 * What it reports (NEVER prints DB_PASSWORD):
 *   - Database host, port, database name, user
 *   - Connection status
 *   - PostgreSQL version
 *   - pgvector availability
 *   - Table inventory (counts for key tables)
 *
 * This script makes NO assumptions about the network. It connects to
 * whatever DB_HOST/DB_PORT are configured — Tailscale, LAN, localhost,
 * or otherwise. Tailscale is purely an OS-level networking layer.
 */

import { config as loadDotenv } from 'dotenv';
import { resolveEnvPath } from '../../utils/pathResolver.js';
import { dbLog as log } from '../../utils/logger.js';
import { checkDbHealth, connectionInfo } from '../db-pool.js';

// Load .env so DB_* overrides are present. Single source of truth:
// src/.env (dev) / <resources>/.env (prod).
loadDotenv({ path: resolveEnvPath(), override: true });

// ---------------------------------------------------------------------------
// Pretty printing helpers
// ---------------------------------------------------------------------------

function hr(title) {
    const line = '═'.repeat(60);
    console.log(`\n${line}`);
    console.log(`  ${title}`);
    console.log(`${line}\n`);
}

function ok(label, value) {
    console.log(`  ✓  ${label}: ${value}`);
}

function bad(label, value) {
    console.log(`  ✗  ${label}: ${value}`);
}

function info(label, value) {
    console.log(`  •  ${label}: ${value}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    hr('Emerald Utilities — Database Preflight');

    // 1. Resolved connection info (sanitised — no password).
    info('Target', `${connectionInfo.user}@${connectionInfo.host}:${connectionInfo.port}/${connectionInfo.database}`);

    // 2. Health check.
    const health = await checkDbHealth();

    if (!health.ok) {
        bad('Connection', 'FAILED');
        info('Reason', health.reason);
        if (health.error) info('Error', health.error);
        console.log('\n  ⚠  Database is NOT reachable. The application will degrade gracefully,\n     but AI/RAG and Tasks features will be unavailable.\n');
        process.exit(1);
    }

    ok('Connection', 'OK');

    if (health.pgVersion) {
        const shortVersion = health.pgVersion.split('\n')[0];
        ok('PostgreSQL', shortVersion);
    } else {
        bad('PostgreSQL', 'version unavailable');
    }

    ok('pgvector', health.pgvector ? 'available' : 'NOT available');

    // 3. Table inventory (best-effort; never fatal).
    try {
        const { pool } = await import('../db-pool.js');
        const tables = [
            'grok_messages',
            'grok_conversations',
            'grok_raw_imports',
            'notes',
            'tasks',
            'network_packet_events',
            'threat_indicators',
        ];

        hr('Table Inventory');
        let anyPresent = false;
        for (const table of tables) {
            try {
                const res = await pool.query(
                    `SELECT COUNT(*)::int AS c FROM "${table}"`
                );
                anyPresent = true;
                ok(table, `${res.rows[0].c} rows`);
            } catch (err) {
                // Table may not exist on this target — that is fine.
                info(table, 'not present');
            }
        }
        if (!anyPresent) {
            info('Note', 'No known tables found. Run migrations if this is a fresh database.');
        }
    } catch (err) {
        log.warn('preflight-tables', err?.message || err, 'Could not inventory tables');
    }

    hr('Result');
    ok('Database', 'healthy');
    console.log('');
    process.exit(0);
}

main().catch((err) => {
    log.error('preflight-fatal', err);
    process.exit(1);
});