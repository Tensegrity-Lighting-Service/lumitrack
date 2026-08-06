# -*- coding: utf-8 -*-
"""Genere latest.json pour l'updater Tauri (2026-08-06).

Le plugin updater interroge
  releases/latest/download/latest.json
sur GitHub : ce script assemble ce manifeste a partir de la version de
tauri.conf.json et de la signature (.sig) produite par `tauri build`
(createUpdaterArtifacts). A joindre a CHAQUE release GitHub avec le
setup.exe ET le .sig — sans latest.json, les apps installees ne voient
simplement pas la mise a jour (pas d'erreur).
"""
import json
import os
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUNDLE = os.path.join(ROOT, "frontend", "src-tauri", "target", "release", "bundle", "nsis")
REPO_URL = "https://github.com/Tensegrity-Lighting-Service/lumitrack"

with open(os.path.join(ROOT, "frontend", "src-tauri", "tauri.conf.json"), encoding="utf-8") as fh:
    version = json.load(fh)["version"]

setup_name = f"Lumitrack_{version}_x64-setup.exe"
sig_path = os.path.join(BUNDLE, setup_name + ".sig")
with open(sig_path, encoding="utf-8") as fh:
    signature = fh.read().strip()

manifest = {
    "version": version,
    "notes": f"Lumitrack {version} — voir {REPO_URL}/releases/tag/v{version}",
    "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": {
        "windows-x86_64": {
            "signature": signature,
            "url": f"{REPO_URL}/releases/download/v{version}/{setup_name}",
        }
    },
}

out = os.path.join(BUNDLE, "latest.json")
with open(out, "w", encoding="utf-8") as fh:
    json.dump(manifest, fh, indent=2)
print(f"OK : {out} (version {version})")
