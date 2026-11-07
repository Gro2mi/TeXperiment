"""Git integration via the git CLI (no third-party deps).

All commands run with cwd=<project root>, so paths given to git are
project-root-relative pathspecs and `HEAD:./<rel>` resolves relative to
the project inside the repo even when the repo toplevel is higher up.
"""
import difflib
import re
import subprocess
import threading
from pathlib import Path

from .parser import parse_file


class GitError(Exception):
    """A git command failed; message is user-presentable."""


# git commands touch .git/index under a lock — serialize our own so a
# background `status` (which may refresh the index stat cache) can never
# collide with a user-initiated `add`/`commit` (index.lock race)
_GIT_LOCK = threading.Lock()


def _run(root, *args, ok_codes=(0,), binary=False):
    """Run git in root; returns stdout (str with surrogates replaced, or bytes)."""
    cmd = ['git', '-c', 'core.quotepath=false', '-c', 'color.ui=false', *args]
    with _GIT_LOCK:
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


def _visible_tex(s):
    r"""What the reader actually sees: drop formatting wrappers and
    command names, keep the words."""
    s = re.sub(r'\\(?:textbf|textit|emph|underline|texttt|textsc|mbox)\{', '', s)
    s = re.sub(r'\\textcolor\{[^{}]*\}\{', '', s)
    s = re.sub(r'\\[a-zA-Z]+\*?', '', s)
    s = s.replace('{', '').replace('}', '')
    s = s.replace('\\&', '&').replace('\\%', '%')
    return re.sub(r'\s+', ' ', s).strip()


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
        new_text = new[r['b_start']:r['b_end']]
        if not old_text.strip() and not new_text.strip():
            continue  # whitespace-only reshuffle
        # formatting-only change (bold/italic/color applied to the same
        # words): the text is unchanged, only wrapped - show the new
        # formatted text green and skip the red placeholder
        if _visible_tex(old_text) == _visible_tex(new_text):
            if r['b_end'] > r['b_start']:
                adds.append({'s': r['b_start'], 'e': r['b_end']})
            continue
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
        # normalized sources align the blocks across line-ending drift;
        # the word diff itself runs on the RAW sources so the issue
        # offsets are raw-source coordinates for the frontend render
        a_raw = [head[s:e] for _t, s, e, _m in old_blocks]
        b_raw = [x['source'] for x in cur_blocks]
        a = [_norm_src(x2) for x2 in a_raw]
        b = [_norm_src(x2) for x2 in b_raw]
        sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
        for tag, i1, i2, j1, j2 in sm.get_opcodes():
            if tag == 'equal':
                continue
            if tag == 'replace':
                # pair up as far as possible; leftovers handled below
                pairs = min(i2 - i1, j2 - j1)
                for k in range(pairs):
                    adds, dels = _word_diff(a_raw[i1 + k], b_raw[j1 + k])
                    if not adds and not dels:
                        continue  # identical modulo trailing newline
                    if len(adds) + len(dels) > MAX_OPS:
                        diffs[cur_blocks[j1 + k]['id']] = {
                            'kind': 'new', 'adds': [{'s': 0, 'e': len(b_raw[j1 + k])}],
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
                    diffs[cur_blocks[j1 + k]['id']] = {
                        'kind': 'new', 'adds': [{'s': 0, 'e': len(b_raw[j1 + k])}],
                        'dels': []}
            elif tag == 'insert':
                for k in range(j1, j2):
                    diffs[cur_blocks[k]['id']] = {
                        'kind': 'new', 'adds': [{'s': 0, 'e': len(b_raw[k])}], 'dels': []}
            elif tag == 'delete':
                for k in range(i1, i2):
                    gid += 1
                    ghosts.append({
                        'gid': f'g{gid}', 'file': rel,
                        'before_id': (cur_blocks[j1]['id']
                                      if j1 < len(cur_blocks) else None),
                        'text': a[k]})
    return {'diffs': diffs, 'ghosts': ghosts}


# ---------------------------------------------------------------- block stage


def _parse_spans(text, is_main):
    """(start, end) raw spans of the parsed blocks of text."""
    return [(s, e) for _t, s, e, _m in parse_file(text, is_main=is_main)]


def _norm_spans(text, spans):
    """Normalized sources for spans (alignment keys)."""
    return [_norm_src(text[s:e]) for s, e in spans]


def _align(base_spans, base_text, cur_sources):
    """Map cur block index -> (base_start, base_end) raw span in base_text,
    or None when the block has no base counterpart."""
    a = _norm_spans(base_text, base_spans)
    b = [_norm_src(s2) for s2 in cur_sources]
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    m = {}
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        for k in range(min(i2 - i1, j2 - j1)):
            m[j1 + k] = (base_spans[i1 + k][0], base_spans[i1 + k][1])
    return m


def _file_texts(store, rel):
    """(head, index, cur) raw texts of a project file (index may be None
    for untracked files)."""
    enc = next((e2['encoding'] for e2 in store.doc['files']
                if e2['path'] == rel), 'utf-8')
    head = _head_text(store.root, rel, enc)
    try:
        idx = _run(store.root, 'show', ':./' + rel, binary=True)
        if idx.startswith(b'\xef\xbb\xbf'):
            idx = idx[3:]
        idx = idx.decode(enc or 'utf-8', errors='replace')
    except GitError:
        idx = None
    cur = (store.root / rel).read_text(encoding=enc or 'utf-8', errors='replace')
    return head, idx, cur


def _staged_flags(store, rel, cur_blocks, idx_text):
    """Per-block: True when the block's change is already staged (the
    index copy equals the worktree copy for that block)."""
    if idx_text is None:
        return {b['id']: False for b in cur_blocks}
    idx_spans = _parse_spans(idx_text,
                          is_main=(rel == store.doc['main']))
    cur_sources = [b['source'] for b in cur_blocks]
    m = _align(idx_spans, idx_text, cur_sources)
    flags = {}
    for j, b in enumerate(cur_blocks):
        span = m.get(j)
        flags[b['id']] = (span is not None and
            _norm_src(idx_text[span[0]:span[1]]) == _norm_src(b['source']))
    return flags


def _splice_region(text, span, replacement):
    """Replace the (start, end) span in text with replacement (span may
    be None = append at end)."""
    if span is None:
        return text + replacement
    s, e = span
    return text[:s] + replacement + text[e:]


def _block_stage_content(store, rel, block_id, target):
    """File content where ONLY the given block differs from `target`
    ('index' for staging, 'head' for unstaging). None when the block has
    no counterpart in the target or nothing would change."""
    is_main = rel == store.doc['main']
    head, idx, cur = _file_texts(store, rel)
    # both targets build on the index: staging splices the current
    # source in, unstaging splices the HEAD copy of the block in
    base = idx
    if base is None:
        return None
    base_spans = _parse_spans(base, is_main)
    cur_blocks = [b for b in store.doc['blocks'] if b['file'] == rel]
    j = next((k for k, b2 in enumerate(cur_blocks) if b2['id'] == block_id), None)
    if j is None:
        return None
    cur_sources = [b2['source'] for b2 in cur_blocks]
    m = _align(base_spans, base, cur_sources)
    span = m.get(j)
    src_block = cur_sources[j]
    if target == 'index':
        # stage this block: index content with our block's current source
        if span is not None:
            s, e = span
            out = base[:s] + src_block + base[e:]
        else:
            # new block: insert next to its aligned neighbors
            pos = None
            for k in range(j - 1, -1, -1):
                if k in m:
                    pos = m[k][1]
                    break
            if pos is None:
                for k in range(j + 1, len(cur_sources)):
                    if k in m:
                        pos = m[k][0]
                        break
            out = (base[:pos] + src_block + base[pos:]) if pos is not None else None
        if out is not None and _norm_src(out) == _norm_src(base):
            return None  # nothing would change
        return out
    # unstage this block: index content with our block reverted to HEAD
    head_spans = _parse_spans(head, is_main)
    hm = _align(head_spans, head, cur_sources)
    hspan = hm.get(j)
    if span is None:
        return None  # block not in the index either - nothing to unstage
    s, e = span
    if hspan is not None:
        old_src = head[hspan[0]:hspan[1]]
        return base[:s] + old_src + base[e:]
    # block is new (not in HEAD): remove it from the index content
    pos_s = pos_e = None
    for k in range(j - 1, -1, -1):
        if k in m:
            pos_s = m[k][1]
            break
    for k in range(j + 1, len(cur_sources)):
        if k in m:
            pos_e = m[k][0]
            break
    if pos_s is not None:
        return base[:pos_s] + base[pos_e:]
    if pos_e is not None:
        return base[:pos_e]
    return None


def _stage_blob(store, rel, content):
    """Stage `content` for rel via hash-object + update-index (the
    worktree is not touched)."""
    enc = next((e2['encoding'] for e2 in store.doc['files']
                if e2['path'] == rel), 'utf-8')
    data = content.encode(enc or 'utf-8')
    p = subprocess.run(['git', 'hash-object', '-w', '--stdin'], cwd=str(store.root),
                       input=data, capture_output=True, timeout=20)
    if p.returncode != 0:
        raise GitError(p.stderr.decode('utf-8', errors='replace').strip())
    sha = p.stdout.decode('utf-8').strip()
    # update-index paths are repo-relative: map the project-relative
    # path through the repo prefix
    _top, prefix = find_repo(store.root)
    rel_repo = prefix + rel if prefix else rel
    # --add handles paths not yet in the index (file previously
    # staged-deleted, or first-time staging)
    _run(store.root, 'update-index', '--add', '--cacheinfo',
         '100644,' + sha + ',' + rel_repo)


def stage_block(store, block_id):
    """Stage exactly this block's change (index = worktree for this block
    only; other blocks keep their stage state)."""
    blk = next((b for b in store.doc['blocks'] if b['id'] == block_id), None)
    if blk is None:
        raise ValueError('block not found')
    rel = blk['file']
    out = _block_stage_content(store, rel, block_id, 'index')
    if out is None:
        return False
    _stage_blob(store, rel, out)
    return True


def unstage_block(store, block_id):
    """Revert this block's staged change (index = HEAD for this block
    only)."""
    blk = next((b for b in store.doc['blocks'] if b['id'] == block_id), None)
    if blk is None:
        raise ValueError('block not found')
    rel = blk['file']
    out = _block_stage_content(store, rel, block_id, 'head')
    if out is None:
        return False
    _stage_blob(store, rel, out)
    return True
