# Remote Homelab Access — Security Proposal

**Status:** Proposal  
**Date:** 2026-09-05  
**Author:** Emerald Utilities Team  

---

## 1. Context

The application has been configured to connect to the homelab database via the public IP `213.197.11.201`. This requires port forwarding on the router, which exposes the PostgreSQL port (5432) directly to the internet.

**Current Risk:** Direct port forwarding of database ports to the public internet is a significant security exposure. Brute-force attacks, unauthorized access attempts, and data breaches are real threats when database ports are publicly reachable.

---

## 2. Proposed Solutions

Two secure alternatives are proposed to replace direct port forwarding:

### Option A: Tailscale / WireGuard VPN (Highly Recommended)

**Concept:** Create a private, encrypted mesh network between the development machine and the homelab server. The database connection travels over this private network — the PostgreSQL port never touches the public internet.

**How it works:**
1. Install Tailscale (or WireGuard) on both the homelab server and the development laptop.
2. Both devices join the same Tailscale network and receive private Tailscale IPs (e.g., `100.x.y.z`).
3. Configure `DB_HOST` to the server's Tailscale IP instead of the public IP.
4. The connection is encrypted end-to-end and never exposed to the public internet.

**Pros:**
- Zero exposure of database ports to the public internet
- End-to-end encryption (WireGuard protocol)
- Simple setup — no router configuration needed
- Works across any network (WiFi, mobile hotspot, etc.)
- Access control via Tailscale ACLs
- NAT traversal handled automatically

**Cons:**
- Requires Tailscale account (free tier available)
- Both devices must have Tailscale installed and running
- Slight overhead (~1-2ms latency)

**Implementation Steps:**
1. Install Tailscale on homelab server: `curl -fsSL https://tailscale.com/install.sh | sh`
2. Install Tailscale on development laptop
3. Authenticate both devices with the same Tailscale account
4. Note the server's Tailscale IP: `tailscale ip -4`
5. Update `DB_HOST` in `.env` to the Tailscale IP
6. Update `OLLAMA_HOST` similarly if using remote Ollama
7. Test connection: `psql -h <tailscale-ip> -U alexljn5 -d emerald_utilities`

---

### Option B: SSH Tunneling

**Concept:** Create an encrypted SSH tunnel from the development machine to the homelab server. The database connection is forwarded through this tunnel, keeping the PostgreSQL port localhost-only on the server.

**How it works:**
1. SSH is enabled on the homelab server (port 22 forwarded or already accessible).
2. From the development machine, create an SSH tunnel:
   ```bash
   ssh -L 5432:localhost:5432 alexljn5@213.197.11.201
   ```
3. This forwards local port 5432 on the laptop to port 5432 on the server via SSH.
4. Configure `DB_HOST=127.0.0.1` in `.env` — the app connects to the local forwarded port.
5. The SSH session must remain open while using the app.

**Pros:**
- Uses existing SSH infrastructure (usually already set up)
- Strong encryption (SSH protocol)
- No additional software needed beyond SSH client
- Database port remains localhost-only on the server

**Cons:**
- Requires maintaining an active SSH session
- Port 22 must be accessible (may need its own port forwarding)
- Less convenient for frequent use
- Connection drops if SSH session times out

**Implementation Steps:**
1. Ensure SSH is running on the homelab server
2. Ensure port 22 is forwarded on the router (or use Tailscale for SSH)
3. Create SSH tunnel: `ssh -L 5432:localhost:5432 alexljn5@213.197.11.201`
4. Update `DB_HOST=127.0.0.1` in `.env`
5. Keep SSH session open while using the app

---

## 3. Comparison Matrix

| Feature | Tailscale VPN | SSH Tunneling | Direct Port Forward (Current) |
|---------|--------------|---------------|-------------------------------|
| Database port exposed to internet | No | No | **Yes** |
| Encryption | Yes (WireGuard) | Yes (SSH) | No (unless using SSL) |
| Setup complexity | Low | Medium | Low |
| Ongoing maintenance | Minimal | Session management | Router config |
| Works on any network | Yes | Yes | Yes |
| Performance impact | ~1-2ms | ~1-2ms | None |
| Requires additional software | Tailscale app | SSH client | None |
| Access control | ACLs | SSH keys | Firewall rules |

---

## 4. Recommendation

**Adopt Option A (Tailscale VPN)** as the primary remote access method.

**Rationale:**
- Provides the highest security posture — database port never exposed
- Zero-configuration NAT traversal — works on any network
- Minimal ongoing maintenance
- Free for personal use
- Can be extended to other homelab services (Ollama, file shares, etc.)

**Migration Path:**
1. Install Tailscale on homelab server and development machines
2. Update `.env` files to use Tailscale IPs
3. Remove port forwarding for PostgreSQL from router
4. Close port 5432 on the server firewall
5. Document Tailscale setup in `docs/CONFIGURATION.md`

**Fallback:** Keep SSH tunneling as a backup method for environments where Tailscale cannot be installed.

---

## 5. Action Items

- [ ] Install Tailscale on homelab server
- [ ] Install Tailscale on development laptop(s)
- [ ] Configure Tailscale ACLs (optional, for team access)
- [ ] Update `DB_HOST` and `OLLAMA_HOST` in `.env` to use Tailscale IPs
- [ ] Remove port 5432 forwarding from router
- [ ] Update firewall to block external access to 5432
- [ ] Update documentation with Tailscale setup instructions
- [ ] Test connection from external network
- [ ] Remove direct port forwarding configuration from router

---

## 6. Additional Security Measures (Regardless of Method)

1. **Strong passwords:** Ensure `DB_PASSWORD` is long and complex
2. **Fail2ban:** Install on the server to block brute-force attempts
3. **PostgreSQL SSL:** Enable SSL/TLS for database connections
4. **Regular updates:** Keep PostgreSQL and OS packages updated
5. **Monitoring:** Set up log monitoring for unauthorized access attempts
6. **Backups:** Ensure automated backups are configured and tested
