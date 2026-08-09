# Emerald Utilities

![Emerald Utilities Logo](img/favicons/android-chrome-512x512.png)

**Version:** 0.1.2
**Author:** alexljn5
**License:** MIT

## Overview

Emerald Utilities is a personal desktop utility tool built with **Electron + React (Vite)**. It runs, schedules, and manages scripts (`.js`, `.sh`, `.bat`, `.ahk`, `.exe`) through a gothic, pixel-inspired interface, and provides a local **RAG (Retrieval-Augmented Generation)** assistant over scraped Grok/X conversations backed by **PostgreSQL + pgvector** and **Ollama** local models.

## Features

- **Script Management** — run, schedule (cron), and manage custom scripts.
- **Network Monitoring** — capture and analyze traffic via `tcpdump`, with blacklist/threat tracking.
- **Database Integration** — PostgreSQL (Dockerized) with JSONB storage and a JSON import pipeline.
- **RAG Assistant** — vector similarity search (pgvector) + local LLM answers (Ollama).
- **Internet Browser (XScraper)** — built-in browser that scrapes Grok/X conversations.
- **Portfolio Monitor** — price tracking via pluggable providers.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Electron App (desktop)                       │
│                                                                     │
│  Renderer (React / Vite)          Main process (heavensgate.js)     │
│  ┌───────────────────┐            ┌──────────────────────────────┐ │
│  │ Dashboard         │  IPC        │ ipcHandlers.js               │ │
│  │ Database / TheAI  │◄──────────► │ scriptManager / networkMgr   │ │
│  │ NetworkMonitoring │            │ db-pool.js (pg Pool)          │ │
│  │ ScriptTool        │            │ rag-query / rag-prepare       │ │
│  └───────────────────┘            └──────────────┬───────────────┘ │
└─────────────────────────────────────────────────┼─────────────────┘
                                                   │ LAN (TCP)
                        ┌──────────────────────────┼───────────────────────┐
                        │           Headless server (Arch Linux)            │
                        │                                                   │
                        │  ┌───────────────────────┐   ┌─────────────────┐ │
                        │  │ Docker: emerald-postgres│   │ Ollama (screen) │ │
                        │  │  PostgreSQL 16 +        │   │  nomic-embed-... │ │
                        │  │  pgvector               │◄──┤  llama3.2        │ │
                        │  │  DB: emerald_utilities  │   └─────────────────┘ │
                        │  └───────────────────────┘                        │
                        └───────────────────────────────────────────────────┘
```

**RAG data flow**

1. XScraper collects Grok/X conversations → JSON files.
2. `populate-from-raw.js` imports JSON into `grok_messages` (batched, idempotent).
3. `rag-prepare.js` calls Ollama to embed each message → `grok_messages.embedding vector(768)`.
4. `rag-query.js` embeds the user query, ranks rows by **cosine distance** (`<=>`) using the
   `idx_grok_messages_embedding_cosine` ivfflat index, and feeds top matches to the chat model.

## Prerequisites

- **Node.js 18+** (developed on 24.x).
- **Docker** (for the PostgreSQL + pgvector container).
- **Ollama** with the `nomic-embed-text` (embeddings) and `llama3.2` (chat) models pulled.

## Configuration

All runtime configuration lives in **`src/.env`** (git-ignored, single source of truth).
Copy the template and fill in real values:

```bash
cp src/database/.env.example src/.env
```

Key variables (see [`.env.example`](src/database/.env.example) for the full list):

| Variable | Purpose |
|---|---|
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | PostgreSQL connection |
| `AI_PROVIDER` | `ollama` \| `grok` \| `openai` \| `lmstudio` |
| `OLLAMA_HOST` | Ollama endpoint (e.g. `http://192.168.2.27:11434`) |
| `OLLAMA_EMBED_MODEL` / `OLLAMA_EMBED_DIM` | embedding model + dimension (default `nomic-embed-text` / `768`) |
| `OLLAMA_CHAT_MODEL` | chat model (default `llama3.2`) |
| `RAG_EMBED_BATCH` / `RAG_MAX_EMBED` | embedding batch size / optional per-run cap |
| `EMERALD_DEBUG` / `NO_COLOR` | verbose logs / disable ANSI colors |

> **Security note:** `dotenv` is loaded with `{ override: true }`, so `src/.env` **wins** over any
> machine-level environment variable (e.g. a system `OLLAMA_HOST` set by the Windows installer).
> Database credentials are **never** committed — `config.json` no longer stores the DB password.
> Cloud API keys can optionally be encrypted at rest with [`scripts/encrypt-secrets.js`](scripts/encrypt-secrets.js:1)
> (Electron `safeStorage`, machine-bound).

## Quick Start (development)

```bash
npm install

# Run the app (Vite + Electron)
npm run dev:electron
```

## Database & RAG setup

The PostgreSQL container is defined in [`src/database/docker-compose.yml`](src/database/docker-compose.yml:1)
and the schema in [`src/database/envy.sql`](src/database/envy.sql:1). The schema is **idempotent and
non-destructive** — it never drops a populated `embedding` column.

```bash
# Start the database container (cross-platform: Linux / macOS / WSL)
./src/internal-scripts/db-start.sh

# One-click RAG setup: ensures container, pgvector, embedding column,
# and the cosine ivfflat index (safe to re-run).
./src/internal-scripts/rag-setup.sh

# Import scraped JSON into grok_messages (idempotent, batched)
node src/database/populate-from-raw.js          # skips if already populated
node src/database/populate-from-raw.js --force  # import anyway

# Generate embeddings for ALL un-embedded messages (loops until done)
node src/database/rag-prepare.js
#   RAG_EMBED_BATCH=200 node src/database/rag-prepare.js   # tune batch size
#   RAG_MAX_EMBED=2000  node src/database/rag-prepare.js   # incremental cap

# Ask a question
node src/database/rag-query.js "your question here"

# Stop the database container
./src/internal-scripts/db-stop.sh
```

> **Vector index:** RAG ranking uses the cosine operator `<=>`, so the ANN index **must** use
> `vector_cosine_ops`. Both `envy.sql` and `rag-setup.sh` create
> `idx_grok_messages_embedding_cosine`. An L2 (`vector_l2_ops`) index cannot serve a `<=>` query and
> would silently fall back to a full sequential scan.

## Backup & restore

Volume-level backup/restore of the Docker Postgres data:

```bash
./src/internal-scripts/volume-backup.sh    # snapshot the postgres volume
./src/internal-scripts/volume-verify.sh    # verify a backup archive
./src/internal-scripts/volume-restore.sh   # restore from a backup
```

Logical (SQL) dump/restore:

```bash
# Dump
docker exec emerald-postgres pg_dump -U alexljn5 emerald_utilities > backup.sql

# Restore (into a fresh, empty database)
cat backup.sql | docker exec -i emerald-postgres psql -U alexljn5 -d emerald_utilities
```

> Re-applying [`src/database/envy.sql`](src/database/envy.sql:1) after a restore is safe: every
> statement uses `IF NOT EXISTS` / conditional `ALTER`, and the embedding column is never dropped.

## Testing

Tests use Node's built-in test runner — **no extra dependency**.

```bash
npm test              # unit tests (fast, no external services)
npm run test:unit     # same as above
npm run test:integration   # DB + Ollama; SKIPS gracefully if unreachable
```

- **Unit tests** ([`tests/unit`](tests/unit)) cover logger secret-redaction, `chunkText`, and
  grok JSON parsing. They run with plain Node (no Electron / DB).
- **Integration tests** ([`tests/integration`](tests/integration)) connect to the live DB / Ollama
  using `src/.env`. They are **non-destructive** (read-only) and **auto-skip** when the target is
  offline, so `npm run test:integration` never fails a CI/dev run just because the server is down.

See [`tests/README.md`](tests/README.md) for details.

## Build

```bash
npm run build:win    # Windows (NSIS)
npm run build:linux  # Linux (AppImage)
npm run build:all    # macOS + Windows + Linux
```

## Project layout

```
src/
  heavensgate.js        Electron main entry
  utils/                logger, IPC handlers, path resolver
  database/             db-pool, RAG (query/prepare/chunk), schema (envy.sql), docker-compose
  internal-scripts/     db-start/stop, rag-setup, volume backup/restore (cross-platform bash)
  pages/ core/ css/     React renderer, feature modules, styles
  scrapers/xscraper/    browser extension + local server for scraping
tests/                  unit + integration tests, fixtures
scripts/                encrypt-secrets and misc tooling
```

## Maintenance notes

- **Dependency pins:** several `devDependencies` are pinned to `"latest"`
  (`@vitejs/plugin-react`, `concurrently`, `cross-env`, `vite`, `wait-on`). This eases updates but
  makes builds non-deterministic. For reproducible builds, pin these to explicit versions and rely
  on `package-lock.json`.
- **Idempotency / safety:** DB scripts and schema are designed to be re-run safely and will never
  destroy populated embeddings. Any dimension change is only auto-applied to an **empty** column.

## Documentation

See [DOCUMENTATION.md](DOCUMENTATION.md) for extended architecture and usage information (if present).
