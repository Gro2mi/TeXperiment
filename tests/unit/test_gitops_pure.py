"""M2 — pure diff/alignment logic in texperiment/gitops.py.

These functions compute the offsets the frontend renders green/red marks
from — past bugs (84d56e0, 2e1d390, bc5b5af, d392c8c) were all offset or
crash bugs in exactly this layer, so the coordinate contracts are pinned
here without any git involved.
"""
from texperiment.gitops import (
    _align,
    _norm,
    _norm_src,
    _parse_spans,
    _splice_region,
    _visible_tex,
    _word_diff,
)
from texperiment.parser import parse_file

# -- _norm_src normalization (was the shadowing bug, TESTING.md #1) --------
# gitops.py used to define _norm_src twice: a CRLF-aware one and a later
# \r\n-only redefinition that shadowed it, so lone \r (CRLF spans end with
# one) never normalized and a clean CRLF checkout read as ~everything
# changed vs the LF blobs in HEAD. The duplicate is gone; this pins the
# CRLF-aware contract.

def test_norm_src_normalizes_crlf_and_lone_cr():
    assert _norm_src('a\r\nb') == 'a\nb'
    assert _norm_src('a\rb') == 'a\nb'      # lone \r = line ending too


def test_norm_src_strips_trailing_newlines():
    assert _norm_src('AAA.\r') == 'AAA.'    # the CRLF span-end case
    assert _norm_src('a\n\n') == 'a'


# -- _norm (porcelain path parsing) ------------------------------------------

def test_norm_plain_path():
    assert _norm('chapters/ch1.tex') == 'chapters/ch1.tex'


def test_norm_takes_rename_target():
    assert _norm('old.tex -> new.tex') == 'new.tex'


def test_norm_unquotes_escaped_paths():
    assert _norm('"a\\tb.tex"') == 'a\tb.tex'


def test_norm_converts_backslashes():
    assert _norm('a\\b.tex') == 'a/b.tex'


# -- _visible_tex ----------------------------------------------------------------

def test_visible_tex_unwraps_formatting():
    assert _visible_tex(r'\textbf{bold} and \emph{stress}') == \
        'bold and stress'


def test_visible_tex_unwraps_textcolor():
    assert _visible_tex(r'\textcolor{red}{alert}') == 'alert'


def test_visible_tex_drops_command_names_keeps_arguments():
    # unknown commands lose their name but the argument stays visible
    # (it is content the reader sees, e.g. a cite key)
    assert _visible_tex(r'as \cite{knuth} shows') == 'as knuth shows'


def test_visible_tex_unescapes_and_collapses():
    assert _visible_tex('50\\%  of   A\\&B') == '50% of A&B'


# -- _word_diff coordinates ------------------------------------------------------

def test_word_diff_single_replace():
    adds, dels = _word_diff('the quick brown fox', 'the slow brown fox')
    assert adds == [{'s': 4, 'e': 8}]
    assert dels == [{'s': 4, 'text': 'quick'}]


def test_word_diff_insertion_at_end():
    # bc5b5af flavor: changes at the very end of a block; the region
    # includes its leading space (the inserted separator token)
    adds, dels = _word_diff('one two', 'one two three')
    assert adds == [{'s': 7, 'e': 13}]
    assert dels == []


def test_word_diff_deletion_at_end():
    adds, dels = _word_diff('one two three', 'one two')
    assert adds == []
    assert len(dels) == 1
    assert dels[0]['s'] == 7          # insertion point = end of `new`
    assert dels[0]['text'].strip() == 'three'


def test_word_diff_adjacent_changes_group_into_one_region():
    adds, dels = _word_diff('a b c', 'a x y c')
    assert adds == [{'s': 2, 'e': 5}]          # 'x y' as one green range
    assert dels == [{'s': 2, 'text': 'b'}]     # one red placeholder


def test_word_diff_whitespace_only_change_skipped():
    assert _word_diff('a  b', 'a b') == ([], [])


def test_word_diff_formatting_only_change_is_add_without_del():
    old, new = 'plain words', r'\textbf{plain words}'
    adds, dels = _word_diff(old, new)
    assert adds == [{'s': 0, 'e': len(new)}]   # whole formatted text green
    assert dels == []                          # no red placeholder


def test_word_diff_offsets_are_in_new_coordinates():
    new = 'alpha BETA gamma delta'
    adds, dels = _word_diff('alpha beta gamma delta', new)
    assert new[adds[0]['s']:adds[0]['e']] == 'BETA'


def test_word_diff_crlf_sources_have_raw_coordinates():
    # 2e1d390 flavor: CRLF blocks — offsets must index into the raw
    # current source, counting \r\n as two characters. The region starts
    # at the inserted space (the separator token), so the green range is
    # ' changed'.
    old = 'line one\r\nline two\r\n'
    new = 'line one\r\nline two changed\r\n'
    adds, dels = _word_diff(old, new)
    assert len(adds) == 1
    assert new[adds[0]['s']:adds[0]['e']] == ' changed'
    assert dels == []   # the removed trailing \r\n is whitespace-only


def test_word_diff_identical_inputs():
    assert _word_diff('same words', 'same words') == ([], [])


# -- span helpers --------------------------------------------------------------------

def test_parse_spans_match_parser():
    text = 'Para.\n\n\\section{S}\nBody.\n'
    assert _parse_spans(text, is_main=False) == \
        [(s, e) for _t, s, e, _m in parse_file(text, is_main=False)]


def test_splice_region_replaces():
    assert _splice_region('aaa[old]bbb', (3, 8), '[new]') == 'aaa[new]bbb'


def test_splice_region_none_appends():
    assert _splice_region('tail', None, '+more') == 'tail+more'


# -- _align ------------------------------------------------------------------------------

def blocks_of(text):
    return [text[s:e] for _t, s, e, _m in parse_file(text)]


def test_align_maps_each_block_to_its_span():
    text = 'AAA.\n\nBBB.\n\nCCC.\n'
    spans = _parse_spans(text, is_main=False)
    m = _align(spans, text, blocks_of(text))
    assert set(m) == {0, 1, 2}
    for j, (s, e) in m.items():
        assert text[s:e] == ['AAA.', 'BBB.', 'CCC.'][j]


def test_align_deletion_leaves_no_mapping():
    base = 'AAA.\n\nBBB.\n\nCCC.\n'
    spans = _parse_spans(base, is_main=False)
    cur = ['AAA.', 'CCC.']                       # BBB deleted
    m = _align(spans, base, cur)
    assert m[0][0] == 0                          # AAA at its base span
    assert 1 not in m or base[m[1][0]:m[1][1]] == 'CCC.'


def test_align_insertion_unmapped():
    base = 'AAA.\n\nCCC.\n'
    spans = _parse_spans(base, is_main=False)
    cur = ['AAA.', 'BBB.', 'CCC.']               # BBB inserted
    m = _align(spans, base, cur)
    assert base[m[0][0]:m[0][1]] == 'AAA.'
    assert base[m[2][0]:m[2][1]] == 'CCC.'
    assert 1 not in m


def test_align_matches_across_line_ending_drift():
    # the shadowing-bug scenario: LF blobs in HEAD vs CRLF worktree
    # sources ending in a lone \r — normalized keys must still match
    base = 'AAA.\n\nBBB.\n'                      # LF in HEAD
    spans = _parse_spans(base, is_main=False)
    cur = ['AAA.\r', 'BBB.\r']                   # CRLF worktree
    m = _align(spans, base, cur)
    assert set(m) == {0, 1}
    assert base[m[0][0]:m[0][1]] == 'AAA.'
    assert base[m[1][0]:m[1][1]] == 'BBB.'
