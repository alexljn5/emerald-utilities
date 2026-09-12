#!/bin/bash
set -euo pipefail

echo "[GROK] Starting bulk import from grok/ folder..."

# Go to database folder
cd "$(dirname "$0")"

# Find .env in parent directory (project root)
ENV_FILE="../.env"
if [[ -f "$ENV_FILE" ]]; then
    echo "[GROK] Loading .env"
    set -a
    source "$ENV_FILE"
    set +a
fi

POSTGRES_USER="${POSTGRES_USER:-emerald-user}"
POSTGRES_DB="${POSTGRES_DB:-emerald_utilities}"

GROK_DIR="./grok"
if [[ ! -d "$GROK_DIR" ]]; then
    echo "[GROK] ERROR: grok/ directory not found" >&2
    exit 1
fi

for file in "$GROK_DIR"/*.json; do
    if [[ -f "$file" ]]; then
        echo "[GROK] Importing $file ..."
        docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
            SELECT import_grok_export('$(cat "$file" | sed "s/'/''/g")');
        " || echo "[GROK] Failed to import $file"
    fi
done

echo "[GROK] Bulk import finished."