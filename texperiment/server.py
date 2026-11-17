"""FastAPI server: multi-project registry, block edit ops, raw file access,
disk browsing, LaTeX compilation, and per-project WS live reload."""
import asyncio
import glob
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import bibparse, gitops, proof, watcher
from .gitops import GitError
from .parser import parse_file
from .proof import ProofError
from .resolver import read_text_preserve, resolve_files
from .storage import ConflictError, FileStore, patch
from .version import __version__


def _web_dir() -> Path:
    """The served web/ directory — beside the package in development,
    inside the PyInstaller bundle when frozen."""
    if getattr(sys, 'frozen', False):
        base = Path(getattr(sys, '_MEIPASS', Path(sys.executable).parent))
        cand = base / 'web'
        if cand.is_dir():
            return cand
    return Path(__file__).resolve().parent.parent / 'web'


WEB_DIR = _web_dir()

NON_EDITABLE = ('preamble', 'enddoc')

# -- settings (~/.texperiment/settings.json) ---------------------------------
CONFIG_DIR = Path.home() / '.texperiment'


def _settings_path() -> Path:
    # resolved per call: tests monkeypatch CONFIG_DIR, and module-level
    # constants would bypass the redirect
    return CONFIG_DIR / 'settings.json'


def load_settings() -> dict:
    try:
        return json.loads(_settings_path().read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def save_setting(key, value) -> None:
    s = load_settings()
    s[key] = value
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        _settings_path().write_text(json.dumps(s, indent=1), encoding='utf-8')
    except OSError:
        pass  # persistence is best-effort; the editor keeps working


IMG_EXTS = ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp')
# LaTeX also happily includes vector formats the browser can't show in
# an <img> — resolve them too, the frontend decides how to display
GRAPHICS_EXTS = IMG_EXTS + ('.pdf', '.eps')

# windowed frozen builds (console=False) have no console for children to
# inherit: without this flag every latexmk/tectonic run would pop up a
# terminal window for the whole compile. 0 on non-Windows (flag absent).
_NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)

# -- TeX toolchain detection -------------------------------------------------
# TeX installers do not always put the binaries on PATH (the TeX Live
# installer frequently doesn't) — probe the typical locations too.
def _tex_dir_globs():
    if os.name != 'nt':
        return ('/usr/local/texlive/*/bin/x86_64-linux',
                '/opt/texlive/*/bin/x86_64-linux',
                '/usr/local/texlive/*/bin/*')
    pats = [r'C:\texlive\*\bin\win64', r'C:\texlive\*\bin\windows',
            r'C:\Program Files\MiKTeX\miktex\bin\x64',
            r'C:\Program Files (x86)\MiKTeX\miktex\bin\x64']
    for var in ('LOCALAPPDATA', 'APPDATA'):
        base = os.environ.get(var)
        if base:  # unset env vars would make the pattern cwd-relative
            pats += [os.path.join(base, 'Programs', 'MiKTeX', 'miktex',
                                  'bin', 'x64'),
                     os.path.join(base, 'MiKTeX', 'miktex', 'bin', 'x64')]
    return tuple(pats)


def _tex_dirs():
    """Dirs where TeX distributions typically live, even off-PATH."""
    out = []
    for pat in _tex_dir_globs():
        out += glob.glob(pat)
    return sorted({d for d in out if os.path.isdir(d)})


def _bundled_tectonic():
    """The tectonic.exe shipped inside the app bundle, or the dev copy."""
    exe = 'tectonic.exe' if os.name == 'nt' else 'tectonic'
    if getattr(sys, 'frozen', False):
        base = Path(getattr(sys, '_MEIPASS', Path(sys.executable).parent))
        cand = base / 'tectonic' / exe
        if cand.is_file():
            return str(cand)
    dev = Path(__file__).resolve().parent.parent / 'packaging' / 'tectonic' / exe
    return str(dev) if dev.is_file() else None


def _find_tex_tool(name):
    """Full path of a TeX tool: PATH first, then the typical install dirs."""
    p = shutil.which(name)
    if p:
        return p
    for d in _tex_dirs():
        cand = Path(d) / (name + ('.exe' if os.name == 'nt' else ''))
        if cand.is_file():
            return str(cand)
    return None


def _compile_env():
    """Subprocess env for compiles: TeX dirs that were found off-PATH are
    prepended so latexmk finds its perl/engines beside it."""
    env = os.environ.copy()
    dirs = _tex_dirs()
    if dirs:
        env['PATH'] = os.pathsep.join(dirs + [env.get('PATH', '')])
    return env


# per-port project persistence: ~/.texperiment/projects.json
CONFIG_PATH = CONFIG_DIR / 'projects.json'


def load_port_projects(port):
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding='utf-8'))
        return data.get('ports', {}).get(str(port), [])
    except (OSError, ValueError):
        return []


def save_port_projects(port, projects):
    records = sorted(
        ({'path': str(p.store.main_path), 'last_accessed': p.last_accessed}
         for p in projects.values()),
        key=lambda r: r['last_accessed'])
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        try:
            data = json.loads(CONFIG_PATH.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            data = {}
        data.setdefault('ports', {})[str(port)] = records
        tmp = CONFIG_PATH.with_suffix('.tmp')
        tmp.write_text(json.dumps(data, indent=2), encoding='utf-8')
        tmp.replace(CONFIG_PATH)
    except OSError:
        pass  # persistence is best-effort; the editor keeps working


class Store:
    """Holds one project's parsed document model and applies block operations."""

    def __init__(self, main_tex):
        self.main_path = Path(main_tex).resolve()
        if not self.main_path.exists():
            raise FileNotFoundError(f'main file not found: {main_tex}')
        if self.main_path.suffix != '.tex':
            raise ValueError('project main must be a .tex file')
        self.root = self.main_path.parent
        self.fs = FileStore(self.root)
        self.lock = threading.RLock()
        # document history: per-op file snapshots for undo/redo. Entries are
        # {'label', 'before': {rel: (text, enc)}, 'after': {rel: (text, enc)}}
        self.history = {'undo': [], 'redo': []}
        self.rebuild()

    # -- model ------------------------------------------------------------
    def rebuild(self):
        with self.lock:
            files = resolve_files(self.main_path)
            blocks, fentries = [], []
            # keep ids attached to CONTENT across re-parses: a block whose
            # file+source matches a previous block reuses its id, so moving
            # a block never re-binds its id to a neighbour. Duplicate sources
            # match in document order; changed/new content falls back to the
            # positional id.
            prev = []
            if getattr(self, 'doc', None):
                prev = [(b['file'], gitops._norm_src(b['source']), b['id'])
                        for b in self.doc['blocks']]
            taken = set()
            for fi, fp in enumerate(files):
                text, enc = read_text_preserve(fp)
                rel = fp.relative_to(self.root).as_posix()
                for bi, (typ, s, e, meta) in enumerate(
                        parse_file(text, is_main=(fp == self.main_path))):
                    src = gitops._norm_src(text[s:e])
                    old = next((pid for pf, ps, pid in prev
                                if pf == rel and ps == src and pid not in taken),
                               None)
                    bid = old
                    if not bid:
                        bid = f'f{fi}b{bi}'
                        n = 0
                        while bid in taken:  # rare: structural change left
                            n += 1           # the positional id already used
                            bid = f'f{fi}b{bi}x{n}'
                    taken.add(bid)
                    b = {'id': bid, 'file': rel, 'type': typ,
                         'start': s, 'end': e, 'source': text[s:e]}
                    if meta:
                        b['meta'] = meta
                    blocks.append(b)
                fentries.append({'path': rel, 'encoding': enc})
            self.doc = {
                'main': self.main_path.relative_to(self.root).as_posix(),
                'files': fentries,
                'blocks': blocks,
            }

    def _block(self, bid):
        for b in self.doc['blocks']:
            if b['id'] == bid:
                return b
        raise KeyError(bid)

    def _read(self, rel):
        return read_text_preserve(self.root / rel)

    def _write_and_rebuild(self, rel, new_text, label):
        p = self.root / rel
        if p.exists():
            old_text, old_enc = read_text_preserve(p)
            before = {rel: (old_text, old_enc)}
        else:
            before = {rel: None}
        text, enc = self._read(rel)
        self.fs.write(self.root / rel, new_text, enc)
        self.rebuild()
        self._record(label, before, {rel: (new_text, enc)})

    # -- history -------------------------------------------------------------
    HISTORY_LIMIT = 100

    def _record(self, label, before, after):
        self.history['undo'].append(
            {'label': label, 'before': before, 'after': after})
        if len(self.history['undo']) > self.HISTORY_LIMIT:
            self.history['undo'].pop(0)
        self.history['redo'].clear()

    def _restore(self, files):
        for rel, snap in files.items():
            p = self.root / rel
            if snap is None:  # the op created this file — undo removes it
                if p.exists():
                    p.unlink()
            else:
                text, enc = snap
                self.fs.write(p, text, enc)
        self.rebuild()

    def op_undo(self):
        with self.lock:
            if not self.history['undo']:
                return None
            entry = self.history['undo'].pop()
            self._restore(entry['before'])
            self.history['redo'].append(entry)
            return entry['label']

    def op_redo(self):
        with self.lock:
            if not self.history['redo']:
                return None
            entry = self.history['redo'].pop()
            self._restore(entry['after'])
            self.history['undo'].append(entry)
            return entry['label']

    # -- ops ----------------------------------------------------------------
    def op_save(self, bid, new_source):
        with self.lock:
            b = self._block(bid)
            text, _ = self._read(b['file'])
            nt = patch(text, b['start'], b['end'], b['source'], new_source)
            if nt is None:
                raise ConflictError(
                    f'block {bid} no longer matches {b["file"]} on disk')
            self._write_and_rebuild(b['file'], nt, 'edit block')

    def op_delete(self, bid):
        with self.lock:
            b = self._block(bid)
            if b['type'] in NON_EDITABLE:
                raise ValueError(f'cannot delete a {b["type"]} block')
            same = [x for x in self.doc['blocks'] if x['file'] == b['file']]
            i = same.index(b)
            s2, e2 = b['start'], b['end']
            if i + 1 < len(same):
                e2 = same[i + 1]['start']  # swallow trailing separator
            elif i > 0:
                s2 = same[i - 1]['end']    # or leading separator
            text, _ = self._read(b['file'])
            nt = patch(text, s2, e2, text[s2:e2], '')
            if nt is None:
                raise ConflictError(f'block {bid} no longer matches on disk')
            self._write_and_rebuild(b['file'], nt, 'delete block')

    @staticmethod
    def _level(x):
        if x['type'] != 'section':
            return 99
        return ((x.get('meta') or {}).get('level') or 2)

    def _section_end(self, same, i):
        """Exclusive end of the section starting at i: everything up to the
        next section of the same or a higher level moves with the heading.
        Preamble/enddoc blocks never belong to a section."""
        lv = self._level(same[i])
        j = i + 1
        while j < len(same):
            x = same[j]
            if x['type'] in NON_EDITABLE or (
                    x['type'] == 'section' and self._level(x) <= lv):
                break
            j += 1
        return j

    def op_move(self, bid, direction, positions=1):
        if direction not in ('up', 'down'):
            raise ValueError("direction must be 'up' or 'down'")
        positions = max(1, int(positions))
        with self.lock:
            b = self._block(bid)
            if b['type'] in NON_EDITABLE:
                raise ValueError(f'cannot move a {b["type"]} block')
            same = [x for x in self.doc['blocks'] if x['file'] == b['file']]
            i = same.index(b)
            if b['type'] == 'section':
                # moving a heading relocates its whole section: swap the
                # chunk with the neighboring sibling section's chunk
                lv = self._level(b)
                end = self._section_end(same, i)
                sibs = [k for k in range(len(same)) if k != i
                        and same[k]['type'] == 'section'
                        and self._level(same[k]) <= lv
                        and ((direction == 'down' and k > i) or
                             (direction == 'up' and k < i))]
                if direction == 'up':
                    sibs = sorted(sibs, reverse=True)[:positions]
                    if not sibs:
                        raise ValueError('no previous section to move past')
                    tgt = sibs[-1]  # farthest sibling for this many steps
                    new = (same[:tgt] + same[i:end] + same[tgt:i] + same[end:])
                else:
                    sibs = sorted(sibs)[:positions]
                    if not sibs:
                        raise ValueError('no following section to move past')
                    tgtend = self._section_end(same, sibs[-1])
                    new = (same[:i] + same[end:tgtend] + same[i:end] +
                           same[tgtend:])
                srcs = [x['source'] for x in new]
            else:
                j = i - positions if direction == 'up' else i + positions
                if j < 0 or j >= len(same):
                    raise ValueError(
                        'target position out of range (moves stay within a file)')
                srcs = [x['source'] for x in same]
                moved = srcs.pop(i)
                srcs.insert(j, moved)
            text, _ = self._read(b['file'])
            lead = text[:same[0]['start']]
            trail = text[same[-1]['end']:]
            # separators belong to slots, not blocks — sources reorder inside them
            seps = [text[same[k]['end']:
                         (same[k + 1]['start'] if k + 1 < len(same) else len(text))]
                    for k in range(len(same))]
            nt = lead + ''.join(s + sep for s, sep in zip(srcs, seps)) + trail
            self._write_and_rebuild(b['file'], nt, 'move block')

    def op_move_blocks(self, bids, after_id, before=False):
        """Move the given blocks (packed together, in their current
        relative order) to a new position: after `after_id` — or before
        it when `before` is true. Non-selected blocks in between are
        skipped and keep their position."""
        if not bids:
            raise ValueError('no blocks selected')
        with self.lock:
            blocks = self.doc['blocks']
            moving = [b for b in blocks if b['id'] in bids]
            if len(moving) != len(bids):
                raise ValueError('unknown block in selection')
            files = {b['file'] for b in moving}
            if len(files) > 1:
                raise ValueError(
                    'selected blocks span several files and cannot be '
                    'moved together')
            if any(b['type'] in NON_EDITABLE for b in moving):
                raise ValueError('cannot move a preamble/enddoc block')
            b0 = moving[0]
            same = [x for x in blocks if x['file'] == b0['file']]
            sel = set(bids)
            # selected blocks in their current order
            moving_in_order = [x for x in same if x['id'] in sel]
            # the reference block anchors the landing position; it must be
            # a non-selected block in the same file
            ref = next((x for x in same if x['id'] == after_id), None)
            if ref is None:
                raise ValueError('reference block not found')
            if ref['id'] in sel:
                raise ValueError('reference block is part of the selection')

            # remove moving blocks from the file flow, keeping everything
            # else in order
            rest = [x for x in same if x['id'] not in sel]
            ri = next(i for i, x in enumerate(rest) if x['id'] == after_id)
            # insertion index: after ref → ri+1; before ref → ri
            insert_at = ri + (0 if before else 1)
            # the landing slot must stay inside the document body: before
            # the preamble or after \end{document} would corrupt the file.
            # before \end{document} is fine — that is the last body slot.
            first_body = next(
                (i for i, x in enumerate(rest)
                 if x['type'] not in NON_EDITABLE), None)
            if first_body is None:
                raise ValueError('no editable blocks in this file')
            if insert_at < first_body:
                raise ValueError('cannot move before the preamble')
            if (rest[-1]['type'] in NON_EDITABLE and
                    insert_at >= len(rest)):
                raise ValueError('cannot move after the end-document block')
            new = rest[:insert_at] + moving_in_order + rest[insert_at:]
            if gitops._norm_src(
                    ''.join(x['source'] for x in new)) == \
                    gitops._norm_src(''.join(x['source'] for x in same)):
                return  # nothing would change

            text, _ = self._read(b0['file'])
            lead = text[:same[0]['start']]
            trail = text[same[-1]['end']:]
            seps = [text[same[k]['end']:
                         (same[k + 1]['start'] if k + 1 < len(same) else len(text))]
                    for k in range(len(same))]
            srcs = [x['source'] for x in new]
            nt = lead + ''.join(s + sep for s, sep in zip(srcs, seps)) + trail
            self._write_and_rebuild(b0['file'], nt, 'move blocks')

    def op_insert(self, after_id, source):
        with self.lock:
            b = self._block(after_id)
            if b['type'] in NON_EDITABLE:
                raise ValueError(f'cannot insert after a {b["type"]} block')
            text, _ = self._read(b['file'])
            nt = text[:b['end']] + '\n\n' + source + text[b['end']:]
            self._write_and_rebuild(b['file'], nt, 'insert block')
            for x in self.doc['blocks']:
                if x['file'] == b['file'] and x['source'] == source:
                    return x['id']
            return None

    # -- whole-section editing -------------------------------------------------
    def _enclosing_section(self, bid):
        """(same-file blocks, index of the section heading) containing block
        bid — bid may be the heading itself. None when it lives outside any
        section or a non-editable block separates it from the heading."""
        b = self._block(bid)
        same = [x for x in self.doc['blocks'] if x['file'] == b['file']]
        i = same.index(b)
        k = i if b['type'] == 'section' else None
        if k is None:
            for j in range(i - 1, -1, -1):
                if same[j]['type'] == 'section':
                    k = j
                    break
        if k is None or self._section_end(same, k) <= i:
            return None
        return same, k

    def section_span(self, bid):
        """Exact on-disk span of the section containing block bid, or None.
        The span includes the heading, the inter-block separators and any
        comment blocks, so an editor showing it can patch it back lossless."""
        with self.lock:
            found = self._enclosing_section(bid)
            if found is None:
                return None
            same, k = found
            end = self._section_end(same, k)
            head = same[k]
            text, _ = self._read(head['file'])
            s, e = head['start'], same[end - 1]['end']
            return {'file': head['file'], 'start': s, 'end': e,
                    'source': text[s:e],
                    'ids': [x['id'] for x in same[k:end]],
                    'heading_id': head['id'], 'level': self._level(head),
                    'title': (head.get('meta') or {}).get('title', '')}

    def op_save_section(self, bid, new_source):
        with self.lock:
            found = self._enclosing_section(bid)
            if found is None:
                raise ValueError(f'block {bid} is not inside a section')
            same, k = found
            end = self._section_end(same, k)
            s, e = same[k]['start'], same[end - 1]['end']
            text, _ = self._read(same[k]['file'])
            nt = patch(text, s, e, text[s:e], new_source)
            if nt is None:
                raise ConflictError('section no longer matches on disk')
            self._write_and_rebuild(same[k]['file'], nt, 'edit section')

    # -- raw file access ------------------------------------------------------
    def _check_rel(self, rel, must_be_tex):
        p = (self.root / rel).resolve()
        if self.root not in p.parents and p != self.root:
            raise ValueError('path escapes project root')
        if not p.exists():
            raise FileNotFoundError(rel)
        if must_be_tex and p.suffix != '.tex':
            raise ValueError('only .tex files can be edited raw')
        return p

    def raw_get(self, rel):
        self._check_rel(rel, must_be_tex=False)
        text, enc = self._read(rel)
        return text, enc

    def raw_put(self, rel, source):
        with self.lock:
            self._check_rel(rel, must_be_tex=True)
            self._write_and_rebuild(rel, source, 'raw file edit')


class Project:
    def __init__(self, main_tex):
        self.id = secrets.token_hex(4)
        self.store = Store(main_tex)
        root_name = self.store.root.name
        self.name = f'{root_name}/{self.store.main_path.name}'
        self.last_accessed = time.time()

    def touch(self):
        self.last_accessed = time.time()


class SaveBody(BaseModel):
    source: str


class MoveBody(BaseModel):
    direction: str
    positions: int = 1


class MoveBlocksBody(BaseModel):
    blocks: list[str]
    after: str
    before: bool = False


class InsertBody(BaseModel):
    after: str
    source: str


class FileBody(BaseModel):
    path: str
    source: str


class AddProjectBody(BaseModel):
    path: str


class GitPathsBody(BaseModel):
    paths: list[str]


class GitCommitBody(BaseModel):
    message: str
    paths: list[str] | None = None


class GitCommitFileBody(BaseModel):
    path: str
    message: str


class ProofCheckBody(BaseModel):
    lang: str = 'en-US'
    block_ids: list[str] | None = None


class ProofEngineBody(BaseModel):
    engine: str  # 'languagetool' | 'spellcheck'


class ProofDictBody(BaseModel):
    word: str


class ProofIgnoreBody(BaseModel):
    rule: str
    text: str


def _parse_bbl(text):
    """Split a .bbl into (key, label, raw_body) triples, in reference order."""
    text = re.sub(r'(?<!\\)%.*', '', text)  # strip comments
    pattern = re.compile(r'\\bibitem(?:\[([^\]]*)\])?\{([^}]+)\}')
    matches = list(pattern.finditer(text))
    out = []
    for k, m in enumerate(matches):
        start = m.end()
        end = matches[k + 1].start() if k + 1 < len(matches) else \
            text.find('\\end{thebibliography}', start)
        if end < 0:
            end = len(text)
        out.append((m.group(2).strip(), m.group(1), text[start:end]))
    return out


def _latex_clean(s):
    """Strip braces and resolve common accents for display strings."""
    s = s.replace('~', ' ')
    for a, b in (('\\,', ' '), ('\\;', ' '), ('\\:', ' '), ('\\!', '')):
        s = s.replace(a, b)
    for a, b in (('\\"a', 'ä'), ('\\"o', 'ö'), ('\\"u', 'ü'), ('\\"A', 'Ä'),
                 ('\\"O', 'Ö'), ('\\"U', 'Ü'), ("\\'a", 'á'), ("\\'e", 'é'),
                 ("\\'i", 'í'), ("\\'o", 'ó'), ("\\'u", 'ú'), ('\\`e', 'è'),
                 ('\\`a', 'à'), ('\\^o', 'ô'), ('\\^e', 'ê'), ('\\~n', 'ñ'),
                 ('\\ss', 'ß'), ('\\c{c}', 'ç')):
        s = s.replace(a, b)
    return s.replace('{', '').replace('}', '').strip()


def _entry_url(raw):
    r"""First usable URL of a bbl entry: \url / \href argument, a bare
    https URL, or a DOI (converted to its https://doi.org form)."""
    m = re.search(r'\\url\{([^{}]+)\}', raw)
    if m:
        return m.group(1).strip()
    m = re.search(r'\\href\{([^{}]+)\}', raw)
    if m:
        return m.group(1).strip()
    m = re.search(r'https?://[^\s\\%]+', raw)
    if m:
        return m.group(0).rstrip('.,;)')
    m = re.search(r'\b(10\.[0-9]{4,9}/[^\s\\]+)', raw)
    if m:
        return 'https://doi.org/' + m.group(1).rstrip('.,;)')
    return None


def _tex_plain(s):
    """Light LaTeX → plain text conversion for reference tooltips."""
    s = re.sub(r'\\newblock\s*', ' ', s)
    s = re.sub(r'\\href\s*\{[^}]*\}\s*\{([^}]*)\}', r'\1', s)
    s = re.sub(r'\\(?:emph|textit|textbf|texttt|textsc|mbox|text|url|textrm)\s*\{([^{}]*)\}', r'\1', s)
    for a, b in (('\\,', ' '), ('\\;', ' '), ('\\:', ' '), ('\\!', ''),
                 ('\\&', '&'), ('\\%', '%'), ('\\_', '_'), ('\\$', '$'),
                 ('\\{', '{'), ('\\}', '}')):
        s = s.replace(a, b)
    s = re.sub(r'\\[a-zA-Z]+\*?\s*', ' ', s)   # remaining bare commands out
    s = s.replace('{', '').replace('}', '')
    s = re.sub(r'---?', '–', s)               # en/em dashes
    s = re.sub(r'\s+', ' ', s).strip()
    return _latex_clean(s)


def create_app(initial_mains=(), port=8080, proof_engine=None, engine='auto'):
    """proof_engine: explicit choice ('languagetool'/'spellcheck') wins;
    None → the persisted setting, else the languagetool default. engine:
    LaTeX compile engine priority ('auto'/'latexmk'/'tectonic')."""
    if proof_engine is None:
        proof_engine = load_settings().get('proof_engine') or 'languagetool'
    # runs on app startup (uvicorn / TestClient context manager): grab the
    # event loop for broadcasts and start the file watchers
    @asynccontextmanager
    async def _lifespan(_app):
        nonlocal loop
        loop = asyncio.get_running_loop()
        for proj in projects.values():
            watch_project(proj)
        yield

    app = FastAPI(title='texperiment', lifespan=_lifespan)
    projects = {}          # pid -> Project
    clients = set()        # websockets
    loop = None
    # dict so routes can switch the engine at runtime (/proof/engine)
    eng_state = {'eng': proof.ENGINES[proof_engine]()}
    engine_pref = engine  # compile engine priority (auto/latexmk/tectonic)
    app.state.focus_cb = {'fn': None}  # desktop shell registers its raiser
    app.state.desktop = False          # set True by texperiment/desktop.py

    def broadcast(msg):
        async def _send():
            dead = []
            for ws in clients:
                try:
                    await ws.send_json(msg)
                except Exception:
                    dead.append(ws)
            for ws in dead:
                clients.discard(ws)
        if loop is None:
            return
        asyncio.run_coroutine_threadsafe(_send(), loop)

    def get_project(pid) -> Project:
        p = projects.get(pid)
        if p is None:
            raise HTTPException(404, 'project not found')
        p.touch()  # every real access bumps the recency used for ordering
        return p

    def add_project(main_tex, last_accessed=None) -> Project:
        proj = Project(main_tex)
        if last_accessed is not None:
            proj.last_accessed = last_accessed
        projects[proj.id] = proj
        save_port_projects(port, projects)
        return proj

    for m in initial_mains:
        try:
            add_project(m)
        except (FileNotFoundError, ValueError) as e:
            print(f'! skipping {m}: {e}')

    # restore the projects persisted for this port (skip already-open ones)
    known = {str(p.store.main_path) for p in projects.values()}
    for rec in load_port_projects(port):
        if rec.get('path') in known:
            continue
        try:
            add_project(rec['path'], rec.get('last_accessed'))
        except (FileNotFoundError, ValueError) as e:
            print(f'! not restoring {rec.get("path")}: {e}')

    def watch_project(proj: Project):
        def should_process(path):
            lw = proj.store.fs.last_write
            if lw and lw[0] == path and time.time() - lw[1] < 1.5:
                return False  # our own write
            return True

        def on_change():
            try:
                proj.store.rebuild()
            except Exception:
                return
            broadcast({'type': 'reload', 'project': proj.id, 'doc': proj.store.doc})

        watcher.start_watcher(proj.store.root, should_process, on_change)

        def on_bib_change():
            # citation data only — no LaTeX run, no doc rebuild; the
            # client refetches /bibliography when it receives this
            broadcast({'type': 'bib', 'project': proj.id})

        # .bib edits (autocomplete source) and .bbl rewrites (bibtex ran)
        watcher.start_watcher(proj.store.root, should_process, on_bib_change,
                              extensions=('.bib', '.bbl'))

        def on_graphic_change():
            # figure files added/changed/removed — no LaTeX run, no doc
            # rebuild; the client refetches /graphics for the
            # \includegraphics autocomplete and re-resolves its figure
            # cache when it receives this
            broadcast({'type': 'graphics', 'project': proj.id})

        watcher.start_watcher(proj.store.root, should_process,
                              on_graphic_change, extensions=GRAPHICS_EXTS,
                              watch_deletes=True)

    def _run(op, *args):
        try:
            return op(*args)
        except KeyError:
            raise HTTPException(404, 'block not found (document changed?)')
        except ConflictError as e:
            raise HTTPException(409, str(e))
        except GitError as e:
            raise HTTPException(400, str(e))
        except ProofError as e:
            raise HTTPException(400, str(e))
        except ValueError as e:
            raise HTTPException(400, str(e))
        except FileNotFoundError as e:
            raise HTTPException(404, str(e))

    # -- projects -------------------------------------------------------------
    @app.get('/api/projects')
    def list_projects():
        return [{'id': p.id, 'name': p.name, 'main': str(p.store.main_path),
                 'last_accessed': p.last_accessed}
                for p in projects.values()]

    @app.post('/api/projects')
    def add_project_route(body: AddProjectBody):
        try:
            proj = add_project(body.path)
        except FileNotFoundError as e:
            raise HTTPException(400, f'file not found: {e}')
        except ValueError as e:
            raise HTTPException(400, str(e))
        watch_project(proj)
        return {'id': proj.id, 'name': proj.name, 'main': str(proj.store.main_path)}

    @app.delete('/api/project/{pid}')
    def remove_project(pid: str):
        get_project(pid)
        del projects[pid]
        save_port_projects(port, projects)
        return {'ok': True}

    # -- disk browser (add project from the UI) --------------------------------
    @app.get('/api/browse')
    def browse(path: str = ''):
        if not path:
            drives = [f'{c}:\\' for c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
                      if Path(f'{c}:\\').exists()]
            return {'roots': drives}
        p = Path(path).resolve()
        if p.is_file() and p.suffix == '.tex':
            return {'file': str(p)}
        if not p.is_dir():
            raise HTTPException(400, 'not a directory or .tex file')
        try:
            entries = list(p.iterdir())
        except PermissionError:
            raise HTTPException(400, 'permission denied')
        dirs = sorted(e.name for e in entries
                      if e.is_dir() and not e.name.startswith('.'))
        tex = sorted(e.name for e in entries
                     if e.is_file() and e.suffix == '.tex' and not e.name.startswith('.'))
        parent = str(p.parent) if p.parent != p else None
        return {'path': str(p), 'parent': parent, 'dirs': dirs, 'tex_files': tex}

    # -- per-project document routes --------------------------------------------
    @app.get('/api/project/{pid}/doc')
    def get_doc(pid: str):
        return get_project(pid).store.doc

    @app.post('/api/project/{pid}/block/{bid}/save')
    def save_block(pid: str, bid: str, body: SaveBody):
        _run(get_project(pid).store.op_save, bid, body.source)
        return {'ok': True, 'doc': get_project(pid).store.doc}

    @app.post('/api/project/{pid}/block/{bid}/delete')
    def delete_block(pid: str, bid: str):
        _run(get_project(pid).store.op_delete, bid)
        return {'ok': True, 'doc': get_project(pid).store.doc}

    @app.post('/api/project/{pid}/block/{bid}/move')
    def move_block(pid: str, bid: str, body: MoveBody):
        _run(get_project(pid).store.op_move, bid, body.direction, body.positions)
        return {'ok': True, 'doc': get_project(pid).store.doc}

    @app.post('/api/project/{pid}/block/move-blocks')
    def move_blocks_route(pid: str, body: MoveBlocksBody):
        proj = get_project(pid)
        _run(proj.store.op_move_blocks, body.blocks, body.after, body.before)
        return {'ok': True, 'doc': get_project(pid).store.doc}

    @app.post('/api/project/{pid}/block/insert')
    def insert_block(pid: str, body: InsertBody):
        new_id = _run(get_project(pid).store.op_insert, body.after, body.source)
        return {'ok': True, 'new_id': new_id, 'doc': get_project(pid).store.doc}

    @app.get('/api/project/{pid}/block/{bid}/section')
    def get_section(pid: str, bid: str):
        span = _run(get_project(pid).store.section_span, bid)
        if span is None:
            raise HTTPException(404, 'block is not inside a section')
        return span

    @app.post('/api/project/{pid}/block/{bid}/section/save')
    def save_section(pid: str, bid: str, body: SaveBody):
        _run(get_project(pid).store.op_save_section, bid, body.source)
        return {'ok': True, 'doc': get_project(pid).store.doc}

    @app.get('/api/project/{pid}/file')
    def get_file(pid: str, path: str):
        try:
            text, enc = get_project(pid).store.raw_get(path)
        except ValueError as e:
            raise HTTPException(400, str(e))
        except FileNotFoundError:
            raise HTTPException(404, path)
        return {'path': path, 'source': text, 'encoding': enc}

    @app.put('/api/project/{pid}/file')
    def put_file(pid: str, body: FileBody):
        _run(get_project(pid).store.raw_put, body.path, body.source)
        return {'ok': True, 'doc': get_project(pid).store.doc}

    # -- git integration --------------------------------------------------------
    def _git_status_payload(proj):
        st = _run(gitops.status, proj.store.root)
        st['repo'] = True
        # repo-relative prefix of the project inside its repo ('' when
        # the project root IS the repo root); the client scopes
        # destructive group operations to the project's own files
        _top, prefix = _run(gitops.find_repo, proj.store.root)
        st['prefix'] = prefix or ''
        return st

    @app.get('/api/project/{pid}/git/status')
    def git_status_route(pid: str):
        proj = get_project(pid)
        top, _ = _run(gitops.find_repo, proj.store.root)
        if top is None:
            return {'repo': False}
        return _git_status_payload(proj)

    @app.post('/api/project/{pid}/git/init')
    def git_init_route(pid: str):
        proj = get_project(pid)
        _run(gitops.init, proj.store.root)
        return {'ok': True, 'status': _git_status_payload(proj)}

    @app.get('/api/project/{pid}/git/diff')
    def git_diff_route(pid: str, path: str, staged: bool = False):
        text = _run(gitops.diff, get_project(pid).store.root, path, staged)
        return {'path': path, 'text': text}

    @app.get('/api/project/{pid}/git/diff-all')
    def git_diff_all_route(pid: str, staged: bool = False):
        text = _run(gitops.diff_all, get_project(pid).store.root, staged)
        return {'text': text}

    @app.post('/api/project/{pid}/git/stage-block')
    def git_stage_block_route(pid: str, body: GitCommitBody):
        proj = get_project(pid)
        staged = _run(gitops.stage_block, proj.store, body.message)
        return {'ok': True, 'staged': staged}

    @app.post('/api/project/{pid}/git/unstage-block')
    def git_unstage_block_route(pid: str, body: GitCommitBody):
        proj = get_project(pid)
        staged = _run(gitops.unstage_block, proj.store, body.message)
        return {'ok': True, 'staged': staged}

    @app.post('/api/project/{pid}/git/discard-block')
    def git_discard_block_route(pid: str, body: GitCommitBody):
        proj = get_project(pid)
        got = _run(gitops.discard_block, proj.store, body.message)
        if not got:
            return {'ok': False}
        rel, content = got
        # raw_put: worktree write + rebuild + undo history; index was
        # already synced by discard_block
        _run(proj.store.raw_put, rel, content)
        # other clients see this as a worktree change; the initiating
        # client applies the POST response itself
        broadcast({'type': 'reload', 'project': pid,
                   'doc': proj.store.doc, 'self': True})
        return {'ok': True, 'doc': proj.store.doc}

    @app.post('/api/project/{pid}/git/stage')
    def git_stage_route(pid: str, body: GitPathsBody):
        _run(gitops.stage, get_project(pid).store.root, body.paths)
        return {'ok': True, 'status': _git_status_payload(get_project(pid))}

    @app.post('/api/project/{pid}/git/unstage')
    def git_unstage_route(pid: str, body: GitPathsBody):
        _run(gitops.unstage, get_project(pid).store.root, body.paths)
        return {'ok': True, 'status': _git_status_payload(get_project(pid))}

    @app.post('/api/project/{pid}/git/discard')
    def git_discard_route(pid: str, body: GitPathsBody):
        proj = get_project(pid)
        _run(gitops.discard, proj.store.root, body.paths)
        # the worktree changed underneath us — re-parse and push a reload
        # ('self': an editor op, not an external disk change)
        proj.store.rebuild()
        broadcast({'type': 'reload', 'project': proj.id,
                   'doc': proj.store.doc, 'self': True})
        return {'ok': True, 'status': _git_status_payload(proj)}

    @app.post('/api/project/{pid}/git/commit')
    def git_commit_route(pid: str, body: GitCommitBody):
        if not body.message.strip():
            raise HTTPException(400, 'commit message is empty')
        summary = _run(gitops.commit, get_project(pid).store.root,
                       body.message.strip(), body.paths)
        return {'ok': True, 'summary': summary,
                'status': _git_status_payload(get_project(pid))}

    @app.post('/api/project/{pid}/git/commit-file')
    def git_commit_file_route(pid: str, body: GitCommitFileBody):
        if not body.message.strip():
            raise HTTPException(400, 'commit message is empty')
        proj = get_project(pid)
        summary = _run(gitops.commit_file, proj.store.root,
                       body.path, body.message.strip())
        return {'ok': True, 'summary': summary,
                'status': _git_status_payload(proj)}

    @app.post('/api/project/{pid}/git/push')
    def git_push_route(pid: str):
        _run(gitops.push, get_project(pid).store.root)
        return {'ok': True, 'status': _git_status_payload(get_project(pid))}

    @app.get('/api/project/{pid}/git/changes')
    def git_changes_route(pid: str):
        ids = _run(gitops.changed_block_ids, get_project(pid).store)
        return {'ids': ids, 'count': len(ids)}

    @app.get('/api/project/{pid}/git/blockdiffs')
    def git_blockdiffs_route(pid: str):
        proj = get_project(pid)
        payload = _run(gitops.block_diffs, proj.store)
        # per-block staged flags for the toggle buttons
        staged = {}
        rels = {e['path'] for e in proj.store.doc['files']}
        for rel in rels:
            cur_blocks = [b for b in proj.store.doc['blocks'] if b['file'] == rel]
            _head, idx, _cur = _run(gitops._file_texts, proj.store, rel)
            staged.update(_run(gitops._staged_flags, proj.store, rel,
                               cur_blocks, idx))
        payload['staged'] = staged
        return payload

    # -- proofreading -----------------------------------------------------------
    @app.get('/api/project/{pid}/proof/config')
    def proof_config_route(pid: str):
        get_project(pid)
        eng = eng_state['eng']
        ok, err = eng.available()
        out = {'engine': eng.name, 'available': ok, 'error': err}
        if isinstance(eng, proof.LanguageToolEngine):
            out['lt'] = eng.lt_state()
        return out

    @app.post('/api/project/{pid}/proof/install-lt')
    def proof_install_lt_route(pid: str):
        """User-consented LanguageTool download (~200 MB, needs Java).
        The check endpoint never downloads on its own."""
        get_project(pid)
        eng = eng_state['eng']
        if not isinstance(eng, proof.LanguageToolEngine):
            raise HTTPException(400, 'LanguageTool is not the active engine')
        eng.start_install()
        return {'ok': True, 'lt': eng.lt_state()}

    @app.post('/api/project/{pid}/proof/engine')
    def proof_engine_route(pid: str, body: ProofEngineBody):
        """Switch the proofreading engine at runtime; persisted."""
        get_project(pid)
        if body.engine not in proof.ENGINES:
            raise HTTPException(400, 'unknown proofreading engine')
        eng_state['eng'] = proof.ENGINES[body.engine]()
        save_setting('proof_engine', body.engine)
        eng = eng_state['eng']
        ok, err = eng.available()
        out = {'engine': eng.name, 'available': ok, 'error': err}
        if isinstance(eng, proof.LanguageToolEngine):
            out['lt'] = eng.lt_state()
        return out

    @app.post('/api/project/{pid}/proof/check')
    def proof_check_route(pid: str, body: ProofCheckBody):
        if not body.lang:
            raise ValueError('lang is required')
        ids = set(body.block_ids) if body.block_ids else None
        issues = _run(proof.check_blocks, get_project(pid).store,
                      eng_state['eng'], body.lang, ids)
        return {'issues': issues, 'count': len(issues)}

    @app.post('/api/project/{pid}/proof/dictionary')
    def proof_dict_route(pid: str, body: ProofDictBody):
        root = get_project(pid).store.root
        words = _run(proof.add_to_dictionary, root, body.word)
        return {'ok': True, 'words': words}

    @app.post('/api/project/{pid}/proof/ignore')
    def proof_ignore_route(pid: str, body: ProofIgnoreBody):
        root = get_project(pid).store.root
        _run(proof.add_ignore, root, body.rule, body.text)
        return {'ok': True}

    # -- undo / redo --------------------------------------------------------------
    def _history_flags(proj):
        h = proj.store.history
        return {'can_undo': bool(h['undo']), 'can_redo': bool(h['redo']),
                'undo_label': h['undo'][-1]['label'] if h['undo'] else '',
                'redo_label': h['redo'][-1]['label'] if h['redo'] else ''}

    @app.get('/api/project/{pid}/history')
    def history_route(pid: str):
        return _history_flags(get_project(pid))

    def _history_op_route(pid, op):
        proj = get_project(pid)
        label = _run(op, proj.store)
        if label is None:
            return {'ok': False, 'noop': True, **_history_flags(proj)}
        # files changed on disk — push a reload like the git discard route.
        # 'self' marks an editor-made change: clients must not flag the
        # reverted blocks as external disk changes (yellow)
        broadcast({'type': 'reload', 'project': proj.id,
                   'doc': proj.store.doc, 'self': True})
        return {'ok': True, 'label': label, 'doc': proj.store.doc,
                **_history_flags(proj)}

    @app.post('/api/project/{pid}/undo')
    def undo_route(pid: str):
        return _history_op_route(pid, lambda store: store.op_undo())

    @app.post('/api/project/{pid}/redo')
    def redo_route(pid: str):
        return _history_op_route(pid, lambda store: store.op_redo())

    # -- LaTeX compilation -------------------------------------------------------
    def _latexmk_outdir(root):
        """$out_dir from the project's latexmkrc (or .latexmkrc), if any."""
        for name in ('latexmkrc', '.latexmkrc'):
            p = Path(root) / name
            if p.exists():
                try:
                    text = p.read_text(encoding='utf-8', errors='replace')
                except OSError:
                    return None
                m = re.search(r'\$out_dir\s*=\s*[\'"]([^\'"]+)[\'"]', text)
                if m:
                    return m.group(1)
        return None

    def _pdf_path(proj):
        """Where latexmk leaves the PDF: root, or latexmkrc's out_dir if
        configured and the file exists there."""
        main_pdf = proj.store.main_path.with_suffix('.pdf')
        out_dir = _latexmk_outdir(proj.store.root)
        if out_dir:
            cand = proj.store.root / out_dir / (main_pdf.name)
            if cand.exists():
                return cand
        return main_pdf

    @app.post('/api/project/{pid}/compile')
    def compile_project(pid: str):
        proj = get_project(pid)
        root = proj.store.root
        main_name = proj.store.main_path.name
        engine = engine_pref
        latexmk = _find_tex_tool('latexmk') if engine in ('auto', 'latexmk') else None
        tect = _bundled_tectonic() if engine in ('auto', 'tectonic') else None
        if latexmk:
            # -f: force past recorded errors from earlier runs — we serve the
            # best-effort PDF together with the log instead of refusing
            cmd = [latexmk, '-pdf', '-f', '-interaction=nonstopmode', main_name]
        elif shutil.which('pdflatex'):
            cmd = ['pdflatex', '-interaction=nonstopmode', '-halt-on-error', main_name]
        elif tect:
            # tectonic reruns and runs BibTeX itself; the PDF lands beside
            # the input (no latexmkrc out_dir handling needed)
            cmd = [tect, main_name]
        else:
            raise HTTPException(400,
                'No TeX toolchain found — install TeX Live or MiKTeX '
                '(latexmk/pdflatex; the bundled tectonic fallback is '
                'missing too).')
        env = _compile_env()
        try:
            proc = subprocess.run(cmd, cwd=str(root), capture_output=True,
                                  text=True, encoding='utf-8',
                                  errors='replace', timeout=300, env=env,
                                  creationflags=_NO_WINDOW)
            if cmd[0] == 'pdflatex' and proc.returncode == 0:
                # second pass for cross references
                subprocess.run(cmd, cwd=str(root), capture_output=True,
                               text=True, encoding='utf-8',
                               errors='replace', timeout=300, env=env,
                               creationflags=_NO_WINDOW)
        except subprocess.TimeoutExpired:
            raise HTTPException(500, 'Compilation timed out after 300 s.')
        except OSError as e:
            raise HTTPException(500, f'Could not run {cmd[0]}: {e}')
        pdf = _pdf_path(proj)
        tail = '\n'.join((proc.stdout or '').splitlines()[-40:])
        # latexmk can exit non-zero while still producing a PDF (best-effort
        # with -f), or report "nothing to do" for an up-to-date PDF — serve
        # it together with the log; only fail when there is no PDF at all
        if proc.returncode == 0:
            clean, log = True, None
        else:
            clean, log = False, tail
        if not pdf.exists():
            err = ((proc.stderr or '') + '\n' + tail).strip()
            hint = ('latexmk reported success but no PDF was found — check '
                    '$out_dir in your latexmkrc (looked in ' +
                    str(proj.store.main_path.with_suffix('.pdf').parent) + ').')
            raise HTTPException(500, 'Compilation failed:\n'
                                + (err or f'exit code {proc.returncode}')
                                + '\n' + hint)
        return {'ok': True, 'pdf': f'/api/project/{pid}/pdf',
                'clean': clean, 'log': log}

    @app.get('/api/project/{pid}/pdf')
    def project_pdf(pid: str):
        proj = get_project(pid)
        pdf = _pdf_path(proj)
        if not pdf.exists():
            raise HTTPException(404, 'No PDF yet — compile first.')
        return FileResponse(str(pdf), media_type='application/pdf',
                            headers={'Cache-Control': 'no-store'})

    # -- bibliography (citation resolution from the compiled .bbl) --------------
    def _bib_payload(proj):
        """Citation data for autocomplete + hover popups.

        The compiled .bbl is authoritative when present (real typeset
        numbering, natbib style). .bib files in the project tree are parsed
        directly as well, so keys not yet cited/bibited still autocomplete
        and a project without any .bbl works too."""
        root = proj.store.root
        stem = proj.store.main_path.stem
        bib_entries = []
        for p in sorted(root.glob('*.bib')):
            try:
                text, _ = read_text_preserve(p)
            except OSError:
                continue
            for e in bibparse.parse_bib(text):
                e['file'] = p.name
                bib_entries.append(e)
        # the .bbl sits wherever bibtex last ran — the latexmkrc out_dir,
        # the project root, or a build/ dir from an older rc setting; take
        # the newest one so an rc change can't orphan the references
        cands = []
        out_dir = _latexmk_outdir(root)
        if out_dir:
            cands.append(root / out_dir / f'{stem}.bbl')
        cands.append(root / f'{stem}.bbl')
        cands.append(root / 'build' / f'{stem}.bbl')
        cands = [c for c in cands if c.exists()]
        bbl = max(cands, key=lambda c: c.stat().st_mtime) if cands else None
        if bbl is not None:
            entries = []
            for num, (key, label, raw) in enumerate(
                    _parse_bbl(bbl.read_text(encoding='utf-8', errors='replace')), 1):
                authors = year = ''
                if label:
                    clean = _latex_clean(label)
                    m = re.match(r'^(.*?)\(([^()]*)\)', clean)
                    if m:
                        authors, year = m.group(1).strip(), m.group(2).strip()
                    else:
                        authors = clean
                # join the .bib metadata (title/journal/url) onto the bbl
                # entry so hover popups are rich even in numeric styles
                extra = next((e for e in bib_entries if e['key'] == key), None)
                entries.append({'key': key, 'num': num, 'label': _latex_clean(label or ''),
                                'url': _entry_url(raw) or (extra and extra.get('url')),
                                'authors': authors or (extra and extra.get('authors')) or '',
                                'year': year or (extra and extra.get('year')) or '',
                                'plain': _tex_plain(raw)})
            # natbib author-year styles emit \bibitem[Author(Year)]{key};
            # numeric styles leave the optional label out
            style = ('authoryear'
                     if any('(' in e['label'] for e in entries) else 'numeric')
            # keys known from .bib but not yet cited (no \bibitem) still
            # autocomplete; they carry no num, so numeric-style rendering
            # falls back to the raw chip for them
            known = {e['key'] for e in entries}
            entries.extend(e for e in bib_entries if e['key'] not in known)
            return {'available': bool(entries), 'style': style,
                    'entries': entries, 'source': 'bbl'}
        # no .bbl yet (or stale) — serve the .bib files directly; the
        # frontend renders these as chips only (no resolved numbering)
        style = 'authoryear' if bib_entries else 'numeric'
        return {'available': bool(bib_entries), 'style': style,
                'entries': bib_entries, 'source': 'bib'}

    @app.get('/api/project/{pid}/bibliography')
    def bibliography_route(pid: str):
        return _bib_payload(get_project(pid))

    # -- project images (\includegraphics) ---------------------------------------
    @app.get('/files/{pid}/{rel:path}')
    def project_file(pid: str, rel: str, request: Request):
        store = get_project(pid).store
        p = (store.root / rel).resolve()
        if store.root not in p.parents and p != store.root:
            raise HTTPException(404)
        if not p.is_file():
            raise HTTPException(404)
        # etag from mtime+size: re-renders remount the figure element, and
        # without a validator the browser re-downloads the whole file every
        # time (visible as the PDF viewer loading twice). max-age keeps
        # plain plugin remounts from hitting the server at all; the etag
        # bounds staleness at a minute for externally edited graphics
        st = p.stat()
        etag = f'"g{st.st_mtime_ns}-{st.st_size}"'
        headers = {'ETag': etag,
                   'Cache-Control': 'private, max-age=60, must-revalidate'}
        if request.headers.get('if-none-match', '').strip() == etag:
            return Response(status_code=304, headers=headers)
        return FileResponse(p, headers=headers)

    def _graphicspath_dirs(proj):
        """Dirs declared via \\graphicspath{{dir/}{dir2/}} in the document."""
        out = []
        for b in proj.store.doc['blocks']:
            for m in re.finditer(r'\\graphicspath\{((?:\s*\{[^{}]*\})+)\}',
                                 b['source']):
                for d in re.finditer(r'\{([^{}]*)\}', m.group(1)):
                    d2 = d.group(1).strip().replace('\\', '/')
                    if d2 and not d2.endswith('/'):
                        d2 += '/'
                    if d2:
                        out.append(d2)
        return out

    def _resolve_graphic(proj, raw):
        """Find the actual file for an \\includegraphics argument, the way
        LaTeX does: literal path, then extension probing, then
        \\graphicspath dirs, then a bounded basename search."""
        p = raw.strip().strip('"{}').replace('\\', '/')
        if not p:
            return None
        root = proj.store.root
        stem = p.rsplit('.', 1)[0].lower() \
            if '.' in p.rsplit('/', 1)[-1] else p.lower()
        has_ext = stem != p.lower()
        bases = [p] if has_ext else [p + e for e in GRAPHICS_EXTS]
        dirs = [''] + _graphicspath_dirs(proj)
        for d in dirs:
            for base in bases:
                cand = (root / d / base).resolve()
                if root not in cand.parents and cand != root:
                    continue  # escapes the project
                if cand.is_file():
                    return cand.relative_to(root).as_posix()
        # last resort: same basename anywhere in the project (skips dot dirs)
        want = p.rsplit('/', 1)[-1].lower()
        for cand in root.rglob('*'):
            parts = cand.relative_to(root).parts
            if any(x.startswith('.') for x in parts):
                continue
            if not cand.is_file() or cand.suffix.lower() not in GRAPHICS_EXTS:
                continue
            if cand.name.lower() == want or \
                    (not has_ext and cand.stem.lower() == want):
                return cand.relative_to(root).as_posix()
        return None

    @app.get('/api/project/{pid}/graphic')
    def graphic_route(pid: str, path: str):
        rel = _resolve_graphic(get_project(pid), path)
        if rel is None:
            raise HTTPException(404, 'graphic not found')
        return {'path': rel}

    @app.get('/api/project/{pid}/graphics')
    def graphics_route(pid: str):
        """All graphics files in the project (raster + pdf/eps) for the
        \\includegraphics autocomplete."""
        root = get_project(pid).store.root
        out = []
        for cand in sorted(root.rglob('*')):
            parts = cand.relative_to(root).parts
            if any(x.startswith('.') for x in parts):
                continue
            if cand.is_file() and cand.suffix.lower() in GRAPHICS_EXTS:
                out.append(cand.relative_to(root).as_posix())
        return {'files': out}

    @app.websocket('/ws')
    async def ws_endpoint(ws: WebSocket):
        await ws.accept()
        clients.add(ws)
        try:
            while True:
                await ws.receive_text()
        except WebSocketDisconnect:
            clients.discard(ws)
        except Exception:
            clients.discard(ws)

    # -- desktop-shell helpers --------------------------------------------------
    class OpenUrlBody(BaseModel):
        url: str

    @app.get('/api/env')
    def env_route():
        return {'desktop': app.state.desktop, 'version': __version__,
                'engine': engine_pref}

    @app.get('/focus')
    def focus_route():
        """The desktop shell raises its window; a second launch hits this
        to activate the first instance instead of failing on the port."""
        fn = app.state.focus_cb.get('fn')
        if fn:
            try:
                fn()
            except Exception:
                pass
        return {'ok': True}

    @app.post('/open-url')
    def open_url_route(body: OpenUrlBody):
        """Open an external link in the system browser — the app window
        itself must never navigate away from the editor."""
        u = (body.url or '').strip()
        if not re.match(r'^https?://', u):
            raise HTTPException(400, 'only http(s) URLs can be opened')
        webbrowser.open(u)
        return {'ok': True}

    @app.post('/api/project/{pid}/pdf-open')
    def pdf_open_route(pid: str):
        """Open the compiled PDF in the system's default PDF viewer."""
        proj = get_project(pid)
        pdf = _pdf_path(proj)
        if not pdf.exists():
            raise HTTPException(404, 'No PDF yet — compile first.')
        try:
            if os.name == 'nt':
                os.startfile(str(pdf))  # noqa: S606 — shell-open by design
            elif sys.platform == 'darwin':
                subprocess.run(['open', str(pdf)], check=False)
            else:
                subprocess.run(['xdg-open', str(pdf)], check=False)
        except OSError as e:
            raise HTTPException(500, f'could not open the PDF: {e}')
        return {'ok': True}

    # dev-friendly caching: browsers must revalidate the frontend assets
    # (etag), otherwise code changes need a hard reload to take effect
    @app.middleware('http')
    async def no_cache_static(request, call_next):
        resp = await call_next(request)
        if request.url.path in ('/', '/index.html', '/app.js', '/style.css'):
            resp.headers['Cache-Control'] = 'no-cache'
        return resp

    app.mount('/', StaticFiles(directory=str(WEB_DIR), html=True), name='web')
    return app
