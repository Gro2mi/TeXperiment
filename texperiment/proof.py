"""Proofreading: LaTeX-aware prose masking + pluggable check engines.

mask_prose() produces a same-length copy of a block source in which only
natural-language prose survives (commands, math, comments and braces become
spaces, argument text of prose-bearing commands is kept). Issue offsets on
the masked text are therefore already block-source offsets — no remapping.

Engines:
  languagetool — local LanguageTool server via language-tool-python
                 (needs Java; downloads LanguageTool on first use)
  spellcheck   — pure-Python offline spellchecker (typos only)

A per-project custom dictionary (~/.texperiment/dictionaries.json, keyed by
project root) silences accepted words, e.g. names and domain terms. Ignored
cases (~/.texperiment/proof_ignores.json, same keying) permanently silence
specific rule+text findings, e.g. a grammar rule that misfires on one phrase.
"""
import json
import re
from pathlib import Path

from .parser import mask_comments

DICT_PATH = Path.home() / '.texperiment' / 'dictionaries.json'


class ProofError(Exception):
    """A check cannot run; message is user-presentable."""


# commands whose first {...} argument is natural-language prose: the command
# name and braces are masked, the argument text is kept (mirrors the sets
# in web/app.js — INLINE_ARG_CMDS plus sectioning/caption commands)
PROSE_ARG_CMDS = {
    'textbf', 'textit', 'emph', 'underline', 'text', 'textrm', 'mbox',
    'footnote', 'caption', 'captionof', 'title', 'chapter', 'section',
    'subsection', 'subsubsection', 'paragraph',
}

CMD_RE = re.compile(r'\\([a-zA-Z]+)\*?')
HAS_CONTENT_RE = re.compile(r'\w', re.UNICODE)

# rules that fire on masking artifacts rather than real language problems
RULE_DENYLIST = {'WHITESPACE_RULE', 'EN_UNPAIRED_BRACKETS',
                 'DE_UNPAIRED_BRACKETS'}


def _group_spans(s, i):
    """Balanced {...} at/after i (skipping whitespace). Returns
    (content_start, content_end, end_after_brace) or None."""
    n = len(s)
    j = i
    while j < n and s[j] in ' \t\r\n':
        j += 1
    if j >= n or s[j] != '{':
        return None
    depth = 0
    k = j
    while k < n:
        c = s[k]
        if c == '\\':
            k += 2
            continue
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return j + 1, k, k + 1
        k += 1
    return None


def _opt_arg_end(s, i):
    """End index just past a [...] optional arg starting at s[i] == '['."""
    k = i + 1
    while k < len(s):
        c = s[k]
        if c == '\\':
            k += 2
            continue
        if c == ']':
            return k + 1
        k += 1
    return None


def mask_prose(text):
    r"""Prose-only view of a block source for the check engines.

    Returns (compact_text, offsets): commands, math, comments and braces are
    removed, and each removed run (plus neighboring spaces/tabs) collapses to
    a single separator (a newline if the run contained one, else a space) so
    sentences stay joined — a mid-sentence \cite must not read like a sentence
    end for LanguageTool. offsets[i] is the block-source index of
    compact_text[i] (kept chars map to themselves; separators map to the start
    of their removed run), so issue spans convert back to source coordinates.
    """
    masked = mask_comments(text)  # blank comment contents, keep offsets
    out = list(masked)
    n = len(out)
    kept = [True] * n

    def blank(a, b):
        for k in range(a, min(b, n)):
            kept[k] = False

    def scan(lo, hi):
        i = lo
        while i < hi:
            c = masked[i]
            if c == '\\':
                if i + 1 < hi and masked[i + 1] == '\\':  # line break \\
                    blank(i, i + 2)
                    i += 2
                    continue
                m = CMD_RE.match(masked, i, hi)
                if not m:
                    blank(i, i + 1)  # escaped char like \% \& — keep the char
                    i += 2
                    continue
                name = m.group(1)
                g = _group_spans(masked, m.end())
                if name in PROSE_ARG_CMDS and g:
                    blank(i, g[0])       # \cmd{
                    blank(g[1], g[2])    # }
                    scan(g[0], g[1])     # nested commands inside the argument
                    i = g[2]
                    continue
                # everything else: blank the command, swallow its [..]{..} args
                blank(i, m.end())
                i = m.end()
                while i < hi:
                    while i < hi and masked[i] in ' \t':
                        i += 1
                    if i < hi and masked[i] == '[':
                        e = _opt_arg_end(masked, i)
                        if e:
                            blank(i, e)
                            i = e
                            continue
                        break
                    if i < hi and masked[i] == '{':
                        g2 = _group_spans(masked, i)
                        if g2:
                            blank(i, g2[2])
                            i = g2[2]
                            continue
                    break
                continue
            if c == '$':
                if i + 1 < hi and masked[i + 1] == '$':
                    j = masked.find('$$', i + 2, hi)
                    end = j + 2 if j > 0 else hi
                else:
                    j = i + 1
                    while j < hi and masked[j] != '$':
                        j += 2 if masked[j] == '\\' else 1
                    end = min(j + 1, hi)
                blank(i, end)
                i = end
                continue
            if c == '~':
                out[i] = ' '  # non-breaking space reads as a plain space
            i += 1

    scan(0, n)

    # absorb kept spaces/tabs that border a removed run, so "in \cite{x} and"
    # compacts to "in and" instead of "in   and" (LanguageTool flags those)
    i = 0
    while i < n:
        if not kept[i]:
            j = i
            while j < n and not kept[j]:
                j += 1
            k = i - 1
            while k >= 0 and kept[k] and out[k] in ' \t':
                kept[k] = False
                k -= 1
            while j < n and kept[j] and out[j] in ' \t':
                kept[j] = False
                j += 1
            i = j
        else:
            i += 1

    # compact: collapse each removed run into one separator; never emit two
    # whitespace chars in a row — "showed \cw{..}{..}\nthat" must not become
    # a blank line (LanguageTool reads \n\n as a paragraph/sentence break)
    chars, offs = [], []
    last = ''
    i = 0
    while i < n:
        if kept[i]:
            c = out[i]
            if c in ' \n' and last in (' ', '\n', ''):
                i += 1
                continue  # collapse doubled whitespace / blank lines
            chars.append(c)
            offs.append(i)
            last = c
            i += 1
            continue
        j = i
        has_nl = False
        while j < n and not kept[j]:
            if text[j] == '\n':
                has_nl = True
            j += 1
        # no separator when it would cuddle punctuation: "\citep{x}." must
        # compact to "." ("implementations ."), "( \citep{x}" to "("
        nxt = out[j] if j < n and kept[j] else ''
        if (last not in ('', ' ', '\n') and nxt not in '.,;:!?)]}' and
                last not in '(['):
            sep = '\n' if has_nl else ' '
            chars.append(sep)
            offs.append(i)  # separator maps to the start of its removed run
            last = sep
        i = j
    return ''.join(chars), offs


# ---------------------------------------------------------------- engines

def _norm_lang(lang):
    return 'de' if str(lang).lower().startswith('de') else 'en'


class LanguageToolEngine:
    """Local LanguageTool server (language-tool-python). Needs Java; the
    LanguageTool archive is downloaded on first use."""
    name = 'languagetool'

    def __init__(self):
        self._lt = {}
        self._error = None

    def _get(self, lang):
        if self._error:
            raise ProofError(self._error)
        if lang not in self._lt:
            try:
                import language_tool_python
                self._lt[lang] = language_tool_python.LanguageTool(lang)
            except Exception as e:  # Java missing, download failed, …
                self._error = (
                    f'LanguageTool could not start: {e} '
                    '(needs Java; fall back to --proof-engine spellcheck)')
                raise ProofError(self._error)
        return self._lt[lang]

    def available(self):
        # do NOT probe here: init may trigger a large download — report healthy
        # until a check proves otherwise
        return self._error is None, self._error

    def check(self, text, lang):
        lt = self._get(lang)
        issues = []
        for m in lt.check(text):
            # attribute names differ across language_tool_python versions
            get = lambda a, b: getattr(m, a, None) or getattr(m, b)
            issues.append({
                'offset': m.offset,
                'length': get('error_length', 'errorLength'),
                'message': m.message,
                'replacements': list(m.replacements)[:5],
                'rule_id': get('rule_id', 'ruleId'),
                'category': get('rule_issue_type', 'ruleIssueType') or 'grammar',
            })
        return issues


class SpellcheckEngine:
    """Offline typo-only checker (pyspellchecker dictionaries)."""
    name = 'spellcheck'

    WORD_RE = re.compile(
        r"[A-Za-zÀ-ÖØ-öø-ÿÄäÖÜüßÉéÈè]"
        r"(?:[A-Za-zÀ-ÖØ-öø-ÿÄäÖÜüßÉéÈè'-]*[A-Za-zÀ-ÖØ-öø-ÿÄäÖÜüßÉéÈè])?")

    def __init__(self):
        self._sc = {}

    def _get(self, lang):
        base = _norm_lang(lang)
        if base not in self._sc:
            try:
                from spellchecker import SpellChecker
                self._sc[base] = SpellChecker(language=base)
            except Exception as e:
                raise ProofError(f'spellcheck dictionary unavailable: {e}')
        return self._sc[base]

    def available(self):
        return True, None

    def check(self, text, lang):
        sc = self._get(lang)
        issues = []
        for m in self.WORD_RE.finditer(text):
            w = m.group(0)
            if len(w) <= 2 or w.isupper() or any(c.isdigit() for c in w):
                continue
            if sc.known([w.lower()]):
                continue
            cands = sc.candidates(w.lower()) or set()
            cands = sorted(cands, key=lambda c: -sc.word_frequency[c])
            issues.append({
                'offset': m.start(),
                'length': len(w),
                'message': f'Possible typo: “{w}”',
                'replacements': [c for c in cands if c != w.lower()][:5],
                'rule_id': 'SPELL',
                'category': 'typo',
            })
        return issues


ENGINES = {'languagetool': LanguageToolEngine, 'spellcheck': SpellcheckEngine}

# ---------------------------------------------------------------- dictionary

MISSPELLING_CATEGORIES = {'misspelling', 'typo'}


def load_dictionary(root):
    """Accepted words for the project at `root` (case-insensitive set)."""
    try:
        data = json.loads(DICT_PATH.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return set()
    return {w.lower() for w in data.get(str(root), [])}


def add_to_dictionary(root, word):
    """Persist a word for the project; returns the updated word list."""
    word = str(word).strip()
    if not word:
        raise ValueError('empty word')
    try:
        data = json.loads(DICT_PATH.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        data = {}
    words = data.setdefault(str(root), [])
    if not any(w.lower() == word.lower() for w in words):
        words.append(word)
    try:
        DICT_PATH.parent.mkdir(parents=True, exist_ok=True)
        DICT_PATH.write_text(json.dumps(data, indent=2), encoding='utf-8')
    except OSError as e:
        raise ValueError(f'cannot save dictionary: {e}')
    return words


# ---------------------------------------------------------------- ignores

IGNORE_PATH = Path.home() / '.texperiment' / 'proof_ignores.json'


def load_ignores(root):
    """Persisted (rule_id, normalized text) pairs for the project at root."""
    try:
        data = json.loads(IGNORE_PATH.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return set()
    return {(str(i.get('rule', '')), str(i.get('text', '')).lower())
            for i in data.get(str(root), [])}


def add_ignore(root, rule, text):
    """Persist one ignored case (rule + flagged text) for the project."""
    rule, text = str(rule).strip(), ' '.join(str(text).split()).lower()
    if not text:
        raise ValueError('empty text')
    try:
        data = json.loads(IGNORE_PATH.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        data = {}
    items = data.setdefault(str(root), [])
    if not any(str(i.get('rule', '')) == rule and
               ' '.join(str(i.get('text', '')).split()).lower() == text
               for i in items):
        items.append({'rule': rule, 'text': text})
    try:
        IGNORE_PATH.parent.mkdir(parents=True, exist_ok=True)
        IGNORE_PATH.write_text(json.dumps(data, indent=2), encoding='utf-8')
    except OSError as e:
        raise ValueError(f'cannot save ignores: {e}')
    return items

# (block id, source, lang) → issues; the source in the key doubles as the
# freshness check, so a rebuilt doc naturally re-checks changed blocks
_cache = {}


def check_blocks(store, engine, lang, block_ids=None):
    """Check prose blocks of the current doc; returns UI-ready issues with
    block_id/file/start/end in block-source coordinates. Custom-dictionary
    words and persisted ignored cases are filtered after the cache, so new
    entries take effect without invalidating cached results."""
    dictionary = load_dictionary(store.root)
    ignores = load_ignores(store.root)
    results = []
    prev_type = None
    for b in store.doc['blocks']:
        prev, prev_type = prev_type, b['type']
        if block_ids is not None and b['id'] not in block_ids:
            continue
        if b['type'] in ('preamble', 'enddoc', 'comment', 'math', 'env'):
            continue  # no natural-language prose worth checking
        key = (b['id'], b['source'], lang)
        if key not in _cache:
            if len(_cache) > 1000:
                _cache.clear()
            compact, offs = mask_prose(b['source'])
            raw = engine.check(compact, lang)
            kept = []
            for it in raw:
                seg = compact[it['offset']:it['offset'] + it['length']]
                # drop artifacts: flagged region has no real word content
                if not HAS_CONTENT_RE.search(seg):
                    continue
                if it['rule_id'] in RULE_DENYLIST:
                    continue
                # map compact coordinates back to block-source coordinates:
                # start char → its source index, last char → index + 1
                s = offs[min(it['offset'], len(offs) - 1)]
                e_idx = min(it['offset'] + it['length'] - 1, len(offs) - 1)
                kept.append({**it, 'offset': s, 'length': offs[e_idx] + 1 - s})
            _cache[key] = kept
        for it in _cache[key]:
            if (it['rule_id'] == 'UPPERCASE_SENTENCE_START' and
                    it['offset'] == 0 and prev in ('math', 'env')):
                continue  # the sentence continues from the equation above
            # offsets are block-source offsets → the source slice is the
            # flagged text itself; normalize like the client does
            flagged = ' '.join(
                b['source'][it['offset']:it['offset'] + it['length']].split())
            norm = flagged.lower()
            if (it['category'] in MISSPELLING_CATEGORIES and norm in dictionary):
                continue
            if (it['rule_id'], norm) in ignores:
                continue
            results.append({
                **it,
                'block_id': b['id'],
                'file': b['file'],
                'start': it['offset'],
                'end': it['offset'] + it['length'],
            })
    return results
