# PyInstaller spec: one-dir build of the TeXperiment desktop app.
# Built by packaging/build.ps1 (Windows) / packaging/build.sh (Linux) and CI.
# datas: the served web/ tree (incl. vendored KaTeX/MathLive), the bundled
# tectonic fallback binary, and the app package itself as plain source —
# run_desktop.py shadows the PYZ copy with the source copy, which is what
# lets incremental builds overlay app-code edits onto a cached
# third-party payload without re-running PyInstaller.
import sys
from PyInstaller.utils.hooks import collect_submodules

hiddenimports = (
    collect_submodules('uvicorn')
    + ['watchdog.observers', 'language_tool_python', 'spellchecker']
)
if sys.platform == 'win32':
    hiddenimports += ['webview.platforms.edgechromium',
                      'webview.platforms.winforms', 'clr']
else:
    hiddenimports += ['webview.platforms.gtk']

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
    excludes=['tkinter'],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='TeXperiment',
    debug=False,
    console=False,            # windowed: stdout is teed to ~/.texperiment/texperiment.log
    icon='packaging/TeXperiment.ico' if sys.platform == 'win32' else None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name='TeXperiment',
)
