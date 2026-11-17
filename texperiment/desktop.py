"""Desktop shell: run the uvicorn server and present the UI.

Three presentation modes:
- native window (pywebview) — the packaged default;
- browser tab — the development default (and window fallback);
- server-only (--no-window) — CI smoke tests and headless use.

A second launch while an instance already holds the port activates the
running window via GET /focus instead of failing on the bind.
"""
import asyncio
import os
import signal
import subprocess
import sys
import threading
import time
import webbrowser

import uvicorn


def _no_window():
    return getattr(subprocess, 'CREATE_NO_WINDOW', 0)


def _silence_connection_reset(loop, context):
    """Windows Proactor IO: browsers can drop keep-alive connections
    mid-shutdown, and asyncio logs every such reset as an exception even
    though uvicorn handles it fine — swallow it instead."""
    if isinstance(context.get('exception'), ConnectionResetError):
        return  # handled
    loop.default_exception_handler(context)


def _wait_started(server, thread, timeout_s=15):
    """Wait until uvicorn bound its port; False when the thread died
    (bind failure — port already taken or invalid)."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if not thread.is_alive():
            return False
        if getattr(server, 'started', False):
            return True
        time.sleep(0.05)
    return False


def _focus_existing(url, timeout_s=2):
    """Ask an already-running instance to raise its window. True when a
    TeXperiment instance answered, False when the port belongs to
    something else (or nothing reachable)."""
    try:
        import urllib.request
        with urllib.request.urlopen(url + '/focus', timeout=timeout_s):
            return True
    except Exception:
        return False


def _tee_output():
    """Frozen builds run without a console: mirror stdout/stderr into a
    log file so start-up problems remain diagnosable."""
    from pathlib import Path

    class _Tee:
        def __init__(self, *streams):
            self.streams = streams

        def isatty(self):
            return False  # uvicorn's log formatter probes for this

        def write(self, data):
            for s in self.streams:
                try:
                    s.write(data)
                except Exception:
                    pass
                else:
                    try:
                        s.flush()
                    except Exception:
                        pass

        def flush(self):
            for s in self.streams:
                try:
                    s.flush()
                except Exception:
                    pass

    log_path = Path.home() / '.texperiment' / 'texperiment.log'
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        f = open(log_path, 'a', encoding='utf-8', buffering=1)
        sys.stdout = _Tee(sys.stdout, f)
        sys.stderr = _Tee(sys.stderr, f)
    except OSError:
        pass


def _default_browser_cmd():
    """Windows: the exe of the browser registered for http:// URLs, from
    the per-user protocol association. Returns (exe, fixed_args) or None."""
    import re
    import winreg
    try:
        with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r'Software\Microsoft\Windows\Shell\Associations'
                r'\UrlAssociations\http\UserChoice') as k:
            prog_id = winreg.QueryValueEx(k, 'ProgId')[0]
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT,
                            prog_id + r'\shell\open\command') as k:
            cmd = winreg.QueryValueEx(k, "")[0]
    except OSError:
        return None
    # '"C:\...\chrome.exe" --single-argument "%1"' → exe + static args
    m = re.match(r'^\s*"([^"]+)"\s*(.*)$', cmd) \
        or re.match(r'^\s*([^\s"]+)\s*(.*)$', cmd)
    if not m:
        return None
    exe, rest = m.group(1), m.group(2)
    # drop placeholder args (quoted or not) — the URL is appended last;
    # remaining static args (e.g. Firefox's -osint -url) are preserved
    args = [a.strip('"') for a in re.split(r'\s+', rest)
            if a and '%1' not in a.replace('"', '')]
    return exe, args


def _open_ui_url(url):
    """Open the UI in the user's browser. Launching the browser EXE
    directly (single-instance forwarding) lands the URL as a new TAB in
    the already-running browser; webbrowser.open (os.startfile /
    ShellExecute) may open a NEW WINDOW depending on the browser's
    protocol registration. No browser exe found → shell fallback."""
    if os.name == 'nt':
        cand = _default_browser_cmd()
        if cand:
            try:
                subprocess.Popen([cand[0], *cand[1], url],
                                 creationflags=_no_window())
                return
            except OSError:
                pass  # registry points at a missing exe — try the fallbacks
        # known installs, most common first
        for exe in (
                os.path.expandvars(r'%ProgramFiles%\Google\Chrome'
                                   r'\Application\chrome.exe'),
                os.path.expandvars(r'%ProgramFiles(x86)%\Google\Chrome'
                                   r'\Application\chrome.exe'),
                os.path.expandvars(r'%ProgramFiles(x86)%\Microsoft\Edge'
                                   r'\Application\msedge.exe'),
                os.path.expandvars(r'%ProgramFiles%\Microsoft\Edge'
                                   r'\Application\msedge.exe'),
                os.path.expandvars(r'%ProgramFiles%\Mozilla Firefox'
                                   r'\firefox.exe'),
                os.path.expandvars(r'%LOCALAPPDATA%\Google\Chrome'
                                   r'\Application\chrome.exe')):
            if os.path.isfile(exe):
                try:
                    subprocess.Popen([exe, url],
                                     creationflags=_no_window())
                    return
                except OSError:
                    continue
    webbrowser.open_new_tab(url)


def run(app, host, port, mode='auto', debug=False):
    """Start the server and present the UI. mode: 'window' | 'browser' |
    'server' | 'auto' (window when frozen, browser tab otherwise).
    Blocks until the window closes (or, server-only, until Ctrl+C)."""
    url = f'http://{host}:{port}'
    if mode == 'auto':
        mode = 'window' if getattr(sys, 'frozen', False) else 'browser'
    if getattr(sys, 'frozen', False):
        _tee_output()

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.set_exception_handler(_silence_connection_reset)
    config = uvicorn.Config(app, host=host, port=port, log_level='warning')
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    if not _wait_started(server, thread):
        if thread.is_alive():
            print('* server did not start in time', flush=True)
            server.should_exit = True
            return 1
        # the port is held by someone — a running TeXperiment instance
        # answers /focus and raises its window
        if _focus_existing(url):
            print('* already running — focused the existing window',
                  flush=True)
            return 0
        print(f'* port {port} is busy — cannot start the server', flush=True)
        return 1

    print(f'* server available at {url}', flush=True)

    if mode == 'window':
        return _run_window(app, server, thread, url, debug)

    if mode == 'browser':
        _open_ui_url(url)
    return _wait_server_only(server)


def _run_window(app, server, thread, url, debug):
    try:
        import webview
    except ImportError:
        print('* pywebview not available — opening a browser tab instead',
              flush=True)
        _open_ui_url(url)
        return _wait_server_only(server)
    app.state.desktop = True

    def _stop(*_a):
        server.should_exit = True

    window = webview.create_window('TeXperiment', url, width=1500,
                                   height=950, min_size=(900, 600))
    app.state.focus_cb['fn'] = lambda: (window.restore(), window.show())
    window.events.closed += _stop
    # blocks until the window closes; the server thread is a daemon and
    # is told to shut down via the closed handler
    webview.start(debug=debug)
    server.should_exit = True
    try:
        thread.join(timeout=5)
    except Exception:
        pass
    print('* server stopped', flush=True)
    return 0


def _wait_server_only(server):
    def _stop(signum, frame):
        server.should_exit = True

    signal.signal(signal.SIGINT, _stop)
    if hasattr(signal, 'SIGBREAK'):
        signal.signal(signal.SIGBREAK, _stop)
    print('* press Ctrl+C to stop', flush=True)
    try:
        while not server.should_exit:
            time.sleep(0.3)
    except KeyboardInterrupt:
        server.should_exit = True
    print('* server stopped', flush=True)
    return 0
