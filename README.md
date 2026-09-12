<div align="center">

![Emerald Utilities Logo](img/favicons/android-chrome-512x512.png)

# Emerald Utilities

**Version:** 0.1.8
**Author:** alexljn5
**License:** Proprietary — All Rights Reserved
**Platform:** Windows · Linux · macOS

[![Electron](https://img.shields.io/badge/Electron-37.2.5-47848F?logo=electron)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19.2.7-61DAFB?logo=react)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-8.1.5-646CFF?logo=vite)](https://vitejs.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql)](https://www.postgresql.org/)
[![pgvector](https://img.shields.io/badge/pgvector-0.7-00C7B7?logo=postgresql)](https://github.com/pgvector/pgvector)
[![Ollama](https://img.shields.io/badge/Ollama-local-000000?logo=ollama)](https://ollama.com/)

</div>

## Overview

Emerald Utilities is a personal desktop utility platform built with **Electron + React + Vite**.

It provides a single application for running and scheduling scripts, monitoring network activity, managing PostgreSQL-backed application data, operating an AI/RAG assistant, scraping supported web content, monitoring portfolio data, and managing creator-oriented integrations.

The project is designed primarily for personal use and self-hosted infrastructure. Remote services can be reached over a private network such as Tailscale without embedding deployment-specific network details into the application source.

## Features

* **Script Management** — Run, schedule, discover, and manage custom scripts including `.js`, `.sh`, `.bat`, `.ahk`, and `.exe`.
* **Network Monitoring** — Capture and analyze traffic with `tcpdump`, including blacklist and threat-indicator tracking.
* **Database Integration** — PostgreSQL 16 with pgvector, JSONB storage, migrations, and JSON import/synchronization workflows.
* **RAG Assistant ("The AI")** — Vector similarity search using pgvector combined with an Ollama-backed language model.
* **Internet Browser / XScraper** — Built-in browser tooling for collecting supported conversation and web data.
* **Portfolio Monitor** — Price tracking through pluggable providers.
* **Creator Hub** — Multi-platform publishing integrations including Bluesky, Threads, TikTok, YouTube, Instagram, and Facebook.

## Architecture

```text
┌──────────────────────────────────────────────────────────────────┐
│                         Electron App                             │
│                                                                  │
│  Renderer (React / Vite)              Main Process               │
│  ┌─────────────────────┐             ┌────────────────────────┐ │
│  │ Dashboard           │    IPC      │ IPC handlers           │ │
│  │ Database / The AI   │◄───────────►│ Script Manager          │ │
│  │ Network Monitoring  │             │ Network Manager         │ │
│  │ Script Tool         │             │ Database / pg Pool      │ │
│  │ Creator Hub         │             │ RAG / AI services        │ │
│  └─────────────────────┘             │ XScraper services        │ │
│                                      └────────────┬───────────┘ │
└───────────────────────────────────────────────────┼────────────┘
                                                    │
                                      Private network / Tailscale
                                                    │
                         ┌──────────────────────────┴─────────────┐
                         │             Remote services           │
                         │                                       │
                         │  PostgreSQL 16 + pgvector             │
                         │  Ollama                                │
                         │  Other optional self-hosted services  │
                         └────────────────────────────────────────┘
```

Emerald Utilities does not manage or authenticate Tailscale itself. Tailscale is treated as external OS/network infrastructure. Emerald only connects to the configured service host and port.

## RAG Data Flow

1. XScraper collects supported conversation data into local JSON/storage.
2. `populate-from-raw.js` imports suitable data into `grok_messages`.
3. `rag-prepare.js` requests embeddings from the configured embedding provider.
4. Embeddings are stored in `grok_messages.embedding`.
5. `rag-query.js` embeds a user query and ranks matching rows using cosine distance.
6. Relevant context is supplied to the configured chat model.
7. Conversation state is persisted separately from context selection.

The database remains the canonical complete conversation history. Context assembly determines what information is supplied to the model for an individual request.

## Prerequisites

* **Node.js 18+** — developed with modern Node.js releases.
* **Docker** — required when running PostgreSQL locally through the included container configuration.
* **PostgreSQL 16 + pgvector** — required for database-backed RAG functionality.
* **Ollama** — required for the default local/self-hosted AI provider.
* Ollama models appropriate to your configuration, such as:

  * `nomic-embed-text`
  * your configured chat model

## Configuration

Runtime configuration is kept outside tracked source files.

The preferred arrangement is:

```text
Tracked:
    src/.env.example
    safe application defaults
    source code

Local:
    src/.env
    private AI state
    local runtime state
    deployment-specific settings
```

The real `src/.env` file must remain Git-ignored.

Create it from the template:

```bash
cp src/.env.example src/.env
```

If the project distribution uses another template location, follow the path documented by that installation.

### Database Configuration

Database connection values are deployment-specific and should be supplied through environment variables:

```env
DB_HOST=<server-hostname>
DB_PORT=5432
DB_NAME=emerald_utilities
DB_USER=<database-user>
DB_PASSWORD=<database-password>
```

The database name `emerald_utilities` is the application's default database name and is not considered a secret.

The actual host, username, and password depend on the installation and must not be hard-coded into tracked source files.

### AI Configuration

Example runtime settings may include:

```env
AI_PROVIDER=ollama
OLLAMA_HOST=http://<server-hostname>:11434
OLLAMA_EMBED_MODEL=nomic-embed-text
OLLAMA_CHAT_MODEL=<chat-model>
```

Cloud providers may use separate environment variables for their credentials where supported.

Never commit:

* API keys
* database passwords
* authentication tokens
* session cookies
* private deployment configuration
* private conversation data

### Configuration Precedence

Where supported by the application, configuration follows this general precedence:

```text
Environment variables
        ↓
Local runtime configuration
        ↓
Safe application defaults
```

Environment-specific values should therefore be supplied locally rather than embedded in the public repository.

## Quick Start

Install dependencies:

```bash
npm install
```

Start the development application:

```bash
npm run dev:electron
```

Alternatively, use the project's development startup script where provided:

```bash
sh start_dev.sh
```

## Database and RAG Setup

The project includes PostgreSQL Docker configuration under:

```text
src/database/docker-compose.yml
```

The database schema is defined in:

```text
src/database/envy.sql
```

The schema and supporting scripts are designed to be re-runnable and avoid destructive replacement of populated embedding data.

### Start PostgreSQL

```bash
./src/internal-scripts/db-start.sh
```

### Configure RAG

```bash
./src/internal-scripts/rag-setup.sh
```

### Import Scraped Data

```bash
node src/database/populate-from-raw.js
```

Force import:

```bash
node src/database/populate-from-raw.js --force
```

### Generate Embeddings

```bash
node src/database/rag-prepare.js
```

Optional batch tuning:

```bash
RAG_EMBED_BATCH=200 node src/database/rag-prepare.js
```

Optional per-run limit:

```bash
RAG_MAX_EMBED=2000 node src/database/rag-prepare.js
```

### Query the RAG System

```bash
node src/database/rag-query.js "your question here"
```

### Stop PostgreSQL

```bash
./src/internal-scripts/db-stop.sh
```

## Vector Index

RAG similarity search uses the PostgreSQL cosine-distance operator:

```sql
<=>
```

The corresponding ANN index uses:

```text
vector_cosine_ops
```

The expected index is:

```text
idx_grok_messages_embedding_cosine
```

Using an incompatible operator class can prevent PostgreSQL from using the intended ANN index efficiently.

## Database Architecture

The database layer is centered around a shared PostgreSQL connection pool.

The application separates:

* database connectivity
* database health checking
* persistence
* context assembly
* RAG retrieval
* AI provider configuration

Application code should use the database abstraction rather than depending on a specific network topology.

Remote infrastructure can therefore be used without embedding a particular private network address into the application source.

## Database Schema

Core database tables include:

| Table                   | Purpose                                |
| ----------------------- | -------------------------------------- |
| `network_packet_events` | Captured network event data            |
| `threat_indicators`     | Network threat intelligence            |
| `grok_conversations`    | AI conversation threads                |
| `grok_raw_imports`      | Raw imported conversation data         |
| `grok_messages`         | AI message history and embeddings      |
| `notes`                 | Notes                                  |
| `tasks`                 | Tasks                                  |
| `task_tags`             | Task/tag relationships                 |
| `subtasks`              | Subtasks                               |
| `xscraper_sync_state`   | Durable XScraper synchronization state |
| `database_meta`         | Database migration/version metadata    |

## PostgreSQL and pgvector

The RAG embedding column uses:

```text
vector(768)
```

when configured for a compatible 768-dimensional embedding model.

The system is designed to avoid destructive replacement of an existing populated embedding column. Dimension changes must be handled explicitly and safely.

## Database Health

The database health system reports non-secret connection information such as:

* host
* port
* database
* user
* connection status
* PostgreSQL version
* pgvector availability

Passwords and other credential material must never be written to logs or health-check output.

Preflight diagnostics:

```bash
node src/database/scripts/db-preflight.js
```

## Backup and Restore

Database backups should be maintained outside the public repository.

Available helper scripts include:

```bash
./src/internal-scripts/volume-backup.sh
./src/internal-scripts/volume-verify.sh
./src/internal-scripts/volume-restore.sh
```

Logical PostgreSQL dumps should use the runtime-configured database credentials rather than embedding usernames or passwords in documentation.

For example:

```bash
docker exec emerald-postgres pg_dump -U "$DB_USER" "$DB_NAME" > backup.sql
```

Restore:

```bash
cat backup.sql | docker exec -i emerald-postgres psql -U "$DB_USER" -d "$DB_NAME"
```

Do not commit database dumps, volume archives, or other database contents to the repository.

## Private AI State

Some AI state is intentionally local and is not part of the public source tree.

The following files may contain private runtime AI data:

```text
src/database/character-sheets.js
src/database/ai-context.js
```

These files are intentionally Git-ignored.

Public templates may be provided as:

```text
src/database/character-sheets.example.js
src/database/ai-context.example.js
```

After cloning the repository, create the local files by copying the templates and then customize them locally.

The private files must never be committed.

See:

```text
docs/AI_STATE_SETUP.md
```

for the setup procedure.

## Testing

The project uses Node's built-in test runner.

Run unit tests:

```bash
npm test
```

or:

```bash
npm run test:unit
```

Integration tests:

```bash
npm run test:integration
```

Integration tests may depend on the configured PostgreSQL and Ollama services and should degrade gracefully when those services are unavailable.

Unit tests cover project utilities and parsing/validation logic without requiring the live infrastructure.

## Build

Windows:

```bash
npm run build:win
```

Linux:

```bash
npm run build:linux
```

All supported targets:

```bash
npm run build:all
```

## Project Layout

```text
src/
├── heavensgate.js          Electron main entry
├── preload.js              IPC bridge
├── main.jsx                React entry
├── index.html              Vite shell
│
├── utils/                  Shared utilities, logging, configuration, paths
├── core/                   Core application services
├── creator-hub/            Social publishing integrations
├── css/                    Global and feature styles
├── database/               PostgreSQL, RAG, schema, migrations
├── internal-scripts/       Database and maintenance scripts
├── pages/                  React application pages
├── portfolio/              Portfolio providers
├── scrapers/               XScraper and related tooling
├── services/               Backend integrations
├── tasks/                  Task scheduling and synchronization
└── mascot/                 Application mascot assets

tests/
├── unit/
└── integration/

scripts/                    Development and maintenance tooling
docs/                       Extended documentation
img/                        Logos, favicons, mascots, backgrounds
fonts/                      Application fonts
```

## Security and Privacy

Emerald Utilities is designed to operate with private/local runtime configuration while keeping the public source tree free of deployment secrets.

Never commit:

```text
.env
database passwords
API keys
session tokens
authentication cookies
private conversation exports
database dumps
SQLite/PostgreSQL runtime databases
private AI state
private character sheets
private deployment addresses
machine-specific secret configuration
```

Use `.env.example` and other example/template files for public documentation.

Public configuration examples should use placeholders such as:

```text
<server-hostname>
<database-user>
<database-password>
<api-key>
```

rather than real deployment values.

## Maintenance Notes

Some development dependencies may intentionally track recent releases. This simplifies maintenance but can make builds less deterministic.

For reproducible releases:

* pin dependency versions
* preserve `package-lock.json`
* validate builds in a clean environment

Database scripts and schema migrations should remain idempotent wherever practical and must avoid destructive changes to populated RAG data.

The Vite development server uses a local loopback development address for the renderer. This is separate from the network configuration used by remote database or AI services.

## License

This project is **proprietary software**.

All rights are reserved by alexljn5. Unauthorized copying, modification, distribution, or use of this software, via any medium, is prohibited.

See [LICENSE](LICENSE) for the full terms.

## Dependency Licenses

Emerald Utilities incorporates open-source software subject to their respective licenses.

| Dependency        | License       |
| ----------------- | ------------- |
| Electron          | MIT           |
| React             | MIT           |
| React DOM         | MIT           |
| Vite              | MIT           |
| Express           | MIT           |
| PostgreSQL (`pg`) | MIT           |
| SQLite3           | Public Domain |
| dotenv            | BSD-2-Clause  |
| node-notifier     | MIT           |
| adm-zip           | MIT           |
| cors              | MIT           |
| body-parser       | MIT           |
| uuid              | MIT           |

All other dependencies remain subject to their respective upstream licenses.

The proprietary license applies only to original code authored for Emerald Utilities and does not override the licenses of third-party components.

## Documentation

See [DOCUMENTATION.md](docs/DOCUMENTATION.md) for extended architecture and usage information.
