"""Span-preserving block parser for LaTeX files.

Splits a file into typed blocks with exact [start, end) char spans so that
concatenating blocks plus the gaps between them reproduces the file byte
for byte. This is what makes per-block editing lossless.
"""
import re

SECTION_NAME_RE = re.compile(r'\\(chapter|section|subsection|subsubsection)\*?\s*\{')
BEGIN_RE = re.compile(r'\\begin\{([A-Za-z]+\*?)\}')

MATH_ENVS = {
    'equation', 'equation*', 'align', 'align*', 'eqnarray', 'eqnarray*',
    'gather', 'gather*', 'multline', 'multline*', 'displaymath', 'math',
}
LIST_ENVS = {'itemize', 'enumerate', 'description'}
TABLE_ENVS = {'tabular', 'tabular*', 'longtable'}
WRAP_TABLE_ENVS = {'table', 'table*'}
FIGURE_ENVS = {'figure', 'figure*'}

SECTION_LEVELS = {'chapter': 1, 'section': 2, 'subsection': 3, 'subsubsection': 4}


def _find_comment_start(line):
    """Index of the first unescaped % in the line, or -1."""
    bs = 0
    for i, ch in enumerate(line):
        if ch == '\\':
            bs += 1
        elif ch == '%':
            if bs % 2 == 0:
                return i
            bs = 0
        else:
            bs = 0
    return -1


def mask_comments(text):
    """Same-length copy of text with comment contents blanked to spaces.

    Structure detection runs on the mask so % commented-out \\input or
    \\begin is never treated as markup. Newline positions are preserved.
    """
    out = []
    for line in text.splitlines(keepends=True):
        idx = _find_comment_start(line)
        if idx >= 0:
            out.append(line[:idx] + ' ' * (len(line) - idx))
        else:
            out.append(line)
    return ''.join(out)


def _read_group(text, pos):
    """Read a balanced {...} group at/after pos (skipping whitespace).

    Returns (body, end_index_after_closing_brace) or None.
    """
    n = len(text)
    i = pos
    while i < n and text[i] in ' \t\r\n':
        i += 1
    if i >= n or text[i] != '{':
        return None
    depth = 0
    j = i
    while j < n:
        c = text[j]
        if c == '\\':
            j += 2
            continue
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return text[i + 1:j], j + 1
        j += 1
    return None


def _env_spans(masked, lo, hi):
    """Top-level \\begin{env}...\\end{env} spans within [lo, hi)."""
    spans = []
    pos = lo
    while True:
        m = BEGIN_RE.search(masked, pos, hi)
        if not m:
            break
        name = m.group(1)
        token = re.compile(r'\\(begin|end)\{' + re.escape(name) + r'\}')
        depth = 1
        end_pos = None
        for t in token.finditer(masked, m.end(), hi):
            if t.group(1) == 'begin':
                depth += 1
            else:
                depth -= 1
                if depth == 0:
                    end_pos = t.end()
                    break
        if end_pos is None:
            pos = m.end()
            continue
        spans.append((m.start(), end_pos, name))
        pos = end_pos
    return spans


def _display_math_spans(masked, gaps):
    """$$...$$ and \\[...\\] spans inside the given gaps."""
    spans = []
    for gs, ge in gaps:
        seg = masked[gs:ge]
        i = 0
        while i < len(seg):
            if seg.startswith('\\[', i):
                j = seg.find('\\]', i + 2)
                if j < 0:
                    break
                spans.append((gs + i, gs + j + 2, 'brackets'))
                i = j + 2
            elif seg.startswith('$$', i):
                j = seg.find('$$', i + 2)
                if j < 0:
                    break
                spans.append((gs + i, gs + j + 2, 'dollars'))
                i = j + 2
            else:
                i += 1
    return spans


def _env_type(name):
    if name in MATH_ENVS:
        return 'math', {'wrap': 'env:' + name}
    if name in LIST_ENVS:
        return 'list', {'env': name}
    if name in TABLE_ENVS or name in WRAP_TABLE_ENVS:
        return 'table', {'env': name}
    if name in FIGURE_ENVS:
        return 'figure', {'env': name}
    return 'env', {'name': name}


def _section_meta(src):
    m = SECTION_NAME_RE.match(src)
    if not m:
        return None
    title = ''
    grp = _read_group(src, m.end() - 1)  # regex consumed the '{'
    if grp:
        title = grp[0].strip()
    return {'level': SECTION_LEVELS[m.group(1)], 'title': title}


def _text_segment(text, s, e, out):
    """Classify a non-environment region into paragraph/section/comment blocks."""
    lines = []
    i = s
    while i < e:
        j = text.find('\n', i, e)
        if j == -1:
            j = e
        lines.append((i, j))
        i = j + 1

    def cls(k):
        ls, le = lines[k]
        st = text[ls:le].strip()
        if not st:
            return 'blank'
        if st.startswith('%'):
            return 'comment'
        if SECTION_NAME_RE.match(st):
            return 'section'
        return 'text'

    k = 0
    while k < len(lines):
        c = cls(k)
        if c == 'blank':
            k += 1
            continue
        if c == 'comment':
            # merge consecutive comment lines into one block
            ls0 = lines[k][0]
            while k < len(lines) and cls(k) == 'comment':
                k += 1
            out.append(('comment', ls0, lines[k - 1][1], None))
            continue
        if c == 'section':
            ls, le = lines[k]
            out.append(('section', ls, le, _section_meta(text[ls:le])))
            k += 1
            continue
        k0 = k
        while k < len(lines) and cls(k) == 'text':
            k += 1
        out.append(('paragraph', lines[k0][0], lines[k - 1][1], None))


def parse_file(text, is_main=False):
    """Parse one file into ordered (type, start, end, meta) spans."""
    masked = mask_comments(text)
    n = len(text)
    lo, hi = 0, n
    blocks = []

    if is_main:
        b = masked.find(r'\begin{document}')
        if b >= 0:
            le = text.find('\n', b)
            le = n if le == -1 else le
            blocks.append(('preamble', 0, le, None))
            lo = le + 1 if le < n else n
        e = masked.rfind(r'\end{document}')
        if e >= 0 and e >= lo:
            ls = text.rfind('\n', 0, e) + 1
            hi = ls
            blocks.append(('enddoc', ls, n, None))

    envs = _env_spans(masked, lo, hi)

    gaps = []
    prev = lo
    for s, e, _name in envs:
        if s > prev:
            gaps.append((prev, s))
        prev = e
    if prev < hi:
        gaps.append((prev, hi))

    barriers = [(s, e, 'env', name) for (s, e, name) in envs]
    for gs, ge, wrap in _display_math_spans(masked, gaps):
        barriers.append((gs, ge, 'math', wrap))
    barriers.sort(key=lambda t: t[0])

    prev = lo
    for s, e, typ, info in barriers:
        if s > prev:
            _text_segment(text, prev, s, blocks)
        if typ == 'env':
            btype, meta = _env_type(info)
        else:
            btype, meta = 'math', {'wrap': info}
        blocks.append((btype, s, e, meta))
        prev = e
    if prev < hi:
        _text_segment(text, prev, hi, blocks)

    blocks.sort(key=lambda t: t[1])
    return blocks
