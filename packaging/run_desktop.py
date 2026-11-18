"""PyInstaller entry point: the packaged app starts here (windowed exe,
no console — output is teed to ~/.texperiment/texperiment.log)."""
import multiprocessing
import os
import sys

# the app package ships TWICE in the bundle: compiled into the PYZ (so
# the analysis still reaches every third-party dependency) and as plain
# source next to the payload (_MEIPASS/texperiment, bundled as datas by
# texperiment.spec). This finder shadows the PYZ copy with the source —
# the frozen importer would otherwise win — which is what lets
# build.ps1 -Incremental / build.sh --incremental overlay app-code edits
# onto a cached payload without re-running PyInstaller.
_BASE = getattr(sys, '_MEIPASS', None)


class _SourceFirstFinder:
    """Redirect texperiment and texperiment.* to the loose source copy."""

    def find_spec(self, fullname, path=None, target=None):
        if _BASE is None or fullname.split('.')[0] != 'texperiment':
            return None
        src = os.path.join(_BASE, 'texperiment')
        parts = fullname.split('.')[1:]
        if not parts:
            init = os.path.join(src, '__init__.py')
            if not os.path.isfile(init):
                return None
            import importlib.util
            return importlib.util.spec_from_file_location(
                fullname, init, submodule_search_locations=[src])
        mod = os.path.join(src, *parts)
        import importlib.util
        if os.path.isfile(mod + '.py'):
            return importlib.util.spec_from_file_location(fullname, mod + '.py')
        pkg_init = os.path.join(mod, '__init__.py')
        if os.path.isfile(pkg_init):
            return importlib.util.spec_from_file_location(
                fullname, pkg_init, submodule_search_locations=[mod])
        return None


if _BASE:
    sys.meta_path.insert(0, _SourceFirstFinder())

from texperiment.__main__ import main

if __name__ == '__main__':
    multiprocessing.freeze_support()  # Windows: required in frozen builds
    main()
