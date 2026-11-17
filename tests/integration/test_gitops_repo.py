"""M2 — gitops against real git repositories (texperiment/gitops.py).

Every test builds a throwaway repo in tmp_path (local identity, autocrlf
disabled so blobs equal worktree bytes on every machine and platform).
`stage_block`-family tests assert the central safety property: staging
writes blobs via hash-object + update-index and must NEVER touch the
worktree.
"""
import subprocess

import pytest
from helpers import find_block

from texperiment import gitops
from texperiment.gitops import GitError
from texperiment.server import Store


def git(root, *args):
    p = subprocess.run(['git', *args], cwd=str(root), capture_output=True,
                       text=True, encoding='utf-8', errors='replace')
    assert p.returncode == 0, f'git {args}: {p.stderr}'
    return p.stdout


@pytest.fixture
def git_repo(demo_project):
    git(demo_project, '-c', 'init.defaultBranch=main', 'init')
    git(demo_project, 'config', 'user.email', 'test@example.com')
    git(demo_project, 'config', 'user.name', 'Test Suite')
    # blobs must equal worktree bytes: no clean/smudge surprises for
    # update-index, identical behavior on LF and CRLF checkouts
    git(demo_project, 'config', 'core.autocrlf', 'false')
    git(demo_project, 'add', '-A')
    git(demo_project, 'commit', '-m', 'initial')
    return demo_project


@pytest.fixture
def store(git_repo):
    return Store(git_repo / 'main.tex')


def worktree_text(store, rel):
    return (store.root / rel).read_text(encoding='utf-8')


def changed_lines(diff_text):
    """Concatenated +/- line contents of a unified diff (context lines
    excluded — a nearby change shows up as context otherwise)."""
    out = []
    for line in diff_text.splitlines():
        if line.startswith(('+', '-')) and not line.startswith(('+++', '---')):
            out.append(line[1:].rstrip('\r'))
    return ''.join(out)


def worktree_bytes(store, rel):
    return (store.root / rel).read_bytes()


# -- find_repo ------------------------------------------------------------------

def test_find_repo_inside_project(git_repo):
    top, prefix = gitops.find_repo(git_repo)
    assert top is not None and top.strip()
    assert prefix == ''   # project root IS the repo root here


def test_find_repo_project_in_subdirectory(demo_project, tmp_path):
    repo = tmp_path / 'repo'
    proj = repo / 'proj'
    proj.mkdir(parents=True)
    (proj / 'main.tex').write_text('x\n', encoding='utf-8')
    git(repo, '-c', 'init.defaultBranch=main', 'init')
    top, prefix = gitops.find_repo(proj)
    assert top is not None
    assert prefix == 'proj/'


def test_find_repo_outside_any_repo(tmp_path):
    assert gitops.find_repo(tmp_path) == (None, None)


# -- status ----------------------------------------------------------------------

def test_status_clean_tree(store):
    res = gitops.status(store.root)
    assert res['branch'] == 'main'
    assert res['ahead'] == 0 and res['behind'] == 0
    assert res['staged'] == res['unstaged'] == res['untracked'] == []
    assert res['has_remote'] is False


def test_status_classifies_changes(store):
    rel = 'chapters/ch2.tex'
    text = worktree_text(store, rel)
    (store.root / rel).write_text(text.replace('tables and figures',
                                               'tables plus figures'),
                                  encoding='utf-8')
    (store.root / 'untracked_new.tex').write_text('x\n', encoding='utf-8')
    res = gitops.status(store.root)
    assert res['unstaged'] == [rel]
    assert res['untracked'] == ['untracked_new.tex']
    gitops.stage(store.root, [rel])
    res = gitops.status(store.root)
    assert res['staged'] == [rel]
    assert res['unstaged'] == []


def test_status_excludes_bak_files(store):
    (store.root / 'chapters/ch2.tex.bak').write_text('x\n', encoding='utf-8')
    res = gitops.status(store.root)
    assert 'chapters/ch2.tex.bak' not in res['untracked']


def test_status_ahead_behind_and_remote(store, tmp_path):
    bare = tmp_path / 'remote.git'
    git(tmp_path, 'init', '--bare', str(bare))
    git(store.root, 'remote', 'add', 'origin', str(bare))
    git(store.root, 'push', '-u', 'origin', 'main')
    res = gitops.status(store.root)
    assert res['has_remote'] is True and res['ahead'] == 0

    (store.root / 'untracked_pushed.txt').write_text('x\n', encoding='utf-8')
    gitops.commit(store.root, 'second', ['untracked_pushed.txt'])
    res = gitops.status(store.root)
    assert res['ahead'] == 1 and res['behind'] == 0

    other = tmp_path / 'other'
    # -b main: the bare repo's HEAD symref still points at its init
    # default branch, which was never pushed — clone that and the
    # worktree checks out empty
    git(tmp_path, 'clone', '--branch', 'main', str(bare), str(other))
    git(other, 'config', 'user.email', 'test@example.com')
    git(other, 'config', 'user.name', 'Test Suite')
    (other / 'chapters/ch1.tex').write_text('remote edit\n', encoding='utf-8')
    git(other, 'add', '-A')
    git(other, 'commit', '-m', 'remote side')
    git(other, 'push')
    # ahead/behind come from the origin/main tracking ref — it only
    # moves when the local repo fetches
    git(store.root, 'fetch', 'origin')
    res = gitops.status(store.root)
    assert res['ahead'] == 1 and res['behind'] == 1


def test_status_scoped_to_project_subtree(tmp_path):
    repo = tmp_path / 'repo'
    for name in ('projA', 'projB'):
        proj = repo / name
        (proj / 'chapters').mkdir(parents=True)
        (proj / 'main.tex').write_text(
            f'\\section{{{name}}}\n\\input{{chapters/c}}\n', encoding='utf-8')
        (proj / 'chapters' / 'c.tex').write_text(f'{name} body\n',
                                                 encoding='utf-8')
    git(repo, '-c', 'init.defaultBranch=main', 'init')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test Suite')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'initial')
    # modify both projects; projB's status must see only its own file,
    # with the repo prefix stripped from the path
    (repo / 'projA' / 'chapters' / 'c.tex').write_text('A edited\n',
                                                       encoding='utf-8')
    (repo / 'projB' / 'chapters' / 'c.tex').write_text('B edited\n',
                                                       encoding='utf-8')
    res = gitops.status(repo / 'projB')
    assert res['unstaged'] == ['chapters/c.tex']
    assert all(not p.startswith('projA') for p in
               res['staged'] + res['unstaged'] + res['untracked'])


# -- diff -------------------------------------------------------------------------

def test_diff_modified_file(store):
    rel = 'chapters/ch2.tex'
    text = worktree_text(store, rel)
    (store.root / rel).write_text(text.replace('tables and figures',
                                               'tables plus figures'),
                                  encoding='utf-8')
    out = gitops.diff(store.root, rel)
    assert 'tables plus figures' in out and 'tables and figures' in out


def test_diff_untracked_file_against_empty(store):
    (store.root / 'brand_new.tex').write_text('fresh content\n',
                                              encoding='utf-8')
    out = gitops.diff(store.root, 'brand_new.tex')
    assert 'fresh content' in out


def test_diff_staged(store):
    rel = 'chapters/ch1.tex'
    text = worktree_text(store, rel)
    (store.root / rel).write_text(text.replace('chapter one', 'chapter 1'),
                                  encoding='utf-8')
    gitops.stage(store.root, [rel])
    out = gitops.diff(store.root, rel, staged=True)
    assert 'chapter 1' in out


# -- changed_block_ids ----------------------------------------------------------

def test_changed_block_ids_clean_crlf_tree_is_empty(store):
    # the _norm_src shadowing bug flagged 23 of 33 blocks here; with the
    # duplicate definition removed a clean tree must be clean — even with
    # CRLF worktree files against whatever line endings the blobs have
    assert gitops.changed_block_ids(store) == []


def test_changed_block_ids_single_edit(store):
    b = find_block(store, 'Chapter two arrives', file='chapters/ch2.tex')
    store.op_save(b['id'], 'Chapter two, rewritten once.')
    changed = gitops.changed_block_ids(store)
    assert len(changed) == 1
    edited = find_block(store, 'Chapter two, rewritten once.')
    assert changed == [edited['id']]


def test_changed_block_ids_insert(store):
    b = find_block(store, 'Chapter two arrives', file='chapters/ch2.tex')
    new_id = store.op_insert(b['id'], 'A fresh paragraph appeared.')
    assert new_id
    assert gitops.changed_block_ids(store) == [new_id]


def test_changed_block_ids_pure_deletion_reports_nothing(store):
    # deletion has no current block to flag — the ghost machinery in
    # block_diffs is what surfaces removals; pinned as current behavior
    b = find_block(store, 'A plain tabular block', file='chapters/ch2.tex')
    store.op_delete(b['id'])
    assert gitops.changed_block_ids(store) == []


def test_changed_block_ids_without_repo(demo_project):
    store = Store(demo_project / 'main.tex')
    assert gitops.changed_block_ids(store) == []


def test_changed_block_ids_repo_without_commits(demo_project):
    git(demo_project, '-c', 'init.defaultBranch=main', 'init')
    store = Store(demo_project / 'main.tex')
    assert set(gitops.changed_block_ids(store)) == \
        {b['id'] for b in store.doc['blocks']}


# -- block_diffs --------------------------------------------------------------------

def test_block_diffs_modified_offsets_index_current_source(store):
    b = find_block(store, 'Chapter two arrives', file='chapters/ch2.tex')
    store.op_save(b['id'],
                  'Chapter two arrives via include and lives in chapters/'
                  'ch2.tex. It exercises tables and figures, loudly.')
    res = gitops.block_diffs(store)
    edited = find_block(store, 'Chapter two arrives via include')
    assert edited['id'] in res['diffs']
    d = res['diffs'][edited['id']]
    assert d['kind'] == 'modified'
    assert d['dels'] and d['dels'][0]['text'].strip()
    # the add range must slice real words out of the current source
    added_words = ''.join(edited['source'][a['s']:a['e']]
                          for a in d['adds'])
    assert 'loudly' in added_words
    assert res['ghosts'] == []


def test_block_diffs_insert_after_replace_no_crash(store):
    # 84d56e0: block_diffs used to crash on a replaced block followed by
    # an inserted one
    b = find_block(store, 'Chapter two arrives', file='chapters/ch2.tex')
    store.op_save(b['id'], 'Chapter two, fully rewritten text.')
    store.op_insert(b['id'], 'Inserted right after the rewrite.')
    res = gitops.block_diffs(store)
    rewritten = find_block(store, 'Chapter two, fully rewritten text.')
    inserted = find_block(store, 'Inserted right after the rewrite.')
    assert res['diffs'][rewritten['id']]['kind'] == 'modified'
    assert res['diffs'][inserted['id']]['kind'] == 'new'
    assert res['ghosts'] == []


def test_block_diffs_ghost_for_middle_deletion(store):
    b = find_block(store, 'A plain tabular block', file='chapters/ch2.tex')
    store.op_delete(b['id'])
    res = gitops.block_diffs(store)
    assert len(res['ghosts']) == 1
    g = res['ghosts'][0]
    assert g['file'] == 'chapters/ch2.tex'
    assert 'plain tabular block' in g['text']
    assert g['before_id'] is not None   # a current block sits there now


def test_block_diffs_ghost_for_end_deletion_has_no_anchor(store):
    # bc5b5af flavor: deleting the very last block of a file
    b = find_block(store, '\\begin{mycustomenv}',
                   file='chapters/ch2.tex', type='env')
    store.op_delete(b['id'])
    res = gitops.block_diffs(store)
    assert len(res['ghosts']) == 1
    assert res['ghosts'][0]['before_id'] is None


def test_block_diffs_formatting_only_change_is_green_only(store):
    b = find_block(store, 'The editor understands sectioning',
                   file='main.tex')
    new_src = b['source'].replace('display formulas',
                                  '\\textbf{display formulas}')
    store.op_save(b['id'], new_src)
    res = gitops.block_diffs(store)
    d = res['diffs'][b['id']]
    assert d['kind'] == 'modified'
    assert d['adds']            # the bold text shows green
    assert d['dels'] == []      # ...and no red placeholder


def test_block_diffs_crlf_word_offsets(store):
    # 2e1d390 flavor: on this CRLF worktree the add ranges must index
    # into the raw current source (counting \r as a character)
    rel = 'chapters/ch2.tex'
    # the CI runner checks out LF (no autocrlf there) — create the CRLF
    # condition explicitly so the test is platform-independent. Blob and
    # worktree both become CRLF: same scenario as a Windows checkout.
    # (A Windows checkout is already CRLF — nothing to rewrite there.)
    p = store.root / rel
    before = p.read_bytes()
    after = before.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
    if after != before:
        p.write_bytes(after)
        store.rebuild()  # block spans/sources must match the new bytes
        git(store.root, 'add', '-A')
        git(store.root, 'commit', '-m', 'crlf worktree')
    assert b'\r\n' in worktree_bytes(store, rel)  # precondition (raw bytes)
    b = find_block(store, 'Chapter two arrives', file=rel)
    store.op_save(b['id'], b['source'].replace(
        'tables and figures', 'tables and large figures'))
    res = gitops.block_diffs(store)
    cur = find_block(store, 'Chapter two arrives', file=rel)  # re-find!
    d = res['diffs'][cur['id']]
    added = ''.join(cur['source'][a['s']:a['e']] for a in d['adds'])
    assert 'large' in added


def test_block_diffs_without_repo(demo_project):
    store = Store(demo_project / 'main.tex')
    assert gitops.block_diffs(store) == {'diffs': {}, 'ghosts': []}


# -- block-granular staging --------------------------------------------------------

def test_stage_block_leaves_worktree_untouched(store):
    rel = 'chapters/ch2.tex'
    a = find_block(store, 'Chapter two arrives', file=rel)
    store.op_save(a['id'], 'Chapter two, first edit.')
    b = find_block(store, 'A plain tabular block', file=rel)
    store.op_save(b['id'], 'A plain tabular block, second edit.')
    a2 = find_block(store, 'Chapter two, first edit.')

    before = worktree_bytes(store, rel)
    assert gitops.stage_block(store, a2['id']) is True
    assert worktree_bytes(store, rel) == before   # worktree untouched

    staged = changed_lines(git(store.root, 'diff', '--cached', '--', rel))
    unstaged = changed_lines(git(store.root, 'diff', '--', rel))
    assert 'first edit' in staged
    assert 'second edit' not in staged
    assert 'second edit' in unstaged
    assert 'first edit' not in unstaged


def test_stage_block_of_unchanged_block_returns_false(store):
    b = find_block(store, 'Chapter two arrives', file='chapters/ch2.tex')
    assert gitops.stage_block(store, b['id']) is False


def test_stage_block_new_block(store):
    rel = 'chapters/ch2.tex'
    b = find_block(store, 'Chapter two arrives', file=rel)
    new_id = store.op_insert(b['id'], 'A brand new staged paragraph.')
    before = worktree_bytes(store, rel)
    assert gitops.stage_block(store, new_id) is True
    assert worktree_bytes(store, rel) == before
    staged = git(store.root, 'diff', '--cached', '--', rel)
    assert 'A brand new staged paragraph.' in staged


def test_unstage_block_reverts_index_only(store):
    rel = 'chapters/ch2.tex'
    b = find_block(store, 'Chapter two arrives', file=rel)
    store.op_save(b['id'], 'Chapter two, staged then unstaged.')
    b2 = find_block(store, 'Chapter two, staged then unstaged.')
    gitops.stage_block(store, b2['id'])
    assert gitops.unstage_block(store, b2['id']) is True

    assert git(store.root, 'diff', '--cached', '--', rel) == ''  # index=HEAD
    unstaged = git(store.root, 'diff', '--', rel)
    assert 'staged then unstaged' in unstaged    # worktree keeps the edit


def test_discard_block_reverts_everywhere(store):
    rel = 'chapters/ch2.tex'
    head_text = worktree_text(store, rel)
    b = find_block(store, 'Chapter two arrives', file=rel)
    store.op_save(b['id'], 'Chapter two, to be discarded.')
    b2 = find_block(store, 'Chapter two, to be discarded.')
    gitops.stage_block(store, b2['id'])

    out = gitops.discard_block(store, b2['id'])
    assert out is not None and out[0] == rel
    # the server writes the returned content — emulate it byte-exactly
    # (write_text would newline-translate and double the CRs on Windows)
    (store.root / rel).write_bytes(out[1].encode('utf-8'))
    assert worktree_text(store, rel) == head_text       # worktree back
    assert git(store.root, 'diff', '--cached', '--', rel) == ''  # index back
    assert git(store.root, 'diff', '--', rel) == ''


def test_stage_unstage_discard_unknown_block_raise(store):
    for fn in (gitops.stage_block, gitops.unstage_block,
               gitops.discard_block):
        with pytest.raises(ValueError):
            fn(store, 'no-such-block')


# -- commits and push ----------------------------------------------------------------

def test_commit_file_limited_to_one_path(store):
    ch1 = 'chapters/ch1.tex'
    ch2 = 'chapters/ch2.tex'
    (store.root / ch1).write_text(
        worktree_text(store, ch1).replace('chapter one', 'chapter uno'),
        encoding='utf-8')
    (store.root / ch2).write_text(
        worktree_text(store, ch2).replace('tables and figures',
                                          'tables and figs'),
        encoding='utf-8')
    gitops.stage(store.root, [ch1])   # ch1 change staged beforehand

    out = gitops.commit_file(store.root, ch2, 'only ch2')
    assert out.strip().endswith('only ch2')
    log = git(store.root, 'log', '-1', '--name-only', '--format=')
    assert log.split() == ['chapters/ch2.tex']   # commit contains only ch2
    res = gitops.status(store.root)
    assert res['staged'] == [ch1]   # ch1 staging survives, uncommitted


def test_commit_with_paths_stages_and_commits_them(store):
    rel = 'chapters/ch1.tex'
    (store.root / rel).write_text(
        worktree_text(store, rel).replace('chapter one', 'chapter eins'),
        encoding='utf-8')
    gitops.commit(store.root, 'path commit', [rel])
    res = gitops.status(store.root)
    assert res['staged'] == res['unstaged'] == []
    assert 'chapter eins' in git(store.root, 'show', 'HEAD:' + rel)


def test_push_to_bare_remote(store, tmp_path):
    bare = tmp_path / 'remote.git'
    git(tmp_path, 'init', '--bare', str(bare))
    git(store.root, 'remote', 'add', 'origin', str(bare))
    git(store.root, 'push', '-u', 'origin', 'main')
    (store.root / 'pushed_note.txt').write_text('x\n', encoding='utf-8')
    gitops.commit(store.root, 'to be pushed', ['pushed_note.txt'])
    gitops.push(store.root)
    local = git(store.root, 'rev-parse', 'HEAD').strip()
    remote = git(store.root, 'rev-parse', 'origin/main').strip()
    assert local == remote


def test_unstage_and_discard_helpers(store):
    rel = 'chapters/ch1.tex'
    (store.root / rel).write_text(
        worktree_text(store, rel).replace('chapter one', 'chapter edited'),
        encoding='utf-8')
    gitops.stage(store.root, [rel])
    gitops.unstage(store.root, [rel])
    assert gitops.status(store.root)['staged'] == []
    gitops.discard(store.root, [rel])
    assert gitops.status(store.root)['unstaged'] == []


# -- safety on foreign paths -------------------------------------------------------

def test_discard_foreign_path_raises_and_does_not_touch_it(tmp_path):
    repo = tmp_path / 'repo'
    for name in ('projA', 'projB'):
        proj = repo / name
        proj.mkdir(parents=True)
        (proj / 'main.tex').write_text(f'{name} original\n', encoding='utf-8')
    git(repo, '-c', 'init.defaultBranch=main', 'init')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test Suite')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'initial')
    (repo / 'projA' / 'main.tex').write_text('projA edited\n',
                                             encoding='utf-8')
    with pytest.raises(GitError):
        gitops.discard(repo / 'projB', ['projA/main.tex'])
    assert (repo / 'projA' / 'main.tex').read_text(
        encoding='utf-8') == 'projA edited\n'
