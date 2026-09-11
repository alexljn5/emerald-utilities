# Emerald Utilities — Development Database Bridge via Tailscale

## Objective

Safely connect the current Emerald Utilities development environment to the PostgreSQL/pgvector database on `INFHUB-Server` using Tailscale.

This is a **development/self-hosted infrastructure solution only**.

Tailscale must NOT become a runtime dependency of Emerald Utilities itself.

The long-term architecture should allow Emerald to eventually use its own backend/API or another user-facing data layer without requiring end users to install Tailscale or access PostgreSQL directly.

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

## 1. Inspect the existing database architecture

Before modifying anything:

- [ ] Find the existing PostgreSQL connection code.
- [ ] Find database configuration/environment variables.
- [ ] Find migrations/schema initialization.
- [ ] Find pgvector initialization.
- [ ] Find connection pooling.
- [ ] Determine whether the database layer currently assumes localhost.
- [ ] Determine whether database access is already abstracted behind a service/repository layer.

Do not rewrite the database layer unnecessarily.

Preserve existing functionality.

---

## 2. Make database connectivity environment-configurable

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

## 3. Development environment configuration

For the current development setup, configure:

```env
DB_HOST=infhub-server
DB_PORT=5432
```

or the appropriate MagicDNS hostname once verified.

The development machine should have Tailscale installed separately.

Emerald itself should only make a normal PostgreSQL connection.

---

## 4. Secure INFHUB PostgreSQL

On `INFHUB-Server`:

- [ ] Verify PostgreSQL is running.
- [ ] Determine whether PostgreSQL runs directly on the host or inside Docker.
- [ ] Verify pgvector is installed.
- [ ] Verify the Emerald database exists.
- [ ] Check PostgreSQL listening addresses.
- [ ] Configure PostgreSQL so it is reachable from the Tailscale interface.
- [ ] Do NOT expose PostgreSQL publicly.

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

## 5. Test the Tailscale bridge

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

---

## 6. Add a database preflight/health check

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

---

## 7. Preserve local development

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

---

## 8. Create a clean database abstraction boundary

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

---

## 9. SECURITY VERIFICATION

Before marking this task complete, verify:

- [ ] Tailscale is installed only as system infrastructure
- [ ] Emerald does not contain Tailscale-specific code
- [ ] Emerald does not manage Tailscale
- [ ] PostgreSQL is not exposed to the public internet
- [ ] No router port-forward exists for PostgreSQL
- [ ] PostgreSQL does not allow `0.0.0.0/0`
- [ ] PostgreSQL credentials are not committed
- [ ] Emerald can connect through Tailscale
- [ ] Local PostgreSQL configuration still works
- [ ] pgvector still works
- [ ] PostgreSQL survives/restarts correctly
- [ ] Emerald reconnects after PostgreSQL restart

---

## 10. FUTURE TODO — Emerald's own networking/data layer

Create a clearly documented future TODO for replacing the development-only direct PostgreSQL connection with a proper application-facing layer.

This is NOT part of the current implementation.

Do not implement it yet unless the existing architecture requires minimal preparation.

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
