# Stancz-PSN Editor

Éditeur de chorégraphie **desktop natif** (Windows / macOS / Linux) pour la
lumière : on place des points sur une scène, on les anime sur une timeline, et
l'application diffuse leurs positions en **PosiStageNet (PSN)** vers Capture,
Depence ou une grandMA3.

Chaque point représente un **projecteur porté par un opérateur**, pas un
danseur — l'app est pensée pour la programmation lumière, pas pour la danse.

> ⚠️ **État : v0.1.** Le cœur (import, timeline, PSN, timecode) est écrit et
> couvert par des tests. La sortie réseau n'a **pas encore été validée sur une
> vraie machine avec Capture** — voir « Ce qui reste à valider ».

---

## Fonctionnalités

- **Éditeur de scène 2D** — grille métrique, image de sol en référence
  (plan du stade), points déplaçables à la souris, zoom/pan.
- **Timeline** — formations en blocs, playhead déplaçable, règle temporelle.
- **Entrée timecode** — saisie manuelle (`HH:MM:SS.mmm`, `MM:SS`, secondes)
  **et** asservissement à un timecode externe :
  - **Art-Net timecode** (UDP 6454) — sans dépendance supplémentaire
  - **MTC / MIDI timecode** — nécessite `mido` + `python-rtmidi`
- **Sortie PSN v2** — multicast configurable, choix de l'interface réseau,
  fréquence 1-120 Hz, découpage automatique en plusieurs datagrammes.
- **Transformation de repère** — origine, inversion X/Y, échange des axes,
  hauteur Z, pour coller à la convention de ta prévisu.
- **Import `.stancz`** — lit les projets Stancz (points, formations, courbes,
  audio) pour ne pas repartir de zéro.
- **Format de projet natif** `.spsn` (JSON lisible, versionné, diffable).

---

## Installation

Python 3.10 ou plus récent.

```bash
git clone <ton-dépôt>
cd stancz-psn-editor

python -m venv .venv
# Windows :
.venv\Scripts\activate
# macOS / Linux :
source .venv/bin/activate

pip install -r requirements.txt
```

### Lancement

```bash
python -m stanczpsn
```

(depuis la racine du dépôt ; le paquet est dans `src/`, ajouté au chemin par
`pyproject.toml` en installation éditable — sinon `PYTHONPATH=src python -m stanczpsn`)

Ou en installation éditable, ce qui ajoute la commande `stanczpsn` :

```bash
pip install -e .
stanczpsn
```

### Dépendances optionnelles

```bash
pip install mido python-rtmidi   # pour l'entrée MTC
pip install pytest               # pour lancer les tests
```

---

## Utilisation

1. **Fichier → Importer .stancz** (ou Nouveau, puis ajouter des points).
2. **Fichier → Image de sol de référence** : charge le plan du stade. Elle est
   mise à l'échelle de la scène en conservant son rapport d'aspect.
3. Sélectionne une formation, coche **Edit positions**, déplace les points.
   Les nouvelles positions sont écrites dans la formation sélectionnée.
4. Dans le panneau **Output** :
   - règle l'origine (bouton **Centre on stage** pour recentrer),
   - coche **Invert Y** / **Swap X/Y** selon la convention de ta prévisu,
   - vérifie l'IP multicast et surtout **l'interface réseau** si la machine a
     plusieurs cartes,
   - **Start PSN**.
5. Pour asservir au show : **Timecode input → Art-Net timecode** ou **MTC**,
   et règle l'**Offset** (timecode entrant − offset = temps projet).

**Raccourcis** : `Espace` lecture/pause · `Ctrl+0` zoom sur la scène ·
`Ctrl+S` enregistrer · `Ctrl+O` ouvrir.

---

## Empaqueter en exécutable

Voir [`packaging/README.md`](packaging/README.md). En résumé :

```bash
pip install pyinstaller
pyinstaller packaging/stanczpsn.spec
```

Chaque plateforme doit être compilée **sur elle-même** : PyInstaller ne fait
pas de compilation croisée. Un `.exe` se construit sous Windows, un `.app`
sous macOS.

---

## Architecture

```
src/stanczpsn/
├── __main__.py          point d'entrée + thème sombre
├── core/                aucune dépendance à Qt — testable seul
│   ├── project.py       modèle de données, format .spsn, import .stancz
│   ├── timeline.py      interpolation, courbes d'easing, transformation de repère
│   ├── psn.py           encodeur PSN v2 + émetteur UDP multicast
│   ├── timecode.py      parsing, réception Art-Net TC et MTC
│   └── engine.py        transport (horloge) + thread de diffusion PSN
└── ui/                  couche Qt uniquement
    ├── main_window.py
    ├── stage_view.py    canvas QGraphicsView, unités = centimètres
    └── timeline_widget.py
```

`core/` ne connaît pas Qt : si tu veux un jour une autre interface (ou piloter
l'app en ligne de commande), tout le moteur est réutilisable tel quel.

### Conventions d'unités

| | Interne | PSN |
|---|---|---|
| Unité | centimètres | mètres |
| Origine | coin haut-gauche de la scène | définie par la transformation |
| Y | vers le fond de scène | inversable |

Les positions **peuvent sortir des limites de la scène** (coulisses, entrées) :
rien n'est jamais tronqué aux dimensions du plateau.

### Détails PSN

- Multicast par défaut **236.10.10.10:56565**.
- `PSN_DATA` envoyé à la fréquence choisie, `PSN_INFO` (noms) toutes les
  secondes.
- Les deux types de paquets sont **découpés automatiquement** sous 1472 octets
  et renseignent `packet_count` — indispensable au-delà d'une soixantaine de
  points, sinon les paquets dépassent le MTU.
- L'ID de tracker PSN est le **numéro du point** (surchargeable par point).
- Un point sans position connue à l'instant courant n'est **pas envoyé** — il
  n'est jamais placé arbitrairement à (0, 0).

---

## Tests

```bash
pip install pytest
PYTHONPATH=src python -m pytest -q
```

34 tests couvrent le format PSN (aller-retour vérifié contre la bibliothèque
indépendante `pypsn`), le découpage des paquets, l'interpolation, les courbes,
la transformation de repère, le timecode et le format de projet.

---

## Ce qui reste à valider

Points connus, à traiter avant toute utilisation en production :

1. **Réception réelle en prévisu** — l'encodage PSN est vérifié contre un
   parseur tiers, mais rien n'a encore été reçu par Capture ou une MA3.
   À tester avec **un seul point** avant de lancer les 90.
2. **Convention d'axes** — à caler avec ce point de test (Invert Y ? Swap ?).
3. **Régularité d'envoi** — la boucle utilise une horloge absolue, mais le
   comportement au-delà de 60 Hz avec ~100 points n'a pas été mesuré.
4. **Noms des courbes d'easing dans `.stancz`** — seul `linear` a été observé
   dans un export réel. Les autres noms sont des hypothèses (voir
   `EASING_ALIASES` dans `core/timeline.py`).
5. **`stageFloorTexture`** — le champ existe dans le format Stancz mais était
   vide dans l'export de référence ; l'import ne le traite donc pas encore.
6. **LTC (timecode audio)** — non implémenté. Art-Net TC et MTC couvrent la
   majorité des cas ; LTC demande une entrée audio et un décodeur.

---

## Licence

MIT — voir [`LICENSE`](LICENSE).
