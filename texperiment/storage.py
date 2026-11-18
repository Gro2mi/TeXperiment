"""Atomic file writes, session backups and anchor-match span patching."""
import os
import time
from pathlib import Path

# Windows denies access to project files with Errno 13 while another
# process holds them: a PDF export just ran the TeX engine over the
# sources, an antivirus scans each file it created, a sync client or
# indexer touches the directory. One denied write must not fail the
# edit — retry briefly before giving up.
WRITE_RETRY_DELAYS = (0.05, 0.10, 0.20, 0.40)


def _retried(fn):
    """Run fn, retrying while another process briefly denies access."""
    for delay in WRITE_RETRY_DELAYS:
        try:
            return fn()
        except PermissionError:
            time.sleep(delay)
    return fn()


class ConflictError(Exception):
    """Raised when a block edit cannot be anchored in the current file."""


class FileStore:
    def __init__(self, root):
        self.root = Path(root)
        self._backed = set()
        self.last_write = None  # (abs_path_str, timestamp) — used to suppress the watcher

    def _backup(self, p):
        if p in self._backed:
            return
        bak = p.with_name(p.name + '.bak')
        if p.exists():
            _retried(lambda: bak.write_bytes(p.read_bytes()))
        self._backed.add(p)

    def write(self, p, text, enc):
        """Atomic write (temp file + os.replace), one .bak per file per
        session. A PermissionError survives a short retry (see
        WRITE_RETRY_DELAYS); if the lock holds, the re-raised error names
        the file so the HTTP layer can say which one is locked."""
        p = Path(p)
        self._backup(p)
        tmp = p.with_name(p.name + '.tmp~')
        try:
            _retried(lambda: self._write_tmp_and_replace(tmp, p, text, enc))
        except PermissionError as e:
            # leave no half-written temp behind (one that is itself
            # locked stays — deleting it can be denied too)
            try:
                tmp.unlink()
            except OSError:
                pass
            raise PermissionError(
                f'cannot write {p.name}: {e.strerror or e}') from None
        self.last_write = (str(p), time.time())

    def _write_tmp_and_replace(self, tmp, p, text, enc):
        with open(tmp, 'w', encoding=enc, newline='') as f:
            f.write(text)
        os.replace(tmp, p)


def patch(text, start, end, original, new):
    """Replace [start, end) with new, verifying the span still holds `original`.

    If the span drifted (file edited elsewhere), fall back to a text search
    for the original block source. Returns the new text, or None on conflict.
    """
    if 0 <= start <= end <= len(text) and text[start:end] == original:
        return text[:start] + new + text[end:]
    idx = text.find(original)
    if idx >= 0:
        return text[:idx] + new + text[idx + len(original):]
    return None
