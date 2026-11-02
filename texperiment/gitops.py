"""Git integration via the git CLI (no third-party deps).

All commands run with cwd=<project root>, so paths given to git are
project-root-relative pathspecs and `HEAD:./<rel>` resolves relative to
the project inside the repo even when the repo toplevel is higher up.
"""
import difflib
import re
import subprocess
from pathlib import Path

from .parser import parse_file


class GitError(Exception):
    """A git command failed; message is user-presentable."""


def _run(root, *args, ok_codes=(0,), binary=False):
    """Run git in root; returns stdout (str with surrogates replaced, or bytes)."""
    cmd = ['git', '-c', 'core.quotepath=false', '-c', 'color.ui=false', *args]
    try:
        p = subprocess.run(cmd, cwd=str(root), capture_output=True, timeout=20)
    except FileNotFoundError:
        raise GitError('git is not installed or not on PATH')
    except subprocess.TimeoutExpired:
        raise GitError(f'git timed out: {args[0]}')
    if p.returncode not in ok_codes:
        err = p.stderr.decode('utf-8', errors='replace').strip()
        raise GitError(err or f'git {args[0]} failed (exit {p.returncode})')
    return p.stdout if binary else p.stdout.decode('utf-8', errors='replace')


def find_repo(root):
    """Return (repo_toplevel, prefix_of_root_in_repo) or (None, None)."""
    try:
        top = _run(root, 'rev-parse', '--show-toplevel').strip()
        prefix = _run(root, 'rev-parse', '--show-prefix').strip()
    except GitError:
        return None, None
    return top, prefix


def init(root):
    _run(root, 'init')
    return 'Initialized empty git repository'


def _norm(path):
    """Normalize a porcelain status path: unescape quotes, keep forward
    slashes, take the rename target when git reports 'old -> new'."""
    p = path.strip()
    if p.startswith('"') and p.endswith('"'):
        p = p[1:-1].encode('latin-1').decode('unicode_escape')
    if ' -> ' in p:
        p = p.split(' -> ', 1)[1]
    return p.replace('\\', '/')


def status(root):
    """Parse `git status --porcelain -b` into a UI-friendly payload.
    Scoped to the project's own subtree, with project-relative paths:
    a project inside a subdirectory of its repo never sees (or offers
    to modify) files outside its own folder."""
    _top, prefix = find_repo(root)
    out = _run(root, 'status', '--porcelain', '-b', '--untracked-files=normal')
    lines = out.splitlines()
    res = {'branch': None, 'ahead': 0, 'behind': 0, 'has_remote': False,
           'staged': [], 'unstaged': [], 'untracked': []}
    if not lines:
        return res
    head = lines[0]
    if head.startswith('##'):
        h = head[2:].strip()
        if h.startswith('No commits yet on '):
            res['branch'] = h[len('No commits yet on '):].strip()
        else:
            name, _, rest = h.partition('...')
            res['branch'] = name.strip()
            if rest:
                upstream = rest.split(' ', 1)[0].strip('[] ')
                if upstream and upstream != 'HEAD':
                    res['has_remote'] = True
                for part in rest.split('[')[-1].rstrip(']').split(','):
                    k, _, v = part.strip().partition(' ')
                    if k == 'ahead':
                        res['ahead'] = int(v or 0)
                    elif k == 'behind':
                        res['behind'] = int(v or 0)
    for line in lines[1:]:
        if len(line) < 4:
            continue
        x, y, path = line[0], line[1], _norm(line[3:])
        if prefix:
            if not path.startswith(prefix):
                continue  # another project's file inside this repo
            path = path[len(prefix):]
        if path.endswith('.bak'):
            continue  # our own session backups, not project content
        if x == '?' and y == '?':
            res['untracked'].append(path)
            continue
        if x not in (' ', '?'):
            res['staged'].append(path)
        if y not in (' ', '?'):
            res['unstaged'].append(path)
    # remotes exist but the branch may have no upstream yet
    if not res['has_remote'] and _run(root, 'remote').split():
        res['has_remote'] = True
    return res


def diff(root, path, staged=False):
    """Unified diff text for one project-relative path."""
    if staged:
        return _run(root, 'diff', '--cached', '--', path)
    # include the untracked case: compare against the empty blob
    out = _run(root, 'diff', '--', path, ok_codes=(0,))
    if out:
        return out
    if path in status(root)['untracked']:
        return _run(root, 'diff', '--no-index', '--', '/dev/null', path,
                    ok_codes=(0, 1))
    return ''


def _cwd_rel(root, paths):
    """Client paths are project-relative (as reported by status()); when
    the project sits in a repo subdirectory, older clients may still send
    repo-relative paths - map both onto cwd-relative pathspecs."""
    _top, prefix = find_repo(root)
    out = []
    for p2 in paths:
        out.append(p2[len(prefix):] if prefix and p2.startswith(prefix) else p2)
    return out


def stage(root, paths):
    if paths:
        _run(root, 'add', '--', *_cwd_rel(root, paths))


def unstage(root, paths):
    if paths:
        _run(root, 'reset', 'HEAD', '--', *_cwd_rel(root, paths))


def discard(root, paths):
    """Dangerous: reverts the given paths to their staged/HEAD content.
    Paths are repo-relative; when the project lives in a subdirectory of
    its repo, files outside the project subtree are skipped — a group
    discard from one project must never touch another project's files."""
    if not paths:
        return
    _top, prefix = find_repo(root)
    # pathspecs resolve against cwd (= the project root), so foreign
    # repo-relative paths simply fail loudly instead of touching files
    # outside the project; repo-relative paths of our own files are
    # converted down to the project root
    inside = [p2[len(prefix):] if prefix and p2.startswith(prefix) else p2
              for p2 in paths]
    if inside:
        _run(root, 'checkout', '--', *inside)


def commit(root, message, paths=None):
    if paths:
        _run(root, 'add', '--', *paths)
    _run(root, 'commit', '-m', message)
    out = _run(root, 'log', '-1', '--format=%h %s')
    return out.strip()


def diff_all(root, staged=False):
    """Combined diff of every changed file: working tree vs index
    (unstaged) or index vs HEAD (staged)."""
    return _run(root, 'diff', '--cached') if staged else _run(root, 'diff')


def push(root):
    _run(root, 'push')


def _head_text(root, rel, enc):
    """Content of a project-relative file at HEAD, or None if absent
    (untracked, uncommitted repo, or no repo). Decoded with the encoding
    the live file uses, so block sources compare equal."""
    try:
        data = _run(root, 'show', f'HEAD:./{rel}', binary=True)
    except GitError:
        return None
    if data.startswith(b'\xef\xbb\xbf'):
        data = data[3:]
    return data.decode(enc or 'utf-8', errors='replace')


def _norm_src(s):
    # CRLF files: block spans end in a lone \r (the \n separator sits outside
    # the span), which must not read as extra content vs the LF blob in HEAD
    return s.replace('\r\n', '\n').replace('\r', '\n').rstrip('\n')


def changed_block_ids(store):
    """Block ids of the current doc whose content differs from HEAD.

    Compares per-file multisets of parsed block sources (newline-normalized)
    between HEAD content and the live doc — the same idea as the client's
    diffKeys, but against the committed version.
    """
    top, _ = find_repo(store.root)
    if top is None:
        return []
    head_by_file = {}
    for entry in store.doc['files']:
        rel, enc = entry['path'], entry.get('encoding', 'utf-8')
        text = _head_text(store.root, rel, enc)
        if text is None:
            head_by_file[rel] = None
            continue
        srcs = {}
        for _typ, s, e, _meta in parse_file(text, is_main=(rel == store.doc['main'])):
            src = _norm_src(text[s:e])
            srcs[src] = srcs.get(src, 0) + 1
        head_by_file[rel] = srcs

    out = []
    for b in store.doc['blocks']:
        srcs = head_by_file.get(b['file'])
        if srcs is None:  # file not in HEAD at all → everything is new
            out.append(b['id'])
            continue
        k = _norm_src(b['source'])
        n = srcs.get(k, 0)
        if n > 0:
            srcs[k] = n - 1
        else:
            out.append(b['id'])
    return out

# ---------------------------------------------------------------- block diffs

MAX_OPS = 200  # beyond this a block falls back to "all new"


def _word_diff(old, new):
    r"""Phrase-level diff → (adds, dels) in *current source* coordinates.

    Word-level SequenceMatcher, but adjacent changes that are separated by
    nothing but whitespace are grouped into one region: the new phrasing
    becomes a single green range and the old phrasing a single red
    placeholder, instead of word-by-word interleaving.

    adds: [{s, e}] char ranges in `new`; dels: [{s, text}] insertion points
    in `new` + removed old text. Whitespace-only changes are skipped.
    """
    tok = re.compile(r'(\s+)')
    a = tok.split(old)
    b = tok.split(new)
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    offsets = []
    pos = 0
    for t in b:
        offsets.append(pos)
        pos += len(t)
    offsets.append(pos)

    # collect change regions: consecutive change opcodes separated only by
    # whitespace-only equal runs are merged into one region
    regions = []  # {b_start, b_end, old: [fragments]}
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == 'equal':
            continue
        b_s, b_e = offsets[j1], offsets[j2]
        a_text = ''.join(a[i1:i2])
        if regions:
            gap = new[regions[-1]['b_end']:b_s]
            if not gap.strip():  # only whitespace since the last change
                regions[-1]['old'].append(gap)
                regions[-1]['old'].append(a_text)
                regions[-1]['b_end'] = b_e
                continue
        regions.append({'b_start': b_s, 'b_end': b_e, 'old': [a_text]})

    adds, dels = [], []
    for r in regions:
        old_text = ''.join(r['old'])
        if not old_text.strip() and new[r['b_start']:r['b_end']].strip() == '':
            continue  # whitespace-only reshuffle
        if r['b_end'] > r['b_start']:
            adds.append({'s': r['b_start'], 'e': r['b_end']})
        if old_text.strip():
            dels.append({'s': r['b_start'], 'text': old_text})
    return adds, dels


def block_diffs(store):
    """Inline word-level diffs of changed blocks vs HEAD.

    Returns {diffs: {block_id: {kind, adds, dels}}, ghosts: [...]} where
    ghosts are whole blocks removed since HEAD (before_id = the current
    block at their old position, None = end of document).
    """
    top, _ = find_repo(store.root)
    if top is None:
        return {'diffs': {}, 'ghosts': []}
    diffs, ghosts = {}, []
    gid = 0
    for entry in store.doc['files']:
        rel, enc = entry['path'], entry.get('encoding', 'utf-8')
        head = _head_text(store.root, rel, enc)
        if head is None:
            continue  # untracked file: /git/changes already marks all-new
        cur_blocks = [b for b in store.doc['blocks'] if b['file'] == rel]
        old_blocks = parse_file(head, is_main=(rel == store.doc['main']))
        a = [_norm_src(head[s:e]) for _t, s, e, _m in old_blocks]
        b = [_norm_src(x['source']) for x in cur_blocks]
        sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
        for tag, i1, i2, j1, j2 in sm.get_opcodes():
            if tag == 'equal':
                continue
            if tag == 'replace':
                # pair up as far as possible; leftovers handled below
                pairs = min(i2 - i1, j2 - j1)
                for k in range(pairs):
                    adds, dels = _word_diff(a[i1 + k], b[j1 + k])
                    if not adds and not dels:
                        continue  # identical modulo trailing newline
                    if len(adds) + len(dels) > MAX_OPS:
                        diffs[cur_blocks[j1 + k]['id']] = {
                            'kind': 'new', 'adds': [{'s': 0, 'e': len(b[j1 + k])}],
                            'dels': []}
                    else:
                        diffs[cur_blocks[j1 + k]['id']] = {
                            'kind': 'modified', 'adds': adds, 'dels': dels}
                for k in range(pairs, i2 - i1):  # old blocks without partner
                    gid += 1
                    ghosts.append({
                        'gid': f'g{gid}', 'file': rel,
                        'before_id': (cur_blocks[j1 + pairs]['id']
                                      if j1 + pairs < len(cur_blocks) else None),
                        'text': a[i1 + k]})
                for k in range(pairs, j2 - j1):  # new blocks without partner
                    diffs[cur_blocks[j1 + pairs + k]['id']] = {
                        'kind': 'new', 'adds': [{'s': 0, 'e': len(b[j1 + pairs + k])}],
                        'dels': []}
            elif tag == 'insert':
                for k in range(j1, j2):
                    diffs[cur_blocks[k]['id']] = {
                        'kind': 'new', 'adds': [{'s': 0, 'e': len(b[k])}], 'dels': []}
            elif tag == 'delete':
                for k in range(i1, i2):
                    gid += 1
                    ghosts.append({
                        'gid': f'g{gid}', 'file': rel,
                        'before_id': (cur_blocks[j1]['id']
                                      if j1 < len(cur_blocks) else None),
                        'text': a[k]})
    return {'diffs': diffs, 'ghosts': ghosts}
