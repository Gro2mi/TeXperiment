# TeXperiment

A realtime, local, **no-compile** LaTeX editor. Your document renders as
styled content — paragraphs, formulas, tables, figures — and you edit it
**in place**: click a block, change the text, and the edit is written
straight back into the originating `.tex` file. No PDF compile loop,
nothing hidden on disk. WYSIWYG for the *content*, not the layout. 

## Install & start

**Download the latest release** from
[GitHub Releases](https://github.com/Gro2mi/TeXperiment/releases/latest):

- **Windows**: `TeXperimentSetup-<version>.exe` (installer) or the zip
  (unpack, run `TeXperiment.exe`).
- **Linux**: `texperiment-<version>-linux.tar.gz` (unpack,
  `./TeXperiment/TeXperiment`; the native window needs WebKit2GTK —
  `sudo apt install libwebkit2gtk-4.1-0 gir1.2-webkit2-4.1 libgtk-3-0` —
  otherwise it runs as a server and opens your browser).

Open any `main.tex` via the **＋** sidebar button. LaTeX and git unlock optional .

**From source:**

```bash
git clone https://github.com/Gro2mi/TeXperiment.git
cd TeXperiment
pip install -r requirements.txt
python -m texperiment demo/main.tex
```

Local-only server, opens on [http://127.0.0.1:8080](http://127.0.0.1:8080).

## Features

- **In-place editing** of every block: paragraphs, math, tables, lists, figures, captions, comments, undo, redo
- **Side-by-side raw column** — the real LaTeX source per file, for the
  preamble and anything exotic
- **Autocomplete** in both editors: commands, cite/ref keys from your
  `.bib`, `\includegraphics` files
- **Block ops**: move/drag, insert via ＋ menu, multi-select, whole-section
  editing, undo/redo, `Esc` cancels, `Ctrl+Enter` commits
- **Live reload:** external edits and git operations show up instantly; unsaved edits are never clobbered
- **Rendering**: KaTeX math,`\label` chips, natbib citations,
  siunitx values, booktabs/`\multicolumn` tables, figure images; unknown
  commands stay visible as chips
- **Git panel**: inline word-level diffs, per-block and multi-file staging, commit, push, discard
- **Proofreading**: local LanguageTool (downloaded only on your explicit
  request) or an offline spellchecker, one-click fixes
- **PDF** via latexmk/pdflatex/bundled tectonic with compile-log dialog
- Dark/light theme, font size, outline with reading position, collapsible
  sections, multiple projects per server

## Project layout

```
texperiment/   FastAPI server, parser, storage, git wrapper, proofreading,
               watchers, desktop layer, CLI
web/           vanilla-JS frontend (no build step), vendored KaTeX/MathLive
demo/          sample multi-file document
packaging/     PyInstaller spec, installer, build scripts
tests/         unit / integration / web / e2e — see TESTING.md
```

## Building from source

CI mirrors these scripts and publishes releases on version tags.
Requirements: Python 3.12+, git.

```bash
powershell -File packaging/build.ps1   # Windows: dist\TeXperiment\ + installer exe
bash packaging/build.sh  


# fast distribution testing — skip installer/zip/tarball, keep the unpacked app:
powershell -File packaging/build.ps1 -Unpacked   # -> dist\TeXperiment-<ver>\TeXperiment.exe
bash packaging/build.sh --unpacked               # -> dist/TeXperiment-<ver>/TeXperiment

# incremental: reuse the cached third-party payload, overlay only app code
# (texperiment/, web/, tectonic/) — seconds instead of minutes; a full
# build runs automatically when dependencies or the spec change
powershell -File packaging/build.ps1 -Incremental
bash packaging/build.sh --incremental# Linux: dist/texperiment-<ver>-linux.tar.gz
```

The scripts install build-time deps (pyinstaller, pywebview, Inno Setup on
Windows), verify the vendored math libs against pinned sha256s and fetch
the bundled tectonic binary. Hacking the frontend needs no build: edit
`web/app.js`, bump the `?v=N` cache-bust in `web/index.html`, reload.
