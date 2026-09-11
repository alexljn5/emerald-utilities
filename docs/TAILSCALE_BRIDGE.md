# Tailscale Bridge — Development Database Access

**Status:** Implemented
**Date:** 2026-09-11
**Scope:** Development / self-hosted infrastructure only

---

## 1. Purpose

Safely connect the Emerald Utilities development environment to the
PostgreSQL/pgvector database on `INFHUB-Server` using Tailscale.

This is a **development/self-hosted infrastructure solution only**.

Tailscale must NOT become a runtime dependency of Emerald Utilities itself.

---

## 2. Architecture

```text
┌──────────────────────────────┐
│ Development machine          │
│                              │
│ Emerald Utilities            │
│ AI / RAG                     │
│ PostgreSQL client            │
│                              │
│ Tailscale daemon             │  <-- OS-level infrastructure
└──────────────┬───────────────┘
               │
               │ Private Tailscale network (encrypted WireGuard)
               │
               ▼
┌──────────────────────────────┐
│ INFHUB-Server                │
│                              │
│ Tailscale daemon             │
│ PostgreSQL                   │
│ pgvector                     │
│ Ollama / AI infrastructure   │
└──────────────────────────────┘
```

`INFHUB-Server` Tailscale address:

```text
100.125.191.76
```

MagicDNS hostname (preferred):

```text
infhub-server
```

The Tailscale installation and authentication on `INFHUB-Server` are
already complete.

---

## 3. CRITICAL ARCHITECTURAL RULE

Do NOT implement Tailscale inside Emerald Utilities.

Emerald must not:

- start Tailscale
- stop Tailscale
- authenticate Tailscale
- manage Tailscale credentials
- contain Tailscale-specific networking code
- require elevated privileges for Tailscale
- assume the user has Tailscale installed

Tailscale exists outside the application as an operating-system networking
layer.

From Emerald's perspective, PostgreSQL should simply be another configurable
database endpoint.

For example:

```env
DB_HOST=infhub-server
DB_PORT=5432
```

Emerald should not care whether `infhub-server` is reachable through
Tailscale, LAN, localhost, or another network.

---

## 4. What Was Changed

### 4.1 Removed hardcoded public IP

`src/database/config.json` previously contained the public IP
`213.197.11.201` as a hardcoded default. This is now a safe localhost
default (`127.0.0.1`), with all environment overrides flowing through the
existing config layer.

### 4.2 Environment-configurable connectivity

The existing `db-pool.js` already supported env-var overrides
(`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`). No rewrite
was needed — the connection layer was already abstracted.

Connection precedence (highest wins):

1. Environment variables
2. `config.json` → `database.{host,port,database,user,password}`
3. Safe hardcoded defaults

### 4.3 Development configuration

`src/.env` now points at the Tailscale-bridged server:

```env
DB_HOST=infhub-server
DB_PORT=5432
```

or the direct Tailscale IP (fallback):

```env
DB_HOST=100.125.191.76
```

### 4.4 Clean database abstraction boundary

A new module `src/database/database.js` establishes a single, stable
interface between Emerald application logic and PostgreSQL:

```javascript
database.connect()
database.query()
database.healthCheck()
database.getConnectionInfo()
database.ping()
```

The application depends on this abstraction, NOT on Tailscale or a
specific network topology.

### 4.5 Enhanced health check

`db-pool.js` → `checkDbHealth()` now reports:

- Database host, port, database name, user (NEVER the password)
- Connection status
- PostgreSQL version
- pgvector availability

### 4.6 Preflight script

A standalone CLI preflight check exists at
`src/database/scripts/db-preflight.js`:

```bash
node src/database/scripts/db-preflight.js
```

Exit code 0 = healthy, 1 = unreachable.

---

## 5. INFHUB PostgreSQL Security

On `INFHUB-Server`:

- PostgreSQL is reachable from the Tailscale interface.
- PostgreSQL is NOT exposed to the public internet.
- No router port-forward exists for port 5432.
- PostgreSQL access rules do NOT allow `0.0.0.0/0`.
- The narrowest practical `pg_hba.conf` rule is used.

---

## 6. Testing the Bridge

From the development machine:

```bash
# 1. Confirm Tailscale sees INFHUB-Server
tailscale status

# 2. Run the preflight check
node src/database/scripts/db-preflight.js

# 3. Direct psql through Tailscale (optional)
psql "host=infhub-server port=5432 dbname=emerald_utilities user=alexljn5"
```

Initially the Tailscale IP can be used:

```env
DB_HOST=100.125.191.76
DB_PORT=5432
```

Once connectivity is confirmed, switch to MagicDNS:

```env
DB_HOST=infhub-server
```

---

## 7. Local Development Preservation

The same Emerald codebase supports:

```text
Local development:
Emerald → localhost PostgreSQL

Current homelab development:
Emerald → Tailscale → INFHUB PostgreSQL

Future production:
Emerald → proper backend/data layer
```

Simply set `DB_HOST=127.0.0.1` for local development.

---

## 8. Security Verification

- [x] Tailscale is installed only as system infrastructure
- [x] Emerald does not contain Tailscale-specific code
- [x] Emerald does not manage Tailscale
- [x] PostgreSQL is not exposed to the public internet
- [x] No router port-forward exists for PostgreSQL
- [x] PostgreSQL does not allow `0.0.0.0/0`
- [x] PostgreSQL credentials are not committed
- [x] Emerald can connect through Tailscale
- [x] Local PostgreSQL configuration still works
- [x] pgvector still works
- [x] PostgreSQL survives/restarts correctly
- [x] Emerald reconnects after PostgreSQL restart

---

## 9. Future: Emerald's Own Networking/Data Layer

This is NOT part of the current implementation.

The eventual application should communicate with a backend rather than
directly exposing PostgreSQL to end users.

Full design notes are maintained in
[`docs/FUTURE_BACKEND_DATA_LAYER.md`](./FUTURE_BACKEND_DATA_LAYER.md).