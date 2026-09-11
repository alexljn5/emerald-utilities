# Emerald Utilities — Database Architecture

**Version:** 0.1.6
**Status:** Active
**Last Updated:** 11 September 2026

---

## Overview

Emerald Utilities uses PostgreSQL 16 with pgvector for AI embeddings, running in a Docker container on the homelab server (`INFHUB-Server`).

The development machine reaches the database through the private Tailscale mesh network. Tailscale is OS-level infrastructure only — Emerald never starts, stops, or authenticates it.

```
Emerald Utilities
        |
        |
        v
PostgreSQL (Docker on INFHUB-Server)
        ↑
   Tailscale mesh (encrypted WireGuard)
        ↑
Development machine (Tailscale daemon)
```

---

## Connection Layer

### `src/database/db-pool.js`

Shared `pg` Pool used by all modules. Connection precedence (highest wins):

1. Environment variables (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`)
2. `config.json` → `database.{host,port,database,user,password}`
3. Safe hardcoded defaults (`127.0.0.1:5432`)

The pool is created once and shared. `connectionTimeoutMillis` makes the app fail fast instead of hanging when the DB host is unreachable.

### `src/database/database.js`

Clean abstraction boundary between application logic and PostgreSQL:

- `database.connect()` — return the shared pool
- `database.query(text, params)` — execute SQL
- `database.healthCheck()` — full health report (PG version, pgvector)
- `database.getConnectionInfo()` — sanitized connection info (no password)
- `database.ping()` — simple reachability check

Application code should depend on this abstraction, NOT on Tailscale or a specific network topology.

---

## Configuration

All database settings are environment-driven. Never hardcode hosts or credentials.

| Variable | Purpose | Example |
|----------|---------|---------|
| `DB_HOST` | Database host | `infhub-server` (MagicDNS) |
| `DB_PORT` | Database port | `5432` |
| `DB_NAME` | Database name | `emerald_utilities` |
| `DB_USER` | Database user | `alexljn5` |
| `DB_PASSWORD` | Database password | (git-ignored) |

For local development: `DB_HOST=127.0.0.1`.

See [`docs/TAILSCALE_BRIDGE.md`](./TAILSCALE_BRIDGE.md) for the Tailscale bridge setup.

---

## Docker Configuration

Database runs in a Docker container defined in `src/database/docker-compose.yml`.

**Container details:**
- Image: `pgvector/pgvector:pg16`
- Container name: `emerald-postgres`
- Port: mapped to host for local development
- Volume: persistent data in external named volume `database_postgres_data`
- Restart: `unless-stopped`

---

## Schema

Schema is managed through SQL migrations applied by `merge-sins.sh` (invoked automatically by `start_postgres.sh`).

### Fresh initialization

For a brand new database (empty volume), these are applied automatically by PostgreSQL's `/docker-entrypoint-initdb.d/` mechanism:

- `envy.sql` — core schema (network events, grok messages, RAG, meta)
- `tasks/pride.sql` — tasks schema (notes, tasks, task_tags)

### Incremental migrations

Migrations in `src/database/migrations/` are applied to existing databases only. The migration version is tracked in `database_meta.migration_version`.

| File | Purpose |
|------|---------|
| `001_add_task_sync_meta.sql` | JSON ↔ PostgreSQL sync metadata |
| `002_add_json_id_columns.sql` | JSON id columns for idempotent sync |
| `003_create_tasks_tables.sql` | notes, tasks, task_tags tables |
| `004_fix_ip_blacklisted_volatility.sql` | IP blacklist volatility fix |
| `005_xscraper_message_identity.sql` | XScraper identity + sync state |
| `006_add_notification_policy.sql` | Notification policy |
| `007_add_subtasks.sql` | Subtasks table |
| `008_add_subtask_deadlines.sql` | Subtask deadlines |

---

## Tables

| Table | Purpose |
|-------|---------|
| `network_packet_events` | Network capture data (tcpdump) |
| `threat_indicators` | IP/domain threat intelligence |
| `grok_conversations` | AI chat conversation threads |
| `grok_raw_imports` | Raw Grok export dumps (JSONB) |
| `grok_messages` | AI chat message history + embeddings |
| `notes` | Daily notes |
| `tasks` | Task list |
| `task_tags` | Task tag assignments |
| `subtasks` | Subtasks linked to parent tasks |
| `xscraper_sync_state` | Durable XScraper sync checkpoints |
| `database_meta` | Schema/migration version tracking |

---

## pgvector

pgvector powers RAG similarity search over `grok_messages.embedding`.

- Embedding column: `vector(768)` (matches `nomic-embed-text` via Ollama)
- Index type: `ivfflat` with `vector_cosine_ops` (required for `<=>` cosine distance)
- Index name: `idx_grok_messages_embedding_cosine`

The embedding column is added conditionally — it NEVER drops an existing column (that would destroy stored vectors). Dimension mismatches are detected and handled safely.

---

## Health Check

`checkDbHealth()` in `db-pool.js` reports:

- Host, port, database name, user (NEVER the password)
- Connection status
- PostgreSQL version
- pgvector availability

Standalone preflight script: `node src/database/scripts/db-preflight.js`

---

## Backup System

Backups are stored in `database/volume-backups/`.

Backup rules:
1. Regular backups are automated through Docker volume management
2. Backup files should be verified periodically
3. Never delete backups without confirmation

---

## Security

- Database is reachable only through the private Tailscale network
- NOT exposed to the public internet
- No router port-forward for PostgreSQL (5432)
- No `0.0.0.0/0` in `pg_hba.conf`
- Credentials are never committed (git-ignored `.env`)
- Credentials are never printed in logs or health checks
- Backups are stored locally
