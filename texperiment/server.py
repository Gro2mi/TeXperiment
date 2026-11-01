"""FastAPI server: multi-project registry, block edit ops, raw file access,
disk browsing, and per-project WS live reload."""
import asyncio
import secrets
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
from . import watcher

WEB_DIR = Path(__file__).resolve().parent.parent / 'web'

NON_EDITABLE = ('preamble', 'enddoc')


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


def create_app(initial_mains=()):
    app = FastAPI(title='texperiment')
    projects = {}          # pid -> Project
    clients = set()        # websockets
    loop = None

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

    def add_project(main_tex) -> Project:
        proj = Project(main_tex)
        projects[proj.id] = proj
        return proj

    for m in initial_mains:
        try:
            add_project(m)
        except (FileNotFoundError, ValueError) as e:
            print(f'! skipping {m}: {e}')

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
