"""Resolve the \\input/\\include file graph starting from a main .tex file."""
import re
from pathlib import Path

from .parser import mask_comments

INPUT_RE = re.compile(r'\\(?:input|include)\{([^{}]+)\}')


def read_text_preserve(path):
    """Read a file preserving exact newline bytes; returns (text, encoding).

    utf-8-sig is only chosen when a BOM is actually present, because
    writing with that codec unconditionally re-adds a BOM.
    """
    data = Path(path).read_bytes()
    if data.startswith(b'\xef\xbb\xbf'):
        return data.decode('utf-8-sig'), 'utf-8-sig'
    for enc in ('utf-8', 'cp1252', 'latin-1'):
        try:
            return data.decode(enc), enc
        except UnicodeDecodeError:
            continue
    return data.decode('latin-1'), 'latin-1'


def resolve_files(main_path):
    """Ordered list of absolute Paths: main file first, then \\input/\\include
    targets in document order. Commented-out inputs are ignored; cycles and
    missing files are skipped."""
    main_path = Path(main_path).resolve()
    root = main_path.parent
    order = []
    seen = set()

    def walk(p):
        rp = p.resolve()
        if rp in seen or not rp.exists():
            return
        seen.add(rp)
        order.append(rp)
        text, _ = read_text_preserve(rp)
        masked = mask_comments(text)
        for m in INPUT_RE.finditer(masked):
            name = m.group(1).strip()
            if not name:
                continue
            cand = root / name
            if cand.suffix == '':
                cand = Path(str(cand) + '.tex')
            if cand.exists():
                walk(cand)

    walk(main_path)
    return order
