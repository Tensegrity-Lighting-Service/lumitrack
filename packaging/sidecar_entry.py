"""Point d'entrée PyInstaller du sidecar (release installable, 2026-08-06).

`src/lumitrack/__main__.py` fait un import RELATIF (`from .sidecar import
main`) — valide pour `python -m lumitrack`, mais PyInstaller lancé sur ce
fichier n'a pas de paquet parent et échoue. Ce shim importe en absolu ;
le vrai code reste dans src/lumitrack/ (--paths src au build).

Build : packaging/build-sidecar.bat (produit
frontend/src-tauri/binaries/lumitrack-sidecar-x86_64-pc-windows-msvc.exe,
le suffixe de plateforme est la convention externalBin de Tauri).
"""
import sys

from lumitrack.sidecar import main

if __name__ == "__main__":
    sys.exit(main())
