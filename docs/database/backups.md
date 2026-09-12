# Backups

## Overview

The primary recovery mechanism is PostgreSQL logical backups created with `pg_dump` in custom format (`-Fc`).

## Creating a Backup

```bash
cd src/database
./scripts/db-backup.sh
```

This creates a timestamped file in `src/database/backups/`:

```
emerald_utilities_2026-08-09_060000.dump
```

## Backup Contents

The backup includes:
- All database schemas
- All table data
- Indexes and constraints
- Functions and triggers
- Extension configurations

The backup does NOT include:
- Docker volume configuration
- Docker Compose configuration
- SQL schema files

## Backup Storage

Backups are stored in `src/database/backups/` by default. This directory is inside the repository, which means:

- Backups are included in git (unless `.gitignore` is updated)
- Backups survive container restarts
- Backups do NOT survive volume deletion

For production safety, also back up the Docker volume:

```bash
docker run --rm \
    -v database_postgres_data:/source \
    -v $(pwd)/backups:/backup \
    alpine tar czf /backup/volume_backup_$(date +%Y-%m-%d).tar.gz -C /source .
```

## Automated Backups

Consider adding a cron job for regular backups:

```bash
# Daily backup at 2 AM
0 2 * * * cd /home/emerald-user/emerald-utilities/src/database && ./scripts/db-backup.sh >> /var/log/emerald-db-backup.log 2>&1
```

## Backup Verification

Periodically verify backups by restoring to a test database:

```bash
# Create a test database
docker compose exec postgres psql -U emerald-user -d postgres -c "CREATE DATABASE emerald_test;"

# Restore backup to test database
docker compose exec postgres pg_restore -U emerald-user -d emerald_test /path/to/backup.dump

# Verify
docker compose exec postgres psql -U emerald-user -d emerald_test -c "SELECT COUNT(*) FROM grok_messages;"

# Clean up
docker compose exec postgres psql -U emerald-user -d postgres -c "DROP DATABASE emerald_test;"
```
