"""Git integration via the git CLI (no third-party deps).

All commands run with cwd=<project root>, so paths given to git are
project-root-relative pathspecs and `HEAD:./<rel>` resolves relative to
the project inside the repo even when the repo toplevel is higher up.
"""
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
    """Parse `git status --porcelain -b` into a UI-friendly payload."""
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


def stage(root, paths):
    if paths:
        _run(root, 'add', '--', *paths)


def unstage(root, paths):
    if paths:
        _run(root, 'reset', 'HEAD', '--', *paths)


def discard(root, paths):
    """Dangerous: reverts the given paths to their staged/HEAD content."""
    if paths:
        _run(root, 'checkout', '--', *paths)


def commit(root, message, paths=None):
    if paths:
        _run(root, 'add', '--', *paths)
    _run(root, 'commit', '-m', message)
    out = _run(root, 'log', '-1', '--format=%h %s')
    return out.strip()


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
