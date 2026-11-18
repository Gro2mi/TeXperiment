#!/usr/bin/env python
"""Fetch the pinned offline math libraries into web/vendor/.

Downloads the exact npm tarballs for KaTeX and MathLive and extracts only
the files the app serves, so the packaged app needs no CDN. The manifest
(web/vendor/manifest.json) records sha256 sums — `--check` verifies the
committed files without downloading (used by CI).
"""
import hashlib
import json
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
VENDOR = REPO / 'web' / 'vendor'

# exact npm tarball URLs — bump the version and re-run to upgrade
SOURCES = {
    'katex': {
        'url': 'https://registry.npmjs.org/katex/-/katex-0.16.11.tgz',
        'version': '0.16.11',
        # package-relative path → vendor-relative destination
        'files': {
            'package/dist/katex.min.css': 'katex.min.css',
            'package/dist/katex.min.js': 'katex.min.js',
        },
        'dirs': {'package/dist/fonts': 'fonts'},
    },
    'mathlive': {
        'url': 'https://registry.npmjs.org/mathlive/-/mathlive-0.111.4.tgz',
        'version': '0.111.4',
        'files': {
            'package/mathlive.min.js': 'mathlive.min.js',
            'package/mathlive-static.css': 'mathlive-static.css',
        },
        'dirs': {},
    },
}


def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 16), b''):
            h.update(chunk)
    return h.hexdigest()


def _manifest() -> dict:
    out = {}
    if (VENDOR / 'manifest.json').is_file():
        out = json.loads((VENDOR / 'manifest.json').read_text(encoding='utf-8'))
    return out


def check() -> int:
    """Verify the committed vendor tree against the manifest."""
    m = _manifest()
    if not m:
        print('vendor manifest missing — run fetch_vendor.py first')
        return 1
    bad = []
    for rel, want in sorted(m.items()):
        p = VENDOR / rel
        if not p.is_file() or _sha256(p) != want:
            bad.append(rel)
    if bad:
        print('vendor files missing or modified:')
        for rel in bad:
            print('  ' + rel)
        return 1
    print(f'vendor OK — {len(m)} files verified')
    return 0


def fetch() -> int:
    VENDOR.mkdir(parents=True, exist_ok=True)
    manifest = {}
    with tempfile.TemporaryDirectory() as td:
        for name, spec in SOURCES.items():
            dest = VENDOR / name
            if dest.exists():
                shutil.rmtree(dest)
            dest.mkdir(parents=True)
            tgz = Path(td) / f'{name}.tgz'
            print(f'downloading {spec["url"]}')
            urllib.request.urlretrieve(spec['url'], tgz)
            with tarfile.open(tgz, 'r:gz') as tf:
                for member in tf.getmembers():
                    for src, dst in spec['files'].items():
                        if member.name == src and member.isfile():
                            out = dest / dst
                            out.parent.mkdir(parents=True, exist_ok=True)
                            with tf.extractfile(member) as f, open(out, 'wb') as g:
                                g.write(f.read())
                    for src, dst in spec['dirs'].items():
                        if member.name.startswith(src + '/'):
                            rel = member.name[len(src) + 1:]
                            if not rel or not member.isfile():
                                continue
                            out = dest / dst / rel
                            out.parent.mkdir(parents=True, exist_ok=True)
                            with tf.extractfile(member) as f, open(out, 'wb') as g:
                                g.write(f.read())
            for p in sorted(dest.rglob('*')):
                if p.is_file():
                    manifest[f'{name}/{p.relative_to(dest).as_posix()}'] = _sha256(p)
            n = sum(1 for _ in dest.rglob('*') if _.is_file())
            print(f'  -> web/vendor/{name} ({n} files)')
            # mathlive-static.css declares the KaTeX font faces with
            # paths relative to itself (fonts/KaTeX_*.woff2) — serve the
            # already-vendored KaTeX fonts from that location too
            if name == 'mathlive':
                fonts_src = VENDOR / 'katex' / 'fonts'
                fonts_dst = dest / 'fonts'
                if fonts_src.is_dir():
                    shutil.copytree(fonts_src, fonts_dst, dirs_exist_ok=True)
                for p in sorted(fonts_dst.rglob('*')):
                    if p.is_file():
                        manifest[f'mathlive/fonts/{p.relative_to(fonts_dst).as_posix()}'] \
                            = _sha256(p)
                nf = sum(1 for _ in fonts_dst.rglob('*') if _.is_file())
                print(f'  -> web/vendor/mathlive/fonts ({nf} files, from katex)')
    (VENDOR / 'manifest.json').write_text(
        json.dumps(manifest, indent=1, sort_keys=True) + '\n', encoding='utf-8')
    print(f'manifest written ({len(manifest)} files)')
    return 0


if __name__ == '__main__':
    sys.exit(check() if '--check' in sys.argv else fetch())
