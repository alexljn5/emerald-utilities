-- Add due_time and reminder_time columns to subtasks table
-- This enables per-subtask deadline tracking and reminders

-- Add due_time column
ALTER TABLE subtasks
    ADD COLUMN IF NOT EXISTS due_time TIMESTAMPTZ;

-- Add reminder_time column
ALTER TABLE subtasks
    ADD COLUMN IF NOT EXISTS reminder_time TIMESTAMPTZ;

-- Add index for due_time queries
CREATE INDEX IF NOT EXISTS idx_subtasks_due_time
    ON subtasks (due_time);

-- Add index for reminder_time queries
CREATE INDEX IF NOT EXISTS idx_subtasks_reminder_time
    ON subtasks (reminder_time);

-- Add index for task_id + due_time (for fetching subtasks due for a parent task)
CREATE INDEX IF NOT EXISTS idx_subtasks_task_due
    ON subtasks (task_id, due_time);

-- Add comments
COMMENT ON COLUMN subtasks.due_time IS 'Optional due date/time for this subtask';
COMMENT ON COLUMN subtasks.reminder_time IS 'Optional reminder date/time for this subtask';
