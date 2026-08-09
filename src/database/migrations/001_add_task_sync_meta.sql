-- ============================================================
-- Migration 001: Add task_sync_meta table for JSON ↔ PostgreSQL sync tracking
-- ============================================================
-- Tracks synchronization state between JSON mirror and PostgreSQL.
-- Used by sync-tasks-data.js for deterministic conflict resolution.

CREATE TABLE IF NOT EXISTS task_sync_meta (
    id TEXT PRIMARY KEY DEFAULT 'global',
    last_sync_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sync_version INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL DEFAULT 'startup',
    notes_synced INTEGER NOT NULL DEFAULT 0,
    tasks_synced INTEGER NOT NULL DEFAULT 0,
    tags_synced INTEGER NOT NULL DEFAULT 0,
    conflicts_count INTEGER NOT NULL DEFAULT 0,
    details JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Seed initial row if missing
INSERT INTO task_sync_meta (id, last_sync_at, sync_version, source)
VALUES ('global', NOW(), 1, 'migration')
ON CONFLICT (id) DO NOTHING;
