# Emerald Utilities — Database Architecture

**Version:** 0.1.5
**Status:** Active  
**Last Updated:** 22 July 2026

---

## Overview

Emerald Utilities uses PostgreSQL 16 with pgvector for AI embeddings, running in a Docker container.

```
Emerald Utilities
        |
        |
        v
Docker Database Container
        |
        |
        v
Real production data
```

---

## Docker Configuration

Database runs in a Docker container defined in [`src/database/docker-compose.yml`](src/database/docker-compose.yml).

**Container details:**
- Image: PostgreSQL 16 with pgvector extension
- Port: mapped to host for local development
- Volume: persistent data storage in `database/volume-backups/`

---

## Credentials

**Never hardcode credentials.** All database credentials are stored in [`src/database/.env`](src/database/.env) (git-ignored).

Required environment variables:

| Variable | Purpose |
|----------|---------|
| `DB_HOST` | Database host (usually `localhost` or container name) |
| `DB_PORT` | Database port (usually `5432`) |
| `DB_DATABASE` | Database name |
| `DB_USERNAME` | Database user |
| `DB_PASSWORD` | Database password |

**Rules:**
- Never print passwords in logs.
- Never commit `.env` to version control.
- Use `.env.example` as a template.

---

## Connection

Database connections are managed in [`src/database/db-pool.js`](src/database/db-pool.js).

Connection rules:
1. Read credentials from `.env` only.
2. Use connection pooling for all queries.
3. Never create ad-hoc connections outside the pool.
4. Close pool gracefully on application shutdown.

---

## Startup Logging

Current database startup logging:

```
Database connected

Host: localhost
Database: emerald
Tables: users, posts, grok_messages
Connection: SUCCESS
```

**Rules:**
- Never print passwords in startup logs.
- Always log connection status (SUCCESS / FAILED).
- Log table count on successful connection.

---

## Migrations

Database schema is managed through SQL files in [`src/database/envy.sql`](src/database/envy.sql).

Migration rules:
1. All schema changes must be reflected in `envy.sql`.
2. Never modify schema directly in the database without updating `envy.sql`.
3. Run migrations through the application startup sequence.

---

## Backup System

Backups are stored in [`database/volume-backups/`](database/volume-backups/).

Backup rules:
1. Regular backups are automated through Docker volume management.
2. Backup files should be verified periodically.
3. Never delete backups without confirmation.

---

## Diagnostic Command

The application provides a database status diagnostic:

```
Database Status

Connected: YES
Database: emerald
Tables: 17
Rows:
  grok_messages: 16921
  users: 5
  posts: 142
Last backup: 2026-07-22
```

---

## Tables

Current database tables:

| Table | Purpose |
|-------|---------|
| `users` | Application users |
| `posts` | Creator Hub published posts |
| `grok_messages` | AI chat message history |
| `conversations` | Chat conversation threads |
| `settings` | User preferences |
| `scripts` | Saved scripts |
| `network_captures` | Network monitoring data |
| `portfolio_holdings` | Portfolio tracking |
| `rag_documents` | RAG document chunks |
| `rag_embeddings` | Vector embeddings for RAG |

---

## pgvector

pgvector is used for AI embeddings in the RAG system.

- Embeddings are stored in `rag_embeddings` table.
- Vector dimension: 384 (all-MiniLM-L6-v2)
- Index type: HNSW for approximate nearest neighbor search

---

## Data Verification

To verify database connectivity and data:

1. Check Docker container is running: `docker ps`
2. Check database logs: `docker logs <container-name>`
3. Run diagnostic from application settings
4. Verify table counts match expected values

---

## Security

- Database is not exposed to the internet.
- Only the local application can connect.
- Credentials are never transmitted outside the host.
- Backups are stored locally.
