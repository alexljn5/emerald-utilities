# XScraper Pipeline Fix — Task Tracking

## Goal
Scrape → SQLite durable queue → batch worker → PostgreSQL, with one `SCRAPE + FORWARD` button, no manual second action, and no crashes.

## Status
- [x] Trace the full XScraper pipeline (forwarder, IPC, server, UI)
- [x] Confirm durable forwarder service exists (`src/database/xscraper-forwarder.js`)
- [x] Confirm IPC handlers + renderer API in place
- [x] Update `scripts/xscraper-diagnose.js` to use nested `getStatus()` shape
- [x] Confirm `src/database/xscraper-sync.js` (canonical identity, durable checkpoint)

## UI Rewire (`src/pages/Internet.jsx`)
- [x] Import durable forwarder API methods
- [x] Add status poll driving real DB-state counters
- [x] Rewire `handleScrapeAndForward` → `startLiveSync()` + crawler + auto-start
- [x] Rewire `handleForwardToPostgres` → `forwardPending()` (no crash)
- [x] Add "Clear Forwarded (SQLite)" button + confirmation modal

## Verification
- [x] `node scripts/xscraper-diagnose.js` — forwarder status + convergence confirmed
      (PG reachable at 192.168.2.27, SQLite forwarded=1/pending=0, converged=0 pending)
- [x] Run `node scripts/xscraper-selftest.js` regression — ALL 17 CHECKS PASSED
      (SQLite→PG converges, new message inserted exactly once, history skipped,
       AI/RAG retrieval works; PG target 192.168.2.27)
- [ ] Test `SCRAPE + FORWARD` end-to-end (requires app + Firefox)
- [ ] Test manual "Send to PostgreSQL" no longer crashes (requires app)
- [ ] Test "Clear Forwarded" confirmation modal (requires app)
