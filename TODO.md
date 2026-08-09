# XScraper Pipeline Fix — TODO

## Root causes
1. **Messages never reach SQLite**: the server's `messages` table lacks the
   `forwarded` column that its `saveMessages` INSERT references, so every
   extension POST fails with "no such column: forwarded" and nothing persists.
2. **Worker only drains 200/tick**: `runBatch` reads only
   `BATCH_SIZE * MAX_CONCURRENT_BATCHES` pending messages per tick, then waits
   2s, so a large backlog is slow.

## Steps
- [x] 1. Add forwarding columns to server `messages` table
      (`src/scrapers/xscraper/src/server/database.js`).
- [x] 2. Make `runBatch` drain the entire pending queue in one pass
      (`src/database/xscraper-forwarder.js`).
- [x] 3. Add copious debug logging to the forwarder + server save path.
- [x] 4. Verify syntax / build.
- [x] 5. Auto-start the forward worker in the main process
      (`src/heavensgate.js`), so forwarding runs even when the
      Internet page is not mounted.
- [x] 6. Full end-to-end wiring verified: extension → server → SQLite
      (forwarded=0) → auto-started worker → PostgreSQL → mark forwarded=1.
