#!/bin/bash

# Emerald Utilities - Development launcher
#
# Runs `npm run dev:electron` which is just `vite`. The vite-plugin-electron
# (see vite.config.js) automatically spawns Electron with hot reload, so we must
# NOT also run `electron .` here — doing so would launch a second app.
#
# The Portfolio Monitor page reads the EODHD key from src/.env (EODHD_API),
# scripts/config.json ("apiKey"), or the EODHD_API_KEY env variable.

# Check if node_modules exists, if not install dependencies
if [ ! -d "node_modules" ]; then
    echo "node_modules not found. Installing dependencies..."
    npm install
else
    echo "Dependencies already installed."
fi

echo "Freeing port 5173 (Vite) if in use..."
if command -v npx >/dev/null 2>&1; then
    npx --yes kill-port 5173 2>/dev/null || true
fi

echo "Starting Emerald Utilities (vite + vite-plugin-electron)..."
npm run dev:electron
