-- ============================================================
-- Emerald Utilities - PostgreSQL JSONB Initialization Script
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- NETWORK PACKET EVENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS network_packet_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source TEXT NOT NULL DEFAULT 'tcpdump',
    interface_name TEXT NOT NULL DEFAULT 'any',
    direction TEXT,
    protocol TEXT,
    transport_protocol TEXT,
    source_ip INET,
    destination_ip INET,
    source_port INTEGER,
    destination_port INTEGER,
    packet_length INTEGER,
    is_blacklisted BOOLEAN NOT NULL DEFAULT FALSE,
    severity TEXT NOT NULL DEFAULT 'none',
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- THREAT INDICATORS
-- ============================================================

CREATE TABLE IF NOT EXISTS threat_indicators (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    indicator_type TEXT NOT NULL DEFAULT 'ipv4',
    value TEXT NOT NULL,
    ip_value INET,
    source_name TEXT NOT NULL DEFAULT 'local-blacklist',
    confidence INTEGER NOT NULL DEFAULT 50 CHECK (confidence >= 0 AND confidence <= 100),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- FIX: REQUIRED for ON CONFLICT + dedupe safety
CREATE UNIQUE INDEX IF NOT EXISTS idx_threat_indicators_value_unique
ON threat_indicators(value);

-- ============================================================
-- GROK CONVERSATIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS grok_conversations (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    message_count INTEGER NOT NULL DEFAULT 0,
    last_scraped TIMESTAMPTZ,
    metadata JSONB
);

-- ============================================================
-- RAW GROK DUMP LAYER (CRITICAL FIX)
-- ============================================================

CREATE TABLE IF NOT EXISTS grok_raw_imports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    filename TEXT NOT NULL,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    raw JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_grok_raw_imports_filename
ON grok_raw_imports(filename);

CREATE INDEX IF NOT EXISTS idx_grok_raw_imports_raw_gin
ON grok_raw_imports USING GIN (raw);

-- ============================================================
-- GROK MESSAGES
-- ============================================================

CREATE TABLE IF NOT EXISTS grok_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    content TEXT NOT NULL,
    author TEXT NOT NULL,
    timestamp TIMESTAMPTZ,
    scraped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_grok_conversation
        FOREIGN KEY (conversation_id)
        REFERENCES grok_conversations(id)
        ON DELETE CASCADE
);

-- ============================================================
-- DATABASE META
-- ============================================================

CREATE TABLE IF NOT EXISTS database_meta (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_packet_events_captured_at_desc
ON network_packet_events (captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_packet_events_source_ip
ON network_packet_events (source_ip);

CREATE INDEX IF NOT EXISTS idx_packet_events_destination_ip
ON network_packet_events (destination_ip);

CREATE INDEX IF NOT EXISTS idx_packet_events_protocol
ON network_packet_events (protocol);

CREATE INDEX IF NOT EXISTS idx_packet_events_transport_protocol
ON network_packet_events (transport_protocol);

CREATE INDEX IF NOT EXISTS idx_packet_events_blacklisted
ON network_packet_events (is_blacklisted);

CREATE INDEX IF NOT EXISTS idx_packet_events_payload_gin
ON network_packet_events USING GIN (payload);

CREATE INDEX IF NOT EXISTS idx_packet_events_captured_at_blacklisted
ON network_packet_events (captured_at DESC, is_blacklisted)
WHERE is_blacklisted = TRUE;

-- Threat indexes
CREATE INDEX IF NOT EXISTS idx_threat_indicators_active_ip
ON threat_indicators (active, ip_value)
WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_threat_indicators_value
ON threat_indicators (value);

-- Grok indexes
CREATE INDEX IF NOT EXISTS idx_grok_conversations_last_updated
ON grok_conversations (last_updated DESC);

CREATE INDEX IF NOT EXISTS idx_grok_messages_conversation_id
ON grok_messages (conversation_id);

CREATE INDEX IF NOT EXISTS idx_grok_messages_timestamp
ON grok_messages (timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_grok_messages_author
ON grok_messages (author);

CREATE INDEX IF NOT EXISTS idx_grok_messages_scraped_at
ON grok_messages (scraped_at DESC);

CREATE INDEX IF NOT EXISTS idx_grok_messages_payload_gin
ON grok_messages USING GIN (payload);

-- ============================================================
-- SEEDS (SAFE)
-- ============================================================

INSERT INTO database_meta (key, value)
VALUES
('schema_version', '"1.0.0"'),
('migration_version', '"0"'),
('last_import_from_jsonl', 'null'),
('retention_days', '90')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- FUNCTIONS
-- ============================================================

CREATE OR REPLACE FUNCTION is_ip_blacklisted(check_ip INET)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1
        FROM threat_indicators
        WHERE active = TRUE
          AND ip_value >>= check_ip
    );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION touch_threat_indicator(p_indicator_value TEXT)
RETURNS VOID AS $$
BEGIN
    UPDATE threat_indicators
    SET last_seen_at = NOW()
    WHERE value = p_indicator_value
      AND active = TRUE;
END;
$$ LANGUAGE plpgsql;