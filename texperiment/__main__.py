"""CLI entry point: python -m texperiment [main.tex ...] [--port 8080]

Starts one server that can hold several projects; further projects can be
added from the UI (sidebar → ＋)."""
import argparse

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
    args = ap.parse_args()

    app = create_app(args.main_tex)
    url = f'http://{args.host}:{args.port}'
    print(f'* TeXperiment — {len(args.main_tex)} project(s) loaded', flush=True)
    print(f'* server available at {url}  (Ctrl+C to stop)', flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level='warning')


if __name__ == '__main__':
    main()
