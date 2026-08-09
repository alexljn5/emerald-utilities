-- ============================================================
-- Emerald Utilities — Tasks Database Schema
-- Minimal schema for notes and tasks (sticky-note style).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- NOTES
-- ============================================================

CREATE TABLE IF NOT EXISTS notes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    content TEXT NOT NULL,
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notes_date
    ON notes (date DESC);

CREATE INDEX IF NOT EXISTS idx_notes_created_at
    ON notes (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notes_archived
    ON notes (archived);

-- ============================================================
-- TASKS
-- ============================================================

CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title TEXT NOT NULL,
    description TEXT,
    completed BOOLEAN NOT NULL DEFAULT FALSE,
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    priority TEXT NOT NULL DEFAULT 'green' CHECK (priority IN ('green', 'orange', 'red')),
    due_time TIMESTAMPTZ,
    reminder_time TIMESTAMPTZ,
    long_term BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_completed
    ON tasks (completed);

CREATE INDEX IF NOT EXISTS idx_tasks_archived
    ON tasks (archived);

CREATE INDEX IF NOT EXISTS idx_tasks_priority
    ON tasks (priority);

CREATE INDEX IF NOT EXISTS idx_tasks_due_time
    ON tasks (due_time);

CREATE INDEX IF NOT EXISTS idx_tasks_reminder_time
    ON tasks (reminder_time);

CREATE INDEX IF NOT EXISTS idx_tasks_created_at
    ON tasks (created_at DESC);

-- ============================================================
-- TASK TAGS (optional lightweight tagging)
-- ============================================================

CREATE TABLE IF NOT EXISTS task_tags (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_task_tag UNIQUE (task_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_task_tags_task_id
    ON task_tags (task_id);

CREATE INDEX IF NOT EXISTS idx_task_tags_tag
    ON task_tags (tag);

-- ============================================================
-- TRIGGER: auto-update updated_at on notes
-- ============================================================

CREATE OR REPLACE FUNCTION update_notes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notes_updated_at ON notes;
CREATE TRIGGER trg_notes_updated_at
    BEFORE UPDATE ON notes
    FOR EACH ROW
    EXECUTE FUNCTION update_notes_updated_at();

-- ============================================================
-- TRIGGER: auto-update updated_at on tasks
-- ============================================================

CREATE OR REPLACE FUNCTION update_tasks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tasks_updated_at ON tasks;
CREATE TRIGGER trg_tasks_updated_at
    BEFORE UPDATE ON tasks
    FOR EACH ROW
    EXECUTE FUNCTION update_tasks_updated_at();
