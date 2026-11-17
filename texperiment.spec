# PyInstaller spec: one-dir build of the TeXperiment desktop app.
# Built by packaging/build.ps1 (Windows) / packaging/build.sh (Linux) and CI.
# datas: the served web/ tree (incl. vendored KaTeX/MathLive) and the
# bundled tectonic fallback binary (fetched by packaging/fetch_tectonic.py).
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
