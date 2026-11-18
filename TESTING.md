# Testing Strategy

TeXperiment edits users' `.tex` files in place. The one unforgivable failure
is corrupting a document; everything else is recoverable. This strategy ranks
test milestones by exactly that: **what must never break, tested first**.

Why this exists: of the 58 commits on `main`, ~21% are fixes, clustering in
gitops block-diff logic (word-diff offsets, end-of-block deletions,
insert-after-replace crash), editor state handling in `web/app.js`, Windows
CRLF issues, and LaTeX rendering edge cases — while the repo had **zero
tests, no CI, no linters**. This document is the plan that closes that gap
milestone by milestone.

## Ranking principle

| # | Milestone | Protects | Status |
|---|-----------|----------|--------|
| M1 | Data integrity: parser spans, `patch()`, `Store` ops round-trips | User `.tex` files — never corrupt, never lose bytes | **done** |
| M2 | gitops: pure diff logic + real-git integration | User git repos — block staging/discard must not mangle worktrees | **done** |
| M3 | Server API contract (FastAPI TestClient) | The HTTP edit loop, conflicts → 409, undo/redo over HTTP | **done** |
| M4 | Frontend pure logic (vitest + jsdom) | Rendering/editor transforms — the biggest visible breakage area | **done** |
| M5 | E2E smoke (Playwright: real server + browser) | The full stack working together per commit | **done** |
| M6 | Hygiene: linters, coverage report, cache-bust check | Slows the rot between milestones | **done** |

M0 (scaffold — pytest/vitest/CI wiring, done once) precedes all of these.

## How to run

```bash
# Python (M1–M3 suites)
pip install -r requirements.txt -r requirements-dev.txt
python -m pytest                 # everything (warnings are errors)
python -m pytest tests/unit      # fast, pure-logic only
python -m pytest --cov=texperiment --cov-report=term-missing   # soft coverage
python -m ruff check texperiment/ tests/ conftest.py           # lint

# Web (M4 suites + assets sanity)
npm install
npm test                         # vitest run
npm run lint                     # eslint
```

CI (`.github/workflows/tests.yml`) runs the Python suite on
**windows-latest + ubuntu** and the web suite on ubuntu, on every push.
Windows is first-class on purpose: the app is developed on Windows and CRLF
bugs are a recurring theme. TeX/Java-dependent tests (M3 compile, LanguageTool)
must carry skip markers so CI stays green without those binaries.

## Conventions

- **No source changes to add tests.** Tests use the public shapes already
  there (`parse_file`, `patch`, `Store`, top-level functions in `app.js`).
- **Byte-level cases live in code, not fixture files.** CRLF and BOM cases
  are written as explicit byte/char strings in the tests — git checkout
  newline conversion would silently corrupt byte-exact fixture files.
- **`demo/` is the canonical integration fixture** — copied to `tmp_path`
  per test, never touched in place.
- **Regression-first policy:** every bug fix lands with a test that fails
  on the old code, named after the symptom (`test_regressions.py` keeps
  them, docstrings cite the fix commit).
- **Golden files** (`tests/golden/`) pin exact on-disk results of `Store`
  op sequences. Regenerate deliberately after an *intended* behavior
  change with `TEXPERIMENT_UPDATE_GOLDEN=1 python -m pytest tests/integration`,
  review the diff, and commit it together with the change.

## M1 — data integrity (done)

The parser promises: blocks carry exact `[start, end)` spans and
`source == text[start:end]`, so per-block editing is lossless. Tests pin:

- `parser.py` — span coverage (ordered, non-overlapping, in-bounds) across a
  corpus exercising every block type; comment masking (same length, escaped
  `\%`, `\\%`); nested same-name environments; `$$`/`\[..\]` math; starred
  sections; graceful handling of unbalanced environments; empty files,
  missing trailing newline, CRLF, BOM.
- `storage.py` — `patch()` exact-span, drift fallback, conflict → `None`,
  duplicate-source behavior pinned; atomic write preserves EOLs byte-exact;
  `.bak` written once per session; `last_write` marker set.
- `resolver.py` — `\input`/`\include` graph order, `.tex` suffix defaulting,
  cycles, missing files, commented inputs; encoding sniffing (utf-8, BOM,
  cp1252, latin-1); no newline translation on read.
- `bibparse.py` — entry parsing, `@string` resolution, author formatting,
  `et al.` beyond 3, url/doi display fields.
- `Store` ops (`tests/integration/test_store_ops.py`) — save / insert /
  delete / move / move-blocks / section move / save-section / raw put,
  each followed by the **re-parse invariant** (every block's `source`
  equals its on-disk slice; ids unique; unchanged blocks keep their ids).
  A fixed op sequence is pinned against `tests/golden/`; undoing the whole
  history must restore the original files byte-for-byte, redoing must
  reproduce the goldens. Conflict path: externally-drifted file → 409-style
  `ConflictError`. CRLF and BOM projects keep their encoding through edits.

## M2 — gitops (done)

Biggest historical bug cluster, and it writes to the user's repo.

- Pure (`tests/unit/test_gitops_pure.py`): `_word_diff` coordinate
  contracts (add ranges slice real words out of the current source;
  changes at end-of-block; adjacent changes grouped into one region;
  formatting-only changes are green-only; CRLF sources diff in raw
  coordinates), `_visible_tex`, `_align` (deletion/insertion/drift
  mappings), `_parse_spans`, `_splice_region`, `_norm` porcelain paths.
- Integration (`tests/integration/test_gitops_repo.py`, real git in
  `tmp_path`, local identity, `core.autocrlf=false` so blobs equal
  worktree bytes on every platform): `status` classification (clean /
  staged / unstaged / untracked, `.bak` excluded, ahead/behind against a
  bare remote, subtree scoping with prefix stripping),
  `changed_block_ids`, `block_diffs` (modified offsets,
  insert-after-replace — the 84d56e0 crash, ghosts for middle and
  end-of-file deletions — the bc5b5af flavor), and the central safety
  property: **`stage_block`/`unstage_block`/`discard_block` never touch
  the worktree** (hash-object + update-index only; `discard_block`
  returns the content the server writes). Plus `commit_file` path
  limiting, `commit(paths)`, push to a bare remote, and `discard`
  refusing foreign paths across project subdirectories.
- **Fixed during M2** (regression-first, register #1): the duplicate
  `_norm_src` in `gitops.py` shadowed the CRLF-aware definition, so a
  *clean* CRLF checkout flagged 23 of 33 demo blocks as changed vs HEAD.
  The duplicate is deleted; `test_changed_block_ids_clean_crlf_tree_is_empty`
  fails on the old code.

## M3 — server API contract (done)

`tests/integration/test_api.py` — FastAPI `TestClient` against
`create_app()` rooted in a tmp copy of `demo/` (spellcheck proof engine,
no Java). Covers:

- project lifecycle (list/add/delete, bad paths → 400) and the disk
  browser
- the full edit loop over HTTP: save/insert/delete/move/move-blocks with
  the doc returned, files verified on disk
- exception → status mapping: unknown block 404, external drift 409,
  bad direction/paths 400, unknown project 404
- sections (span get / 404 outside / save), raw file get/put + errors,
  history flags and undo/redo routes incl. the noop response
- git routes: status (`repo:false` → init → true), changes, blockdiffs
  with staged flags, the block-id-in-`message` staging contract
  (register #5, pinned), discard-block writing the file, commit message
  validation
- proofreading offline: config, check (misspelling found), dictionary,
  ignore
- bibliography: .bbl preferred (natbib labels → authoryear style, .bib
  keys ride along without numbers), .bib fallback when no .bbl
- graphics: listing, literal + extension-probed resolution, path-escape
  404s, `/files` ETag + 304 revalidation
- compile: no-toolchain 400 (monkeypatched `shutil.which`), PDF 404
  before compiling, and a real-latexmk end-to-end test that skips when
  latexmk is absent
- static frontend served with no-cache headers
- WebSocket: a `/ws` client receives the `reload` broadcast an undo
  triggers (`self: true`), and a real watcher rebuilds the doc after an
  external file append (polled through `/doc`)

Isolation conventions: `tests/integration/conftest.py` redirects
`~/.texperiment` persistence (projects.json, dictionaries.json,
proof_ignores.json) into tmp_path — the app must never touch the real
home config in tests. Shared helpers live in `tests/helpers.py` (a
`conftest` module name becomes ambiguous once subdirectory conftests
exist).

## M4 — frontend pure logic (done)

`tests/web/helpers/load-app.js` loads the real `web/app.js` into jsdom
against the real `index.html` shell (stubs: `fetch`, `WebSocket`, `katex`,
a `math-field` custom element; the script is injected as a real classic
script so top-level functions become window properties and `const state`
is reachable via `window.eval`). Four suites:

- `table.test.js` — the recent fix cluster: `tokenizeTableBody` (cells,
  seps, row ends, `\\[1ex]` spacing, escaped `\&`, rule args),
  `tableBodyToModel` (rule boundary indices, multicolumn spans, advanced
  flag), six `parseTableRich ↔ serializeTableRich` round-trips (bare,
  booktabs, wrapped captions above/below, multicolumn, tabularx), a
  cell-edit round-trip, rejection cases, and the strict
  `parseTabular` / display-only `parseTabularLenient` split.
- `render-inline.test.js` — the LaTeX→HTML engine: formatting nesting,
  footnotes, run-ins, chips (label/ref/cite/unknown command), escapes,
  comments-to-EOL, math through the KaTeX stub incl. siunitx-in-math
  expansion, proof squiggles and green/red git marks with exact
  whitespace-collapsed `data-full` behavior; brace readers
  (`readGroup(s)`, `findUnescaped`, `groupEndAt`).
- `siunitx.test.js` — `groupDigits`, `renderUnit`, `siUnitToMath`
  (per-exponents, prefix fusing, `{}^` anchoring), `expandSiunitxMath`
  incl. option skipping, malformed-input pass-through and no
  over-matching of longer command names.
- `misc-pure.test.js` — `figureParts`, `listItems` (incl. nested envs),
  `stripCommentDecorations`, `srcToText`, `shiftGit`/`shiftMarks`
  window-clipping, `prefixContext`/`acContext`/`acSuggestions` (cmd,
  unit, cite-from-bib, graphic), `mergeIssues` ordering.

## Warnings policy

The Python suite runs with `filterwarnings = ["error"]`
(`pyproject.toml`): any new warning fails the run. Fix the cause; for a
third-party warning we genuinely cannot fix, add a narrowly-scoped
ignore with a comment. To date none are ignored — the `on_event`
deprecation was fixed by moving `create_app` to a lifespan handler, and
the starlette TestClient warning by installing `httpx2`
(requirements-dev.txt).

## M5 — E2E smoke (done)

`npm run test:e2e` — Playwright (chromium, 1 worker, 1 retry) against the
real `python -m texperiment` server spawned on a free port with a throwaway
git-initialized copy of `demo/` (repo-local identity — the isolated HOME
has no gitconfig, so the app's own commits would fail without it) and an
isolated HOME (the spawned app never touches the real `~/.texperiment`).
24 tests in four groups:

**Core loop**: render + WS connect; raw-column edit → disk; git panel
reports the change; undo byte-for-byte; the select-all regression
(register #13); external reload over WS without page navigation; sbs
toggle.

**Editor operations**: insert via the ＋ menu (hover-revealed;
dispatchEvent — a real click opens the menu under the cursor and breaks
its own mouseup); delete via the hover toolbar with its confirm()
dialog; move ↓/↑ verified by disk order; Escape cancels the inline
editor without saving; the grid editor rewrites table cells (located by
textarea *value* — cells are set via .value and have no text nodes);
the math editor's LaTeX-source pane; autocomplete (`\se` → popup →
Enter inserts `\section{`).

**Rendering**: inline math renders through KaTeX and the figure `<img>`
decodes real bytes; the section collapse chevron hides ≥2 blocks and
restores them (collapsed blocks are display:none — assert DOM presence,
not visibility); clicking an outline entry scrolls the section into
view.

**Proof / compile / chrome / git**: proofreading end-to-end (planted
misspelling → squiggle row → chip fix rewrites the block on disk; the
proof route is NOT stubbed here — and the client doc must catch up to
the API-made edit over WS *before* checking, since flagged offsets map
onto the client doc, and the load-time auto-check must have released
its `checking` guard or the button click is swallowed); failing compile
shows the log overlay (route-stubbed 400); theme + font size persist
across reloads; git stage → unstage → commit cycle verified via
`git log`; the multi-select batch bar (`＋ Stage` — case-insensitive
hasText would also match `⇤ Unstage`); per-block stage ＋/－ toggling
verified via `git diff --cached`; the diff modal opens and closes.

Determinism rules (each earned in CI):
- route stubs go in **before `page.goto`** — the proofreading auto-check
  fires during load and routes only intercept later requests
- `settleForEditing` (networkidle + settle beat) after goto;
  `exitSbsMode` for tests needing the rendered-only DOM (the app
  defaults to side-by-side)
- hover-revealed controls (`.btools`, `.insertbtn`, `.stage-in-block`)
  need an explicit `hover()` first; popup-under-cursor and unstable
  buttons get `dispatchEvent('click')`
- editors open via the toolbar ✎ button — synthetic dblclick is
  swallowed by the block-selection click handler (probe-verified)
- app-globals assertions use string-form `waitForFunction` (eslint
  no-undef inside evaluate callbacks)

The block-level editors were deliberately *not* driven by dblclick: that
exposed real client-side races (register #13/#14). The suite fails fast
(8 s bounds) and retries once; Playwright's flaky counter makes how
often the races strike visible per run.

CI runs the e2e job on ubuntu with `playwright install --with-deps
chromium`.

## M6 — hygiene (done)

- **ruff** (`pyproject.toml`, select `E4,E7,E9,F,I` — pyflakes, pycodestyle
  errors, import sorting; widen deliberately, never opportunistically).
  `python -m ruff check texperiment/ tests/ conftest.py` — clean. The
  adoption pass fixed 11 import-order/unused-import findings plus one
  loop-lambda in `proof.py` (E731 — also removed its late-binding hazard).
- **eslint** (`eslint.config.js`, flat config: recommended rules, browser
  + CDN globals for the classic script `web/app.js`, module mode for the
  tests; `no-empty` allows empty catch only). `npm run lint` — clean.
  The adoption pass removed dead code (committed `toggleDiskHl`, unused
  `SEL_CLASSES`/`cycleKind`/locals) and fixed two real bugs, see the
  register.
- **soft coverage** (`pytest-cov`, no threshold): 
  `python -m pytest --cov=texperiment --cov-report=term-missing`
- **cache-bust sanity** (`tests/web/assets.test.js`): every `?v=N`
  reference in index.html resolves to a real file, no self-hosted js/css
  is referenced unversioned, each asset referenced once.
- CI runs ruff + eslint before the test suites.

## Known fragile spots register

Things exploration found that tests should pin as they reach the
surrounding code — entries move out when fixed:

1. **Fixed in M2**: `_norm_src` was defined twice in `gitops.py`; the
   later `\r\n`-only redefinition shadowed the CRLF-aware one, so clean
   CRLF checkouts read as almost-entirely changed vs HEAD (23/33 demo
   blocks). The duplicate is deleted; pinned by
   `test_changed_block_ids_clean_crlf_tree_is_empty` and the
   `test_norm_src_*` unit tests.
2. `storage.patch()` drift fallback (`storage.py:44`) replaces the *first*
   `text.find` match — two identical block sources can patch the wrong one.
3. Watchers are never stopped on project removal (`server.py:696`) —
   observers keep running for deleted projects.
4. The watcher callback swallows all exceptions (`server.py:636`), so a
   failed rebuild leaves the UI stale until the next disk change.
5. `stage-block`/`unstage-block`/`discard-block` routes smuggle the block
   id through `GitCommitBody.message` (`server.py:819-829`).
6. LanguageTool engine failure is cached forever (`proof.py:248-253`) — no
   retry once Java appears.
7. latin-1 fallback decode never fails, so mojibake is accepted silently
   (`resolver.py:19-24`); `Store` reuses the old file's encoding for new
   content (`server.py:143-144`).
8. Found by the M1 goldens: on CRLF files, block/section moves can leave a
   doubled lone `\r` at moved-chunk boundaries (observed `\r\r\n` after the
   multi-block move in the golden sequence) — separator-slot mechanics pair
   block sources that already end in `\r` with `\n`-led separators. The
   golden pins current behavior; a fix should normalize separators and
   update the goldens deliberately.
9. **Fixed in M6**: graphic autocomplete `sub` for root-level files showed
   `'logo.sv'` instead of `'project root'` — `f.lastIndexOf('/')` is `-1`
   and `f.slice(0, -1)` chopped a character. Fixed in `acSuggestions`;
   pinned in `misc-pure.test.js`.
10. **Fixed in M6** (eslint adoption): `'\Omega'` in the AC_UNITS table
    collapsed to `Omega` in JS (unknown escape drops the backslash), so
    the ohm suggestion inserted the unit without its `\`. Fixed and
    pinned in `misc-pure.test.js`.
11. **Fixed in M6** (eslint adoption): a duplicate `gitMsgDraft` key in
    the `state` object — the later `gitMsgDraft: ''` silently overwrote
    the sessionStorage-restoring initializer, killing the "commit draft
    survives reloads" behavior. Duplicate removed.
12. **Fixed in M6** (ruff adoption): loop-lambda in
    `proof.py` LanguageToolEngine.check captured the loop variable late
    (E731/B023) — rewritten as a `def` binding `_m` eagerly.
13. **Fixed** (editor pass after M5): the inline editor's
    `selectionchange` handler rebuilt the editor DOM (`ceRender`) when
    the caret left an active raw command — destroying any non-collapsed
    selection (Ctrl+A, drag-select), so typed text *prepended* instead
    of replacing. Fix: the caret tracker now returns early while the
    selection is non-collapsed (`sel.isCollapsed` guard). Regression:
    the E2E `select-all + type` test (red at ~1-in-4 before the fix,
    10/10 green after in isolation).
14. Open (editor state): intermittent races around open editors. Diagnosed
    so far (via CPU-throttled reproduction, 6x): (a) the caret tracker's
    rebuild could destroy selections — fixed, #13; (b) Ctrl+A with the
    caret inside a raw command span selects only the span (nested
    contentEditable is the innermost editing host) — the smoke test
    clicks plain text first; (c) **load-time asyncs eject open editors**:
    the proofreading auto-check's squiggle re-render and the
    WS-onopen-triggered second doc refresh + applyDoc re-render can both
    land mid-edit on slow machines, silently discarding typed text (no
    save fires). The e2e suite stubs the proof route and waits for
    network-idle before editing (`settleForEditing`). (c) is a real
    user-facing hazard — a slow machine + fast typing loses edits the
    same way; the proper fix is an editor-aware applyDoc that preserves
    an open editor instead of re-rendering under it.
15. **Fixed** (editor pass): (c) is fixed — this was the select-all e2e
    failing only on the ubuntu runner while passing locally. Three
    ejection paths, all closed: (i) `rerenderContentPreservingScroll`
    only guarded `state.edit`, so the proof auto-check's `finally`
    re-render (which runs **even with zero issues** — the e2e proof stub
    emptied the squiggles but not the re-render), the bibliography
    refresh, the git-diff re-render and the graphics refresh all tore
    down an open inline editor mid-typing; it now defers while
    `state.inlineEdit` is open too, and `commitInlineEdit` /
    `cancelInlineEdit` flush the deferral (as `closeEditor` already did).
    (ii) `applyDoc`'s editor preservation called `cePlaceCaret` on the
    still-null `state.inlineEdit` because `openInlineEdit` queues — the
    throw was swallowed by `refreshDoc`'s try/catch into a bogus
    "Cannot load document" toast and the caret was never restored; the
    caret now travels into the queued open. (iii) the WS-onopen chain
    called `discardStaleEditState()` on the FIRST connect too — when a
    slow machine's late handshake lands mid-edit, that discard is what
    actually ejected the editor; first connects now skip it (the doc
    that chain loads is fresh), genuine reconnects keep it. Proven with
    a deterministic mid-edit repro: `refreshBib()` / `checkDocument()`
    fired while the editor held typed text ejected it pre-fix and are
    survival-tested post-fix (temporary repro, deleted after the run).
