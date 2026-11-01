"""FastAPI server: multi-project registry, block edit ops, raw file access,
disk browsing, LaTeX compilation, and per-project WS live reload."""
import asyncio
import json
import secrets
import shutil
import subprocess
import threading
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .parser import parse_file
from .resolver import read_text_preserve, resolve_files
from .storage import ConflictError, FileStore, patch
from . import gitops, watcher
from .gitops import GitError

WEB_DIR = Path(__file__).resolve().parent.parent / 'web'

NON_EDITABLE = ('preamble', 'enddoc')

# per-port project persistence: ~/.texperiment/projects.json
CONFIG_DIR = Path.home() / '.texperiment'
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
        self.rebuild()

    # -- model ------------------------------------------------------------
    def rebuild(self):
        with self.lock:
            files = resolve_files(self.main_path)
            blocks, fentries = [], []
            for fi, fp in enumerate(files):
                text, enc = read_text_preserve(fp)
                rel = fp.relative_to(self.root).as_posix()
                # stable ids: same document structure → same ids, so a
                # re-parse never invalidates ids the UI is still using
                for bi, (typ, s, e, meta) in enumerate(
                        parse_file(text, is_main=(fp == self.main_path))):
                    b = {'id': f'f{fi}b{bi}', 'file': rel, 'type': typ,
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

    def _write_and_rebuild(self, rel, new_text):
        text, enc = self._read(rel)
        self.fs.write(self.root / rel, new_text, enc)
        self.rebuild()

    # -- ops ----------------------------------------------------------------
    def op_save(self, bid, new_source):
        with self.lock:
            b = self._block(bid)
            text, _ = self._read(b['file'])
            nt = patch(text, b['start'], b['end'], b['source'], new_source)
            if nt is None:
                raise ConflictError(
                    f'block {bid} no longer matches {b["file"]} on disk')
            self._write_and_rebuild(b['file'], nt)

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
            self._write_and_rebuild(b['file'], nt)

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
            j = i - positions if direction == 'up' else i + positions
            if j < 0 or j >= len(same):
                raise ValueError('target position out of range (moves stay within a file)')
            text, _ = self._read(b['file'])
            lead = text[:same[0]['start']]
            trail = text[same[-1]['end']:]
            # separators belong to slots, not blocks — sources reorder inside them
            seps = [text[same[k]['end']:
                         (same[k + 1]['start'] if k + 1 < len(same) else len(text))]
                    for k in range(len(same))]
            srcs = [x['source'] for x in same]
            moved = srcs.pop(i)
            srcs.insert(j, moved)
            nt = lead + ''.join(s + sep for s, sep in zip(srcs, seps)) + trail
            self._write_and_rebuild(b['file'], nt)

    def op_insert(self, after_id, source):
        with self.lock:
            b = self._block(after_id)
            if b['type'] in NON_EDITABLE:
                raise ValueError(f'cannot insert after a {b["type"]} block')
            text, _ = self._read(b['file'])
            nt = text[:b['end']] + '\n\n' + source + text[b['end']:]
            self._write_and_rebuild(b['file'], nt)
            for x in self.doc['blocks']:
                if x['file'] == b['file'] and x['source'] == source:
                    return x['id']
            return None

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
            text, enc = self._read(rel)
            self.fs.write(self.root / rel, source, enc)
            self.rebuild()


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


class ProofCheckBody(BaseModel):
    lang: str = 'en-US'
    block_ids: list[str] | None = None


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
    for a, b in (('\\"a', 'ä'), ('\\"o', 'ö'), ('\\"u', 'ü'), ('\\"A', 'Ä'),
                 ('\\"O', 'Ö'), ('\\"U', 'Ü'), ("\\'a", 'á'), ("\\'e", 'é'),
                 ("\\'i", 'í'), ("\\'o", 'ó'), ("\\'u", 'ú'), ('\\`e', 'è'),
                 ('\\`a', 'à'), ('\\^o', 'ô'), ('\\^e', 'ê'), ('\\~n', 'ñ'),
                 ('\\ss', 'ß'), ('\\c{c}', 'ç')):
        s = s.replace(a, b)
    return s.replace('{', '').replace('}', '').strip()


def _tex_plain(s):
    """Light LaTeX → plain text conversion for reference tooltips."""
    s = re.sub(r'\\newblock\s*', ' ', s)
    s = re.sub(r'\\href\s*\{[^}]*\}\s*\{([^}]*)\}', r'\1', s)
    s = re.sub(r'\\(?:emph|textit|textbf|texttt|textsc|mbox|text|url|textrm)\s*\{([^{}]*)\}', r'\1', s)
    for a, b in (('\\&', '&'), ('\\%', '%'), ('\\_', '_'), ('\\$', '$'),
                 ('\\{', '{'), ('\\}', '}')):
        s = s.replace(a, b)
    s = re.sub(r'\\[a-zA-Z]+\*?\s*', '', s)   # remaining bare commands out
    s = s.replace('{', '').replace('}', '')
    s = re.sub(r'---?', '–', s)               # en/em dashes
    s = re.sub(r'\s+', ' ', s).strip()
    return _latex_clean(s)


def create_app(initial_mains=(), port=8080, proof_engine='languagetool'):
    app = FastAPI(title='texperiment')
    projects = {}          # pid -> Project
    clients = set()        # websockets
    loop = None
    proof_eng = proof.ENGINES[proof_engine]()

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

    def _run(op, *args):
        try:
            return op(*args)
        except KeyError:
            raise HTTPException(404, 'block not found (document changed?)')
        except ConflictError as e:
            raise HTTPException(409, str(e))
        except GitError as e:
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

    @app.post('/api/project/{pid}/block/insert')
    def insert_block(pid: str, body: InsertBody):
        new_id = _run(get_project(pid).store.op_insert, body.after, body.source)
        return {'ok': True, 'new_id': new_id, 'doc': get_project(pid).store.doc}

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
        proj.store.rebuild()
        broadcast({'type': 'reload', 'project': proj.id, 'doc': proj.store.doc})
        return {'ok': True, 'status': _git_status_payload(proj)}

    @app.post('/api/project/{pid}/git/commit')
    def git_commit_route(pid: str, body: GitCommitBody):
        if not body.message.strip():
            raise HTTPException(400, 'commit message is empty')
        summary = _run(gitops.commit, get_project(pid).store.root,
                       body.message.strip(), body.paths)
        return {'ok': True, 'summary': summary,
                'status': _git_status_payload(get_project(pid))}

    @app.post('/api/project/{pid}/git/push')
    def git_push_route(pid: str):
        _run(gitops.push, get_project(pid).store.root)
        return {'ok': True, 'status': _git_status_payload(get_project(pid))}

    @app.get('/api/project/{pid}/git/changes')
    def git_changes_route(pid: str):
        ids = _run(gitops.changed_block_ids, get_project(pid).store)
        return {'ids': ids, 'count': len(ids)}

    # -- proofreading -----------------------------------------------------------
    @app.get('/api/project/{pid}/proof/config')
    def proof_config_route(pid: str):
        get_project(pid)
        ok, err = proof_eng.available()
        return {'engine': proof_eng.name, 'available': ok, 'error': err}

    @app.post('/api/project/{pid}/proof/check')
    def proof_check_route(pid: str, body: ProofCheckBody):
        if not body.lang:
            raise ValueError('lang is required')
        ids = set(body.block_ids) if body.block_ids else None
        issues = _run(proof.check_blocks, get_project(pid).store,
                      proof_eng, body.lang, ids)
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
        # files changed on disk — push a reload like the git discard route
        broadcast({'type': 'reload', 'project': proj.id, 'doc': proj.store.doc})
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
        if shutil.which('latexmk'):
            # -f: force past recorded errors from earlier runs — we serve the
            # best-effort PDF together with the log instead of refusing
            cmd = ['latexmk', '-pdf', '-f', '-interaction=nonstopmode', main_name]
        elif shutil.which('pdflatex'):
            cmd = ['pdflatex', '-interaction=nonstopmode', '-halt-on-error', main_name]
        else:
            raise HTTPException(400,
                'No TeX toolchain found — install TeX Live or MiKTeX '
                '(needs latexmk or pdflatex on PATH).')
        try:
            proc = subprocess.run(cmd, cwd=str(root), capture_output=True,
                                  text=True, encoding='utf-8',
                                  errors='replace', timeout=300)
            if cmd[0] == 'pdflatex' and proc.returncode == 0:
                # second pass for cross references
                subprocess.run(cmd, cwd=str(root), capture_output=True,
                               text=True, encoding='utf-8',
                               errors='replace', timeout=300)
        except subprocess.TimeoutExpired:
            raise HTTPException(500, 'Compilation timed out after 300 s.')
        except OSError as e:
            raise HTTPException(500, f'Could not run {cmd[0]}: {e}')
        pdf = proj.store.main_path.with_suffix('.pdf')
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
            raise HTTPException(500, 'Compilation failed:\n'
                                + (err or f'exit code {proc.returncode}'))
        return {'ok': True, 'pdf': f'/api/project/{pid}/pdf',
                'clean': clean, 'log': log}

    @app.get('/api/project/{pid}/pdf')
    def project_pdf(pid: str):
        proj = get_project(pid)
        pdf = proj.store.main_path.with_suffix('.pdf')
        if not pdf.exists():
            raise HTTPException(404, 'No PDF yet — compile first.')
        return FileResponse(str(pdf), media_type='application/pdf',
                            headers={'Cache-Control': 'no-store'})

    # -- project images (\includegraphics) ---------------------------------------
    @app.get('/files/{pid}/{rel:path}')
    def project_file(pid: str, rel: str):
        store = get_project(pid).store
        p = (store.root / rel).resolve()
        if store.root not in p.parents and p != store.root:
            raise HTTPException(404)
        if not p.is_file():
            raise HTTPException(404)
        return FileResponse(p)

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

    @app.on_event('startup')
    async def _startup():
        nonlocal loop
        loop = asyncio.get_running_loop()
        for proj in projects.values():
            watch_project(proj)

    app.mount('/', StaticFiles(directory=str(WEB_DIR), html=True), name='web')
    return app
