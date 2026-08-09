-- ============================================================
-- Migration 004: Fix is_ip_blacklisted function volatility
-- ============================================================
-- The function should be STABLE (not IMMUTABLE) because it reads
-- from the threat_indicators table which can change over time.
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
$$ LANGUAGE plpgsql STABLE;
