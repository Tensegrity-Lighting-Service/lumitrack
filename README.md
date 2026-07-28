# Lumitrack

Éditeur de prévisu lumière : on place des points sur une scène 3D, on les
anime sur une timeline à blocs de cue, et l'application diffuse leurs
positions en **PosiStageNet (PSN)** vers Capture, Depence ou une grandMA3.

Chaque point représente un **projecteur porté par un opérateur**, pas un
danseur — l'app est pensée pour la programmation lumière, pas pour la danse.

> ⚠️ **État : v2 en construction (voir `CONCEPTION.md` §13 pour le périmètre
> du v1/MVP).** Le moteur Python (`core/`) est réécrit autour d'un modèle de
> cue/activation et couvert par des tests. Le frontend Tauri/React est un
> premier socle : scène 3D vue Dessus, timeline à blocs, synchronisation
> backend-autoritaire avec le sidecar. La sortie réseau n'a **pas encore été
> validée sur une vraie machine avec Capture**.

---

## Architecture

```
lumitrack/
├── src/lumitrack/
│   ├── __main__.py       lance le sidecar (python -m lumitrack)
│   ├── sidecar.py         serveur WebSocket local, backend-autoritaire
│   └── core/               aucune dépendance UI — testable seul
│       ├── project.py      modèle Cue/Activation, import .stancz, bundle
│       ├── timeline.py      résolution position/axe, courbes d'easing
│       ├── psn.py            encodeur PSN v2 + émetteur UDP multicast
│       ├── timecode.py        parsing, réception Art-Net TC et MTC
│       └── engine.py           transport (horloge) + thread de diffusion PSN
└── frontend/                Tauri + React + react-three-fiber
    ├── src/
    │   ├── sidecar.ts        client WebSocket vers le sidecar Python
    │   ├── scene/Scene.tsx    scène 3D, vue Dessus
    │   └── timeline/          piste de blocs (@xzdarcy/react-timeline-editor)
    └── src-tauri/            coquille Rust ; lance le sidecar au démarrage
```

`core/` ne connaît aucune couche d'interface : le moteur (modèle de données,
interpolation, encodage PSN, timecode) est entièrement réutilisable, que ce
soit derrière le sidecar WebSocket actuel ou une autre interface plus tard.
Le frontend **n'a jamais l'autorité sur le temps ou les positions** : il
affiche ce que le sidecar lui pousse (`tick` à ~30 Hz) et envoie des
commandes d'édition ; toute interpolation a lieu côté Python
(voir CONCEPTION.md §12.11/§13.1.7).

### Modèle de données (v2)

Le modèle séquentiel `Formation` du v0.1 est remplacé par des **Cues** : des
blocs sur la timeline, libres de se chevaucher, vides à la création. On y
**active** des points un par un ; chaque activation porte son propre temps de
fade et peut toucher x/y/z/lacet indépendamment (un axe non touché continue
de suivre sa dernière valeur connue). Voir `CONCEPTION.md` §12.1/§13.1 pour
le détail et le rationnel.

---

## Installation

Prérequis : **Python ≥ 3.10**, **Node.js LTS**, **Rust** (`rustup`), et côté
Windows les **Build Tools Visual Studio (workload C++)** pour le linker MSVC
qu'utilise Rust.

```bash
git clone <ton-dépôt>
cd lumitrack

python -m venv .venv
# Windows :
.venv\Scripts\activate
# macOS / Linux :
source .venv/bin/activate

pip install -r requirements.txt

cd frontend
npm install
```

### Lancement (dev)

Sous Windows, double-clique **`Lancer Lumitrack (dev).bat`** à la racine du
dépôt : il installe les dépendances si besoin puis ouvre la fenêtre Tauri
(qui démarre elle-même le sidecar Python). Aucune commande à taper.

En ligne de commande, l'équivalent est :

```bash
cd frontend
npm run tauri dev
```

Le sidecar Python peut aussi être lancé seul, utile pour déboguer le moteur
indépendamment du frontend :

```bash
PYTHONPATH=src python -m lumitrack --port 17845
```

---

## Tests

```bash
pip install -r requirements-dev.txt
PYTHONPATH=src python -m pytest -q
```

Couvre le format PSN (aller-retour vérifié contre la bibliothèque
indépendante `pypsn`, y compris l'orientation), le découpage des paquets,
la résolution du modèle cue/activation (chevauchement, LTP, animation par
axe indépendante), les transformations de groupe (rotation/translation avec
arc individuel par acteur), la transformation de repère, le timecode et le
format de projet — bundle inclus (dédoublonnage des médias par hash).

---

## Conventions d'unités

| | Interne | PSN |
|---|---|---|
| Unité | centimètres | mètres |
| Origine | coin haut-gauche de la scène | définie par la transformation |
| Y | vers le fond de scène | inversable |
| Orientation | degrés, lacet uniquement | radians (`PSN_DATA_TRACKER_ORI`) |

Les positions **peuvent sortir des limites de la scène** (coulisses, entrées) :
rien n'est jamais tronqué aux dimensions du plateau. Un point sans position
connue à l'instant courant n'est **jamais envoyé** — jamais placé
arbitrairement à (0, 0).

---

## Ce qui reste à valider / à construire

Voir `CONCEPTION.md` §13.2 pour le périmètre explicitement hors v1, et
§12.13 pour les points non tranchés. En particulier, pas encore fait :

1. **Réception réelle en prévisu** — l'encodage PSN est vérifié contre un
   parseur tiers, mais rien n'a encore été reçu par Capture ou une MA3.
2. **Convention d'axes et d'orientation** — à caler avec un point de test
   unique avant de lancer tous les acteurs.
3. **Packaging** — le sidecar tourne pour l'instant via `python -m lumitrack`
   lancé par Rust en dev ; l'empaqueter en `externalBin` (PyInstaller +
   config Tauri) pour un exécutable distribuable n'est pas fait
   (CONCEPTION.md §12.13).
4. **Waveform audio, sauvegarde bundle côté UI, undo/redo** — le moteur les
   supporte (`core/project.py`), le câblage frontend est partiel ou absent.

---

## Licence

MIT — voir [`LICENSE`](LICENSE).
