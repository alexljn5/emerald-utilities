# Homelab Deployment

## Network Configuration

### Determining Your Homelab IP

Find your homelab server's LAN IP:

```bash
ip addr show | grep -E 'inet .* scope global'
```

Or on some systems:

```bash
hostname -I
```

### Port Configuration

PostgreSQL listens on port 5432 inside the container. The host port is configurable:

| Scenario | Host Port | Internal Port |
|----------|-----------|---------------|
| Fresh homelab (no conflict) | 5432 | 5432 |
| Remote server also on 5432 | 5433 | 5432 |
| Custom configuration | Any | 5432 |

Set the host port in `.env`:

```env
POSTGRES_PORT=5433
```

### Connection Address

Applications on the trusted LAN connect using:

```
postgres://<user>:<password>@<homelab-ip>:<port>/<database>
```

Example:

```
postgres://emerald-user:[REDACTED]@192.168.1.50:5432/emerald_utilities
```

### Firewall Considerations

Ensure the PostgreSQL port is accessible only from your trusted LAN:

```bash
# Example: ufw allow from 192.168.1.0/24 to any port 5432
sudo ufw allow from 192.168.1.0/24 to any port 5432
```

Do NOT expose PostgreSQL to the public internet (0.0.0.0).

## Boot-Time Startup

### Option A: Direct script (recommended for testing)

```bash
cd ~/emerald-utilities/src/database
./start_postgres.sh
```

### Option B: Cron (current setup)

The existing cron job runs:

```bash
@reboot sleep 17 && su - emerald-user -c "/home/emerald-user/<server-hostname>/<server-hostname>_scripts/start_emerald_database.sh >> /home/emerald-user/emerald-db-start.log 2>&1"
```

This script changes to `~/emerald-utilities/src/database` and runs `docker compose up`.

### Option C: Systemd (future)

A systemd service can be created to manage the database stack:

```ini
[Unit]
Description=Emerald PostgreSQL Database
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/home/emerald-user/emerald-utilities/src/database
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

## Verification

After startup, verify the database is accessible:

```bash
cd ~/emerald-utilities/src/database
./scripts/db-status.sh
```

Check that:
- Container is running
- PostgreSQL is ready
- Required extensions exist (uuid-ossp, pgcrypto, vector)
- Required tables exist
- Volume is mounted correctly
