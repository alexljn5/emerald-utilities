# Migrations

## Overview

Migrations are explicit, versioned SQL files that modify an existing database schema. They are applied automatically by `merge-sins.sh` during startup, or manually via `scripts/db-migrate.sh`.

## Migration Tracking

The current migration version is stored in `database_meta.migration_version` as a JSON number.

## Creating a Migration

1. Create a new file in `src/database/migrations/` with a zero-padded sequential name:

   ```
   001_add_user_preferences.sql
   002_fix_task_index.sql
   ```

2. Write idempotent SQL where possible:

   ```sql
   -- 001_add_user_preferences.sql
   ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences JSONB DEFAULT '{}'::jsonb;
   CREATE INDEX IF NOT EXISTS idx_users_preferences ON users USING GIN (preferences);
   ```

3. Update `database_meta.migration_version` is handled automatically by `merge-sins.sh`.

## Applying Migrations

### Automatic (during startup)

Migrations are applied automatically when you run `./start_postgres.sh`. The script invokes `merge-sins.sh` after PostgreSQL is ready.

### Manual

```bash
cd src/database
./scripts/db-migrate.sh
```

This will:
1. Check PostgreSQL health
2. Create a pre-migration backup
3. Apply all pending migrations
4. Verify PostgreSQL remains healthy
5. Report success or failure

## Migration Safety

- A backup is created before each migration is applied
- If a migration fails, the database may be in a partially migrated state
- The backup path is reported so you can restore if needed
- `merge-sins.sh` returns a non-zero exit code on failure

## Fresh vs Existing Databases

| Scenario | What happens |
|----------|-------------|
| Empty volume (first init) | `envy.sql` + `tasks/pride.sql` applied by Docker init mechanism |
| Existing volume | `merge-sins.sh` checks version and applies only pending migrations |

The initialization SQL files (`envy.sql`, `tasks/pride.sql`) are NEVER re-executed against an existing database.
