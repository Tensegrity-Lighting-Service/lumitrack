# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec. Build from the repository root:

    pyinstaller packaging/lumitrack.spec

PyInstaller does not cross-compile: build the Windows .exe on Windows and the
macOS .app on macOS.
"""
import sys
from pathlib import Path

ROOT = Path(SPECPATH).parent
SRC = ROOT / "src"

a = Analysis(
    [str(SRC / "lumitrack" / "__main__.py")],
    pathex=[str(SRC)],
    binaries=[],
    datas=[],
    hiddenimports=[
        "pypsn",
        # Optional MIDI backend: harmless if absent, needed if installed.
        "mido",
        "mido.backends.rtmidi",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Qt ships far more than this app uses; trimming keeps the bundle sane.
    excludes=[
        "PySide6.QtWebEngineCore", "PySide6.QtWebEngineWidgets",
        "PySide6.Qt3DCore", "PySide6.Qt3DRender", "PySide6.QtQuick",
        "PySide6.QtQml", "PySide6.QtMultimedia", "PySide6.QtCharts",
        "tkinter", "matplotlib", "numpy",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="StanczPSN",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,          # GUI app: no console window on Windows
    disable_windowed_traceback=False,
    argv_emulation=False,   # set True on macOS if you want file drag-and-drop
    target_arch=None,       # 'universal2' for a fat macOS binary
    codesign_identity=None,
    entitlements_file=None,
    icon=None,              # point at packaging/icon.ico / .icns when you have one
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="StanczPSN",
)

if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="StanczPSN.app",
        icon=None,
        bundle_identifier="eu.lumitrack.editor",
        info_plist={
            "CFBundleShortVersionString": "0.1.0",
            "NSHighResolutionCapable": True,
            # macOS 15+ asks the user to approve local network access; without
            # this string the prompt has no explanation and PSN/Art-Net will
            # silently fail if the user declines.
            "NSLocalNetworkUsageDescription":
                "Sends PosiStageNet tracking data and receives Art-Net timecode "
                "on the local network.",
        },
    )
