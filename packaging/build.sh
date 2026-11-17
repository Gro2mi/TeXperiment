#!/usr/bin/env bash
# Local Linux build: mirrors the CI build job (.github/workflows/build.yml).
# Produces dist/texperiment-<ver>-linux.tar.gz — a one-dir build the user
# unpacks and runs via ./TeXperiment/TeXperiment.
#
# Runtime system packages (not bundlable): WebKit2GTK for the window mode,
#   sudo apt install libwebkit2gtk-4.1-0 gir1.2-webkit2-4.1 libgtk-3-0
# Without them the app falls back to --no-window (server + system browser
# via webbrowser); compile needs a TeX toolchain or the bundled tectonic.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(python -c "import sys; sys.path.insert(0, '.'); from texperiment import __version__; print(__version__)")

echo "== TeXperiment $Version build (linux) =="

# 1. build-time python deps
python -m pip install --quiet --user pyinstaller pywebview

# 2. vendored math libs must be present and unmodified
python packaging/fetch_vendor.py --check

# 3. bundled tectonic fallback binary
python packaging/fetch_tectonic.py

# 4. one-dir PyInstaller build
python -m PyInstaller texperiment.spec --noconfirm --distpath dist --workpath build

# 5. tarball
TARBALL="dist/texperiment-${VERSION}-linux.tar.gz"
tar -C dist -czf "$TARBALL" TeXperiment

echo "== done: $TARBALL =="
