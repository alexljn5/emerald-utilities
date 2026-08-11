-- Add notification policy columns to tasks table
-- This enables per-task notification scheduling (none, once, daily, weekly, custom)

-- Add notification_policy column with default 'daily'
ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS notification_policy VARCHAR(20) DEFAULT 'daily' CHECK (notification_policy IN ('none', 'once', 'daily', 'weekly', 'custom'));

-- Add custom_interval_minutes for custom policy
ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS custom_interval_minutes INTEGER DEFAULT 60 CHECK (custom_interval_minutes > 0);

-- Add index for policy queries
CREATE INDEX IF NOT EXISTS idx_tasks_notification_policy ON tasks(notification_policy) WHERE notification_policy != 'none';

-- Add comment
COMMENT ON COLUMN tasks.notification_policy IS 'Notification policy: none, once, daily, weekly, custom';
COMMENT ON COLUMN tasks.custom_interval_minutes IS 'Custom notification interval in minutes (used when policy is custom)';
