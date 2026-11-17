"""Desktop shell: run the uvicorn server and present the UI.

Three presentation modes:
- native window (pywebview) — the packaged default;
- browser tab — the development default (and window fallback);
- server-only (--no-window) — CI smoke tests and headless use.

A second launch while an instance already holds the port activates the
running window via GET /focus instead of failing on the bind.
"""
import asyncio
import signal
import sys
import threading
import time
import webbrowser

import uvicorn


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
        webbrowser.open(url)
    return _wait_server_only(server)


def _run_window(app, server, thread, url, debug):
    try:
        import webview
    except ImportError:
        print('* pywebview not available — opening a browser tab instead',
              flush=True)
        webbrowser.open(url)
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
