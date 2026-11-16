"""Shared fixtures (helpers live in tests/helpers.py — a unique module
name that no conftest shadows)."""
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))  # `helpers` importable everywhere

import pytest
from helpers import DEMO

DEMO_JUNK = ('*.aux', '*.log', '*.pdf', '*.fls', '*.fdb_latexmk',
             '*.bak', '*.tmp~', '*.out', '*.toc', '*.synctex.gz')


@pytest.fixture
def demo_project(tmp_path):
    """A fresh copy of the bundled demo project (tex + figures only)."""
    dst = tmp_path / 'demo'
    shutil.copytree(DEMO, dst, ignore=shutil.ignore_patterns(*DEMO_JUNK))
    return dst
