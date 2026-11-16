"""Integration-test isolation: the server and proof modules persist state
under ~/.texperiment (projects.json per port, dictionaries.json,
proof_ignores.json). Tests must never touch the real ones — this autouse
fixture redirects every one of them into the test's tmp_path.
"""
import pytest


@pytest.fixture(autouse=True)
def isolate_home_config(tmp_path, monkeypatch):
    from texperiment import proof, server
    cfg = tmp_path / 'texperiment-home'
    cfg.mkdir()
    monkeypatch.setattr(server, 'CONFIG_DIR', cfg)
    monkeypatch.setattr(server, 'CONFIG_PATH', cfg / 'projects.json')
    monkeypatch.setattr(proof, 'DICT_PATH', cfg / 'dictionaries.json')
    monkeypatch.setattr(proof, 'IGNORE_PATH', cfg / 'proof_ignores.json')
    yield cfg
