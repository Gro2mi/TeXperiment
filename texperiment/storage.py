"""Atomic file writes, session backups and anchor-match span patching."""
import os
import time
from pathlib import Path


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
            bak.write_bytes(p.read_bytes())
        self._backed.add(p)

    def write(self, p, text, enc):
        """Atomic write (temp file + os.replace), one .bak per file per session."""
        p = Path(p)
        self._backup(p)
        tmp = p.with_name(p.name + '.tmp~')
        with open(tmp, 'w', encoding=enc, newline='') as f:
            f.write(text)
        os.replace(tmp, p)
        self.last_write = (str(p), time.time())


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
