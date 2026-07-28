"""Entry point: python -m lumitrack — runs the local sidecar (see sidecar.py).

The Qt desktop UI from v0.1 has been retired; the editor is now the Tauri +
React frontend, which launches this same module as a packaged sidecar
process (CONCEPTION.md §12.11).
"""
from __future__ import annotations

from .sidecar import main

if __name__ == "__main__":
    raise SystemExit(main())
