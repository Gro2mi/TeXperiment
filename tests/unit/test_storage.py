"""M1 — patch anchoring and atomic writes (texperiment/storage.py).

`patch()` is the last line of defense against corrupting a .tex file: it
only replaces text it can anchor, and returns None (conflict) otherwise.
"""
import threading
import time

import pytest

import texperiment.storage as storage
from texperiment.storage import FileStore, patch

# -- patch ----------------------------------------------------------------------

def test_patch_exact_span():
    text = 'AAA[old]BBB'
    assert patch(text, 4, 8, '[old]', '[new]') == 'AAA[new]BBB'


def test_patch_start_and_end_boundaries():
    text = '[old] tail'
    assert patch(text, 0, 5, '[old]', '[new]') == '[new] tail'
    text = 'head [old]'
    assert patch(text, 5, 10, '[old]', '[new]') == 'head [new]'


def test_patch_drifted_span_falls_back_to_search():
    # the file grew before the block — the span is stale but the source
    # is still findable, so the edit lands at the found position
    text = 'XXXXAAA[old]BBB'
    assert patch(text, 4, 8, '[old]', '[new]') == 'XXXXAAA[new]BBB'


def test_patch_missing_original_conflicts():
    text = 'AAA other BBB'
    assert patch(text, 4, 8, '[old]', '[new]') is None


def test_patch_span_mismatch_but_source_found_elsewhere():
    # span no longer holds the original, but the original exists at a
    # different offset — the fallback patches the found occurrence
    text = 'AAA foo BBB [old] CCC'
    assert patch(text, 0, 3, '[old]', '[new]') == 'AAA foo BBB [new] CCC'


def test_patch_duplicate_source_falls_back_to_first_occurrence():
    # two identical block sources: a stale span pointing at the second
    # can't be verified, and the drift fallback patches the FIRST
    # occurrence — pinned as current behavior (TESTING.md register #2)
    text = 'x [blk] y [blk] z'
    assert patch(text, 9, 14, '[blk]', '[new]') == 'x [new] y [blk] z'


def test_patch_empty_replacement_deletes():
    text = 'keep[drop]rest'
    assert patch(text, 4, 10, '[drop]', '') == 'keeprest'


def test_patch_crlf_sources_unchanged_region():
    text = 'a\r\n[old]\r\nb\r\n'
    assert patch(text, 3, 9, '[old]\r', 'x') == 'a\r\nx\nb\r\n'


# -- FileStore --------------------------------------------------------------------

def test_filestore_write_is_byte_exact(tmp_path):
    fs = FileStore(tmp_path)
    p = tmp_path / 'main.tex'
    fs.write(p, 'alpha\r\nbeta\r\n', 'utf-8')
    assert p.read_bytes() == b'alpha\r\nbeta\r\n'
    fs.write(p, 'only lf\n', 'utf-8')
    assert p.read_bytes() == b'only lf\n'


def test_filestore_bak_written_once_per_session(tmp_path):
    fs = FileStore(tmp_path)
    p = tmp_path / 'main.tex'
    p.write_text('original', encoding='utf-8')
    fs.write(p, 'first', 'utf-8')
    assert (tmp_path / 'main.tex.bak').read_text(encoding='utf-8') == \
        'original'
    fs.write(p, 'second', 'utf-8')
    # the .bak still holds the pre-session content, not 'first'
    assert (tmp_path / 'main.tex.bak').read_text(encoding='utf-8') == \
        'original'


def test_filestore_no_bak_for_new_file(tmp_path):
    fs = FileStore(tmp_path)
    p = tmp_path / 'new.tex'
    fs.write(p, 'content', 'utf-8')
    assert p.read_text(encoding='utf-8') == 'content'
    assert not (tmp_path / 'new.tex.bak').exists()


def test_filestore_leaves_no_temp_file(tmp_path):
    fs = FileStore(tmp_path)
    p = tmp_path / 'main.tex'
    p.write_text('x', encoding='utf-8')
    fs.write(p, 'y', 'utf-8')
    assert list(tmp_path.glob('*.tmp~')) == []


def test_filestore_sets_last_write_marker(tmp_path):
    fs = FileStore(tmp_path)
    p = tmp_path / 'main.tex'
    t0 = time.time()
    fs.write(p, 'y', 'utf-8')
    assert fs.last_write is not None
    path_str, ts = fs.last_write
    assert path_str == str(p)
    assert ts >= t0


# -- locked-file retries ------------------------------------------------------------
# Windows denies writes to project files with Errno 13 while another
# process holds them: a PDF export just spawned pdflatex over the
# sources, an antivirus scans each file it created, a sync client or
# indexer touches the directory. One denied write used to fail the whole
# edit with a 500 (seen live: block move during a PDF export).

def test_write_retries_a_transient_lock(tmp_path):
    # the temp file is held read-only for a moment, then released — the
    # write must survive it (retry window ~0.75 s, the lock lifts at 0.15)
    fs = FileStore(tmp_path)
    p = tmp_path / 'main.tex'
    p.write_text('original', encoding='utf-8')
    tmp = tmp_path / 'main.tex.tmp~'
    tmp.write_text('', encoding='utf-8')
    tmp.chmod(0o444)

    def unlock():
        time.sleep(0.15)
        tmp.chmod(0o666)
    threading.Thread(target=unlock).start()

    fs.write(p, 'after the lock', 'utf-8')
    assert p.read_text(encoding='utf-8') == 'after the lock'
    assert list(tmp_path.glob('*.tmp~')) == []


def test_write_persistent_lock_preserves_the_file(tmp_path, monkeypatch):
    # the lock never lifts (the .tex sits open in a program that denies
    # writes): give up fast (no retry delays), keep the original bytes
    # untouched, and name the file in the error
    monkeypatch.setattr(storage, 'WRITE_RETRY_DELAYS', (0.0,))
    fs = FileStore(tmp_path)
    p = tmp_path / 'main.tex'
    p.write_text('original', encoding='utf-8')
    tmp = tmp_path / 'main.tex.tmp~'
    tmp.write_text('', encoding='utf-8')
    tmp.chmod(0o444)
    try:
        with pytest.raises(PermissionError, match='main.tex'):
            fs.write(p, 'never written', 'utf-8')
        assert p.read_text(encoding='utf-8') == 'original'
    finally:
        tmp.chmod(0o666)  # let tmp_path teardown delete it on Windows
