"""Debounced file watching (.tex reloads, .bib citations, figures)."""
import threading

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

DEBOUNCE_S = 0.35


class _Handler(FileSystemEventHandler):
    def __init__(self, should_process, on_change, extensions=('.tex',),
                 watch_deletes=False):
        self.should_process = should_process
        self.on_change = on_change
        self.extensions = tuple(extensions)
        self.watch_deletes = watch_deletes
        self._timer = None
        self._lock = threading.Lock()

    def _hit(self, path):
        p = str(path)
        if not p.endswith(self.extensions) or p.endswith('.bak') \
                or p.endswith('.tmp~'):
            return
        if not self.should_process(p):
            return
        with self._lock:
            if self._timer:
                self._timer.cancel()
            self._timer = threading.Timer(DEBOUNCE_S, self._fire)
            self._timer.daemon = True
            self._timer.start()

    def on_modified(self, event):
        if not event.is_directory:
            self._hit(event.src_path)

    on_created = on_modified

    def on_moved(self, event):
        self._hit(event.dest_path)

    def on_deleted(self, event):
        # deletions matter for derived listings (figures autocomplete):
        # the path string still carries the extension, which is all the
        # filter needs — the file itself is already gone
        if self.watch_deletes and not event.is_directory:
            self._hit(event.src_path)

    def _fire(self):
        self.on_change()


def start_watcher(root, should_process, on_change, extensions=('.tex',),
                  watch_deletes=False):
    handler = _Handler(should_process, on_change, extensions, watch_deletes)
    obs = Observer()
    obs.schedule(handler, str(root), recursive=True)
    obs.daemon = True
    obs.start()
    return obs
