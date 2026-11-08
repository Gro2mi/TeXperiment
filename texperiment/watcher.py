"""Debounced .tex file watching (external changes → live reload)."""
import threading

from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

DEBOUNCE_S = 0.35


class _Handler(FileSystemEventHandler):
    def __init__(self, should_process, on_change, extensions=('.tex',)):
        self.should_process = should_process
        self.on_change = on_change
        self.extensions = tuple(extensions)
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
        pass

    def _fire(self):
        self.on_change()


def start_watcher(root, should_process, on_change, extensions=('.tex',)):
    handler = _Handler(should_process, on_change, extensions)
    obs = Observer()
    obs.schedule(handler, str(root), recursive=True)
    obs.daemon = True
    obs.start()
    return obs
