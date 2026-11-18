"""M3 — the HTTP API contract (texperiment/server.py create_app).

FastAPI TestClient against a real app rooted in a tmp copy of demo/.
Covers the full edit loop over HTTP, the exception→status mapping
(KeyError→404, ConflictError→409, GitError/ValueError→400), sections,
raw files, history, git routes (including the block-id-in-message
contract), proofreading via the offline spellcheck engine, bibliography
resolution, graphics serving with ETags, compile fallbacks, static
serving, and the WebSocket reload broadcast with a real watcher.
"""
import json
import queue
import shutil
import subprocess
import sys
import threading
import time

import pytest
from fastapi.testclient import TestClient

from texperiment.server import create_app
from texperiment.storage import FileStore


def git(root, *args):
    p = subprocess.run(['git', *args], cwd=str(root), capture_output=True,
                       text=True, encoding='utf-8', errors='replace')
    assert p.returncode == 0, f'git {args}: {p.stderr}'
    return p.stdout


@pytest.fixture
def client(demo_project):
    """App + client without the startup event: no watchers, no event loop
    — broadcast is a no-op, which is exactly right for plain API tests."""
    app = create_app([str(demo_project / 'main.tex')], port=9999,
                     proof_engine='spellcheck')
    c = TestClient(app)
    pid = c.get('/api/projects').json()[0]['id']
    return c, pid, demo_project


def blocks(c, pid):
    return c.get(f'/api/project/{pid}/doc').json()['blocks']


def bid_by_prefix(c, pid, prefix, file=None):
    hits = [b for b in blocks(c, pid)
            if b['source'].lstrip().startswith(prefix)
            and (file is None or b['file'] == file)]
    assert len(hits) == 1, f'expected 1 block for {prefix!r}, got {len(hits)}'
    return hits[0]['id']


# -- projects ---------------------------------------------------------------

def test_project_lifecycle(client):
    c, pid, demo = client
    assert len(c.get('/api/projects').json()) == 1

    r = c.post('/api/projects', json={'path': str(demo / 'chapters' / 'ch1.tex')})
    assert r.status_code == 200
    pid2 = r.json()['id']
    names = [p['id'] for p in c.get('/api/projects').json()]
    assert {pid, pid2} <= set(names)

    assert c.delete(f'/api/project/{pid2}').json() == {'ok': True}
    assert pid2 not in [p['id'] for p in c.get('/api/projects').json()]


def test_add_project_bad_paths(client, tmp_path):
    c = client[0]
    assert c.post('/api/projects',
                  json={'path': str(tmp_path / 'nope.tex')}).status_code == 400
    p = tmp_path / 'notes.txt'
    p.write_text('x', encoding='utf-8')
    assert c.post('/api/projects', json={'path': str(p)}).status_code == 400


def test_unknown_project_is_404(client):
    c = client[0]
    assert c.get('/api/project/zzz/doc').status_code == 404


def test_browse(client, demo_project):
    c = client[0]
    roots = c.get('/api/browse').json()['roots']
    assert isinstance(roots, list)
    r = c.get('/api/browse', params={'path': str(demo_project)}).json()
    assert 'chapters' in r['dirs'] and 'figures' in r['dirs']
    assert 'main.tex' in r['tex_files']
    assert r['parent'] is not None
    assert c.get('/api/browse',
                 params={'path': str(demo_project / 'main.tex')}).json() == \
        {'file': str(demo_project / 'main.tex')}
    png = demo_project / 'figures' / 'plot.png'
    assert c.get('/api/browse', params={'path': str(png)}).status_code == 400


# -- the edit loop over HTTP ----------------------------------------------------

def test_doc_shape(client):
    c, pid, _ = client
    doc = c.get(f'/api/project/{pid}/doc').json()
    assert doc['main'] == 'main.tex'
    assert [f['path'] for f in doc['files']] == \
        ['main.tex', 'chapters/ch1.tex', 'chapters/ch2.tex']
    assert {'preamble', 'section', 'math', 'list', 'table', 'figure',
            'env', 'enddoc'} <= {b['type'] for b in doc['blocks']}


def test_save_block_over_http(client):
    c, pid, demo = client
    bid = bid_by_prefix(c, pid, 'Chapter two arrives', file='chapters/ch2.tex')
    r = c.post(f'/api/project/{pid}/block/{bid}/save',
               json={'source': 'Chapter two, edited over HTTP.'})
    assert r.status_code == 200
    assert r.json()['ok'] is True
    assert 'doc' in r.json()
    disk = (demo / 'chapters' / 'ch2.tex').read_bytes()
    assert b'Chapter two, edited over HTTP.' in disk


def test_insert_and_delete_over_http(client):
    c, pid, demo = client
    bid = bid_by_prefix(c, pid, 'Chapter two arrives', file='chapters/ch2.tex')
    r = c.post(f'/api/project/{pid}/block/insert',
               json={'after': bid, 'source': 'Inserted through the API.'})
    assert r.status_code == 200
    new_id = r.json()['new_id']
    assert new_id

    r = c.post(f'/api/project/{pid}/block/{new_id}/delete')
    assert r.status_code == 200
    assert b'Inserted through the API.' not in \
        (demo / 'chapters' / 'ch2.tex').read_bytes()


def test_move_and_move_blocks_over_http(client):
    c, pid, demo = client
    tab = bid_by_prefix(c, pid, '\\begin{tabular}{ll}',
                        file='chapters/ch2.tex')
    r = c.post(f'/api/project/{pid}/block/{tab}/move',
               json={'direction': 'down', 'positions': 1})
    assert r.status_code == 200
    fig = bid_by_prefix(c, pid, '\\begin{figure}', file='chapters/ch2.tex')
    env = bid_by_prefix(c, pid, '\\begin{mycustomenv}',
                        file='chapters/ch2.tex')
    r = c.post(f'/api/project/{pid}/block/move-blocks',
               json={'blocks': [fig], 'after': env})
    assert r.status_code == 200
    text = (demo / 'chapters' / 'ch2.tex').read_bytes().replace(b'\r\n', b'\n')
    assert text.rstrip().endswith(b'\\end{figure}')


def test_conflict_maps_to_409(client, demo_project):
    c, pid, _ = client
    bid = bid_by_prefix(c, pid, 'Chapter two arrives', file='chapters/ch2.tex')
    p = demo_project / 'chapters' / 'ch2.tex'
    text = p.read_bytes().decode('utf-8')
    p.write_bytes(text.replace('Chapter two arrives via',
                               'Externally replaced,').encode('utf-8'))
    r = c.post(f'/api/project/{pid}/block/{bid}/save',
               json={'source': 'too late'})
    assert r.status_code == 409


def test_unknown_block_maps_to_404(client):
    c, pid, _ = client
    r = c.post(f'/api/project/{pid}/block/zzz/save',
               json={'source': 'x'})
    assert r.status_code == 404


def test_bad_move_direction_maps_to_400(client):
    c, pid, _ = client
    bid = bid_by_prefix(c, pid, 'Chapter two arrives', file='chapters/ch2.tex')
    r = c.post(f'/api/project/{pid}/block/{bid}/move',
               json={'direction': 'sideways'})
    assert r.status_code == 400


def test_locked_file_maps_to_503(client, monkeypatch):
    # a .tex locked by another program (Errno 13 — seen on Windows while
    # a PDF export/antivirus holds project files) is a transient server
    # condition, not a document conflict: the client must get 503 with a
    # full-sentence hint it can show, never a 500 traceback
    def denied(*args, **kwargs):
        raise PermissionError(13, 'Permission denied')
    monkeypatch.setattr(FileStore, 'write', denied)
    c, pid, _ = client
    tab = bid_by_prefix(c, pid, '\\begin{tabular}{ll}',
                        file='chapters/ch2.tex')
    r = c.post(f'/api/project/{pid}/block/{tab}/move',
               json={'direction': 'down', 'positions': 1})
    assert r.status_code == 503
    assert 'locked' in r.json()['detail']


# -- sections ------------------------------------------------------------------

def test_section_get_and_save(client):
    c, pid, demo = client
    bid = bid_by_prefix(c, pid, 'A plain tabular block',
                        file='chapters/ch2.tex')
    r = c.get(f'/api/project/{pid}/block/{bid}/section')
    assert r.status_code == 200
    span = r.json()
    assert span['title'] == 'Tables'
    assert span['source'].startswith('\\subsection{Tables}')

    r = c.post(f'/api/project/{pid}/block/{bid}/section/save',
               json={'source': '\\subsection{Tables}\n\nRewritten via API.\n'})
    assert r.status_code == 200
    assert b'Rewritten via API.' in (demo / 'chapters' / 'ch2.tex').read_bytes()


def test_section_outside_is_404(client):
    c, pid, _ = client
    bid = bid_by_prefix(c, pid, '\\maketitle', file='main.tex')
    assert c.get(f'/api/project/{pid}/block/{bid}/section').status_code == 404


# -- raw files ---------------------------------------------------------------------

def test_raw_file_get_put(client):
    c, pid, demo = client
    r = c.get(f'/api/project/{pid}/file',
              params={'path': 'chapters/ch2.tex'})
    assert r.status_code == 200
    body = r.json()
    assert body['path'] == 'chapters/ch2.tex'
    assert 'Chapter two arrives' in body['source']

    r = c.put(f'/api/project/{pid}/file',
              json={'path': 'chapters/ch2.tex',
                    'source': body['source'].replace(
                        'tables and figures', 'tables and figures, raw')})
    assert r.status_code == 200
    assert b'tables and figures, raw' in \
        (demo / 'chapters' / 'ch2.tex').read_bytes()


def test_raw_file_errors(client, demo_project):
    c, pid, _ = client
    assert c.get(f'/api/project/{pid}/file',
                 params={'path': '../outside.tex'}).status_code == 400
    assert c.get(f'/api/project/{pid}/file',
                 params={'path': 'missing.tex'}).status_code == 404
    (demo_project / 'notes.txt').write_text('x', encoding='utf-8')
    assert c.put(f'/api/project/{pid}/file',
                 json={'path': 'notes.txt', 'source': 'y'}).status_code == 400


# -- history / undo / redo --------------------------------------------------------

def test_undo_redo_over_http(client, demo_project):
    c, pid, _ = client
    rel = demo_project / 'chapters' / 'ch2.tex'
    original = rel.read_bytes()
    bid = bid_by_prefix(c, pid, 'Chapter two arrives', file='chapters/ch2.tex')
    c.post(f'/api/project/{pid}/block/{bid}/save',
           json={'source': 'Edited once.'})

    h = c.get(f'/api/project/{pid}/history').json()
    assert h['can_undo'] is True and h['undo_label'] == 'edit block'
    assert h['can_redo'] is False

    r = c.post(f'/api/project/{pid}/undo').json()
    assert r['ok'] is True and r['label'] == 'edit block'
    assert rel.read_bytes() == original

    r = c.post(f'/api/project/{pid}/redo').json()
    assert r['ok'] is True
    assert b'Edited once.' in rel.read_bytes()

    r = c.post(f'/api/project/{pid}/redo').json()   # nothing left
    assert r == {'ok': False, 'noop': True, 'can_undo': True,
                 'can_redo': False, 'undo_label': 'edit block',
                 'redo_label': ''}


# -- git routes ---------------------------------------------------------------------

def test_git_status_init_and_changes(client, demo_project):
    c, pid, _ = client
    assert c.get(f'/api/project/{pid}/git/status').json() == {'repo': False}
    assert c.post(f'/api/project/{pid}/git/init').json()['ok'] is True
    st = c.get(f'/api/project/{pid}/git/status').json()
    assert st['repo'] is True and st['branch']

    bid = bid_by_prefix(c, pid, 'Chapter two arrives', file='chapters/ch2.tex')
    c.post(f'/api/project/{pid}/block/{bid}/save',
           json={'source': 'Edited for git routes.'})
    r = c.get(f'/api/project/{pid}/git/changes').json()
    assert r['count'] >= 1


def test_git_block_stage_contract_and_discard(client, demo_project):
    # pins the quirky contract (TESTING.md register #5): the block id
    # travels in GitCommitBody.message
    c, pid, _ = client
    git(demo_project, '-c', 'init.defaultBranch=main', 'init')
    git(demo_project, 'config', 'user.email', 'test@example.com')
    git(demo_project, 'config', 'user.name', 'Test Suite')
    git(demo_project, 'config', 'core.autocrlf', 'false')
    git(demo_project, 'add', '-A')
    git(demo_project, 'commit', '-m', 'initial')
    original = (demo_project / 'chapters' / 'ch2.tex').read_bytes()

    bid = bid_by_prefix(c, pid, 'Chapter two arrives', file='chapters/ch2.tex')
    c.post(f'/api/project/{pid}/block/{bid}/save',
           json={'source': 'Edited for block staging.'})

    r = c.post(f'/api/project/{pid}/git/stage-block',
               json={'message': bid})
    assert r.status_code == 200 and r.json()['staged'] is True
    staged = git(demo_project, 'diff', '--cached', '--', 'chapters/ch2.tex')
    assert 'Edited for block staging.' in staged

    r = c.post(f'/api/project/{pid}/git/discard-block',
               json={'message': bid})
    assert r.status_code == 200 and r.json()['ok'] is True
    assert 'doc' in r.json()
    assert (demo_project / 'chapters' / 'ch2.tex').read_bytes() == original


def test_git_blockdiffs_includes_staged_flags(client, demo_project):
    c, pid, _ = client
    git(demo_project, '-c', 'init.defaultBranch=main', 'init')
    git(demo_project, 'config', 'user.email', 'test@example.com')
    git(demo_project, 'config', 'user.name', 'Test Suite')
    git(demo_project, 'config', 'core.autocrlf', 'false')
    git(demo_project, 'add', '-A')
    git(demo_project, 'commit', '-m', 'initial')

    bid = bid_by_prefix(c, pid, 'Chapter two arrives', file='chapters/ch2.tex')
    c.post(f'/api/project/{pid}/block/{bid}/save',
           json={'source': 'Edited for blockdiffs.'})
    r = c.get(f'/api/project/{pid}/git/blockdiffs').json()
    assert r['diffs'] and r['ghosts'] == []
    edited = bid_by_prefix(c, pid, 'Edited for blockdiffs.')
    assert edited in r['diffs']
    assert edited in r['staged'] and r['staged'][edited] is False


def test_git_commit_message_validation(client, demo_project):
    c, pid, _ = client
    git(demo_project, '-c', 'init.defaultBranch=main', 'init')
    git(demo_project, 'config', 'user.email', 'test@example.com')
    git(demo_project, 'config', 'user.name', 'Test Suite')
    git(demo_project, 'add', '-A')
    git(demo_project, 'commit', '-m', 'initial')
    r = c.post(f'/api/project/{pid}/git/commit', json={'message': '   '})
    assert r.status_code == 400
    (demo_project / 'new.txt').write_text('x\n', encoding='utf-8')
    r = c.post(f'/api/project/{pid}/git/commit',
               json={'message': 'add file', 'paths': ['new.txt']})
    assert r.status_code == 200 and 'add file' in r.json()['summary']


# -- proofreading (offline spellcheck engine) --------------------------------------

def test_proof_config_check_dictionary_ignore(client):
    c, pid, _ = client
    cfg = c.get(f'/api/project/{pid}/proof/config').json()
    assert cfg['engine'] == 'spellcheck'
    assert cfg['available'] is True
    assert 'lt' not in cfg  # the install-state payload is LT-only

    bid = bid_by_prefix(c, pid, 'Chapter two arrives', file='chapters/ch2.tex')
    c.post(f'/api/project/{pid}/block/{bid}/save',
           json={'source': 'This sentence contains a mispelled word.'})
    r = c.post(f'/api/project/{pid}/proof/check', json={'lang': 'en-US'})
    assert r.status_code == 200
    assert r.json()['count'] >= 1
    assert 'mispelled' in json.dumps(r.json()['issues'])

    r = c.post(f'/api/project/{pid}/proof/dictionary',
               json={'word': 'mispelled'})
    assert r.status_code == 200 and 'mispelled' in r.json()['words']

    r = c.post(f'/api/project/{pid}/proof/ignore',
               json={'rule': 'MISSPELLING', 'text': 'mispelled'})
    assert r.status_code == 200 and r.json() == {'ok': True}


def test_proof_languagetool_gate_never_downloads(client, monkeypatch):
    """The LanguageTool engine reports its install state and REFUSES to
    check while the jar is missing — a check must never trigger the
    ~200 MB download implicitly."""
    from texperiment import proof as proof_mod

    c, pid, _ = client
    # switch the app to the LanguageTool engine (the runtime-switch route)
    r = c.post(f'/api/project/{pid}/proof/engine', json={'engine': 'languagetool'})
    assert r.status_code == 200
    cfg = r.json()
    assert cfg['engine'] == 'languagetool'
    assert 'lt' in cfg and cfg['lt']['state'] in (
        'ready', 'needs-download', 'no-java')

    # force the "java present, jar missing" state and forbid downloads
    monkeypatch.setattr(proof_mod.LanguageToolEngine, '_java_present',
                        staticmethod(lambda: True))
    monkeypatch.setattr(proof_mod.LanguageToolEngine, '_jar_present',
                        staticmethod(lambda: False))

    class _ForbidLT:
        def __getattr__(self, name):  # any use = implicit download attempt
            raise AssertionError('LanguageTool was constructed implicitly!')
    monkeypatch.setitem(sys.modules, 'language_tool_python', _ForbidLT())
    # the check cache is module-level and keyed (block, source, lang) —
    # an earlier test's spellcheck results must not shadow the gate
    monkeypatch.setattr(proof_mod, '_cache', {})

    bid = bid_by_prefix(c, pid, 'Chapter two arrives', file='chapters/ch2.tex')
    c.post(f'/api/project/{pid}/block/{bid}/save',
           json={'source': 'This sentence contains a mispelled word.'})
    r = c.post(f'/api/project/{pid}/proof/check', json={'lang': 'en-US'})
    assert r.status_code == 400
    assert 'download' in r.json()['detail'].lower()
    # the config payload reports the decision the UI needs
    cfg = c.get(f'/api/project/{pid}/proof/config').json()
    assert cfg['lt']['state'] == 'needs-download'
    assert cfg['lt']['java'] is True and cfg['lt']['jar'] is False

    # switching back to spellcheck restores working checks (and persists)
    r = c.post(f'/api/project/{pid}/proof/engine', json={'engine': 'spellcheck'})
    assert r.status_code == 200 and r.json()['engine'] == 'spellcheck'
    r = c.post(f'/api/project/{pid}/proof/check', json={'lang': 'en-US'})
    assert r.status_code == 200 and r.json()['count'] >= 1
    from texperiment.server import load_settings
    assert load_settings().get('proof_engine') == 'spellcheck'

    r = c.post(f'/api/project/{pid}/proof/engine',
               json={'engine': 'nope'})
    assert r.status_code == 400


# -- bibliography ---------------------------------------------------------------------

@pytest.fixture
def bib_project(tmp_path):
    proj = tmp_path / 'bibdemo'
    proj.mkdir()
    (proj / 'main.tex').write_text(
        '\\documentclass{article}\n\\begin{document}\n'
        'See \\cite{euler1748} and maybe \\cite{knuth1984}.\n'
        '\\bibliographystyle{plainnat}\n\\bibliography{refs}\n'
        '\\end{document}\n', encoding='utf-8')
    (proj / 'refs.bib').write_text(
        '@article{euler1748,\n  author = {Euler, Leonhard},\n'
        '  title = {Introductio},\n  year = 1748,\n}\n'
        '@book{knuth1984,\n  author = {Knuth, Donald},\n'
        '  title = {The TeXbook},\n  year = 1984,\n}\n', encoding='utf-8')
    (proj / 'main.bbl').write_text(
        '\\begin{thebibliography}{1}\n\n'
        '\\bibitem[Euler(1748)]{euler1748}\n'
        'L.~Euler.\n\\newblock Introductio.\n'
        '\\newblock \\url{https://example.org/euler}\n\n'
        '\\end{thebibliography}\n', encoding='utf-8')
    return proj


def test_bibliography_prefers_bbl(bib_project):
    app = create_app([str(bib_project / 'main.tex')], port=9999,
                     proof_engine='spellcheck')
    c = TestClient(app)
    pid = c.get('/api/projects').json()[0]['id']
    r = c.get(f'/api/project/{pid}/bibliography').json()
    assert r['available'] is True
    assert r['source'] == 'bbl'
    assert r['style'] == 'authoryear'
    by_key = {e['key']: e for e in r['entries']}
    assert by_key['euler1748']['num'] == 1
    assert by_key['euler1748']['authors'] == 'Euler'
    assert by_key['euler1748']['year'] == '1748'
    assert by_key['euler1748']['url'] == 'https://example.org/euler'
    # uncited .bib keys ride along for autocomplete, without a number
    assert 'num' not in by_key['knuth1984']


def test_bibliography_falls_back_to_bib(bib_project):
    (bib_project / 'main.bbl').unlink()
    app = create_app([str(bib_project / 'main.tex')], port=9999,
                     proof_engine='spellcheck')
    c = TestClient(app)
    pid = c.get('/api/projects').json()[0]['id']
    r = c.get(f'/api/project/{pid}/bibliography').json()
    assert r['source'] == 'bib'
    assert {e['key'] for e in r['entries']} == {'euler1748', 'knuth1984'}


# -- graphics ---------------------------------------------------------------------------

def test_graphics_listing_and_resolution(client):
    c, pid, _ = client
    r = c.get(f'/api/project/{pid}/graphics').json()
    assert 'figures/plot.png' in r['files']

    r = c.get(f'/api/project/{pid}/graphic',
              params={'path': 'figures/plot.png'}).json()
    assert r == {'path': 'figures/plot.png'}
    # extension probing like LaTeX
    r = c.get(f'/api/project/{pid}/graphic',
              params={'path': 'figures/plot'}).json()
    assert r == {'path': 'figures/plot.png'}
    assert c.get(f'/api/project/{pid}/graphic',
                 params={'path': '../../etc/passwd'}).status_code == 404
    assert c.get(f'/api/project/{pid}/graphic',
                 params={'path': 'figures/nothere'}).status_code == 404


def test_file_serving_with_etag(client):
    c, pid, _ = client
    url = f'/files/{pid}/figures/plot.png'
    r1 = c.get(url)
    assert r1.status_code == 200
    etag = r1.headers['etag']
    r2 = c.get(url, headers={'if-none-match': etag})
    assert r2.status_code == 304
    r3 = c.get(url, headers={'if-none-match': '"stale"'})
    assert r3.status_code == 200


# -- compilation -----------------------------------------------------------------------

def test_compile_without_tex_toolchain_is_400(client, monkeypatch):
    c, pid, _ = client
    # nothing on PATH, no typical install dirs, no bundled tectonic
    monkeypatch.setattr('texperiment.server.shutil.which', lambda name: None)
    monkeypatch.setattr('texperiment.server._tex_dirs', lambda: [])
    monkeypatch.setattr('texperiment.server._bundled_tectonic', lambda: None)
    r = c.post(f'/api/project/{pid}/compile')
    assert r.status_code == 400
    assert 'TeX' in r.json()['detail']
    assert c.get(f'/api/project/{pid}/pdf').status_code == 404


def test_compile_tectonic_fallback(client, monkeypatch, tmp_path):
    """No latexmk/pdflatex on PATH, but a bundled tectonic: the compile
    route must run it and serve the PDF it produces (a stub stands in for
    the real binary — its bundle download needs the internet)."""
    import os

    c, pid, root = client
    if os.name == 'nt':
        stub = tmp_path / 'fake_tectonic.bat'
        # %% escapes to a literal % in a batch file; redirection comes
        # first so the trailing "4" cannot parse as a handle redirect
        stub.write_text('@echo off\r\n'
                        '> "%~d1%~p1%~n1.pdf" echo %%PDF-1.4\r\n'
                        '>> "%~d1%~p1%~n1.pdf" echo %%EOF\r\n',
                        encoding='ascii')
        tect = str(stub)
    else:
        stub = tmp_path / 'fake_tectonic'
        stub.write_text(
            '#!/bin/sh\nout=$(dirname "$1")/$(basename "$1" .tex).pdf\n'
            'printf "%%PDF-1.4\\n%%%%EOF\\n" > "$out"\n', encoding='utf-8')
        stub.chmod(0o755)
        tect = str(stub)
    monkeypatch.setattr('texperiment.server.shutil.which', lambda name: None)
    monkeypatch.setattr('texperiment.server._tex_dirs', lambda: [])
    monkeypatch.setattr('texperiment.server._bundled_tectonic',
                        lambda: tect)
    r = c.post(f'/api/project/{pid}/compile')
    assert r.status_code == 200, r.text
    assert r.json()['ok'] is True
    r = c.get(f'/api/project/{pid}/pdf')
    assert r.status_code == 200
    assert r.content[:5] == b'%PDF-'


@pytest.mark.skipif(not shutil.which('latexmk'),
                    reason='latexmk not installed')
def test_compile_with_real_latexmk(client):
    c, pid, _ = client
    r = c.post(f'/api/project/{pid}/compile')
    assert r.status_code == 200, r.text
    body = r.json()
    assert body['ok'] is True and body['pdf'].endswith('/pdf')
    r = c.get(f'/api/project/{pid}/pdf')
    assert r.status_code == 200
    assert r.headers['content-type'].startswith('application/pdf')
    assert r.content[:5] == b'%PDF-'


# -- static frontend ---------------------------------------------------------------------

def test_static_frontend_served(client):
    c = client[0]
    r = c.get('/')
    assert r.status_code == 200
    assert 'TeXperiment' in r.text
    r = c.get('/app.js')
    assert r.status_code == 200
    assert r.headers['cache-control'] == 'no-cache'


# -- websocket + watcher -------------------------------------------------------------------

def ws_messages(ws, timeout=5.0):
    q = queue.Queue()
    def reader():
        while True:
            try:
                q.put(ws.receive_json())
            except Exception:
                return
    t = threading.Thread(target=reader, daemon=True)
    t.start()
    out = []
    try:
        while True:
            out.append(q.get(timeout=timeout))
    except queue.Empty:
        return out


def test_ws_receives_undo_reload_broadcast(demo_project):
    app = create_app([str(demo_project / 'main.tex')], port=9999,
                     proof_engine='spellcheck')
    with TestClient(app) as c:   # startup: event loop + watchers
        pid = c.get('/api/projects').json()[0]['id']
        bid = next(b['id'] for b in c.get(f'/api/project/{pid}/doc')
                   .json()['blocks']
                   if b['source'].lstrip().startswith('Chapter two arrives'))
        c.post(f'/api/project/{pid}/block/{bid}/save',
               json={'source': 'Edited before ws test.'})
        with c.websocket_connect('/ws') as ws:
            c.post(f'/api/project/{pid}/undo')
            msgs = ws_messages(ws)
        assert any(m.get('type') == 'reload' and m.get('project') == pid
                   and m.get('self') is True and 'doc' in m for m in msgs)


def test_watcher_rebuilds_doc_on_external_change(demo_project):
    app = create_app([str(demo_project / 'main.tex')], port=9999,
                     proof_engine='spellcheck')
    marker = b'External watcher marker paragraph.'
    with TestClient(app) as c:
        pid = c.get('/api/projects').json()[0]['id']
        ch1 = demo_project / 'chapters' / 'ch1.tex'
        with open(ch1, 'ab') as f:
            f.write(b'\r\n' + marker + b'\r\n')
        deadline = time.time() + 10
        found = False
        while time.time() < deadline:
            sources = [b['source'] for b in
                       c.get(f'/api/project/{pid}/doc').json()['blocks']]
            if any('External watcher marker' in s for s in sources):
                found = True
                break
            time.sleep(0.2)
        assert found, 'watcher did not rebuild the doc within 10 s'
