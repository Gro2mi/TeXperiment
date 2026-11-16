"""M1 — Store block operations on a real project (texperiment/server.py).

The Store is where edits become bytes on disk. Two layers of protection:
an invariant checker after every op (source == on-disk slice, unique ids),
and a golden-file pin of a fixed op sequence — undoing the whole history
must restore the demo project byte-for-byte, redoing must reproduce the
goldens.

Regenerate goldens deliberately after an intended behavior change:
    TEXPERIMENT_UPDATE_GOLDEN=1 python -m pytest tests/integration
"""
import os
from pathlib import Path

import pytest
from helpers import assert_doc_consistent, find_block

from texperiment.resolver import read_text_preserve
from texperiment.server import Store
from texperiment.storage import ConflictError

GOLDEN = Path(__file__).resolve().parent.parent / 'golden' / 'store_ops'


def read_bytes_of(store, rel):
    return (store.root / rel).read_bytes()


def current_files(store):
    """{rel: bytes} snapshot of every file in the doc."""
    return {f['path']: read_bytes_of(store, f['path'])
            for f in store.doc['files']}


def compare_or_update_golden(store):
    for fentry in store.doc['files']:
        rel = fentry['path']
        gpath = GOLDEN / rel
        # compare newline-agnostically: the demo files' line endings
        # depend on the checkout's git autocrlf setting, and goldens
        # must hold on every machine. Stripping all \r is idempotent
        # (a plain \r\n -> \n pass is not: '\r\r\n' leaves a residual
        # '\r\n' behind). Byte-level CRLF behavior itself is pinned in
        # tests/unit/test_regressions.py on controlled inputs.
        data = read_bytes_of(store, rel).replace(b'\r', b'')
        if os.environ.get('TEXPERIMENT_UPDATE_GOLDEN'):
            gpath.parent.mkdir(parents=True, exist_ok=True)
            gpath.write_bytes(data)
        else:
            assert gpath.exists(), \
                f'missing golden {gpath} — regenerate with ' \
                'TEXPERIMENT_UPDATE_GOLDEN=1'
            assert gpath.read_bytes().replace(b'\r', b'') == data, \
                f'{rel} differs from golden {gpath}'


def run_op_sequence(store):
    """The fixed op sequence pinned by the golden files."""

    def step(fn):
        fn()
        assert_doc_consistent(store)

    # 1. edit a paragraph in the main file
    b = find_block(store, 'BLOCKONE Welcome', file='main.tex')
    step(lambda: store.op_save(
        b['id'],
        'Welcome to the live LaTeX editor demo. This paragraph was '
        'edited by the test suite.'))

    # 2. insert a single-block paragraph in ch2
    b = find_block(store, 'Chapter two arrives', file='chapters/ch2.tex')
    def do_insert():
        new_id = store.op_insert(
            b['id'], 'A brand new paragraph inserted by the test suite.')
        assert new_id, 'single-block insert should return the new id'
    step(do_insert)

    # 3. delete a middle paragraph (trailing separator goes with it)
    b = find_block(store, 'A plain tabular block', file='chapters/ch2.tex')
    step(lambda: store.op_delete(b['id']))

    # 4. move the first tabular down one position
    b = find_block(store, '\\begin{tabular}{ll}', file='chapters/ch2.tex',
                   type='table')
    step(lambda: store.op_move(b['id'], 'down', 1))

    # 5. multi-block move: the figure travels to the end of ch2
    fig = find_block(store, '\\begin{figure}', file='chapters/ch2.tex',
                     type='figure')
    env = find_block(store, '\\begin{mycustomenv}',
                     file='chapters/ch2.tex', type='env')
    step(lambda: store.op_move_blocks([fig['id']], env['id']))

    # 6. rewrite a whole section in ch2
    b = find_block(store, '\\subsection{Tables}', file='chapters/ch2.tex',
                   type='section')
    step(lambda: store.op_save_section(
        b['id'],
        '\\subsection{Tables}\n\n'
        'The tables section body was rewritten by the test suite.\n'))

    # 7. move a whole subsection up past its sibling in ch1
    b = find_block(store, '\\subsection{Lists}', file='chapters/ch1.tex',
                   type='section')
    step(lambda: store.op_move(b['id'], 'up', 1))


# -- golden sequence -------------------------------------------------------------

def test_op_sequence_golden_and_history_roundtrip(demo_project):
    store = Store(demo_project / 'main.tex')
    assert_doc_consistent(store)
    originals = current_files(store)

    run_op_sequence(store)
    compare_or_update_golden(store)

    # undo the entire history: files return to their original bytes
    while store.history['undo']:
        store.op_undo()
    assert_doc_consistent(store)
    assert current_files(store) == originals

    # redo everything: goldens again
    while store.history['redo']:
        store.op_redo()
    assert_doc_consistent(store)
    compare_or_update_golden(store)


# -- document shape ----------------------------------------------------------------

def test_demo_doc_shape(demo_project):
    store = Store(demo_project / 'main.tex')
    doc = store.doc
    assert doc['main'] == 'main.tex'
    assert [f['path'] for f in doc['files']] == \
        ['main.tex', 'chapters/ch1.tex', 'chapters/ch2.tex']
    types = {b['type'] for b in doc['blocks']}
    assert {'preamble', 'enddoc', 'section', 'paragraph', 'math', 'list',
            'table', 'figure', 'env', 'comment'} <= types


def test_constructor_rejects_bad_mains(tmp_path):
    with pytest.raises(FileNotFoundError):
        Store(tmp_path / 'missing.tex')
    p = tmp_path / 'main.txt'
    p.write_text('x', encoding='utf-8')
    with pytest.raises(ValueError):
        Store(p)


# -- id stability --------------------------------------------------------------------

def test_ids_stable_for_blocks_not_being_edited(demo_project):
    store = Store(demo_project / 'main.tex')
    before = {b['id']: (b['file'], b['source']) for b in store.doc['blocks']}
    edited = find_block(store, 'BLOCKONE Welcome', file='main.tex')
    store.op_save(edited['id'], 'Edited to something else entirely.')
    by_id = {b['id']: b for b in store.doc['blocks']}
    for bid, (f, src) in before.items():
        if bid == edited['id']:
            continue
        assert bid in by_id, f'{bid} vanished although its content exists'
        assert (by_id[bid]['file'], by_id[bid]['source']) == (f, src), \
            f'{bid} re-bound to different content'
    # duplicate sources would make content-bound ids ambiguous — demo has none
    sources = [b['source'] for b in store.doc['blocks']]
    assert len(sources) == len(set(sources))


def test_moves_preserve_the_whole_id_set(demo_project):
    store = Store(demo_project / 'main.tex')
    ids0 = {b['id'] for b in store.doc['blocks']}
    b = find_block(store, '\\begin{tabular}{ll}', file='chapters/ch2.tex',
                   type='table')
    store.op_move(b['id'], 'down', 1)
    assert {x['id'] for x in store.doc['blocks']} == ids0
    s = find_block(store, '\\subsection{Lists}', file='chapters/ch1.tex',
                   type='section')
    store.op_move(s['id'], 'up', 1)
    assert {x['id'] for x in store.doc['blocks']} == ids0


# -- individual ops ---------------------------------------------------------------------

def test_op_save_changes_disk_bytes(demo_project):
    store = Store(demo_project / 'main.tex')
    b = find_block(store, 'Chapter two arrives', file='chapters/ch2.tex')
    new = 'Chapter two, now with different words.'
    store.op_save(b['id'], new)
    text, _ = read_text_preserve(store.root / 'chapters/ch2.tex')
    assert new in text
    assert 'Chapter two arrives via' not in text
    # surrounding content untouched
    assert 'A plain tabular block' in text
    assert '\\end{mycustomenv}' in text


def test_op_insert_single_block_returns_id(demo_project):
    store = Store(demo_project / 'main.tex')
    b = find_block(store, 'Chapter two arrives', file='chapters/ch2.tex')
    new_id = store.op_insert(b['id'], 'Inserted single paragraph.')
    assert new_id
    nb = store._block(new_id)
    assert nb['source'] == 'Inserted single paragraph.'
    assert nb['type'] == 'paragraph'


def test_op_insert_multi_block_returns_none_but_inserts(demo_project):
    store = Store(demo_project / 'main.tex')
    b = find_block(store, 'Chapter two arrives', file='chapters/ch2.tex')
    src = '\\section{Fresh}\n\nFresh body.'
    new_id = store.op_insert(b['id'], src)
    assert new_id is None  # no single block equals the whole source
    heads = [x for x in store.doc['blocks']
             if x['file'] == 'chapters/ch2.tex'
             and x['type'] == 'section'
             and (x.get('meta') or {}).get('title') == 'Fresh']
    assert len(heads) == 1
    assert find_block(store, 'Fresh body.', file='chapters/ch2.tex')


def test_op_delete_middle_block_swallows_trailing_separator(demo_project):
    store = Store(demo_project / 'main.tex')
    b = find_block(store, 'A booktabs table with rules',
                   file='chapters/ch2.tex')
    store.op_delete(b['id'])
    text, _ = read_text_preserve(store.root / 'chapters/ch2.tex')
    assert 'booktabs table with rules' not in text
    # the paragraph's trailing blank line went with it; the leading one
    # stayed — so exactly one blank line remains between the neighbours
    # (the demo files are CRLF; compare newline-agnostically)
    norm = text.replace('\r\n', '\n')
    assert '\\end{tabular}\n\n\\begin{tabular}{lrr}' in norm


def test_op_delete_last_block_of_file(demo_project):
    store = Store(demo_project / 'main.tex')
    b = find_block(store, '\\begin{mycustomenv}',
                   file='chapters/ch2.tex', type='env')
    store.op_delete(b['id'])
    text, _ = read_text_preserve(store.root / 'chapters/ch2.tex')
    assert 'mycustomenv' not in text
    # the env was the last block; the file now ends with the intro
    # paragraph of the "Something exotic" section
    assert text.rstrip().endswith('kept safe and visible:')


def test_op_delete_before_preamble_forbidden(demo_project):
    store = Store(demo_project / 'main.tex')
    pre = next(x for x in store.doc['blocks'] if x['type'] == 'preamble')
    with pytest.raises(ValueError):
        store.op_delete(pre['id'])


def test_op_move_preamble_forbidden(demo_project):
    store = Store(demo_project / 'main.tex')
    pre = next(x for x in store.doc['blocks'] if x['type'] == 'preamble')
    with pytest.raises(ValueError):
        store.op_move(pre['id'], 'down', 1)


def test_op_insert_after_preamble_forbidden(demo_project):
    store = Store(demo_project / 'main.tex')
    pre = next(x for x in store.doc['blocks'] if x['type'] == 'preamble')
    with pytest.raises(ValueError):
        store.op_insert(pre['id'], 'nope')


def test_unknown_block_id_raises_keyerror(demo_project):
    store = Store(demo_project / 'main.tex')
    with pytest.raises(KeyError):
        store.op_save('does-not-exist', 'x')


def test_op_move_out_of_range(demo_project):
    store = Store(demo_project / 'main.tex')
    b = find_block(store, 'This is chapter one', file='chapters/ch1.tex')
    with pytest.raises(ValueError):
        store.op_move(b['id'], 'up', 1)  # already first in its file


def test_op_move_bad_direction(demo_project):
    store = Store(demo_project / 'main.tex')
    b = find_block(store, 'This is chapter one', file='chapters/ch1.tex')
    with pytest.raises(ValueError):
        store.op_move(b['id'], 'sideways')


# -- conflicts ---------------------------------------------------------------------------

def test_op_save_conflict_when_source_gone_from_disk(demo_project):
    store = Store(demo_project / 'main.tex')
    b = find_block(store, 'Chapter two arrives', file='chapters/ch2.tex')
    # external edit removes the anchored source text entirely
    p = store.root / 'chapters/ch2.tex'
    text, enc = read_text_preserve(p)
    p.write_bytes(text.replace(b['source'], 'REPLACED EXTERNALLY')
                  .encode(enc))
    with pytest.raises(ConflictError):
        store.op_save(b['id'], 'too late')


# -- undo / redo ---------------------------------------------------------------------------

def test_undo_redo_single_op_byte_exact(demo_project):
    store = Store(demo_project / 'main.tex')
    rel = 'chapters/ch2.tex'
    before = read_bytes_of(store, rel)
    b = find_block(store, 'Chapter two arrives', file=rel)
    store.op_save(b['id'], 'Rewritten once.')
    after = read_bytes_of(store, rel)
    assert after != before

    assert store.op_undo() == 'edit block'
    assert read_bytes_of(store, rel) == before
    assert store.op_redo() == 'edit block'
    assert read_bytes_of(store, rel) == after


def test_undo_returns_none_on_empty_history(demo_project):
    store = Store(demo_project / 'main.tex')
    assert store.op_undo() is None
    assert store.op_redo() is None


def test_history_capped_at_limit(demo_project):
    store = Store(demo_project / 'main.tex')
    b = find_block(store, 'this is a test if the LaTeX editor picks up',
                   file='chapters/ch1.tex')
    for i in range(store.HISTORY_LIMIT + 5):
        store.op_save(b['id'], f'toggle {i % 2}')
    assert len(store.history['undo']) == store.HISTORY_LIMIT


# -- sections --------------------------------------------------------------------------------

def test_section_span_covers_heading_to_next_sibling(demo_project):
    store = Store(demo_project / 'main.tex')
    body = find_block(store, 'A plain tabular block',
                      file='chapters/ch2.tex')
    span = store.section_span(body['id'])
    assert span['file'] == 'chapters/ch2.tex'
    assert span['title'] == 'Tables'
    assert span['level'] == 3
    text, _ = read_text_preserve(store.root / span['file'])
    assert span['source'] == text[span['start']:span['end']]
    assert span['source'].startswith('\\subsection{Tables}')
    assert '\\begin{tabular}{lrr}' in span['source']
    assert '\\subsection{Figures}' not in span['source']
    # ids of the spanned blocks, heading first
    assert span['heading_id'] == span['ids'][0]


def test_section_span_none_outside_any_section(demo_project):
    store = Store(demo_project / 'main.tex')
    pre = next(x for x in store.doc['blocks'] if x['type'] == 'preamble')
    assert store.section_span(pre['id']) is None
    maketitle = find_block(store, '\\maketitle', file='main.tex')
    assert store.section_span(maketitle['id']) is None


def test_op_save_section_replaces_span(demo_project):
    store = Store(demo_project / 'main.tex')
    b = find_block(store, 'A plain tabular block', file='chapters/ch2.tex')
    store.op_save_section(
        b['id'],
        '\\subsection{Tables}\n\nOnly prose remains.\n')
    text, _ = read_text_preserve(store.root / 'chapters/ch2.tex')
    assert 'Only prose remains.' in text
    assert 'tabular' not in text
    assert '\\subsection{Figures}' in text
    assert_doc_consistent(store)


def test_op_save_section_rejects_block_outside_section(demo_project):
    store = Store(demo_project / 'main.tex')
    pre = next(x for x in store.doc['blocks'] if x['type'] == 'preamble')
    with pytest.raises(ValueError):
        store.op_save_section(pre['id'], 'x')


# -- raw file access ---------------------------------------------------------------------------

def test_raw_get_put_roundtrip(demo_project):
    store = Store(demo_project / 'main.tex')
    text, _ = store.raw_get('chapters/ch2.tex')
    assert 'Chapter two arrives' in text
    store.raw_put('chapters/ch2.tex', text.replace(
        'Chapter two arrives via', 'Chapter two, edited raw, arrives via'))
    text2, _ = store.raw_get('chapters/ch2.tex')
    assert 'edited raw' in text2
    assert_doc_consistent(store)


def test_raw_put_rejects_non_tex(demo_project):
    store = Store(demo_project / 'main.tex')
    store.fs.write(store.root / 'notes.txt', 'x', 'utf-8')
    with pytest.raises(ValueError):
        store.raw_put('notes.txt', 'y')


def test_raw_access_rejects_path_escape(demo_project):
    store = Store(demo_project / 'main.tex')
    with pytest.raises(ValueError):
        store.raw_get('../outside.tex')
    with pytest.raises(FileNotFoundError):
        store.raw_get('not-there.tex')
