# Migrations

This directory contains explicit database migrations for the Emerald Utilities PostgreSQL deployment.

## How migrations work

Migrations are applied by `merge-sins.sh` (invoked automatically by `start_postgres.sh`).

The migration version is tracked in `database_meta.migration_version`.

On every startup, `merge-sins.sh`:
1. Checks the current `migration_version` in `database_meta`
2. Compares it against the highest numbered migration file in this directory
3. Applies only the pending migrations (those with a higher version number)
4. Updates `migration_version` after each successful migration

## Migration file naming

Use zero-padded sequential numbering:

```
001_add_feature_x.sql
002_fix_something.sql
003_add_new_table.sql
```

The version number is extracted from the filename prefix.

## Writing migrations

- Each migration should be idempotent where possible (use `CREATE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, etc.)
- Never drop production data in a migration
- Test migrations against a copy of production data before deploying
- Keep migrations small and focused

## Fresh initialization

For a brand new database (empty volume), `envy.sql` and `tasks/pride.sql` are applied automatically by PostgreSQL's `/docker-entrypoint-initdb.d/` mechanism. Migrations in this directory are only applied to existing databases.
