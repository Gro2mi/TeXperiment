"""M1 — input/include graph and encoding sniffing (texperiment/resolver.py)."""
from texperiment.resolver import read_text_preserve, resolve_files


def write(p, text, encoding='utf-8'):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(text.encode(encoding))
    return p


# -- read_text_preserve -----------------------------------------------------------

def test_read_utf8(tmp_path):
    p = write(tmp_path / 'a.tex', 'héllo wörld')
    assert read_text_preserve(p) == ('héllo wörld', 'utf-8')


def test_read_bom_stripped_and_flagged(tmp_path):
    p = tmp_path / 'a.tex'
    p.write_bytes(b'\xef\xbb\xbfcontent')
    assert read_text_preserve(p) == ('content', 'utf-8-sig')


def test_read_cp1252(tmp_path):
    p = tmp_path / 'a.tex'
    p.write_bytes(b'caf\xe9')  # é in cp1252, invalid utf-8
    assert read_text_preserve(p) == ('café', 'cp1252')


def test_read_latin1_fallback_for_cp1252_undefined_byte(tmp_path):
    p = tmp_path / 'a.tex'
    p.write_bytes(b'x\x81y')  # 0x81 undefined in cp1252
    text, enc = read_text_preserve(p)
    assert enc == 'latin-1'
    assert text == 'x\x81y'


def test_read_preserves_newline_bytes(tmp_path):
    p = tmp_path / 'a.tex'
    p.write_bytes(b'line1\r\nline2\r\nline3\n')
    text, _ = read_text_preserve(p)
    assert text == 'line1\r\nline2\r\nline3\n'


# -- resolve_files ------------------------------------------------------------------

def make_graph(tmp_path):
    write(tmp_path / 'main.tex',
          '\\documentclass{article}\n'
          '\\begin{document}\n'
          '% \\input{commented}\n'
          '\\input{a}\n'
          '\\include{sub/b}\n'
          '\\input{missing}\n'
          '\\input{cycle}\n'
          '\\end{document}\n')
    write(tmp_path / 'a.tex', 'A first.\n\\input{cycle}\n')
    write(tmp_path / 'cycle.tex', 'Cycle content.\n\\input{main}\n')
    write(tmp_path / 'sub' / 'b.tex', 'B content.\n')
    return tmp_path / 'main.tex'


def test_resolve_order_is_document_order_depth_first(tmp_path):
    order = resolve_files(make_graph(tmp_path))
    names = [p.name for p in order]
    assert names == ['main.tex', 'a.tex', 'cycle.tex', 'b.tex']


def test_resolve_paths_are_absolute_and_inside_root(tmp_path):
    main = make_graph(tmp_path)
    for p in resolve_files(main):
        assert p.is_absolute()
        assert p == p.resolve()


def test_resolve_skips_cycles(tmp_path):
    order = resolve_files(make_graph(tmp_path))
    assert len(order) == 4  # main appears exactly once despite the cycle


def test_resolve_skips_missing_and_commented_inputs(tmp_path):
    order = resolve_files(make_graph(tmp_path))
    names = [p.name for p in order]
    assert 'commented.tex' not in names
    assert 'missing.tex' not in names


def test_resolve_appends_tex_suffix(tmp_path):
    write(tmp_path / 'main.tex', '\\input{a}\n')
    write(tmp_path / 'a.tex', 'content\n')
    order = resolve_files(tmp_path / 'main.tex')
    assert order[-1].name == 'a.tex'


def test_resolve_keeps_explicit_extension(tmp_path):
    write(tmp_path / 'main.tex', '\\input{a.tex}\n')
    write(tmp_path / 'a.tex', 'content\n')
    order = resolve_files(tmp_path / 'main.tex')
    assert order[-1].name == 'a.tex'


def test_resolve_missing_main_returns_empty(tmp_path):
    assert resolve_files(tmp_path / 'nope.tex') == []
