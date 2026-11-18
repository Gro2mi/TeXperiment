# AGENTS.md — guidance for AI coding agents working in this repo

TeXperiment is a realtime, no-compile LaTeX content editor: a FastAPI
backend that parses `.tex` files into editable blocks, a vanilla-JS
frontend that renders and edits them in place, and a desktop packaging
layer (PyInstaller + pywebview). It edits **users' real documents on
disk** — the one unforgivable failure is corrupting or losing a byte of
a user file. Everything else is recoverable. See `TESTING.md` for the
full testing strategy and its rationale.

## Commands

```bash
# Python (backend + logic suites)
python -m pytest                      # all suites; warnings are errors
python -m pytest tests/unit           # fast pure-logic only
python -m ruff check texperiment/ tests/ conftest.py

# Web (frontend unit tests + lint)
npm install
npm test                              # vitest run
npm run lint                          # eslint

# End-to-end (real server + Chromium)
npm run test:e2e                      # Playwright smoke suite

# Desktop build (produces dist/ artifacts; build outputs are gitignored)
powershell -File packaging/build.ps1  # Windows: exe + installer + zip
bash packaging/build.sh               # Linux: one-dir tarball
```

Run the dev server: `python -m texperiment [main.tex] [--port 8080]`
(opens a browser tab; `--window` for the native shell, `--no-window`
for headless).

## Layout

| Path                       | Role                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `texperiment/server.py`  | FastAPI app: routes, `Store` (block model + ops + undo history), watchers, TeX engine detection, settings |
| `texperiment/parser.py`  | LaTeX → block model (types, source spans)                                                                  |
| `texperiment/storage.py` | `FileStore` (atomic writes, one `.bak` per session), `patch()` span edits with drift fallback         |
| `texperiment/gitops.py`  | git wrapper (serialized by `_GIT_LOCK`), block diffs, index surgery for per-block staging                 |
| `texperiment/proof.py`   | Proofreading engines; LanguageTool downloads ONLY via explicit user request (`start_install`)             |
| `texperiment/watcher.py` | Debounced watchdog watchers (.tex reload, .bib, figures)                                                    |
| `texperiment/desktop.py` | Window/browser/server presentation modes, single-instance, system hand-off                                  |
| `texperiment/version.py` | The single version source (exe, installer, UI)                                                              |
| `web/app.js`             | The whole frontend — one classic script, top-level functions on `window`, shared `state` object        |
| `web/index.html`         | Assets are cache-busted with `?v=N` query strings (bump on every JS/CSS change)                           |
| `web/vendor/`            | Vendored KaTeX/MathLive, pinned by `manifest.json` sha256s — never edit by hand                          |
| `packaging/`             | Spec, installer, build scripts, vendor/tectonic fetchers                                                    |

## Hard rules

1. **Every new feature gets a test.** No exceptions. Match the layer:
   - backend logic / ops / parsing → `tests/unit/` (fast, pure)
   - HTTP contract / multi-piece behavior → `tests/integration/` (TestClient; real throwaway git repos for git tests)
   - frontend pure functions / rendering → `tests/web/` (vitest + jsdom via `tests/web/helpers/load-app.js`)
   - full-stack user loop → `tests/e2e/smoke.spec.js`
   - a bug fix gets the regression test that reproduces it first, then the fix.
2. **Never corrupt user files.** Writes are atomic (`FileStore.write`), block ops record undo history, spans come from the current parse. Any change to spans/patch/ops needs a byte-exact round-trip test.
3. **Both sides of the wire.** A feature spanning server + client gets tests on both (pytest for the route, vitest for the rendering/logic).
4. **Bump `?v=N` in `web/index.html` for every app.js/style.css change** — `tests/web/assets.test.js` enforces this.
5. **All suites green before committing**: `ruff`, `pytest`, `eslint`, `npm test`, and `npm run test:e2e` when UI behavior changed.
6. **No new pytest warnings** — `filterwarnings = ["error"]`.
7. Use git worktrees to not tangle the files with other agents.
8. Start the server without the --window argument for your tests
9. Only commit when the user asks.

## Conventions

- **Python**: ruff line-length 100, rules E4/E7/E9/F/I, import sorting enforced. Comments explain *why*, matching the existing density. User-visible messages are full sentences, mention the alternative where one exists.
- **JS**: no build step, no framework — classic script semantics. Match the existing style: small functions, `el()` helper for DOM, `esc()` for any interpolated user text, `toast()` for feedback. Keep `window.__sel` (debug API) working.
- **Commits**: conventional-commit style summaries (`feat:`, `fix:`, `test:`, `docs:`, `fix(deps):`), one logical change per commit.
- **Client ops are serialized** through `enqueueOp()` — any new mutating client operation must go through it (ordering with editor commits and raw-file saves matters).
- **Server ops raise ValueError/KeyError/ConflictError** → `_run` maps them to 400/404/409. Don't return error shapes manually.
- **Block ids are content-stable** across re-parses (matching file+source reuses the id); positional fallback ids are collision-safe. Don't reintroduce positional-only ids.
- **LanguageTool must never download implicitly** — the consent gate in `proof.py` is a product decision; keep tests enforcing it.
- **Child processes on Windows** use `CREATE_NO_WINDOW` (`_NO_WINDOW` in gitops/server, `_quiet_popen` in proof) — the app is a windowed build with no console.
- **Vendored libs**: update via `packaging/fetch_vendor.py`, never hand-edited; `web/vendor/**` is excluded from eslint and the cache-bust rule.

## Known traps (learned the hard way)

- **CRLF**: block spans count `\r` as a character; `gitops._norm_src` normalizes for HEAD comparison. The Linux CI runner checks out LF — tests that need CRLF must **create** it explicitly (rewrite bytes → `store.rebuild()` → commit), never assume the checkout's line endings.
- **Multi-layer string escaping**: when generating fixtures with backslashes through shell heredocs or tool calls, characters get halved silently. Prefer file edits via the Edit/Write tools, or build strings from `chr(92)` / `String.fromCharCode(92)`; verify the bytes (`data.count(b'\x5c\x5c')`).
- **`<tr>` elements must live inside `<table>`** — stray rows around the table element get foster-parented by the HTML parser into garbage.
- **Client init is async**: toolbar listeners attach before the first `await`; anything that must survive a slow server/CI runner can't depend on post-init timing. E2E helpers wait for the initial render (`enterSbsMode`) and retry.
- **The caret tracker** re-measures after rebuilds and pins `lastOff` to the post-render value — a ±1 drift otherwise oscillates rebuild↔measure forever on headless font metrics.
- **E2E determinism**: stub network routes *before* `page.goto` (the proofreading auto-check fires during load), and use settle barriers before interacting with the inline editor.
- **Windows denies writes transiently (Errno 13)**: while a PDF export runs, an antivirus scans the files it created, or a sync client touches the project dir, opens/replaces fail for a moment. `FileStore.write` retries (`WRITE_RETRY_DELAYS`); `_run` maps a persistent `PermissionError` to 503 (not 409 — the frontend's 409 branch claims "file changed on disk", which would mislead).
- **`state.desktop`** gates native-shell behavior (system browser/PDF viewer instead of `window.open`) — fetch `/api/env` semantics.
- **Packaging**: `packaging/tectonic/`, `packaging/tools/`, `dist/`, `build/` are gitignored build outputs; the CI build job (`.github/workflows/build.yml`) mirrors `build.ps1`/`build.sh` step-for-step — keep them in sync.

## Verification checklist (before saying "done")

```
node --check web/app.js        # syntax (catches splice errors early)
python -m ruff check texperiment/ tests/ conftest.py
python -m pytest
npm run lint && npm test
npm run test:e2e               # if the UI changed
```

New feature? Point to the test that proves it. New route? Hit it over
HTTP in a test. New rendering path? Assert on the HTML in vitest.
