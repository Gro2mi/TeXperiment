"""Shared helpers for the texperiment test suites (imported as `helpers`,
a unique module name that no conftest shadows)."""
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEMO = REPO / 'demo'


# -- invariants -------------------------------------------------------------

def assert_spans_valid(text, blocks):
    """Parser-level span invariant: blocks are ordered, non-overlapping,
    in-bounds, and block + gap slices reconstruct the file exactly."""
    pieces = []
    cur = 0
    for typ, s, e, meta in blocks:
        assert 0 <= s <= e <= len(text), (typ, s, e, len(text))
        assert s >= cur, f'block {typ} at {s} overlaps previous end {cur}'
        pieces.append(text[cur:s])  # gap
        pieces.append(text[s:e])    # block
        cur = e
    pieces.append(text[cur:])
    assert ''.join(pieces) == text


def assert_doc_consistent(store):
    """Store-level invariant after any op: every block's source equals its
    on-disk slice in its file, ids are unique, and per-file blocks are
    ordered and non-overlapping."""
    from texperiment.resolver import read_text_preserve
    doc = store.doc
    ids = [b['id'] for b in doc['blocks']]
    assert len(ids) == len(set(ids)), 'duplicate block ids'
    for fentry in doc['files']:
        rel = fentry['path']
        text, _ = read_text_preserve(store.root / rel)
        same = sorted((b for b in doc['blocks'] if b['file'] == rel),
                      key=lambda b: b['start'])
        cur = 0
        for b in same:
            assert b['start'] >= cur, f'{rel}:{b["id"]} overlaps'
            assert b['source'] == text[b['start']:b['end']], \
                f'{rel}:{b["id"]} source/span mismatch'
            cur = b['end']


# -- lookup helpers ----------------------------------------------------------

def find_block(store, prefix, file=None, type=None):
    """The block whose source starts with `prefix` (after strip)."""
    hits = [b for b in store.doc['blocks']
            if b['source'].lstrip().startswith(prefix)
            and (file is None or b['file'] == file)
            and (type is None or b['type'] == type)]
    assert len(hits) == 1, f'expected 1 block starting {prefix!r}, got {len(hits)}'
    return hits[0]
