"""M1 — regression pins for past bug flavors (see TESTING.md policy).

Each test names the bug class it guards against; docstrings cite the fix
commit when known. New fixes append new tests here, failing-first.
"""
from helpers import assert_spans_valid

from texperiment.parser import parse_file
from texperiment.resolver import read_text_preserve
from texperiment.server import Store

CRLF_MAIN = (
    '\\documentclass{article}\r\n'
    '\\begin{document}\r\n'
    '\r\n'
    'Alpha paragraph.\r\n'
    '\r\n'
    '\\section{S}\r\n'
    'Beta paragraph.\r\n'
    '\r\n'
    '\\end{document}\r\n'
)


def make_project(tmp_path, main_text, encoding='utf-8'):
    p = tmp_path / 'main.tex'
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(main_text.encode(encoding))
    return p


def lf_count(text):
    return text.count('\n')


def crlf_count(text):
    return text.count('\r\n')


# 2a4fe91 — CRLF leaked into proofreading text; more broadly: CRLF files
# must stay CRLF through a block edit, never mixed line endings
def test_crlf_project_stays_crlf_through_block_edit(tmp_path):
    p = make_project(tmp_path, CRLF_MAIN)
    store = Store(p)
    b = next(x for x in store.doc['blocks']
             if x['source'].startswith('Alpha paragraph'))
    store.op_save(b['id'], 'Alpha paragraph, edited.\r')
    text, _ = read_text_preserve(p)
    assert 'Alpha paragraph, edited.' in text
    assert 'Beta paragraph.' in text
    # every newline in the file is still part of a CRLF pair
    assert lf_count(text) == crlf_count(text), \
        'bare LF leaked into a CRLF file'


def test_crlf_blocks_span_only_their_own_lines(tmp_path):
    p = make_project(tmp_path, CRLF_MAIN)
    store = Store(p)
    for b in store.doc['blocks']:
        if b['type'] in ('preamble', 'enddoc'):
            continue  # these legitimately span to the file/line edge
        # a body block may end with at most one \r (its own line ending);
        # the \n separators between blocks stay outside the span
        assert not b['source'].endswith('\r\n'), b['id']
        assert not b['source'].startswith('\n'), b['id']


# encoding drift class: BOM files must round-trip with their BOM intact
def test_bom_project_keeps_bom_through_edit(tmp_path):
    p = make_project(tmp_path, CRLF_MAIN.replace('\r\n', '\n'),
                     encoding='utf-8-sig')
    store = Store(p)
    assert store.doc['files'][0]['encoding'] == 'utf-8-sig'
    b = next(x for x in store.doc['blocks']
             if x['source'].startswith('Alpha paragraph'))
    store.op_save(b['id'], 'Alpha paragraph, edited.')
    assert p.read_bytes().startswith(b'\xef\xbb\xbf')
    assert b'Alpha paragraph, edited.' in p.read_bytes()


# bc5b5af flavor — deletions at the very end of a block / at EOF boundaries
def test_delete_final_body_block_before_end_document(tmp_path):
    # no blank line before \end{document}: the paragraph is the last body
    # block, flush against the enddoc block
    p = make_project(tmp_path,
                     '\\documentclass{article}\n\\begin{document}\n'
                     'Only paragraph.\n\\end{document}\n')
    store = Store(p)
    b = next(x for x in store.doc['blocks']
             if x['source'] == 'Only paragraph.')
    store.op_delete(b['id'])
    text, _ = read_text_preserve(p)
    assert 'Only paragraph.' not in text
    assert text.endswith('\\begin{document}\n\\end{document}\n')


def test_delete_block_at_eof_without_trailing_newline(tmp_path):
    p = make_project(tmp_path, '\\documentclass{article}\n'
                     '\\begin{document}\n\nFirst.\n\nLast.')
    store = Store(p)
    b = next(x for x in store.doc['blocks'] if x['source'] == 'Last.')
    store.op_delete(b['id'])
    text, _ = read_text_preserve(p)
    assert text.endswith('First.')
    assert 'Last.' not in text


# 84d56e0 flavor (Store-level half) — a replaced block followed by an
# inserted block must not corrupt the spans of following blocks
def test_replace_then_insert_keeps_following_blocks_intact(tmp_path):
    p = make_project(tmp_path,
                     '\\documentclass{article}\n\\begin{document}\n'
                     'One.\n\nTwo.\n\nThree.\n\\end{document}\n')
    store = Store(p)
    two = next(x for x in store.doc['blocks'] if x['source'] == 'Two.')
    store.op_save(two['id'], 'Two, replaced with longer text.')
    store.op_insert(two['id'], 'Two-and-a-half, inserted after.')
    three = next(x for x in store.doc['blocks']
                 if x['source'] == 'Three.')
    text, _ = read_text_preserve(p)
    assert text[three['start']:three['end']] == 'Three.'
    assert 'Two, replaced with longer text.\n\n' \
        'Two-and-a-half, inserted after.\n\nThree.' in text


# 2e1d390 / d392c8c flavor — parser offsets must survive re-parses when
# only the tail of the document changed
def test_spans_stable_when_tail_changes(tmp_path):
    text = 'Head paragraph.\n\n\\section{S}\nTail one.\n'
    blocks0 = parse_file(text)
    text2 = 'Head paragraph.\n\n\\section{S}\nTail one, changed.\n'
    blocks1 = parse_file(text2)
    assert_spans_valid(text2, blocks1)
    assert blocks0[0][1:3] == blocks1[0][1:3]  # head span identical
    assert blocks0[1][1:3] == blocks1[1][1:3]  # section span identical
    assert blocks1[2][1:3] == (text2.index('Tail one'), len(text2) - 1)


# --- natexlab in natbib labels: \citep chips showed (Author, 2026\natexlabb) ---
# natbib writes year suffixes into the optional bibitem label as
# \bibitem[Fischer et~al.(2026\natexlab{b})]{key}; the display cleaner must
# resolve \natexlab{X} to X (what LaTeX typesets), not keep the command name
# after stripping braces. Bug + fix live in _latex_clean / _bbl_entry.

def test_latex_clean_resolves_natexlab():
    from texperiment.server import _latex_clean
    assert _latex_clean(r'Fischer et~al.(2026\natexlab{b})') == \
        'Fischer et al.(2026b)'
    # suffix-less labels pass through unchanged
    assert _latex_clean(r'Fischer et~al.(2026)') == 'Fischer et al.(2026)'


def test_bbl_entry_year_takes_only_the_typeset_year():
    from texperiment.server import _bbl_entry
    e = _bbl_entry('fischer_towards_2026', 1,
                   r'Fischer et~al.(2026\natexlab{b})',
                   r'\newblock A title. (2026)', None)
    assert e['authors'] == 'Fischer et al.'
    assert e['year'] == '2026b'
