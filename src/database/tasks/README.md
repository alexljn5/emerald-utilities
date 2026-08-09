# Tasks Database

Minimal PostgreSQL database for the Tasks feature (virtual sticky notes with reminders).

## Connection Strategy

The Tasks feature prefers the **remote homelab database** and falls back to a **local Docker container** if the remote is unreachable.

### Remote Database

Set `TASKS_DATABASE_URL` in `.env`:

```
TASKS_DATABASE_URL=postgres://user@192.168.2.27:5432/emerald_utilities
```

When the remote is reachable, the UI shows:

```
[Tasks DB] Connected: remote
```

### Local Fallback

If the remote PostgreSQL is unreachable, the application automatically:

1. Finds `docker-compose.yml` in this directory (`src/database/tasks/`)
2. Starts the database: `docker compose up -d`
3. Detects the postgres service/container dynamically from the compose file (no hardcoded names)
4. Connects locally

The UI shows:

```
[Tasks DB] Connected: local fallback
```

## Schema

See [`schema.sql`](schema.sql). Tables:

- `notes` — dated sticky-note style notes
- `tasks` — simple tasks with optional due/reminder time
- `task_tags` — optional lightweight tagging

No boards, columns, or Kanban concepts.

## Starting the Database Manually

```bash
cd src/database/tasks
bash start_tasks_database.sh
```

Or directly:

```bash
cd src/database/tasks
docker compose up -d
```

## Docker Volume

The database uses a named volume `tasks_postgres_data` (defined in `docker-compose.yml`). Create it once before first run:

```bash
docker volume create tasks_postgres_data
```

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `TASKS_DATABASE_URL` | Remote database connection string | — |
| `POSTGRES_USER` | Local container user | `alexljn5` |
| `POSTGRES_PASSWORD` | Local container password | `[REDACTED]` |
| `POSTGRES_DB` | Local container database name | `emerald_utilities` |
| `POSTGRES_PORT` | Local container port | `5432` |
