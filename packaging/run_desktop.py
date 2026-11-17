"""PyInstaller entry point: the packaged app starts here (windowed exe,
no console — output is teed to ~/.texperiment/texperiment.log)."""
import multiprocessing

from texperiment.__main__ import main

if __name__ == '__main__':
    multiprocessing.freeze_support()  # Windows: required in frozen builds
    main()
