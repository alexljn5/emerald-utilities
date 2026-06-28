# PostgreSQL JSONB Database - WSL Docker Setup

This directory contains the PostgreSQL database configuration for Emerald Utilities.

- **`envy.sql`** — Database schema and seed data (runs automatically on first container start)
- **`wrath.js`** — Electron main-process database service (connection pooling, queries, imports)
- **`docker-compose.yml`** — PostgreSQL + optional pgAdmin containers
- **`.env`** — Database credentials (git-ignored)

## Prerequisites

### Option A: Docker Desktop with WSL2 Backend (Recommended)

If you have Docker Desktop installed with WSL2 integration enabled:

1. Open Docker Desktop
2. Go to Settings → Resources → WSL Integration
3. Enable integration with your WSL distribution (e.g., Ubuntu)
4. Click "Apply & Restart"

### Option B: Native Docker Engine in WSL

If you have Docker Engine installed directly in your WSL distribution:

```bash
# In your WSL terminal
pacman -Syu
pacman -S -y docker.io docker-compose
usermod -aG docker $USER
# Log out and back in for group changes to take effect
```

## Quick Start

### 1. Navigate to the database directory

```bash
# From the project root
cd src/database

# Or from WSL
cd /mnt/c/Users/alexl/Documents/GitHub/emerald-utilities/src/database
```

### 2. Start PostgreSQL

```bash
# Using Docker Compose
docker compose up -d

# Or if using older docker-compose syntax
docker-compose up -d
```

### 3. Verify the container is running

```bash
docker compose ps
```

You should see `emerald-postgres` in a "healthy" state.

### 4. Connect to PostgreSQL

```bash
# Using psql (if installed locally)
psql -h localhost -p 5432 -U emerald -d emerald_utilities

# Or using docker exec
docker compose exec postgres psql -U emerald -d emerald_utilities
```

Default password: `emerald_local` (from `.env`)

### 5. Stop the database

```bash
docker compose down

# To also remove the data volume (WARNING: deletes all data)
docker compose down -v
```

## Configuration

Edit `.env` to change defaults:

```env
POSTGRES_USER=emerald
POSTGRES_PASSWORD=emerald_local
POSTGRES_DB=emerald_utilities
POSTGRES_PORT=5432
```

## Schema

The database schema is initialized automatically from `envy.sql` on first run.

### Tables

- `network_packet_events` - Captured network packets with JSONB payloads
- `threat_indicators` - IP blacklist and threat intelligence
- `database_meta` - Application metadata and migration tracking

### Key Indexes

- GIN index on `network_packet_events.payload` for JSONB searches
- B-tree indexes on `captured_at`, `source_ip`, `destination_ip`, `protocol`
- Composite index for blacklisted packet queries

## WSL Path Notes

### Docker Desktop with WSL2 Backend

Docker Desktop can access Windows paths, but for better performance with volumes, store data in the WSL filesystem:

```bash
# In WSL, create a data directory in the Linux filesystem
mkdir -p ~/emerald-data/postgres
```

Then update `docker-compose.yml` to use the WSL path:

```yaml
volumes:
  - ~/emerald-data/postgres:/var/lib/postgresql/data
```

### Native Docker in WSL

If using native Docker in WSL, paths are already Linux-native. The current `docker-compose.yml` works as-is.

## Connecting from Electron App

The Electron main process connects using the `DatabaseService` in `wrath.js`:

```javascript
import databaseService from './database/wrath.js';

// Check connection
const health = await databaseService.healthCheck();

// Insert a packet
await databaseService.insertPacketEvent({
    captured_at: new Date().toISOString(),
    source: 'tcpdump',
    interface: 'any',
    protocol: 'TCP',
    source_ip: '192.168.1.10',
    destination_ip: '10.0.0.1',
    payload: { raw: '...', parsed: {...} }
});
```

## pgAdmin (Optional)

A pgAdmin4 instance is included for visual database management:

- URL: http://localhost:8080
- Email: `admin@emerald.local`
- Password: `admin`

To add the PostgreSQL server in pgAdmin:
1. Right-click "Servers" → "Create" → "Server"
2. Name: `Emerald PostgreSQL`
3. Connection tab:
   - Host: `postgres` (the Docker service name)
   - Port: `5432`
   - Username: `emerald`
   - Password: `emerald_local`

## Troubleshooting

### "Cannot connect to Docker daemon"

```bash
# Start Docker Desktop, or in WSL:
sudo service docker start
```

### "Port 5432 already in use"

Change `POSTGRES_PORT` in `.env` to a different port (e.g., `5433`).

### "Permission denied" on volumes

```bash
# In WSL, ensure your user has permissions
sudo chown -R $USER:$USER ~/emerald-data/postgres
```

### Container won't start (health check failing)

```bash
# Check logs
docker compose logs postgres

# Common issues:
# - PostgreSQL data directory not empty (remove volume and retry)
# - Insufficient memory (increase Docker memory limit)
```

## Data Persistence

PostgreSQL data is stored in a Docker named volume (`postgres_data`). This persists across container restarts but is tied to the Docker host.

For backup:

```bash
# Export all data
docker compose exec postgres pg_dump -U emerald emerald_utilities > backup.sql

# Restore
docker compose exec -T postgres psql -U emerald -d emerald_utilities < backup.sql
```

## Next Steps

1. Install the `pg` npm package in the main project:
   ```bash
   npm install pg
   ```

2. Integrate `databaseService` into `heavensgate.js` IPC handlers

3. Add database mode toggle to the UI

4. Implement JSONL import tool for existing logs
