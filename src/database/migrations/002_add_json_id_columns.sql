-- ============================================================
-- Migration 002: Add json_id columns for JSON ↔ PostgreSQL sync
-- ============================================================
-- These columns store the original JSON file IDs so that sync
-- operations can be idempotent (no duplicate records on re-run).

-- Notes: add json_id for mapping JSON note IDs to PostgreSQL UUIDs
ALTER TABLE notes ADD COLUMN IF NOT EXISTS json_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_json_id ON notes (json_id) WHERE json_id IS NOT NULL;

-- Tasks: add json_id for mapping JSON task IDs to PostgreSQL UUIDs
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS json_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_json_id ON tasks (json_id) WHERE json_id IS NOT NULL;

-- Task tags: add json_id for mapping JSON tag IDs to PostgreSQL UUIDs
ALTER TABLE task_tags ADD COLUMN IF NOT EXISTS json_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_tags_json_id ON task_tags (json_id) WHERE json_id IS NOT NULL;
