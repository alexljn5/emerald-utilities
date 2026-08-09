# Deployment Guide

## Prerequisites

- Docker Engine 20.10+ with Docker Compose v2+
- The external volume `database_postgres_data` must exist (or be creatable)
- Sufficient disk space for PostgreSQL data and backups

## First-Time Installation

### 1. Clone the repository

```bash
git clone <repository-url>
cd emerald-utilities
```

### 2. Configure environment

```bash
cd src/database
cp .env.example .env
nano .env
```

Edit `.env` with your settings:
- `POSTGRES_PASSWORD` — set a strong password
- `POSTGRES_PORT` — host port (default 5432, use 5433 if 5432 is occupied)
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` — application connection settings

### 3. Verify the volume

```bash
docker volume ls | grep database_postgres_data
```

If the volume does not exist and this is a fresh installation:

```bash
docker volume create database_postgres_data
```

If the volume already exists (existing deployment), **do not recreate it**.

### 4. Start PostgreSQL

```bash
./start_postgres.sh
```

The script will:
1. Start the PostgreSQL container (detached)
2. Wait for readiness
3. Run `merge-sins.sh` to verify/apply schema
4. Report status

### 5. Verify the deployment

```bash
./scripts/db-status.sh
```

## Switching Between Remote and Homelab

To point the Emerald application at the homelab database, edit `src/database/.env`:

```env
DB_HOST=<homelab-ip>
DB_PORT=5432
DB_NAME=emerald_utilities
DB_USER=alexljn5
DB_PASSWORD=<password>
```

To point back at the remote database, change these values back.

The application reads these environment variables with `override: true`, so they take precedence over `config.json`.

## What NOT to do

```bash
# NEVER run these on a production deployment:
docker compose down -v          # Destroys the volume and all data
docker volume rm database_postgres_data  # Deletes the database
docker volume prune             # Deletes unused volumes (might delete yours)
docker system prune             # Deletes images, volumes, containers
```

## Volume Persistence

The PostgreSQL data lives in the Docker volume `database_postgres_data`. This volume:

- Persists across container restarts
- Persists across `docker compose down` (without `-v`)
- Is NOT deleted by `docker compose down`
- Must be explicitly deleted with `docker volume rm` (which you should never do)

The volume is the source of truth for this deployment.
