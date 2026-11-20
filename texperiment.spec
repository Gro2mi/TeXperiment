# PyInstaller spec: one-dir build of the TeXperiment desktop app.
# Built by packaging/build.ps1 (Windows) / packaging/build.sh (Linux) and CI.
#
# Two flavors via the TEXPERIMENT_FLAVOR env var (default: desktop):
# - desktop: native window (pywebview) + browser fallback
# - server:  no viewer — server + browser only; console exe, no webview
#            shipped at all (run_desktop.py detects that and desktop.py
#            resolves frozen 'auto' to the browser)
#
# datas: the served web/ tree (incl. vendored KaTeX/MathLive), the bundled
# tectonic fallback binary, and the app package itself as plain source —
# run_desktop.py shadows the PYZ copy with the source copy, which is what
# lets incremental builds overlay app-code edits onto a cached
# third-party payload without re-running PyInstaller.
import os
import sys
from PyInstaller.utils.hooks import collect_submodules

SERVER_FLAVOR = os.environ.get('TEXPERIMENT_FLAVOR') == 'server'
APP_NAME = 'TeXperiment-Server' if SERVER_FLAVOR else 'TeXperiment'

hiddenimports = (
    collect_submodules('uvicorn')
    + ['watchdog.observers', 'language_tool_python', 'spellchecker']
)
if sys.platform == 'win32':
    hiddenimports += ['webview.platforms.edgechromium',
                      'webview.platforms.winforms', 'clr']
elif not SERVER_FLAVOR:
    hiddenimports += ['webview.platforms.gtk']
if SERVER_FLAVOR:
    hiddenimports = [h for h in hiddenimports if not h.startswith('webview.')]

excludes = ['tkinter']
if SERVER_FLAVOR:
    # the viewer and its UI toolkit are the whole point of this flavor
    excludes += ['webview', 'PIL']

datas = [
    ('web', 'web'),
    ('packaging/tectonic', 'tectonic'),
    ('texperiment', 'texperiment'),
]

a = Analysis(
    ['packaging/run_desktop.py'],
    pathex=['.'],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name=APP_NAME,
    # the server flavor is run from a terminal — show the server log
    # instead of teeing it silently into ~/.texperiment/texperiment.log
    debug=False,
    console=SERVER_FLAVOR,
    icon='packaging/TeXperiment.ico' if sys.platform == 'win32' else None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name=APP_NAME,
)
