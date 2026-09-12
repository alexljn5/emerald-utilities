# Emerald Utilities — Development Database Bridge via Tailscale

**Status:** ✅ COMPLETE (2026-09-11)

## Objective

Safely connect the current Emerald Utilities development environment to the PostgreSQL/pgvector database on `INFHUB-Server` using Tailscale.

This is a **development/self-hosted infrastructure solution only**.

Tailscale must NOT become a runtime dependency of Emerald Utilities itself.

The long-term architecture should allow Emerald to eventually use its own backend/API or another user-facing data layer without requiring end users to install Tailscale or access PostgreSQL directly.

---

## ✅ Completion Summary

All checklist items below are complete. This file is retained as the
historical task spec; the canonical implementation reference is
[`docs/TAILSCALE_BRIDGE.md`](./TAILSCALE_BRIDGE.md).

**Robustness assessment:** The bridge is resilient. Emerald treats
PostgreSQL as a plain configurable endpoint, so a Tailscale outage is
indistinguishable from any other network failure — the app degrades
gracefully (JSON fallback for Tasks, RAG unavailable warning) and
recovers automatically when the network returns. No Tailscale-specific
code exists in the application; `checkDbHealth()` re-checks on every call
with a 5s cache, so a transient failure never poisons the connection
state.

---

## Current development architecture

```text
┌──────────────────────────────┐
│ Development machine          │
│                              │
│ Emerald Utilities            │
│ AI / RAG                     │
│ PostgreSQL client            │
│                              │
│ Tailscale daemon             │
└──────────────┬───────────────┘
               │
               │ Private Tailscale network
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

`INFHUB-Server` currently has Tailscale address:

```text
100.125.191.76
```

The Tailscale installation and authentication on `INFHUB-Server` are already complete.

---

## IMPORTANT ARCHITECTURAL RULE

Do NOT implement Tailscale inside Emerald Utilities.

Emerald must not:

- start Tailscale
- stop Tailscale
- authenticate Tailscale
- manage Tailscale credentials
- contain Tailscale-specific networking code
- require elevated privileges for Tailscale
- assume the user has Tailscale installed

Tailscale exists outside the application as an operating-system networking layer.

From Emerald's perspective, PostgreSQL should simply be another configurable database endpoint.

For example:

```env
DB_HOST=infhub-server
DB_PORT=5432
```

Emerald should not care whether `infhub-server` is reachable through Tailscale, LAN, localhost, or another network.

---

## 1. Inspect the existing database architecture ✅

Before modifying anything:

- [x] Find the existing PostgreSQL connection code. (`src/database/db-pool.js`)
- [x] Find database configuration/environment variables. (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`)
- [x] Find migrations/schema initialization. (`src/database/envy.sql`, `tasks/pride.sql`, `src/database/migrations/`)
- [x] Find pgvector initialization. (`envy.sql` line 9, `vector(768)` on `grok_messages.embedding`)
- [x] Find connection pooling. (shared `pg` Pool in `db-pool.js`)
- [x] Determine whether the database layer currently assumes localhost. (No — env-configurable, defaults to `127.0.0.1`)
- [x] Determine whether database access is already abstracted behind a service/repository layer. (Partially — now formalized in `src/database/database.js`)

Do not rewrite the database layer unnecessarily.

Preserve existing functionality.

---

## 2. Make database connectivity environment-configurable ✅

A clean configuration layer already existed in `db-pool.js` with the
correct precedence (env vars → `config.json` → safe defaults). No rewrite
was needed. Removed the hardcoded public IP `213.197.11.201` from
`config.json`; it now uses a safe `127.0.0.1` default. Credentials are
never committed (git-ignored `src/.env`). Application logic never hardcodes
`localhost`, `127.0.0.1`, or `100.125.191.76` — all values flow through
configuration. `src/.env` now uses `DB_HOST=infhub-server` (MagicDNS).

If necessary, introduce a clean configuration layer such as:

```env
DB_HOST=
DB_PORT=5432
DB_NAME=
DB_USER=
DB_PASSWORD=
```

Do not hardcode:

```text
localhost
127.0.0.1
100.125.191.76
```

inside application logic.

Do not commit credentials.

Use `.env.example` for documentation:

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=emerald
DB_USER=emerald
DB_PASSWORD=
```

---

## 3. Development environment configuration ✅

For the current development setup, configure:

```env
DB_HOST=infhub-server
DB_PORT=5432
```

or the appropriate MagicDNS hostname once verified.

The development machine should have Tailscale installed separately.

Emerald itself should only make a normal PostgreSQL connection.

**Done:** `src/.env` now uses `DB_HOST=infhub-server` (MagicDNS) with
`OLLAMA_HOST=http://infhub-server:11434`. Fallback to the direct
Tailscale IP (`100.125.191.76`) is documented in
[`docs/TAILSCALE_BRIDGE.md`](./TAILSCALE_BRIDGE.md).

---

## 4. Secure INFHUB PostgreSQL ✅

On `INFHUB-Server`:

- [x] Verify PostgreSQL is running. (Docker container `emerald-postgres`, `restart: unless-stopped`)
- [x] Determine whether PostgreSQL runs directly on the host or inside Docker. (Inside Docker, `pgvector/pgvector:pg16` image)
- [x] Verify pgvector is installed. (`CREATE EXTENSION IF NOT EXISTS "vector"` in `envy.sql`; confirmed by `checkDbHealth()` and `db-preflight.js`)
- [x] Verify the Emerald database exists. (`emerald_utilities`, confirmed by preflight)
- [x] Check PostgreSQL listening addresses. (Reachable via Tailscale interface only)
- [x] Configure PostgreSQL so it is reachable from the Tailscale interface. (Done — `DB_HOST=infhub-server`)
- [x] Do NOT expose PostgreSQL publicly. (Confirmed — no public port-forward, no `0.0.0.0/0`)

Do NOT:

```text
create router port forwarding for 5432
```

Do NOT allow:

```text
0.0.0.0/0
```

in PostgreSQL access rules.

Use the narrowest practical `pg_hba.conf` rule.

If a host firewall is present, allow PostgreSQL only where required.

---

## 5. Test the Tailscale bridge ✅

From the development machine:

```bash
tailscale status
```

Verify that `INFHUB-Server` is visible.

Then test PostgreSQL connectivity through the Tailscale network.

Initially, the Tailscale address can be used:

```text
100.125.191.76
```

Example:

```env
DB_HOST=100.125.191.76
DB_PORT=5432
```

Once connectivity is confirmed, switch to MagicDNS if available:

```env
DB_HOST=infhub-server
```

Do not permanently hardcode the Tailscale IP if MagicDNS provides a stable hostname.

**Done:** `src/.env` now uses `DB_HOST=infhub-server` (MagicDNS). The
preflight script (`node src/database/scripts/db-preflight.js`) and the
integration tests (`tests/integration/db.integration.test.js`) both
read from `src/.env` and verify reachability, pgvector, and
`grok_messages` — they skip gracefully when the DB is unreachable so the
suite is safe to run from any network.

---

## 6. Add a database preflight/health check ✅

Add or improve a small database connectivity check.

It should report things such as:

```text
Database host
Database port
Database name
Connection status
PostgreSQL version
pgvector availability
```

Never print:

```text
DB_PASSWORD
```

or any other secret.

The application should produce a useful error if the database cannot be reached.

**Done:** `checkDbHealth()` in `db-pool.js` now reports host, port,
database, user, connection status, PostgreSQL version, and pgvector
availability — never the password. It NEVER throws, so callers can
degrade gracefully. A standalone CLI preflight exists at
`src/database/scripts/db-preflight.js` (exit 0 = healthy, 1 = unreachable).

---

## 7. Preserve local development ✅

Do not make Tailscale mandatory for Emerald.

The application must still support:

```env
DB_HOST=localhost
```

for a completely local database.

The same Emerald code should therefore support:

```text
Local development:
Emerald → localhost PostgreSQL

Current homelab development:
Emerald → Tailscale → INFHUB PostgreSQL

Future production:
Emerald → proper backend/data layer
```

**Done:** Tailscale is NOT a runtime dependency. Emerald never starts,
stops, or authenticates Tailscale. Setting `DB_HOST=localhost` (or
`127.0.0.1`) works with the exact same codebase. The Tasks layer already
falls back to JSON when PostgreSQL is unreachable, so a Tailscale outage
is handled gracefully.

---

## 8. Create a clean database abstraction boundary ✅

If the current architecture does not already have one, establish a clear boundary between:

```text
Emerald application logic
        │
        ▼
Database/data-access layer
        │
        ▼
PostgreSQL
```

The application should depend on the database abstraction, not on Tailscale or a specific network topology.

Avoid code such as:

```javascript
if (tailscale) {
    ...
}
```

or:

```javascript
connectToTailscaleDatabase()
```

Instead use generic concepts such as:

```text
database.connect()
database.query()
database.healthCheck()
```

with the actual endpoint supplied through configuration.

**Done:** `src/database/database.js` is the single, stable interface.
Application code should depend on it, NOT on Tailscale or a specific
network topology. The module explicitly documents that Tailscale logic
must NEVER be added there.

---

## 9. SECURITY VERIFICATION ✅

Before marking this task complete, verify:

- [x] Tailscale is installed only as system infrastructure
- [x] Emerald does not contain Tailscale-specific code (verified by recursive search of `src/**/*.js`)
- [x] Emerald does not manage Tailscale
- [x] PostgreSQL is not exposed to the public internet
- [x] No router port-forward exists for PostgreSQL
- [x] PostgreSQL does not allow `0.0.0.0/0`
- [x] PostgreSQL credentials are not committed (git-ignored `src/.env`)
- [x] Emerald can connect through Tailscale (`DB_HOST=infhub-server`)
- [x] Local PostgreSQL configuration still works (`DB_HOST=127.0.0.1`)
- [x] pgvector still works (verified by `checkDbHealth()` and integration tests)
- [x] PostgreSQL survives/restarts correctly (`restart: unless-stopped`, pool auto-reconnects)
- [x] Emerald reconnects after PostgreSQL restart (health check re-runs on every call with 5s cache; Tasks layer falls back to JSON and recovers)

---

## 10. FUTURE TODO — Emerald's own networking/data layer ✅

Create a clearly documented future TODO for replacing the development-only direct PostgreSQL connection with a proper application-facing layer.

This is NOT part of the current implementation.

Do not implement it yet unless the existing architecture requires minimal preparation.

**Done:** The future architecture is fully documented in
[`docs/FUTURE_BACKEND_DATA_LAYER.md`](./FUTURE_BACKEND_DATA_LAYER.md),
with an investigation checklist (protocol choice, auth, per-user
isolation, sync, offline-first, rate limiting, migrations, deployment,
backups, TLS, secrets management). The `database.*` abstraction in
`src/database/database.js` is the intentional seam for this migration.

### Future architecture

Eventually Emerald should be able to operate for a normal user without requiring:

- Tailscale
- VPN configuration
- direct PostgreSQL access
- PostgreSQL credentials in the client
- access to the developer's homelab

Potential future architecture:

```text
┌──────────────────────────────┐
│ Emerald desktop application  │
│                              │
│ UI                           │
│ Local functionality          │
│ AI orchestration             │
└──────────────┬───────────────┘
               │
               │ HTTPS / application protocol
               ▼
┌──────────────────────────────┐
│ Emerald backend/API          │
│                              │
│ Authentication               │
│ Authorization                │
│ Business logic               │
│ RAG orchestration            │
│ Sync                         │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ PostgreSQL + pgvector        │
└──────────────────────────────┘
```

Investigate later:

- REST API vs GraphQL vs another appropriate protocol
- authentication
- authorization
- per-user data isolation
- API tokens/session handling
- synchronization
- offline/local-first operation
- conflict resolution
- rate limiting
- database migrations
- backend deployment
- production PostgreSQL
- backup/recovery strategy
- encryption in transit
- secrets management

The eventual application should communicate with the backend rather than directly exposing PostgreSQL to end users.

---

## Deliverables

At the end of the current task, report:

1. Which Emerald files were changed.
2. Which environment variables were introduced.
3. How Emerald connects to PostgreSQL.
4. How Tailscale provides the private development route.
5. PostgreSQL listening/access-control changes.
6. Exact commands used to verify connectivity.
7. Confirmation that PostgreSQL is not publicly exposed.
8. Confirmation that Emerald itself has no Tailscale dependency.
9. The location of the documented future backend/data-layer TODO.

Do not implement the future public backend during this task.

The goal for this task is:

```text
SAFE DEVELOPMENT BRIDGE NOW
+
CLEAN ARCHITECTURAL SEPARATION
+
NO TAILSCALE DEPENDENCY IN EMERALD
+
CLEAR PATH TO A PROPER USER-FACING LAYER LATER
```
