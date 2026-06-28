#!/usr/bin/env bash
set -euo pipefail

echo "[GROK] Bulk importing JSON dumps..."

# ALWAYS resolve script location safely
if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
    SCRIPT_DIR="$(pwd)"
fi

GROK_DIR="$SCRIPT_DIR/grok"

if [[ ! -d "$GROK_DIR" ]]; then
    echo "[GROK] ERROR: grok directory not found: $GROK_DIR" >&2
    exit 1
fi

cd "$SCRIPT_DIR"

# Load env if present (IMPORTANT)
ENV_FILE="$SCRIPT_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
    echo "[GROK] Loading env: $ENV_FILE"
    set -a
    source "$ENV_FILE"
    set +a
else
    echo "[GROK] No .env found at $ENV_FILE (continuing with defaults)"
fi

POSTGRES_USER="${POSTGRES_USER:-emerald}"
POSTGRES_DB="${POSTGRES_DB:-emerald_utilities}"

# Enable recursive globbing
shopt -s globstar nullglob

# Collect all .json files (including subdirs)
json_files=( "$GROK_DIR"/**/*.json )

if [[ ${#json_files[@]} -eq 0 ]]; then
    echo "[GROK] No JSON files found in $GROK_DIR"
    exit 0
fi

echo "[GROK] Found ${#json_files[@]} JSON file(s)."

for file in "${json_files[@]}"; do
    # Compute a safe, unique name based on relative path
    rel_path="${file#$GROK_DIR/}"                    # e.g., subdir/file.json
    safe_name="${rel_path//\//_}"                    # replace '/' with '_'

    echo "=== Importing $rel_path (as $safe_name) ==="

    docker cp "$file" emerald-postgres:/tmp/"$safe_name"

    docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<EOF
BEGIN;
WITH raw AS (
    SELECT pg_read_file('/tmp/$safe_name')::jsonb AS doc
)
INSERT INTO grok_raw_imports (filename, raw)
VALUES ('$safe_name', (SELECT doc FROM raw));
COMMIT;
EOF

    docker compose exec -T postgres rm -f "/tmp/$safe_name"
done

echo "[GROK] Bulk import finished."