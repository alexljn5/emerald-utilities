# Recovery

## Overview

Recovery procedures for the Emerald Utilities PostgreSQL database.

## Scenario 1: Container Won't Start

### Diagnosis

```bash
cd src/database
docker compose ps
docker compose logs postgres
```

### Common causes

- Volume missing: `docker volume ls | grep database_postgres_data`
- Port conflict: `POSTGRES_PORT` in `.env` conflicts with another service
- Image pull failure: Check network connectivity

### Recovery

If the volume exists but the container won't start:

```bash
# Stop any stale containers
docker compose down

# Remove the container (NOT the volume)
docker rm emerald-postgres

# Restart
./start_postgres.sh
```

## Scenario 2: Database Corruption

### Diagnosis

```bash
cd src/database
./scripts/db-status.sh
```

Look for:
- PostgreSQL not ready
- Missing tables
- Extension errors

### Recovery

1. Stop the database:

   ```bash
   ./stop_db.sh
   ```

2. Find the most recent backup:

   ```bash
   ls -lt src/database/backups/*.dump | head -5
   ```

3. Restore from backup:

   ```bash
   ./scripts/db-restore.sh src/database/backups/emerald_utilities_2026-08-08_120000.dump
   ```

4. Restart:

   ```bash
   ./start_postgres.sh
   ```

## Scenario 3: Accidental Data Loss

If data was accidentally deleted or modified:

1. **Do not shut down the database** (unless necessary)
2. Find the most recent backup
3. Restore to a temporary database first to verify:

   ```bash
   # Create temp database
   docker compose exec postgres psql -U alexljn5 -d postgres -c "CREATE DATABASE emerald_verify;"

   # Restore to temp
   docker compose exec postgres pg_restore -U alexljn5 -d emerald_verify /path/to/backup.dump

   # Verify data
   docker compose exec postgres psql -U alexljn5 -d emerald_verify -c "SELECT COUNT(*) FROM grok_messages;"

   # If good, restore to production
   ./scripts/db-restore.sh /path/to/backup.dump

   # Clean up temp
   docker compose exec postgres psql -U alexljn5 -d postgres -c "DROP DATABASE emerald_verify;"
   ```

## Scenario 4: Volume Failure

If the Docker volume itself is corrupted:

1. The volume `database_postgres_data` contains all data
2. If you have a volume backup (tar.gz), restore it:

   ```bash
   # Stop database
   ./stop_db.sh

   # Remove corrupted volume
   docker volume rm database_postgres_data

   # Create new volume
   docker volume create database_postgres_data

   # Restore volume backup
   docker run --rm \
       -v database_postgres_data:/target \
       -v $(pwd)/backups:/backup \
       alpine tar xzf /backup/volume_backup_DATE.tar.gz -C /target

   # Restart
   ./start_postgres.sh
   ```

3. If you only have logical backups (pg_dump), restore using `db-restore.sh` instead.

## Prevention

- Take regular backups (`./scripts/db-backup.sh`)
- Verify backups periodically
- Monitor disk space on the Docker host
- Keep the Docker volume on reliable storage
