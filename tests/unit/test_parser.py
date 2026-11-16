"""M1 — parser span integrity (texperiment/parser.py).

The parser's promise: blocks carry exact [start, end) spans so per-block
editing is lossless. Every corpus case checks ordering, non-overlap,
bounds, and exact reconstruction of the input from block + gap slices.
"""
import pytest
from helpers import assert_spans_valid

from texperiment.parser import mask_comments, parse_file


def types(text, is_main=False):
    return [t for t, *_ in parse_file(text, is_main=is_main)]


# -- corpus ------------------------------------------------------------------

CORPUS = [
    # (name, text, is_main, expected block types in order)
    ('plain-paragraph', 'Hello world.\n', False, ['paragraph']),
    ('two-paragraphs', 'One.\n\nTwo.\n', False, ['paragraph', 'paragraph']),
    ('no-trailing-newline', 'One.\n\nTwo.', False,
     ['paragraph', 'paragraph']),
    ('section', '\\section{One}\n\nBody of one.\n', False,
     ['section', 'paragraph']),
    ('starred-section', '\\section*{Ack}\n\nThanks.\n', False,
     ['section', 'paragraph']),
    ('main-doc',
     '\\documentclass{article}\n\\begin{document}\nHello.\n\n'
     '\\section{S}\nBody.\n\\end{document}\n',
     True, ['preamble', 'paragraph', 'section', 'paragraph', 'enddoc']),
    ('list-env',
     '\\begin{itemize}\n\\item a\n\\item b\n\\end{itemize}\n',
     False, ['list']),
    ('nested-same-name-env',
     '\\begin{itemize}\n\\item one\n\\begin{itemize}\n\\item nested\n'
     '\\end{itemize}\n\\item two\n\\end{itemize}\n',
     False, ['list']),
    ('math-env',
     '\\begin{equation}\nE = mc^2\n\\end{equation}\n',
     False, ['math']),
    ('display-brackets', 'Before.\n\n\\[\na + b\n\\]\n\nAfter.\n',
     False, ['paragraph', 'math', 'paragraph']),
    ('display-dollars', 'a\n\n$$x$$\n\nb\n',
     False, ['paragraph', 'math', 'paragraph']),
    ('table-wrap',
     '\\begin{table}\n\\centering\n\\begin{tabular}{ll}\na & b\\\\\n'
     '\\end{tabular}\n\\caption{Cap.}\n\\end{table}\n',
     False, ['table']),
    ('figure-env',
     '\\begin{figure}\n\\includegraphics{x.png}\n\\end{figure}\n',
     False, ['figure']),
    ('unknown-env',
     '\\begin{mycustomenv}\nraw body\n\\end{mycustomenv}\n',
     False, ['env']),
    ('comments-merge', '% one\n% two\n\ntext\n',
     False, ['comment', 'paragraph']),
    ('comment-only-line-between', 'a\n\n% side note\n\nb\n',
     False, ['paragraph', 'comment', 'paragraph']),
    ('empty-file', '', False, []),
    ('blank-only-file', '\n\n\n', False, []),
    ('crlf', 'A.\r\n\r\n\\section{T}\r\nB.\r\n', False,
     ['paragraph', 'section', 'paragraph']),
]


@pytest.mark.parametrize('name,text,is_main,expected', CORPUS,
                         ids=[c[0] for c in CORPUS])
def test_corpus_spans_and_types(name, text, is_main, expected):
    blocks = parse_file(text, is_main=is_main)
    assert_spans_valid(text, blocks)
    assert [t for t, *_ in blocks] == expected


# -- specific behaviors --------------------------------------------------------

def test_section_meta_level_and_title():
    blocks = parse_file('\\chapter{Top}\n\\section{One}\n'
                        '\\subsection{Deep \\texttt{thing}}\n')
    levels = [b[3]['level'] for b in blocks]
    titles = [b[3]['title'] for b in blocks]
    assert levels == [1, 2, 3]
    assert titles == ['Top', 'One', 'Deep \\texttt{thing}']


def test_starred_section_meta():
    b = parse_file('\\subsection*{Notes}\n')[0]
    assert b[0] == 'section'
    assert b[3] == {'level': 3, 'title': 'Notes'}


def test_math_env_meta_wrap():
    b = parse_file('\\begin{align*}\nx &= 1\n\\end{align*}\n')[0]
    assert b[0] == 'math'
    assert b[3] == {'wrap': 'env:align*'}


def test_display_math_meta_wrap():
    blocks = parse_file('$$x$$\n')
    assert blocks[0][3] == {'wrap': 'dollars'}
    blocks = parse_file('\\[x\\]\n')
    assert blocks[0][3] == {'wrap': 'brackets'}


def test_list_env_meta():
    b = parse_file('\\begin{enumerate}\n\\item x\n\\end{enumerate}\n')[0]
    assert b[3] == {'env': 'enumerate'}


def test_unknown_env_meta_name():
    b = parse_file('\\begin{quote}\ntext\n\\end{quote}\n')[0]
    assert b[0] == 'env'
    assert b[3] == {'name': 'quote'}


def test_commented_out_env_is_not_markup():
    # the whole \begin{itemize} sits behind % — must stay one comment block
    blocks = parse_file('% \\begin{itemize}\n% \\item hidden\n'
                        '% \\end{itemize}\n\nreal text\n')
    assert_spans_valid('% \\begin{itemize}\n% \\item hidden\n'
                       '% \\end{itemize}\n\nreal text\n', blocks)
    assert [b[0] for b in blocks] == ['comment', 'paragraph']


def test_escaped_percent_is_not_a_comment():
    text = 'Discount 50\\% today.\n\nMore.\n'
    blocks = parse_file(text)
    assert_spans_valid(text, blocks)
    assert [b[0] for b in blocks] == ['paragraph', 'paragraph']
    assert text[blocks[0][1]:blocks[0][2]] == 'Discount 50\\% today.'


def test_double_backslash_then_percent_is_a_comment():
    # \\% is a line-continuation backslash followed by a real comment
    text = 'code \\\\\n% actually a comment\n'
    blocks = parse_file(text)
    assert [b[0] for b in blocks] == ['paragraph', 'comment']


def test_unbalanced_env_degrades_to_paragraph():
    text = '\\begin{itemize}\n\\item no end\n'
    blocks = parse_file(text)
    assert_spans_valid(text, blocks)
    assert [b[0] for b in blocks] == ['paragraph']


def test_preamble_span_includes_begin_document_line():
    text = '\\documentclass{article}\n\\title{T}\n\\begin{document}\nbody\n' \
           '\\end{document}\n'
    blocks = parse_file(text, is_main=True)
    pre = blocks[0]
    assert pre[0] == 'preamble'
    assert text[pre[1]:pre[2]] == \
        '\\documentclass{article}\n\\title{T}\n\\begin{document}'
    end = blocks[-1]
    assert end[0] == 'enddoc'
    assert text[end[1]:end[2]] == '\\end{document}\n'


def test_missing_end_document_still_parses_body():
    text = '\\documentclass{article}\n\\begin{document}\nbody\n'
    blocks = parse_file(text, is_main=True)
    assert_spans_valid(text, blocks)
    assert [b[0] for b in blocks] == ['preamble', 'paragraph']


def test_paragraph_merges_consecutive_text_lines():
    text = 'first line\nsecond line\n\nnext para\n'
    blocks = parse_file(text)
    assert len(blocks) == 2
    assert text[blocks[0][1]:blocks[0][2]] == 'first line\nsecond line'


def test_section_block_spans_whole_line_including_trailing_words():
    text = '\\section{T} some trailing words\nbody\n'
    blocks = parse_file(text)
    assert blocks[0][0] == 'section'
    assert text[blocks[0][1]:blocks[0][2]] == '\\section{T} some trailing words'


# -- mask_comments -------------------------------------------------------------

def test_mask_comments_same_length_and_only_blanks():
    text = 'keep\n% comment gone\ndata\r\n50\\% ok\n'
    masked = mask_comments(text)
    assert len(masked) == len(text)
    # masking only ever blanks characters — never rewrites surviving ones
    for i, ch in enumerate(masked):
        assert ch == ' ' or ch == text[i]


def test_mask_comments_hides_comment_content():
    masked = mask_comments('% \\begin{itemize}\nb\n')
    assert 'itemize' not in masked
    assert 'b' in masked  # uncommented line untouched


def test_mask_comments_never_hides_structure_outside_comments():
    text = '\\begin{itemize}\n% \\end{itemize}\n'
    masked = mask_comments(text)
    assert masked.startswith('\\begin{itemize}')
    assert '\\end' not in masked
