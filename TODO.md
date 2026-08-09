# Emerald Utilities — Persistence & Context Migration/Repair

PostgreSQL (emerald_utilities @ 192.168.2.27:5432, migration v4) is verified healthy.
This is a **surgical** implementation. PostgreSQL is the single source of truth;
JSON becomes a backup/import source only; local AI becomes a single flag.

## Implementation Steps

- [x] **Investigate architecture** — read main process, IPC, DB pool, tasks service/store,
      AI persistence, RAG query, migrations, startup scripts.

- [ ] **1. db-pool.js** — enrich `checkDbHealth()` to classify connection failures
      (container-down / tcp / host / port / auth / db-missing / query / schema).
      Log configured host/port/db/user (never password).

- [ ] **2. config.json** — add `localAI.enabled` flag (single source, no new config system).

- [ ] **3. globals.js** — derive `LOCAL_AI_ENABLED` from config/env (single flag).

- [ ] **4. rag-query.js** — add `queryRAGWithContext()` (retrieve similar messages WITH
      surrounding conversational turns + metadata; grouped per conversation).

- [ ] **5. ai-persistence.js** — add a context-assembly pipeline `buildConversationContext()`
      that separates: system / current user message / recent history / RAG-retrieved
      older context (with neighbors), preserving roles & order, de-duplicating.

- [ ] **6. ipcHandlers.js** — import `assembleContext` (fixes ReferenceError);
      refactor `grok-chat` + `grok-query` to use the unified context pipeline;
      return structured errors; add `grok-context` diagnostic handler.

- [ ] **7. tasks-service.js** — make JSON mirror refresh opt-out; PG authoritative by
      default (jsonMirrorEnabled=false). JSON = read-fallback/backup only.
      Wire `ensureLegacyMigrated()` so migration runs once.

- [ ] **8. migrate-legacy-json.js** — add checksum(s) of source files to the marker;
      explicitly report invalid/skipped records.

- [ ] **9. heavensgate.js** — deterministic startup chain (remote DB verify → run
      merge-sins/start posture → legacy JSON migration if required → reconciliation →
      app). Honor `LOCAL_AI_ENABLED` for local AI init.

- [ ] **10. TheAI.jsx** — robust renderer error handling; DB-unavailable state handled
      without crashing.

- [ ] **11. Verification** — `src/database/verify-install.js` + `verify-database.sh`
      covering the §12 checklist.

## Notes
- PostgreSQL is authoritative for Notes, Tasks, AI conversations, AI history.
- JSON files retained as backup/import sources; NOT written as runtime store.
- Single schema/migration system = `merge-sins.sh`.
- Local AI controlled by `LOCAL_AI_ENABLED` flag (globals), not removed.

