"""CLI entry point: python -m texperiment [main.tex ...] [--port 8080]

Starts one server that can hold several projects; projects persist per port
on disk (~/.texperiment/projects.json) and more can be added from the UI."""
import argparse
import signal
import threading
import time

import uvicorn

from .server import create_app


def main():
    ap = argparse.ArgumentParser(
        prog='texperiment',
        description='Realtime, no-compile LaTeX content editor.')
    ap.add_argument('main_tex', nargs='*',
                    help='path(s) to main .tex files to open initially')
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=8080)
    ap.add_argument('--proof-engine', choices=('languagetool', 'spellcheck'),
                    default='languagetool',
                    help='proofreading engine (default: languagetool, needs '
                         'Java; spellcheck is an offline typo-only fallback)')
    args = ap.parse_args()

    app = create_app(args.main_tex, args.port, proof_engine=args.proof_engine)
    url = f'http://{args.host}:{args.port}'
    print(f'* TeXperiment — {len(args.main_tex)} project(s) loaded from CLI, '
          f'restored the rest for port {args.port} from ~/.texperiment/projects.json',
          flush=True)
    print(f'* server available at {url}  (Ctrl+C to stop)', flush=True)

    # Run uvicorn in a daemon thread so the main thread keeps Python's default
    # signal handling — on Windows, uvicorn's own handlers can swallow Ctrl+C.
    config = uvicorn.Config(app, host=args.host, port=args.port,
                            log_level='warning')
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    def _stop(signum, frame):
        server.should_exit = True

    signal.signal(signal.SIGINT, _stop)
    if hasattr(signal, 'SIGBREAK'):
        signal.signal(signal.SIGBREAK, _stop)
    try:
        while thread.is_alive():
            time.sleep(0.3)
    except KeyboardInterrupt:
        server.should_exit = True
        try:
            thread.join(timeout=5)
        except Exception:
            pass
    print('* server stopped', flush=True)


if __name__ == '__main__':
    main()
