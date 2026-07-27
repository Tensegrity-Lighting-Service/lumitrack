# Mise en place locale + GitHub

## 1. Placer le dossier

Extrais l'archive dans tes Documents, par exemple :

- Windows : `C:\Users\<toi>\Documents\stancz-psn-editor`
- macOS   : `~/Documents/stancz-psn-editor`

## 2. Initialiser le dépôt

```bash
cd stancz-psn-editor
git init -b main
git add .
git commit -m "Initial commit: desktop editor with timecode input and PSN output"
```

## 3. Pousser vers GitHub

Crée un dépôt vide sur GitHub (sans README ni .gitignore, ils existent déjà),
puis :

```bash
git remote add origin git@github.com:<ton-compte>/stancz-psn-editor.git
git push -u origin main
```

En HTTPS plutôt qu'en SSH :

```bash
git remote add origin https://github.com/<ton-compte>/stancz-psn-editor.git
git push -u origin main
```

Avec le CLI GitHub, les deux étapes en une :

```bash
gh repo create stancz-psn-editor --private --source=. --push
```

## 4. Vérifier que tout tourne

```bash
python -m venv .venv
source .venv/bin/activate        # Windows : .venv\Scripts\activate
pip install -r requirements-dev.txt
python -m pytest -q              # doit afficher 34 passed
PYTHONPATH=src python -m stanczpsn
```

## 5. Intégrer le travail de Claude Design

Le code d'interface est isolé dans `src/stanczpsn/ui/`, et `src/stanczpsn/core/`
n'a aucune dépendance à Qt. Deux cas :

- **Maquettes / direction visuelle** → le thème est centralisé dans la
  constante `DARK_QSS` de `src/stanczpsn/__main__.py`. Les couleurs du canvas
  sont dans `ui/stage_view.py`, celles de la timeline dans
  `ui/timeline_widget.py`.
- **Interface HTML/CSS complète** → prévenir avant d'aller plus loin : Qt ne
  réutilise pas du HTML. Dans ce cas il faudrait basculer sur Electron ou
  Tauri, et seul `core/` serait à reporter (ou à garder en Python derrière un
  service local).
