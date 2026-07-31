import pytest


@pytest.fixture(autouse=True)
def _isolated_autosave(tmp_path, monkeypatch):
    # Session() relit %APPDATA%/Lumitrack/autosave.json sur une vraie
    # machine — pointé ici sur un dossier tmp vide pour que chaque test
    # démarre du même projet de démo propre, quel que soit ce qui traîne
    # sur la machine du développeur qui lance la suite (un simple usage
    # réel de l'app suffit à faire dériver test_block_context.py /
    # test_sidecar.py, qui construisent Session() sans isolation propre).
    monkeypatch.setenv("APPDATA", str(tmp_path))
