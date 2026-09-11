# Future: Emerald's Own Networking / Data Layer

**Status:** FUTURE TODO — NOT implemented
**Date:** 2026-09-11
**Parent task:** [`docs/TAILSCALE_BRIDGE.md`](./TAILSCALE_BRIDGE.md)

---

## 1. Why This Exists

The current Tailscale bridge is a **development-only** solution. It lets
the developer reach the homelab PostgreSQL safely, but it is NOT a
product architecture.

The eventual application should operate for a normal user WITHOUT requiring:

- Tailscale
- VPN configuration
- direct PostgreSQL access
- PostgreSQL credentials in the client
- access to the developer's homelab

This document records the design direction so it is not lost when the
bridge is eventually replaced.

**Do not implement this during the current task.** The existing
architecture requires minimal preparation; revisit when the direct
PostgreSQL connection is no longer sufficient.

---

## 2. Target Architecture

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

---

## 3. Investigation Checklist

When the time comes, investigate:

- [ ] REST API vs GraphQL vs another appropriate protocol
- [ ] authentication
- [ ] authorization
- [ ] per-user data isolation
- [ ] API tokens / session handling
- [ ] synchronization
- [ ] offline / local-first operation
- [ ] conflict resolution
- [ ] rate limiting
- [ ] database migrations
- [ ] backend deployment
- [ ] production PostgreSQL
- [ ] backup / recovery strategy
- [ ] encryption in transit
- [ ] secrets management

---

## 4. Migration Path

1. Build the backend/API layer behind a feature flag.
2. Route Emerald's data-access calls through the new layer
   (using `src/database/database.js` as the seam).
3. Decommission the direct PostgreSQL connection for end users.
4. Remove the Tailscale bridge documentation once no longer needed.

The `database.*` abstraction in
[`src/database/database.js`](../src/database/database.js) is the
intentional seam — new code should target it, not the raw `pg` pool.