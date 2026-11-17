"""CLI entry point: python -m texperiment [main.tex ...] [--port 8080]

Starts one server that can hold several projects; projects persist per port
on disk (~/.texperiment/projects.json) and more can be added from the UI.
The UI is presented in a native app window (pywebview) when packaged, and
as a browser tab in development."""
import argparse
import sys

from .desktop import run
from .server import create_app
from .version import __version__


def main():
    ap = argparse.ArgumentParser(
        prog='texperiment',
        description='Realtime, no-compile LaTeX content editor.')
    ap.add_argument('main_tex', nargs='*',
                    help='path(s) to main .tex files to open initially')
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=8080)
    ap.add_argument('--proof-engine', choices=('languagetool', 'spellcheck'),
                    default=None,
                    help='proofreading engine (default: the persisted '
                         'setting, else languagetool — full grammar checks; '
                         'spellcheck is an offline typo-only fallback). '
                         'LanguageTool downloads on explicit user request '
                         'from the Proofreading panel only.')
    ap.add_argument('--engine', choices=('auto', 'latexmk', 'tectonic'),
                    default='auto',
                    help='LaTeX compile engine (default: auto = latexmk/'
                         'pdflatex when installed, else the bundled '
                         'tectonic)')
    g = ap.add_mutually_exclusive_group()
    g.add_argument('--window', dest='mode', action='store_const',
                   const='window', default=None,
                   help='open a native app window (default when packaged)')
    g.add_argument('--no-window', dest='mode', action='store_const',
                   const='server', default=None,
                   help='server only — no window, no browser (headless/CI)')
    g.add_argument('--browser', dest='mode', action='store_const',
                   const='browser', default=None,
                   help='open the UI as a browser tab (default in dev)')
    ap.add_argument('--debug', action='store_true',
                    help='window mode with devtools enabled')
    ap.add_argument('--version', action='version',
                    version=f'Texperiment {__version__}')
    args = ap.parse_args()

    app = create_app(args.main_tex, args.port, proof_engine=args.proof_engine,
                     engine=args.engine)
    print(f'* TeXperiment {__version__} — {len(args.main_tex)} project(s) '
          'loaded from CLI, restored the rest for port '
          f'{args.port} from ~/.texperiment/projects.json', flush=True)
    sys.exit(run(app, args.host, args.port, mode=args.mode or 'auto',
                 debug=args.debug))


if __name__ == '__main__':
    main()
