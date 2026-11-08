"""Minimal .bib reader for cite autocomplete and hover popups.

Parses regular entries (ignoring @string/@preamble/@comment) into plain
display fields — no LaTeX typesetting, just enough for the UI:
{key, authors, year, title, plain, url, doi, journal}.
"""
import re


def parse_bib(text):
    """All regular entries of a .bib file, in file order."""
    strings = {}
    entries = []
    for m in re.finditer(r'@(\w+)\s*([{(])', text, re.I):
        kind = m.group(1).lower()
        body = _entry_body(text, m.end() - 1)
        if body is None:
            continue  # unbalanced entry — skip rather than corrupt the rest
        if kind == 'string':
            for name, val in _parse_fields(body):
                strings[name] = val
            continue
        if kind in ('comment', 'preamble'):
            continue
        key, _, fields_raw = body.partition(',')
        entry = {'key': key.strip(), 'type': kind}
        for name, val in _parse_fields(fields_raw):
            entry[name] = _resolve(val, strings)
        entries.append(_display(entry))
    return entries


def _entry_body(text, open_pos):
    """Balanced body of an entry between the braces/parens at open_pos."""
    close = ')' if text[open_pos] == '(' else '}'
    depth = 0
    for j in range(open_pos, len(text)):
        c = text[j]
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:  # the entry's own closing brace
                return text[open_pos + 1:j]
        elif c == close and depth == 0:  # ')' with balanced braces inside
            return text[open_pos + 1:j]
    return None


def _parse_fields(s):
    """(name, raw value) pairs of an entry body; values may concatenate
    with # across quoted / braced / bare parts."""
    fields = []
    i, n = 0, len(s)
    while i < n:
        m = re.match(r'\s*(\w+)\s*=\s*', s[i:])
        if not m:
            break
        i += m.end()
        parts = []
        while i < n:
            c = s[i]
            if c in ' \t\r\n':
                j = i
                while j < n and s[j] in ' \t\r\n':
                    j += 1
                if j < n and s[j] == '#':
                    i = j + 1
                    continue
                break
            if c == '"':
                j = i + 1
                depth = 0
                while j < n:
                    if s[j] == '{':
                        depth += 1
                    elif s[j] == '}':
                        depth -= 1
                    elif s[j] == '"' and depth == 0:
                        break
                    j += 1
                parts.append(s[i + 1:j])
                i = j + 1
            elif c == '{':
                depth = 0
                j = i
                while j < n:
                    if s[j] == '{':
                        depth += 1
                    elif s[j] == '}':
                        depth -= 1
                        if depth == 0:
                            break
                    j += 1
                parts.append(s[i + 1:j])
                i = j + 1
            elif c == ',':
                break
            else:  # bare number or @string name
                j = i
                while j < n and s[j] not in ',# \t\r\n':
                    j += 1
                parts.append(s[i:j])
                i = j
        fields.append((m.group(1).lower(), ''.join(parts)))
        while i < n and s[i] != ',':
            i += 1
        i += 1
    return fields


def _resolve(val, strings):
    """Resolve bare @string names inside a value (word for word)."""
    if not strings:
        return val
    return re.sub(r'[A-Za-z_]\w*',
                  lambda m: strings.get(m.group(0), m.group(0)), val)


def _display(e):
    """Fill the display fields the frontend reads (plain, authors, ...)."""
    clean = {k: re.sub(r'[{}]', '', v).replace('~', ' ')
             .replace(r'\&', '&').replace('\\ ', ' ').strip()
             for k, v in e.items() if isinstance(v, str)}
    e['authors'] = _fmt_authors(clean.get('author') or clean.get('editor') or '')
    e['year'] = clean.get('year', '')
    e['title'] = clean.get('title', '')
    e['journal'] = clean.get('journal') or clean.get('booktitle') \
        or clean.get('publisher') or ''
    url = clean.get('url') or (clean.get('doi')
        and 'https://doi.org/' + clean['doi']) or None
    e['url'] = url
    bits = []
    if e['authors']:
        bits.append(e['authors'])
    if e['year']:
        bits.append('(' + e['year'] + ')' if e['authors'] else e['year'])
    plain = ' '.join(bits)
    if e['title']:
        plain = (plain + '. ' if plain else '') + e['title']
    if e['journal']:
        plain = (plain + '. ' if plain else '') + e['journal']
    e['plain'] = plain.strip() or e['key']
    return e


def _fmt_authors(s):
    """'Last, First and Last2, First2' → display list, et al. beyond 3."""
    names = []
    for name in s.split(' and '):
        name = name.replace('~', ' ').strip()
        if not name:
            continue
        if ',' in name:
            parts = [p.strip() for p in name.split(',')]
            name = (parts[-1] + ' ' + parts[0]).strip()
        names.append(name)
    if not names:
        return ''
    if len(names) > 3:
        return names[0] + ' et al.'
    return ', '.join(names)
