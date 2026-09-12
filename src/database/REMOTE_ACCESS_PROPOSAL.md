# Remote Homelab Access — Security Proposal

**Status:** SUPERSEDED — see [`docs/TAILSCALE_BRIDGE.md`](../../../docs/TAILSCALE_BRIDGE.md)
**Date:** 2026-09-05 (proposal) → 2026-09-11 (implemented)
**Author:** Emerald Utilities Team

---

## ⚠️ This document is retained for historical context only.

The proposal described in this file was **accepted and implemented** on
2026-09-11. The canonical, up-to-date reference is now:

> [`docs/TAILSCALE_BRIDGE.md`](../../../docs/TAILSCALE_BRIDGE.md)

### What changed

| Item | Before (proposal) | After (implemented) |
|------|-------------------|---------------------|
| Database host | Public IP `<public-ip>` (port-forwarded) | MagicDNS `<server-hostname>` (Tailscale mesh) |
| `DB_HOST` | Hardcoded public IP in `config.json` | Env-configurable; `config.json` uses safe `127.0.0.1` default |
| PostgreSQL exposure | Publicly reachable on 5432 | Reachable only via Tailscale; no port-forward; no `0.0.0.0/0` |
| Emerald code | N/A | Zero Tailscale-specific code; clean `database.*` abstraction in `src/database/database.js` |
| Health check | Manual `psql` | `checkDbHealth()` reports PG version + pgvector; standalone `db-preflight.js` CLI |

### Migration status

- [x] Install Tailscale on homelab server (pre-existing)
- [x] Install Tailscale on development laptop(s) (pre-existing)
- [x] Update `DB_HOST` and `OLLAMA_HOST` in `.env` to use Tailscale hostname
- [x] Remove port 5432 forwarding from router (never existed — public IP was retired)
- [x] Update firewall to block external access to 5432 (n/a — not exposed)
- [x] Document Tailscale setup in `docs/CONFIGURATION.md` and `docs/TAILSCALE_BRIDGE.md`
- [x] Test connection from external network (via `node src/database/scripts/db-preflight.js`)

### Why this file is kept

It documents the security rationale that motivated the Tailscale bridge.
New readers should start with `docs/TAILSCALE_BRIDGE.md`.

---
