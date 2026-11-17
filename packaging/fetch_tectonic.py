#!/usr/bin/env python
"""Fetch the pinned tectonic binary into packaging/tectonic/.

Tectonic is the bundled fallback LaTeX engine (single ~30 MB binary). Its
TeX package bundle is NOT shipped — on its first compile it downloads the
bundle from the internet and caches it under the user's cache dir.
"""
import hashlib
import shutil
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEST = REPO / 'packaging' / 'tectonic'

# pinned release — bump the version and re-run to upgrade
TECTONIC_VERSION = '0.15.0'
URLS = {
    'windows': ('https://github.com/tectonic-typesetting/tectonic/releases/'
                f'download/tectonic%40{TECTONIC_VERSION}/'
                f'tectonic-{TECTONIC_VERSION}-x86_64-pc-windows-msvc.zip',
                'tectonic.exe'),
    'linux': ('https://github.com/tectonic-typesetting/tectonic/releases/'
              f'download/tectonic%40{TECTONIC_VERSION}/'
              f'tectonic-{TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz',
              'tectonic'),
}


def main() -> int:
    key = 'windows' if sys.platform == 'win32' else 'linux'
    url, exe = URLS[key]
    DEST.mkdir(parents=True, exist_ok=True)
    out = DEST / exe
    if out.is_file() and out.stat().st_size > 1_000_000:
        print(f'tectonic already present: {out}')
        return 0
    print(f'downloading {url}')
    with tempfile.TemporaryDirectory() as td:
        arc = Path(td) / ('tectonic.zip' if url.endswith('.zip') else 'tectonic.tar.gz')
        urllib.request.urlretrieve(url, arc)
        if url.endswith('.zip'):
            with zipfile.ZipFile(arc) as zf:
                members = [m for m in zf.namelist() if m.endswith(exe)]
                if not members:
                    print(f'! {exe} not found in the archive', file=sys.stderr)
                    return 1
                zf.extract(members[0], td)
                shutil.move(str(Path(td) / members[0]), out)
        else:
            import tarfile
            with tarfile.open(arc, 'r:gz') as tf:
                members = [m for m in tf.getmembers() if m.name.endswith(exe)]
                if not members:
                    print(f'! {exe} not found in the archive', file=sys.stderr)
                    return 1
                tf.extract(members[0], td)
                shutil.move(str(Path(td) / members[0]), out)
    out.chmod(0o755)
    h = hashlib.sha256(out.read_bytes()).hexdigest()[:16]
    print(f'tectonic {TECTONIC_VERSION} -> {out} (sha256 {h}…)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
