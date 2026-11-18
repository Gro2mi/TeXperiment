#!/usr/bin/env bash
# Local Linux build: mirrors the CI build job (.github/workflows/build.yml).
# Produces dist/texperiment-<ver>-linux.tar.gz — a one-dir build the user
# unpacks and runs via ./TeXperiment/TeXperiment.
#
# --unpacked: skip the tarball; leave the one-dir app directly at
# dist/TeXperiment-<ver>/ for fast distribution testing
# (./dist/TeXperiment-<ver>/TeXperiment).
# --incremental: skip PyInstaller entirely — copy the cached third-party
# payload (build/distcache, populated by the last full build) and overlay
# ONLY the first-party code (texperiment/, web/, tectonic/). App-code
# edits reach the dist in seconds; run a full build when dependencies or
# the spec change (validated by a stamp, else the full path runs).
#
# Runtime system packages (not bundlable): WebKit2GTK for the window mode,
#   sudo apt install libwebkit2gtk-4.1-0 gir1.2-webkit2-4.1 libgtk-3-0
# Without them the app falls back to --no-window (server + system browser
# via webbrowser); compile needs a TeX toolchain or the bundled tectonic.
set -euo pipefail
cd "$(dirname "$0")/.."

UNPACKED=0
INCREMENTAL=0
for arg in "$@"; do
    case "$arg" in
        --unpacked) UNPACKED=1 ;;
        --incremental) INCREMENTAL=1 ;;
        *) echo "unknown option: $arg (supported: --unpacked --incremental)" >&2; exit 2 ;;
    esac
done

CACHE=build/distcache
# the stamp pins everything the cached payload depends on that is NOT
# first-party app code (which is always overlaid fresh)
STAMP_INPUTS=$(cat requirements.txt texperiment.spec packaging/run_desktop.py \
    | sha256sum | cut -d' ' -f1)

incremental_valid() {
    [ -f "$CACHE/.stamp" ] || return 1
    PYI_VERSION=$(python -m PyInstaller --version 2>/dev/null || echo missing)
    PY_VERSION=$(python -c 'import sys; print("%d.%d" % sys.version_info[:2])')
    WANT="${PYI_VERSION}|${PY_VERSION}|${STAMP_INPUTS}"
    [ "$(cat "$CACHE/.stamp")" = "$WANT" ]
}

overlay_first_party() {
    # app code, served web tree, tectonic binary — exactly the source, no
    # stale files, no caches
    for pair in "texperiment:_internal/texperiment" \
                "web:_internal/web" \
                "packaging/tectonic:_internal/tectonic"; do
        src="${pair%%:*}"; dst="dist/TeXperiment/${pair#*:}"
        rm -rf "$dst"
        cp -a "$src" "$dst"
        find "$dst" -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true
    done
}

VERSION=$(python -c "import sys; sys.path.insert(0, '.'); from texperiment import __version__; print(__version__)")

echo "== TeXperiment $Version build (linux) =="

if [ "$INCREMENTAL" = "1" ] && incremental_valid; then
    echo "== incremental: reusing cached third-party payload =="
    # cheap no-op-when-present checks — the overlay copies both trees
    python packaging/fetch_vendor.py --check
    python packaging/fetch_tectonic.py
    rm -rf dist/TeXperiment
    cp -a "$CACHE" dist/TeXperiment
    rm -f dist/TeXperiment/.stamp
    overlay_first_party
elif [ "$INCREMENTAL" = "1" ]; then
    echo "== incremental requested but cache missing/stale — full build =="
    # 1. build-time python deps
    python -m pip install --quiet --user pyinstaller pywebview
    # 2. vendored math libs must be present and unmodified
    python packaging/fetch_vendor.py --check
    # 3. bundled tectonic fallback binary
    python packaging/fetch_tectonic.py
    # 4. one-dir PyInstaller build
    python -m PyInstaller texperiment.spec --noconfirm --distpath dist --workpath build
    # populate the payload cache for the next incremental build (stamp
    # computed after the deps are installed — that is what it validates)
    rm -rf "$CACHE"
    cp -a dist/TeXperiment "$CACHE"
    PYI_VERSION=$(python -m PyInstaller --version)
    PY_VERSION=$(python -c 'import sys; print("%d.%d" % sys.version_info[:2])')
    echo "${PYI_VERSION}|${PY_VERSION}|${STAMP_INPUTS}" > "$CACHE/.stamp"
else
    # 1. build-time python deps
    python -m pip install --quiet --user pyinstaller pywebview
    # 2. vendored math libs must be present and unmodified
    python packaging/fetch_vendor.py --check
    # 3. bundled tectonic fallback binary
    python packaging/fetch_tectonic.py
    # 4. one-dir PyInstaller build
    python -m PyInstaller texperiment.spec --noconfirm --distpath dist --workpath build
fi

if [ "$UNPACKED" = "1" ]; then
    # versioned folder so several builds can sit side by side in dist/
    rm -rf "dist/TeXperiment-$VERSION"
    mv dist/TeXperiment "dist/TeXperiment-$VERSION"
    echo "== done: dist/TeXperiment-$VERSION (run ./TeXperiment inside) =="
    exit 0
fi

# 5. tarball
TARBALL="dist/texperiment-${VERSION}-linux.tar.gz"
tar -C dist -czf "$TARBALL" TeXperiment

echo "== done: $TARBALL =="
