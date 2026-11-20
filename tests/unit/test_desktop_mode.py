"""Presentation-mode resolution (texperiment/desktop.py resolve_mode).

The server-only distribution ships WITHOUT pywebview: its frozen 'auto'
must resolve to the browser, never to a window attempt. An explicit
--window on such a build still goes through the window path (which falls
back to a browser tab with a note)."""
import pytest

from texperiment.desktop import resolve_mode


def test_auto_frozen_opens_the_native_window():
    assert resolve_mode('auto', frozen=True) == 'window'


def test_auto_not_frozen_opens_a_browser_tab():
    assert resolve_mode('auto', frozen=False) == 'browser'


def test_auto_server_flavor_opens_a_browser_even_when_frozen():
    # the server-only build: no viewer bundled, the browser IS the UI
    assert resolve_mode('auto', frozen=True, flavor='server') == 'browser'


def test_explicit_modes_pass_through_untouched():
    assert resolve_mode('window', frozen=True) == 'window'
    assert resolve_mode('window', frozen=True, flavor='server') == 'window'
    assert resolve_mode('browser', frozen=False) == 'browser'
    assert resolve_mode('server', frozen=True) == 'server'


def test_unknown_flavor_behaves_like_the_default_build():
    assert resolve_mode('auto', frozen=True, flavor='') == 'window'
    with pytest.raises(ValueError):
        resolve_mode('bogus', frozen=True)
