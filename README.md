# 

# TeXperiment

A realtime, **no-compile** LaTeX content editor. Your document renders in the
browser as styled content — paragraphs, formulas, tables, lists, figures — and
you edit it **in place**: click a block, change the text, and the edit is
written straight back into the originating `.tex` file. No PDF compile loop.

WYSIWYG for the *content*, not the layout: styling and page layout stay in your
LaTeX preamble where they belong.

## Quick start

Requirements: installed python, a browser and an internet connection

Optional: LaTeX for PDF compilation, git

```bash
git clone https://github.com/Gro2mi/TeXperiment.git
cd TeXperiment
pip install -r requirements.txt
python -m texperiment
```

Open http://127.0.0.1:8080 — or try the bundled demo:

```bash
python -m texperiment demo/main.tex
```

## Multiple projects

One server holds any number of projects. Add more from the UI: **＋** in the
sidebar opens a disk browser — type or paste a path (a pasted `.tex` file path
adds the project directly, a pasted folder path navigates there), or browse
folder by folder and click a `.tex` file. Switch projects with the dropdown,
remove them with **✕** (files on disk are never touched by removal). Live
reload and editing apply to whichever project is selected.

## How it works

- **Python backend (FastAPI)** resolves the `\input`/`\include` graph from your
  main file, then parses every file into **blocks** (sections, paragraphs,
  display math, lists, tables, figures, comments, unknown environments) while
  remembering each block's exact `[start, end)` span in its source file.
- The **browser** renders each block: math via KaTeX (with `\label` shown as
  chips), tables — including `tabularx`/booktabs wrappers — as previews,
  natbib citations like `\citep[p.~5]{key}` as single chips, siunitx values
  (`\SI{1500}{m}`, `\ang{60}`, `\num`, ranges) and run-in `\paragraph`
  headings as formatted text, unknown commands as chips including their
  arguments. Comments lose their decorative `---` rules on screen and lone
  `%` separator lines are hidden. Nothing is hidden on disk.
- **Double-click** a block to edit it (single click stays free for marking
  text; comments are editable too):
  - paragraphs → text area with live preview,
  - formulas → MathLive visual editor (with LaTeX-source toggle),
  - plain `tabular` → editable grid with add/remove row/column,
  - exotic blocks (booktabs rules, `\multicolumn`, custom environments) →
    source editor with live preview.
- **Saving** patches exactly that span in the originating file (atomic write,
  one `.bak` per file per session) and the document re-parses instantly.
- A **file watcher** pushes external changes to the browser over WebSocket —
  edit in your other editor and the preview follows; blocks that changed on
  disk get a light highlight until you edit again. If a file changes on disk
  while you have unsaved edits, the editor warns instead of clobbering.

## Compiling the real PDF

The **PDF** button in the sidebar compiles the current project with latexmk
(fallback: pdflatex) and opens the resulting PDF in a new browser tab. A
working TeX installation (TeX Live, MiKTeX) must be on your PATH. If LaTeX
reports problems, the compile log opens in a dialog while a best-effort PDF
is still served; the editor itself never needs the compile step.

## Block operations

**Double-click** a block to edit it. Hover for the toolbar: **move up/down** and
**delete**; the **⠿ grip** on the block's left edge drags it to a new position
within its file (a blue insertion line shows the drop target). The **＋**
buttons between blocks insert a new paragraph / equation / list / table /
section / figure at that spot. Splitting a paragraph is just editing it with a
blank line in the middle. `Esc` closes an open editor from anywhere. The
sidebar has a **raw mode** (per-file full source editor) for the preamble and
anything else — nothing in your documents is off-limits. The outline tracks
your reading position as you scroll.

## Scope notes (v1)

- Layout/styling (`\usepackage`, geometry, `\centering`, column rules) is not
  the target; column specs and preamble are preserved untouched.
- Comments render grayed and are edited via raw mode.
- Saving is per-block on commit (✓ button or `Ctrl+Enter`); `Esc` cancels.
- Section numbers in the text and outline are the editor's display feature;
  the `.tex` files themselves stay unnumbered, as LaTeX numbering requires.
- KaTeX/MathLive/their fonts load from the jsDelivr CDN; offline use would
  require vendoring those assets into `web/`.
- Serves on `127.0.0.1` only and only reads/writes files under the project
  root (the main file's directory).

## Project layout

```
texperiment/   parser, resolver, storage, watcher, FastAPI server, CLI
web/           vanilla-JS frontend (no build step)
demo/          sample multi-file document exercising every supported construct
```
