"""Archive extraction for the bundled tectonic binary
(packaging/fetch_tectonic.py).

Regression: the tar branch passed a TarInfo object where a path string
was expected (Path / TarInfo -> TypeError), crashing the ubuntu CI build
on the tectonic download. The zip branch never crashed because
namelist() returns strings. Both paths must extract the nested member
and return a usable path."""
import importlib.util
import io
import tarfile
import zipfile
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location(
    'fetch_tectonic', _REPO / 'packaging' / 'fetch_tectonic.py')
fetch_tectonic = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fetch_tectonic)


def _make_tar(path: Path, member: str, payload: bytes):
    with tarfile.open(path, 'w:gz') as tf:
        info = tarfile.TarInfo(member)
        info.size = len(payload)
        info.mode = 0o755
        tf.addfile(info, io.BytesIO(payload))


def _make_zip(path: Path, member: str, payload: bytes):
    with zipfile.ZipFile(path, 'w') as zf:
        zf.writestr(member, payload)


def test_extracts_from_tar_with_nested_member(tmp_path):
    # exactly the shape of the real tectonic release archive
    arc = tmp_path / 'tectonic.tar.gz'
    _make_tar(arc, 'tectonic-0.15.0-x86_64-unknown-linux-musl/tectonic',
              b'#!fake-elf')
    td = tmp_path / 'work'
    td.mkdir()
    got = fetch_tectonic.extract_executable(arc, 'tectonic', td)
    assert got is not None and got.is_file()
    assert got.read_bytes() == b'#!fake-elf'


def test_extracts_from_zip(tmp_path):
    arc = tmp_path / 'tectonic.zip'
    _make_zip(arc, 'tectonic-0.15.0-x86_64-pc-windows-msvc/tectonic.exe',
              b'MZ-fake')
    td = tmp_path / 'work'
    td.mkdir()
    got = fetch_tectonic.extract_executable(arc, 'tectonic.exe', td)
    assert got is not None and got.is_file()
    assert got.read_bytes() == b'MZ-fake'


def test_missing_member_returns_none(tmp_path):
    arc = tmp_path / 'tectonic.tar.gz'
    _make_tar(arc, 'some/other/file', b'x')
    td = tmp_path / 'work'
    td.mkdir()
    assert fetch_tectonic.extract_executable(arc, 'tectonic', td) is None


def test_tar_extraction_uses_the_data_filter(tmp_path):
    # Python 3.14 rejects unfiltered extraction by default (and 3.12+
    # warn about it): the filter must be requested explicitly
    import inspect
    assert 'filter' in inspect.getsource(fetch_tectonic.extract_executable)
