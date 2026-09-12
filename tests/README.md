# Emerald Utilities — Tests

Tests use Node's built-in test runner (`node --test`), so **no extra
dependencies** are required.

```bash
npm test              # unit tests only (fast, no DB/Ollama needed)
npm run test:unit     # same as above
npm run test:integration   # integration tests (guarded, see below)
```

## Layout

```
tests/
  unit/          Pure-logic tests. No network, no DB, no Electron.
  integration/   Live checks against the real DB / Ollama. GUARDED: each
                 test SKIPS itself when the target is unreachable, so the
                 suite never fails just because the homelab is offline.
  fixtures/      Sample data (e.g. grok JSON) used by unit tests.
```

## Safety

- **Non-destructive by design.** Integration tests only READ (`SELECT`,
  `pg_isready`, Ollama `/api/tags`). They never write, drop, or alter data.
- Unit tests touch nothing outside `tests/`.

## Integration prerequisites

Integration tests read connection settings from `src/.env` (same as the
app). They automatically **skip** (not fail) when:

- the database is unreachable within the connect timeout, or
- Ollama does not answer on `OLLAMA_HOST`.

To run them meaningfully, ensure the server is up:

```bash
# on the server
./src/internal-scripts/db-start.sh
screen -S ollama -dm ollama serve   # or your start_ollama.sh
```

## Notes on Electron

Some app modules import `electron` (for `safeStorage`) at load time and
therefore cannot be imported under plain Node. Unit tests deliberately
target the pure, Electron-free helpers (e.g. the logger, text chunking,
env parsing) to stay runnable in CI and on the headless server.
