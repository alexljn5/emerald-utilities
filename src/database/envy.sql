-- ============================================================
-- Emerald Utilities - PostgreSQL JSONB Initialization Script
-- ============================================================
-- This script runs automatically when the PostgreSQL container
-- starts for the first time (via docker-entrypoint-initdb.d).
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- Table: network_packet_events
-- Stores every captured packet as a JSONB document plus
-- extracted fields for fast querying.
-- ============================================================
CREATE TABLE IF NOT EXISTS network_packet_events (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    captured_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source              TEXT NOT NULL DEFAULT 'tcpdump',
    interface_name      TEXT NOT NULL DEFAULT 'any',
    direction           TEXT,
    protocol            TEXT,
    transport_protocol  TEXT,
    source_ip           INET,
    destination_ip      INET,
    source_port         INTEGER,
    destination_port    INTEGER,
    packet_length       INTEGER,
    is_blacklisted      BOOLEAN NOT NULL DEFAULT FALSE,
    severity            TEXT NOT NULL DEFAULT 'none',
    payload             JSONB NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Table: threat_indicators
-- Stores IP indicators, threat lists, and metadata.
-- ============================================================
CREATE TABLE IF NOT EXISTS threat_indicators (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    indicator_type  TEXT NOT NULL DEFAULT 'ipv4',
    value           TEXT NOT NULL,
    ip_value        INET,
    source_name     TEXT NOT NULL DEFAULT 'local-blacklist',
    confidence      INTEGER NOT NULL DEFAULT 50 CHECK (confidence >= 0 AND confidence <= 100),
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata        JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Table: grok_conversations
-- Stores X/Grok conversation metadata.
-- ============================================================
CREATE TABLE IF NOT EXISTS grok_conversations (
    id              TEXT PRIMARY KEY,
    title           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    message_count   INTEGER NOT NULL DEFAULT 0,
    last_scraped    TIMESTAMPTZ,
    metadata        JSONB
);

-- ============================================================
-- Table: grok_messages
-- Stores X/Grok messages with JSONB payload.
-- ============================================================
CREATE TABLE IF NOT EXISTS grok_messages (
    id                  TEXT PRIMARY KEY,
    conversation_id     TEXT NOT NULL REFERENCES grok_conversations(id) ON DELETE CASCADE,
    content             TEXT NOT NULL,
    author              TEXT NOT NULL,
    timestamp           TIMESTAMPTZ,
    scraped_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Table: database_meta
-- Stores application-level metadata.
-- ============================================================
CREATE TABLE IF NOT EXISTS database_meta (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Indexes for network_packet_events
-- ============================================================

-- Fast recent-log views
CREATE INDEX IF NOT EXISTS idx_packet_events_captured_at_desc
    ON network_packet_events (captured_at DESC);

-- Filter by attacker/source host
CREATE INDEX IF NOT EXISTS idx_packet_events_source_ip
    ON network_packet_events (source_ip);

-- Filter by contacted host
CREATE INDEX IF NOT EXISTS idx_packet_events_destination_ip
    ON network_packet_events (destination_ip);

-- Filter by protocol
CREATE INDEX IF NOT EXISTS idx_packet_events_protocol
    ON network_packet_events (protocol);

-- Filter by TCP/UDP/ICMP
CREATE INDEX IF NOT EXISTS idx_packet_events_transport_protocol
    ON network_packet_events (transport_protocol);

-- Show suspicious traffic only
CREATE INDEX IF NOT EXISTS idx_packet_events_blacklisted
    ON network_packet_events (is_blacklisted);

-- Search inside JSONB payload (GIN index)
CREATE INDEX IF NOT EXISTS idx_packet_events_payload_gin
    ON network_packet_events USING GIN (payload);

-- Composite index for common query patterns
CREATE INDEX IF NOT EXISTS idx_packet_events_captured_at_blacklisted
    ON network_packet_events (captured_at DESC, is_blacklisted)
    WHERE is_blacklisted = TRUE;

-- ============================================================
-- Indexes for threat_indicators
-- ============================================================

-- Fast blacklist matching
CREATE INDEX IF NOT EXISTS idx_threat_indicators_active_ip
    ON threat_indicators (active, ip_value)
    WHERE active = TRUE;

-- Fast lookup by indicator value
CREATE INDEX IF NOT EXISTS idx_threat_indicators_value
    ON threat_indicators (value);

-- ============================================================
-- Indexes for grok_conversations
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_grok_conversations_last_updated
    ON grok_conversations (last_updated DESC);

-- ============================================================
-- Indexes for grok_messages
-- ============================================================
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
-- Seed threat_indicators from existing blackisted-ips.json
-- ============================================================
INSERT INTO threat_indicators (indicator_type, value, ip_value, source_name, confidence, active)
SELECT
    'ipv4',
    ip,
    ip::inet,
    'local-blacklist',
    80,
    TRUE
FROM UNNEST(ARRAY[
    '13.64.90.137','13.66.56.243','13.68.31.193','13.68.82.8','13.68.92.143',
    '13.68.233.9','13.69.109.130','13.69.109.131','13.69.131.175','13.73.26.107',
    '13.74.169.109','13.78.130.220','13.78.232.226','13.78.233.133','13.88.21.125',
    '13.92.194.212','13.104.215.69','13.105.28.32','13.105.28.48','20.44.86.43',
    '20.49.150.241','20.54.232.160','20.60.20.4','20.69.137.228','20.190.169.24',
    '20.190.169.25','23.99.49.121','23.102.4.253','23.102.5.5','23.102.21.4',
    '23.103.182.126','40.68.222.212','40.69.153.67','40.70.184.83','40.70.220.248',
    '40.77.228.47','40.77.228.87','40.77.228.92','40.77.232.101','40.78.128.150',
    '40.79.85.125','40.88.32.150','40.112.209.200','40.115.3.210','40.115.119.185',
    '40.119.211.203','40.124.34.70','40.126.41.96','40.126.41.160','51.104.136.2',
    '51.105.218.222','51.140.40.236','51.140.157.153','51.143.53.152','51.143.111.7',
    '51.143.111.81','51.144.227.73','52.138.204.217','52.147.198.201','52.155.94.78',
    '52.157.234.37','52.158.208.111','52.164.241.205','52.169.189.83','52.170.83.19',
    '52.174.22.246','52.178.147.240','52.178.151.212','52.178.223.23','52.182.141.63',
    '52.183.114.173','52.184.221.185','52.229.39.152','52.230.85.180','52.230.222.68',
    '52.236.42.239','52.236.43.202','52.255.188.83','65.52.100.7','65.52.100.9',
    '65.52.100.11','65.52.100.91','65.52.100.92','65.52.100.93','65.52.100.94',
    '65.52.161.64','65.55.29.238','65.55.83.120','65.55.113.11','65.55.113.12',
    '65.55.113.13','65.55.176.90','65.55.252.43','65.55.252.63','65.55.252.70',
    '65.55.252.71','65.55.252.72','65.55.252.93','65.55.252.190','65.55.252.202',
    '66.119.147.131','104.41.207.73','104.42.151.234','104.43.137.66','104.43.139.21',
    '104.43.139.144','104.43.140.223','104.43.193.48','104.43.228.53','104.43.228.202',
    '104.43.237.169','104.45.11.195','104.45.214.112','104.46.1.211','104.46.38.64',
    '104.46.162.224','104.46.162.226','104.210.4.77','104.210.40.87','104.210.212.243',
    '104.214.35.244','104.214.78.152','131.253.6.87','131.253.6.103','131.253.34.230',
    '131.253.34.234','131.253.34.237','131.253.34.243','131.253.34.246','131.253.34.247',
    '131.253.34.249','131.253.34.252','131.253.34.255','131.253.40.37','134.170.30.202',
    '134.170.30.203','134.170.30.204','134.170.30.221','134.170.52.151','134.170.235.16',
    '157.56.74.250','157.56.91.77','157.56.106.184','157.56.106.185','157.56.106.189',
    '157.56.113.217','157.56.121.89','157.56.124.87','157.56.149.250','157.56.194.72',
    '157.56.194.73','157.56.194.74','168.61.24.141','168.61.146.25','168.61.149.17',
    '168.61.161.212','168.61.172.71','168.62.187.13','168.63.100.61','168.63.108.233',
    '191.236.155.80','191.237.218.239','191.239.50.18','191.239.50.77','191.239.52.100',
    '191.239.54.52','207.68.166.254'
]) AS ip
ON CONFLICT (value) DO NOTHING;

-- ============================================================
-- Seed database_meta with initial values
-- ============================================================
INSERT INTO database_meta (key, value) VALUES
    ('schema_version', '"1.0.0"'),
    ('migration_version', '"0"'),
    ('last_import_from_jsonl', 'null'),
    ('retention_days', '90')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- Helper function: check if IP is blacklisted
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

-- ============================================================
-- Helper function: update threat indicator last_seen_at
-- ============================================================
CREATE OR REPLACE FUNCTION touch_threat_indicator(p_indicator_value TEXT)
RETURNS VOID AS $$
BEGIN
    UPDATE threat_indicators
    SET last_seen_at = NOW()
    WHERE value = p_indicator_value
      AND active = TRUE;
END;
$$ LANGUAGE plpgsql;
