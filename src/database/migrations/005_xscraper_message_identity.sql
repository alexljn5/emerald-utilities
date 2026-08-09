-- ============================================================
-- 005_xscraper_message_identity.sql
--
-- XSCRAPER ONLY.
--
-- Purpose: give every grok_messages row a STABLE, CONVERSATION-SCOPED
-- identity so XScraper forwarding can be idempotent.
--
-- Before this migration the only identity was the primary key `id`, which
-- for scraped rows is the XScraper content hash (`m_<hash>`). That hash is
-- GLOBAL, not conversation-scoped, so:
--   * the same text in two conversations collided on the PK
--   * the forwarder had no way to ask "does PostgreSQL already have this
--     local message?" without guessing
--
-- This migration is additive and NON-DESTRUCTIVE:
--   * no rows are deleted
--   * no existing ids are rewritten
--   * existing rows are backfilled with source_message_id = id, which is
--     exactly the XScraper source id they were originally inserted with
-- ============================================================

BEGIN;

-- 1. Stable source identity carried over from the local XScraper store.
ALTER TABLE grok_messages ADD COLUMN IF NOT EXISTS source_message_id TEXT;

-- 2. Deterministic content fingerprint (author + content), used for
--    diagnostics and for detecting legacy rows that lack a source id.
ALTER TABLE grok_messages ADD COLUMN IF NOT EXISTS content_hash TEXT;

-- 3. Where the row came from ('xscraper', 'ai-chat', 'import', ...).
ALTER TABLE grok_messages ADD COLUMN IF NOT EXISTS source TEXT;

-- 4. Backfill. Existing scraped rows were inserted with the XScraper id as
--    the primary key, so `id` IS the source id for them.
UPDATE grok_messages
SET source_message_id = id
WHERE source_message_id IS NULL;

UPDATE grok_messages
SET content_hash = md5(author || E'\n' || content)
WHERE content_hash IS NULL;

UPDATE grok_messages
SET source = COALESCE(payload->>'source', 'unknown')
WHERE source IS NULL;

-- 5. THE canonical identity: (conversation_id, source_message_id).
--    This is what makes forwarding idempotent. It cannot create duplicates
--    because source_message_id was backfilled from the unique primary key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_grok_messages_conversation_source
ON grok_messages (conversation_id, source_message_id);

-- 6. Secondary lookup for legacy rows / duplicate reporting.
CREATE INDEX IF NOT EXISTS idx_grok_messages_conversation_content_hash
ON grok_messages (conversation_id, content_hash);

CREATE INDEX IF NOT EXISTS idx_grok_messages_source
ON grok_messages (source);

-- 7. Durable XScraper sync checkpoint.
--    A conversation's checkpoint is ONLY advanced after PostgreSQL has
--    confirmed persistence of the messages up to that point.
CREATE TABLE IF NOT EXISTS xscraper_sync_state (
    conversation_id     TEXT PRIMARY KEY,
    last_source_savedat BIGINT      NOT NULL DEFAULT 0,
    last_message_ts     TIMESTAMPTZ,
    last_source_id      TEXT,
    confirmed_count     INTEGER     NOT NULL DEFAULT 0,
    last_synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb
);

COMMIT;
