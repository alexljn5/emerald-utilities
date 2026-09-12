# Database Architecture

## Overview

The Emerald Utilities database is a self-contained PostgreSQL + pgvector deployment located at `src/database/`.

```
emerald-utilities/
└── src/
    └── database/
        ├── docker-compose.yml      # Compose configuration (single PostgreSQL)
        ├── envy.sql                # RAG/infrastructure schema (fresh init)
        ├── merge-sins.sh           # Canonical schema/migration updater
        ├── start_postgres.sh       # Repository-side startup script
        ├── stop_db.sh              # Stop script (preserves data)
        ├── .env.example            # Environment template
        ├── .env                    # Actual config (git-ignored)
        ├── migrations/             # Explicit migration files
        │   └── README.md
        ├── tasks/
        │   ├── pride.sql           # Tasks/notes schema (fresh init)
        │   ├── docker-compose.yml.disabled  # DISABLED — prevents second container
        │   ├── start_tasks_database.sh.disabled  # DISABLED
        │   ├── tasks-db.js         # Task DB connection (uses main DB)
        │   ├── tasks-service.js    # Task CRUD operations
        │   └── ...
        ├── scripts/
        │   ├── db-status.sh        # Read-only status report
        │   ├── db-backup.sh        # pg_dump logical backup
        │   ├── db-restore.sh       # Restore from backup (destructive)
        │   └── db-migrate.sh       # Manual migration runner
        └── ...
```

## Components

### PostgreSQL Container

- **Image**: `pgvector/pgvector:pg16`
- **Container**: `emerald-postgres`
- **Restart policy**: `unless-stopped`
- **Port**: `${POSTGRES_PORT:-5432}:5432`

### Persistent Volume

- **Name**: `database_postgres_data`
- **Type**: External named Docker volume
- **Mount**: `/var/lib/postgresql/data`
- **Safety**: `external: true` in Compose means Docker will never create or destroy it

### Schemas

| File | Purpose | When Applied |
|------|---------|--------------|
| `envy.sql` | RAG/infrastructure (tables, indexes, functions, extensions) | Fresh init only |
| `tasks/pride.sql` | Tasks/notes (notes, tasks, task_tags, triggers) | Fresh init only |
| `migrations/*.sql` | Explicit schema changes | Existing databases only |

### Application Connection

The Electron application connects via `db-pool.js` with this precedence:

1. Environment variables (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`)
2. `config.json` → `database.{host,port,database,user,password}`
3. Hardcoded safe defaults

The tasks application (`tasks-db.js`) connects via:
1. `TASKS_DATABASE_URL` environment variable
2. Local Docker container (disabled — use main DB instead)
3. JSON file fallback

This allows switching between remote and homelab databases by changing `.env` only.

## Data Flow

```
Application (Electron)
        │
        ▼
db-pool.js / tasks-db.js (connection resolution)
        │
        ▼
PostgreSQL Container (emerald-postgres)
        │
        ▼
Docker Volume (database_postgres_data)
        │
        ▼
Persistent Storage
```

## Safety Guarantees

1. **Volume preservation**: The external volume is never recreated by Compose
2. **Init-only schemas**: `envy.sql` and `tasks/pride.sql` only run on first init of an empty volume
3. **Explicit migrations**: Schema changes to existing databases require explicit migration files
4. **Backup before migration**: `merge-sins.sh` creates a backup before applying any migration
5. **No automatic destruction**: No script contains `docker compose down -v` or `docker volume rm`
6. **Single database**: Only one PostgreSQL container. The disabled `tasks/docker-compose.yml` prevents accidental second containers.

## Startup Architecture

```
Homelab cron
    │
    ▼
<server-hostname>/<server-hostname>_scripts/start_emerald_database.sh
    │
    ▼
cd ~/emerald-utilities/src/database
    │
    ▼
docker compose up -d
    │
    ▼
src/database/merge-sins.sh
    │
    ├── Fresh DB: applies envy.sql + tasks/pride.sql
    ├── Existing DB: applies pending migrations
    └── Verification (extensions, tables, indexes)
    │
    ▼
Database ready
```
