# Stancz → PSN — Dossier de conception

Document de référence pour construire une appli compatible Stancz qui lit les
projets `.stancz` et diffuse les positions en **PosiStageNet (PSN)** vers
Capture / Depence / grandMA3.

**Contexte** : chaque « danseur » Stancz représente en réalité un **projecteur
porté par un humain**. L'objectif est de programmer la lumière en prévisu à
partir d'une chorégraphie dessinée dans Stancz.

**État actuel** : l'application **v0.1 existe et fonctionne**
(`stancz-psn-editor.zip`) — éditeur desktop natif Python/PySide6, import
`.stancz`, timeline, entrée timecode, sortie PSN v2, 34 tests au vert.
Voir **§11 — Ce qui est déjà construit** pour la passation.

Ce document reste la référence : format de fichier, protocole, décisions
d'architecture, et ce qui n'est pas encore validé.

---

## 1. Le format `.stancz` (rétro-ingénierie complète)

Un `.stancz` est un **fichier ZIP** (compression `store`). Vérifié sur
`Hockey-World-Cup.stancz` (44 Mo, dont l'audio).

```
Hockey-World-Cup.stancz
├── manifest.json
├── project.json
└── audio/GajZiR2XxYMVldOyrHnd7.m4a
```

### 1.1 `manifest.json`

```json
{
  "format": "stancz-bundle",
  "version": 1,
  "exportedAt": 1785185474281,
  "appVersion": "0.1.0",
  "projectName": "Hockey World Cup",
  "mediaCount": 1,
  "totalSize": 44267530
}
```

`"version": 1` et `"appVersion": "0.1.0"` → le format est **jeune et
susceptible de bouger**. Prévoir un contrôle de version au chargement et un
échec explicite plutôt qu'un parsing silencieusement faux.

### 1.2 `project.json` — clés racine

| Clé | Type | Notes |
|---|---|---|
| `id`, `name` | string | |
| `stageWidth`, `stageHeight` | number | **centimètres**. Ici 5000 × 3000 = 50 m × 30 m |
| `gridSize` | number | cm (50) |
| `dancers` | array | voir 1.3 |
| `formations` | array | voir 1.4 |
| `props` | array | voir 1.5 |
| `groups` | array | vide dans l'échantillon — **structure inconnue** |
| `audioTrack` | object | voir 1.6 |
| `stageFloorTexture` | null | **`null` dans l'échantillon — format inconnu** |
| `snapDistance` | number | |
| `createdAt`, `updatedAt`, `lastSyncedAt` | number | epoch ms |
| `associationId`, `ownerId`, `ownerName` | string | multi-utilisateur |

### 1.3 `dancers[]`

```json
{
  "id": "R2WFDDu8ToF2ADHInxXZV",
  "name": "Astera 6",
  "color": "#6366F1",
  "shape": "circle",
  "size": "M",
  "number": 6
}
```

- `id` = nanoid (21 caractères). Clé de jointure avec les positions.
- `number` = le numéro affiché dans l'UI → **candidat naturel pour l'ID de
  tracker PSN** (stable, lisible côté console, contrairement au nanoid).
- ⚠️ Dans l'échantillon, deux danseurs portent le nom « Astera 11 »
  (numéros 11 et 12) → **les noms ne sont pas uniques**, ne jamais s'en servir
  comme clé.
- `shape` / `size` : valeurs observées `circle` / `M`. Autres valeurs possibles
  non relevées.

### 1.4 `formations[]` — le cœur du modèle temporel

```json
{
  "id": "wFifCPEfKNZ0RZwxRN_T7",
  "name": "Entrée danseurs",
  "order": 30,
  "duration": 5133.689839572193,
  "easing": "linear",
  "positions": [ { "dancerId": "...", "x": 3050, "y": 3505 } ]
}
```

- `order` : **pas contigu** (10, 20, 30) → toujours trier dessus, ne jamais se
  fier à l'ordre du tableau.
- `duration` : millisecondes, **durée du segment / de la transition vers cette
  formation**. Modèle **séquentiel cumulatif**.
- `easing` : **absent** sur certaines formations → défaut `"linear"`.
- `positions[]` : `x`/`y` en **centimètres**, origine en **haut à gauche**
  (X = largeur, Y = profondeur).
- Un danseur **absent** de `positions` n'est pas déplacé → il conserve sa
  dernière position connue.

**Validation du modèle cumulatif** (confirmée par l'UI Stancz) :

| Formation | `duration` | Début | Fin |
|---|---|---|---|
| F01 INTRO VIDEO | 86 631 ms | 0:00.0 | 1:26.6 |
| F02 ENTREE RAPHAELLA | 20 535 ms | 1:26.6 | 1:47.1 |
| F03 Entrée danseurs | 5 134 ms | 1:47.1 | 1:52.2 |

L'en-tête Stancz affiche **« 3 formations · 1:52.2 »** = 86.6 + 20.5 + 5.1 ✅
et la timeline affiche bien F02 démarrant à 1:26. Le modèle est confirmé.

### 1.5 `props[]`

```json
{
  "id": "...", "type": "custom", "label": "Autre",
  "x": 2450, "y": 3100, "width": 500, "height": 500,
  "rotation": 0, "color": "#8b5a2b", "opacity": 1,
  "locked": false, "zIndex": 1,
  "formationId": "LuW4KX2koGT7kawy9oXcs",
  "height3d": 60
}
```

- `height3d` = hauteur en cm pour la vue 3D.
- `formationId` → un accessoire peut être **lié à une formation** (visible
  seulement pendant celle-ci).
- Types vus dans l'UI : Plateforme, Banc, Chaise, Table, Canapé, Escalier,
  Porte, Miroir, Autre. Seul `"custom"` est confirmé dans le JSON.

### 1.6 `audioTrack`

```json
{
  "fileName": "FIH World Cup X Henri PFR (18min VF).m4a",
  "mediaId": "GajZiR2XxYMVldOyrHnd7",
  "duration": 1107.9253333333334,
  "r2Key": "users/<userId>/<id>.m4a",
  "fileUrl": "audio/GajZiR2XxYMVldOyrHnd7.m4a",
  "bpm": 93.5,
  "beatOffsetMs": 445.29577464788724
}
```

- `duration` en **secondes** (attention : les formations sont en ms).
- `fileUrl` = chemin **relatif dans le zip**.
- `r2Key` révèle un stockage Cloudflare R2 côté serveur.
- ⚠️ L'UI affiche **94 BPM** alors que le JSON contient **93.5** → l'affichage
  arrondit, se fier au JSON.

### 1.7 Coordonnées hors scène — point important

Les positions **sortent volontairement des limites de la scène** : les
danseurs de F03 sont à `y = 3505` pour une scène profonde de `3000`, et le prop
est à `y = 3100`. Dans l'UI, ils sont dessinés **sous** le rectangle de scène
(zone de coulisses / entrée).

➡️ **Ne jamais clamper les coordonnées** aux dimensions de la scène, ni au
rendu ni à la sortie PSN.

---

## 2. Le protocole PSN (PosiStageNet)

### 2.1 Ressources

- Site officiel : <https://posistage.net/>
- **Spec v2.03 (PDF)** :
  <https://github.com/vyv/psn-cpp/blob/master/doc/PosiStageNetprotocol_v2.03_2019_09_09.pdf>
- Implémentation C++ de référence (VYV) : <https://github.com/vyv/psn-cpp>
- **Lib Python `pypsn`** : <https://github.com/open-stage/python-psn> —
  `pip install pypsn`. Utilisée par BlenderDMX ; d'après son README, les
  messages PSN produits sont **reconnus par grandMA3 2.1**.
- Doc grandMA3 côté réception :
  <https://help.malighting.com/grandMA3/2.2/HTML/remote_inputs_psn.html>
- Implémentation .NET/vvvv : `VL.IO.PosiStageNet`

### 2.2 Points clés

- Transport **UDP**, multicast par défaut **236.10.10.10:56565**.
- Protocole développé par **VYV + MA Lighting**, libre de droits.
- Deux télégrammes :
  - **PSN_INFO** (`0x6756`) — noms du système et des trackers, envoyé à ~**1 Hz**.
  - **PSN_DATA** (`0x6755`) — positions/vitesses/orientations, envoyé à
    **60 Hz par défaut** (paramétrable).
- Structure en **chunks** récursifs :
  `u16 chunk_id | u16 champ_longueur | données`
  où le **bit 15** du champ de longueur signale « contient des sous-chunks »
  et les bits 0-14 donnent la longueur des données.
- Les positions sont des **float32 en mètres** → conversion obligatoire depuis
  les centimètres de Stancz.
- Un frame trop gros doit être **réparti sur plusieurs paquets UDP**
  (`packet_count` / `frame_id` servent au réassemblage). Avec 95 trackers c'est
  un vrai sujet : prévoir le découpage sous ~1472 octets utiles.

### 2.3 Chunks utiles

```
PSN_DATA_PACKET (0x6755)
├── PSN_DATA_PACKET_HEADER (0x0000)  u64 timestamp_us, u8 ver_hi, u8 ver_lo, u8 frame_id, u8 packet_count
└── PSN_DATA_TRACKER_LIST  (0x0001)
    └── <chunk_id = tracker_id>
        ├── PSN_DATA_TRACKER_POS     (0x0000)  3× f32 (mètres)
        ├── PSN_DATA_TRACKER_SPEED   (0x0001)  3× f32
        ├── PSN_DATA_TRACKER_ORI     (0x0002)  3× f32
        ├── PSN_DATA_TRACKER_STATUS  (0x0003)  f32
        ├── PSN_DATA_TRACKER_ACCEL   (0x0004)  3× f32
        ├── PSN_DATA_TRACKER_TRGTPOS (0x0005)  3× f32
        └── PSN_DATA_TRACKER_TIMESTAMP (0x0006) u32

PSN_INFO_PACKET (0x6756)
├── PSN_INFO_PACKET_HEADER (0x0000)  même en-tête 12 octets
├── PSN_INFO_SYSTEM_NAME   (0x0001)  chaîne
└── PSN_INFO_TRACKER_LIST  (0x0002)
    └── <chunk_id = tracker_id>
        └── PSN_INFO_TRACKER_NAME (0x0000)  chaîne
```

**Piste d'amélioration** : n'envoyer que `POS` est suffisant pour faire suivre
un projecteur, mais envoyer aussi `SPEED` permet aux consoles de lisser /
extrapoler entre deux paquets — utile si on descend la fréquence d'envoi.
`TRGTPOS` pourrait servir à annoncer la position d'arrivée de la formation
suivante.

---

## 3. Côté prévisu

### 3.1 Capture — deux mécanismes bien distincts

Source : manuel Capture 2024, §17.3 et §19.4.

| Objet | Piloté par | Usage ici |
|---|---|---|
| **DMX Mover** | DMX / Art-Net (canaux X/Y/Z, 8 ou 16 bits) | Positions pilotées **depuis la console** |
| **DMX Rotator** | DMX / Art-Net (canal Alpha, + Speed pour rotation continue) | Orientation |
| **Motion Construct** | **Protocoles de tracking** (PSN, BlackTrax RTTrP, Kinesys K2) | ✅ **C'est notre cible** |

Mise en œuvre : un **Motion Construct par point**, puis la propriété
**Motion Fixture** de l'objet 3D est assignée à ce construct.

Protocoles de tracking supportés par Capture (§19.4.2) : `PosiStageNet`,
`Blacktrax RTTrP`, `Kinesys K2`. → **PSN est bien supporté nativement.**

Manuel en ligne : <https://www.capture.se/Manual/en-UK/2024/LibraryTab.html>
et <https://www.capture.se/Manual/en-UK/2024/Appendix.html>

### 3.2 Depence

Import MVR supporté, export MVR limité. Doc :
<https://help.depence.com/depence-construction/mvr>
À vérifier : la réception PSN dans Depence (non documenté dans les pages
consultées — **question ouverte**).

### 3.3 grandMA3

Réception PSN native : `Menu → In & Out → PSN`. Paramètres disponibles :
Sender IP, Port, Multicast IP, **MapX/MapY/MapZ** (remapping d'axes) et
**InvX/InvY/InvZ** (inversion par axe).

➡️ **Conséquence utile** : le remapping d'axes peut se faire *côté console*.
Notre appli doit quand même l'offrir, mais ce n'est pas bloquant si on se
trompe de convention au départ.

---

## 4. Conversion de repère (le point qui fera perdre le plus de temps)

| | Stancz | PSN / prévisu |
|---|---|---|
| Unité | centimètres | **mètres** |
| Origine | coin haut-gauche de la scène | à définir (souvent centre scène) |
| Axe Y | profondeur, vers le bas de l'écran | souvent inversé |
| Z | inexistant (2D) | hauteur — à fixer (hauteur de porté du projecteur ?) |

Formule retenue dans le prototype :

```
x_m = (x_cm - origine_x_cm) * 0.01
y_m = (y_cm - origine_y_cm) * 0.01     (× -1 si inversion Y)
z_m = constante paramétrable
```

Pour recentrer sur le milieu de la scène : `origine_x = stageWidth / 2`,
`origine_y = stageHeight / 2` (soit 2500 / 1500 ici).

**À caler sur le terrain** avec un point de test unique avant de lancer les 95.

---

## 5. Architecture proposée

```
┌───────────────┐   zip+json    ┌──────────────┐
│ .stancz       │──────────────▶│ Parser       │
└───────────────┘               └──────┬───────┘
                                       │ modèle (danseurs, formations, audio)
                                       ▼
┌───────────────┐   t (ms)      ┌──────────────┐
│ Timeline /    │──────────────▶│ Interpolateur│──▶ {id: (x,y)}
│ Timecode      │               │ + easing     │
└───────────────┘               └──────┬───────┘
                                       ▼
                                ┌──────────────┐
                                │ Transformation│ cm→m, origine, inversion, Z
                                └──────┬───────┘
                                       ▼
                                ┌──────────────┐  UDP multicast
                                │ Encodeur PSN │─────────────────▶ Capture / MA3
                                └──────────────┘
```

Le découplage **interpolateur / transformation / encodeur** est important :
il permet de tester chaque étage isolément, et de remplacer la sortie PSN par
autre chose (OSC, Art-Net vers DMX Movers) sans toucher au reste.

### 5.1 Bases open source existantes (timeline + gestion d'objets)

Le travail coûteux n'est ni le parsing ni le PSN — c'est **l'éditeur** :
canvas avec sélection/déplacement/snap/groupes, timeline avec keyframes et
formes d'onde, undo/redo, gestion de projet. Quatre pistes pour ne pas le
réécrire.

#### A. OpenMarch — le plus proche du besoin

<https://github.com/OpenMarch/OpenMarch> · <https://openmarch.com/>

Logiciel d'écriture de **drill** (marching band) : un terrain, des exécutants,
des « sets » (= nos formations), une timeline calée sur la musique. C'est
littéralement le même problème que Stancz, en open source.

- **Licence** : AGPL-3.0. ⚠️ Il existe **aussi** un `LICENSE-internal.md` aux
  termes non identifiés, un `CONTRIBUTOR_LICENSE_AGREEMENT.md` et un
  `TRADEMARK.md` → **à lire avant tout fork**, ça sent le double-licensing.
- **Stack** : Electron · React · Zustand · Radix + Tailwind · **fabric.js**
  (canvas) · SQLite · monorepo Turbo/pnpm · Vitest/Playwright.
- **Vitalité** : ~2 200 commits, version 0.0.22 (février 2026), 85 étoiles,
  50 forks, Discord actif.
- ✅ **Pour** : le canvas et la timeline existent et sont éprouvés par de vrais
  utilisateurs ; TypeScript moderne ; architecture propre.
- ⚠️ **Contre** : très **orienté marching band** — repères en yards, comptes
  et mesures musicales plutôt que timecode libre. Adapter ça vers une scène
  métrique + timecode SMPTE n'est pas cosmétique. Le projet annonce
  explicitement qu'il ne fera **jamais de 3D**. Et 0.0.22 = jeune.

#### B. Blender + BlenderDMX — le plus rapide à mettre en œuvre

<https://blenderdmx.eu/> · <https://github.com/open-stage/blender-dmx>

Blender est probablement le meilleur gestionnaire d'objets + timeline
existant, et tu l'as déjà installé, avec le modèle du stade dedans.

- BlenderDMX gère déjà **GDTF/MVR**, **Art-Net/sACN**, l'animation par
  keyframes, et **reçoit** du PSN (jusqu'à 10 slots). Il faudrait écrire
  l'**émission** PSN — soit exactement le module que j'ai déjà validé.
- Les **F-curves** de Blender donnent gratuitement toutes les courbes
  d'easing, en bien plus fin que les 6 courbes de Stancz.
- ⚠️ Licence annoncée **GPLv3** sur leur site mais **MIT** sur la fiche
  Blender Extensions → **à vérifier**. Les libs sous-jacentes (`pypsn`,
  `pyGDTF`, `pyMVR`) sont en MIT.
- ⚠️ **Ce n'est pas une appli « end user »** : un chorégraphe ne touchera pas
  à Blender. Valable si l'utilisateur final, c'est toi.

#### C. Theatre.js — la timeline pro à embarquer

<https://www.theatrejs.com/> · <https://github.com/theatre-js/theatre>

Éditeur de motion design pour le web : séquenceur à keyframes + éditeur de
courbes, qui anime **n'importe quelle variable JS**. Nos points sont des
objets `{x, y}` → on récupère toute l'UI de timeline sans l'écrire.

- **Licence** : `@theatre/studio` est en **AGPL-3.0** ; le cœur est sous une
  licence plus permissive. Les sources secondaires se contredisent (certaines
  annoncent du MIT) → **vérifier le `LICENSE.md` du dépôt** avant de s'engager.
- ⚠️ Le développement a été **déplacé dans un dépôt privé** « temporairement »
  pour la 1.0, et ça date. **Vitalité à vérifier** avant de bâtir dessus.

#### D. Assemblage de briques — le plus de contrôle

| Besoin | Brique | Licence |
|---|---|---|
| Canvas 2D, objets, sélection, transformation | **fabric.js** ou **Konva.js** | MIT |
| Forme d'onde + segments colorés par formation | **wavesurfer.js** ou **Peaks.js** (BBC) | BSD / LGPL |
| Transport, BPM, calage au beat | **Tone.js** | MIT |
| Appli desktop | **Electron** ou **Tauri** | MIT / Apache-2.0 |
| PSN | module déjà écrit (Python) ou portage TS | — |

Plus de travail, mais **aucune contrainte de licence** et un ajustement exact
au besoin. C'est d'ailleurs à peu près la stack d'OpenMarch, reconstruite.

### 5.2 La question qui tranche : diffusion ou usage interne ?

L'AGPL-3.0 (options A et C) impose de **publier les sources** de toute version
distribuée — et même simplement rendue accessible par le réseau.

- **Outil interne / pour tes prods** → l'AGPL ne gêne pas. **Forker OpenMarch**
  est alors la voie la plus rapide vers quelque chose d'utilisable.
- **Produit à distribuer ou vendre, code fermé** → écarter A et C, partir sur
  **D** (briques MIT).
- **Outil personnel avant tout** → **B (Blender)** donne le plus de puissance
  pour le moins d'effort.

### 5.3 Remarque de fond

Face à Stancz, ton avantage n'est pas l'éditeur — c'est **l'intégration
lumière** : PSN, timecode, calage sur la prévisu, notion de projecteur porté
plutôt que de danseur. Refaire un meilleur éditeur 2D est un gros chantier ;
faire le **seul** éditeur qui parle aux consoles est un chantier plus court et
sans concurrent. À arbitrer avant d'écrire la première ligne.

### 5.4 Choix de stack pour le moteur — **décidé**

| Option | Pour | Contre |
|---|---|---|
| ✅ **Python + PySide6 (Qt)** — *retenu* | vraie appli native Win/Mac, `pypsn` dispo, `core/` sans dépendance à Qt | packaging PyInstaller par plateforme |
| **TypeScript** (si base OpenMarch) | un seul langage avec l'UI | encodeur PSN à porter (pas de lib TS mûre identifiée) |
| C++ avec `psn-cpp` | implémentation de référence, timing solide | développement bien plus lourd |

**Raison du choix** : besoin explicite d'une appli **desktop native, pas web**.
Qt donne des fenêtres système réelles, et tout l'écosystème protocolaire
(`pypsn`, `mido`, `pyGDTF`, `pyMVR`) est en Python.

⚠️ **Réserve** : si l'interface produite avec Claude Design est du **HTML/CSS**,
elle n'est pas réutilisable dans Qt. Dans ce cas, basculer sur Electron/Tauri
et ne reporter que `core/` — qui a été volontairement écrit **sans aucune
dépendance à Qt** précisément pour rendre ce pivot possible sans tout jeter.

---

## 6. Fonctionnalités demandées — état

| Besoin | État | Notes |
|---|---|---|
| Lecture `.stancz` | ✅ fait et testé | `core/project.py::import_stancz` |
| Timeline (lecture/pause/scrub) | ✅ fait | widget natif, blocs de formations, playhead |
| Saisie **timecode** | ✅ fait | `HH:MM:SS.mmm`, `MM:SS`, secondes, virgule décimale |
| **Timecode entrant** | ✅ Art-Net TC + MTC | LTC toujours non implémenté (§8) |
| Sol du stade en référence | ✅ fait | image chargée manuellement, mise à l'échelle de la scène |
| Envoi **PSN** | ✅ fait, découpage MTU corrigé | **jamais reçu par une vraie prévisu** |
| Édition des formations | ✅ fait | ajout, duplication, suppression, « Store positions » |
| Édition des positions | ✅ fait | points déplaçables, écrits dans la formation active |
| Format de projet natif | ✅ `.spsn` | JSON versionné et diffable |
| Application native Win/Mac | ✅ PySide6 + spec PyInstaller | **binaires jamais compilés ni testés** |
| Forme d'onde audio sur la timeline | ❌ à faire | Stancz l'a ; utile pour caler à l'oreille |
| Vue 3D | ❌ | Capture fait déjà la 3D — probablement inutile |
| Undo / redo | ❌ à faire | manque criant dès le premier usage réel |
| Groupes de points | ❌ à faire | `groups[]` de Stancz jamais observé rempli |

---

## 7. Points de vigilance techniques

1. ✅ **Régularité de l'envoi** — *résolu* : la boucle utilise une horloge
   absolue (`next_tick += période`) avec resynchronisation si on décroche, et
   non un `sleep` fixe qui dérive. Voir `core/engine.py::PsnBroadcaster._loop`.
   **Non mesuré** au-delà de 30 Hz avec ~100 points.
2. ✅ **Taille des paquets** — *résolu, et c'était un vrai bug*. Avec 92
   trackers nommés, `PSN_INFO` faisait **1592 octets**, au-delà du MTU : seuls
   les paquets DATA étaient découpés. `split_info_packets()` a été ajouté ;
   un test vérifie qu'aucun tracker ne se perd et que `packet_count` est
   correct (1 à 300 trackers).
3. ✅ **Multicast et interface réseau** — *résolu* : `IP_MULTICAST_IF` est
   posé, et le champ **Interface** est exposé dans le panneau Output.
4. **TTL multicast** — par défaut 1 sur beaucoup de systèmes = ne franchit pas
   un switch routé. Le prototype force 8.
5. **Pare-feu Windows** — cause n°1 de « ça ne marche pas » ; à documenter.
6. **Danseurs jamais positionnés** — dans l'échantillon, 3 des 95 n'ont aucune
   position (« 3 hors scène » dans l'UI). Ils doivent être **exclus** du flux
   PSN, pas envoyés à (0,0).
7. **Première apparition d'un point** — s'il n'existe dans aucune formation
   antérieure, il n'y a pas de position de départ : le prototype le fait
   apparaître directement à sa cible. **À confirmer contre le comportement
   réel de Stancz.**

---

## 8. Piste majeure non traitée : le timecode entrant

L'appli sait *afficher* et *saisir* un timecode, mais en exploitation, la
prévisu doit se caler sur **la même horloge que le spectacle**. Trois voies :

- **LTC audio** — lib Python `libltc` / décodage maison depuis une entrée audio.
- **MTC (MIDI Timecode)** — via `python-rtmidi` / `mido`.
- **Art-Net Timecode** (`OpArtTimeCode`) — si la console ou le serveur en
  émet ; le plus simple sur un réseau déjà en Art-Net.

Vu ta stack (QLab, Reaper, MA3, Companion), une piste plus courte existe :
**piloter le transport via OSC** depuis Companion/QLab, sans décoder de
timecode du tout. À arbitrer selon qui est maître du show.

---

## 9. Questions ouvertes à trancher

| # | Question | Comment y répondre |
|---|---|---|
| 1 | **Noms exacts des courbes d'easing** dans le JSON | Ouvrir le projet dans Stancz, dérouler le menu « Linéaire » sur une formation, changer la courbe, ré-exporter et diffuser le JSON. Seul `"linear"` est confirmé. |
| 2 | Format de `stageFloorTexture` | Charger une image de sol dans Stancz, ré-exporter, inspecter le champ (data-URI ? entrée du zip ?). |
| 3 | Structure de `groups[]` | Créer un groupe dans Stancz, ré-exporter. |
| 4 | Comportement d'entrée d'un point absent des formations précédentes | Observer la lecture dans Stancz. |
| 5 | Depence reçoit-il du PSN ? | Doc Depence / test direct. |
| 6 | Convention d'axes attendue par ta prévisu | Test avec 1 tracker unique. |
| 7 | Qui est maître du timecode sur ce show ? | Décision d'exploitation (voir §8). |

Les questions **1 à 3 se résolvent toutes de la même façon** : faire une
manipulation dans Stancz, ré-exporter un `.stancz`, comparer les JSON. C'est
une demi-heure de manip qui sécurise tout le parsing.

---

## 10. Ressources — récapitulatif

**PSN**
- Spec v2.03 : <https://github.com/vyv/psn-cpp/blob/master/doc/PosiStageNetprotocol_v2.03_2019_09_09.pdf>
- `pypsn` : <https://github.com/open-stage/python-psn>
- `psn-cpp` : <https://github.com/vyv/psn-cpp>
- PSN dans MA3 : <https://help.malighting.com/grandMA3/2.2/HTML/remote_inputs_psn.html>

**Capture**
- Library Tab (Movers / Rotators / Motion Constructs) : <https://www.capture.se/Manual/en-UK/2024/LibraryTab.html>
- Appendix (tables DMX, protocoles) : <https://www.capture.se/Manual/en-UK/2024/Appendix.html>
- Universes Tab (connectivité) : <https://www.capture.se/Manual/en-UK/2024/UniversesTab.html>

**Depence**
- MVR : <https://help.depence.com/depence-construction/mvr>

**Bases open source candidates**
- OpenMarch (drill writing, AGPL-3.0) : <https://github.com/OpenMarch/OpenMarch>
- BlenderDMX : <https://blenderdmx.eu/> · <https://github.com/open-stage/blender-dmx>
- Theatre.js : <https://github.com/theatre-js/theatre>
- fabric.js · Konva.js · wavesurfer.js · Peaks.js · Tone.js · Electron / Tauri

**Stancz**
- Projet de test : <https://stancz.com/editor/o8IBHoZlfdwtNypeipiGx>

**Livrables**
- `stancz-psn-editor.zip` — l'application v0.1 (voir §11)
- `stancz-psn.zip` — l'ancien prototype web, **obsolète**, gardé pour mémoire

---

## 11. Ce qui est déjà construit — passation

Archive : **`stancz-psn-editor.zip`**. À décompresser dans `Documents`, puis
`git init` (les commandes exactes sont dans `SETUP_GIT.md` à la racine).

### 11.1 Arborescence

```
stancz-psn-editor/
├── README.md                 doc utilisateur + architecture
├── SETUP_GIT.md              init local et push GitHub
├── LICENSE                   MIT
├── pyproject.toml            paquet + entrée console `stanczpsn`
├── requirements.txt          PySide6, pypsn
├── requirements-dev.txt      + pytest, pyinstaller
├── packaging/
│   ├── stanczpsn.spec        spec PyInstaller (Windows + macOS)
│   └── README.md             pare-feu, quarantaine, réseau local macOS 15+
├── src/stanczpsn/
│   ├── __main__.py           point d'entrée + thème sombre (DARK_QSS)
│   ├── core/                 ← AUCUNE dépendance à Qt
│   │   ├── project.py        modèle, format .spsn, import_stancz()
│   │   ├── timeline.py       interpolation, easing, OutputTransform
│   │   ├── psn.py            encodeur PSN v2 + PsnSender
│   │   ├── timecode.py       parsing, ArtNetTimecodeReceiver, MidiTimecodeReceiver
│   │   └── engine.py         Transport (horloge) + PsnBroadcaster (thread)
│   └── ui/                   ← couche Qt uniquement
│       ├── main_window.py    menus, docks, transport, panneau Output
│       ├── stage_view.py     QGraphicsView, unités = centimètres
│       └── timeline_widget.py
└── tests/test_core.py        34 tests
```

**La séparation `core/` ÷ `ui/` est structurante** : `core/` n'importe jamais
Qt. C'est ce qui permet de changer d'interface (Electron, Tauri, CLI) sans
réécrire le moteur. À ne pas casser.

### 11.2 Décisions d'implémentation à connaître

- **Unités internes = centimètres**, origine coin haut-gauche, comme Stancz.
  La conversion en mètres n'a lieu **qu'à la sortie**, dans `OutputTransform`.
- **La scène du canvas est en centimètres** : `QGraphicsView` fait le zoom, on
  raisonne toujours en dimensions réelles.
- **Un point sans position connue n'est pas envoyé.** Jamais de repli sur
  (0, 0) — un projecteur fantôme au centre de la scène serait pire que rien.
- **ID de tracker PSN** = le numéro du point, surchargeable par point
  (`Point.psn_tracker_id`), avec repli sur l'index.
- **Les positions peuvent sortir de la scène** (coulisses) : aucun clamp.
- Les **alias d'easing français** (`linéaire`, `doux`, `rebond`, `ressort`,
  `exponentiel`) sont dans `EASING_ALIASES` — ce sont des **hypothèses**, voir
  §9 question 1.

### 11.3 Ce qui est réellement testé

```bash
PYTHONPATH=src python -m pytest -q     # 34 passed
```

Couvert : format PSN en aller-retour contre le parseur indépendant `pypsn`,
découpage des paquets (1 → 300 trackers, MTU et `packet_count`), interpolation
et cumul des segments, bornes des courbes d'easing, transformation de repère,
parsing timecode, décodage Art-Net TC, aller-retour du format `.spsn`.

L'application complète a aussi été lancée **en headless** (`QT_QPA_PLATFORM=offscreen`)
avec le vrai projet Hockey World Cup : 95 points et 3 formations importés,
timeline évaluée, 92 trackers PSN construits et redécodés.

### 11.4 Ce qui n'a JAMAIS été exécuté

À traiter en priorité, dans cet ordre :

1. **L'interface graphique sur un vrai écran.** Elle n'a tourné qu'en
   offscreen : aucune vérification visuelle, aucun test de mise en page,
   d'ergonomie ou de comportement au redimensionnement.
2. **Les binaires.** Le spec PyInstaller n'a jamais été exécuté — ni `.exe`,
   ni `.app`. Attendre des ajustements.
3. **Le réseau.** Aucun paquet PSN n'a été reçu par Capture, Depence ou une
   MA3. **Tester avec un seul point** avant de lancer les 92, et caler la
   convention d'axes à ce moment-là.
4. **Le timecode entrant.** `ArtNetTimecodeReceiver` et `MidiTimecodeReceiver`
   sont écrits et le décodage Art-Net est testé sur paquet synthétique, mais
   **aucun timecode réel** n'a jamais été reçu.

### 11.5 Chantiers suivants, par ordre de valeur

1. **Undo / redo** — absent, et ça se sentira dès la première session
   d'édition sérieuse. `QUndoStack` s'intègre naturellement à Qt.
2. **Forme d'onde audio sur la timeline** — l'audio est déjà extrait du
   `.stancz` (`Project.audio_path`) mais n'est ni lu ni affiché. C'est le
   principal manque face à Stancz pour caler à l'oreille.
3. **Lecture audio synchronisée** — `QtMultimedia` (exclu du spec PyInstaller
   pour l'instant : à réintégrer si on l'utilise).
4. **Sélection multiple et outils de formation** — aligner, répartir, cercle,
   ligne, V, grille. C'est ce qui fait gagner du temps dans Stancz.
5. **Sélecteur d'interface réseau par liste** plutôt que saisie d'IP à la main.
6. **Groupes de points** — dépend de la question 3 du §9.
7. **Export `.stancz`** — pour l'aller-retour avec Stancz. L'import existe,
   l'export non.

### 11.6 Pièges connus dans le code actuel

- `StageView.update_positions()` désactive temporairement
  `ItemSendsGeometryChanges` pour éviter une boucle entre l'animation de la
  timeline et le signal de déplacement manuel. Prudence si on touche à cette
  fonction.
- Les récepteurs de timecode appellent le callback **depuis leur thread**.
  `Transport` est protégé par un verrou ; toute nouvelle écriture d'état
  déclenchée par ces callbacks doit l'être aussi.
- `_store_positions()` écrit les positions **interpolées à l'instant courant**
  dans la formation sélectionnée. Utilisé au milieu d'une transition, il fige
  un état intermédiaire — c'est voulu, mais contre-intuitif.
- Le thème est **une seule constante** `DARK_QSS` dans `__main__.py`. Les
  couleurs du canvas et de la timeline sont en dur dans leurs widgets
  respectifs — c'est là qu'il faut intervenir pour appliquer une direction
  visuelle.

---

## 12. Session de conception fonctionnelle (2026-07) — V2, au-delà de l'import Stancz

**Contexte** : session de planification pure (aucun code écrit) menée pour définir
ce que doit devenir l'outil au-delà de "importer un `.stancz` et sortir du PSN".
Objectif affiché : un livrable en 24h — jugé irréaliste pour le périmètre complet
ci-dessous (voir §12.13) ; on vise un **MVP restreint**, le reste devient feuille de
route.

### 12.1 Modèle de données : cue/activation (remplace la "Formation" pure)

Le modèle séquentiel cumulatif de Stancz (§1.4) est **insuffisant** dès qu'on veut
des mouvements décalés/parallèles (l'équivalent de plusieurs playbacks de console
qui tournent en même temps, un `Go` n'attendant pas la fin du précédent). Nouveau
modèle, pensé comme une **cue lumière** :

- Un **bloc** posé sur la timeline a une **largeur/durée réelle affichée**, comme un
  clip de DAW — ce n'est pas qu'un point de départ.
- Il est **vide à la création**. On y **active** des cibles une par une (un acteur
  seul, ou un groupe). Chaque activation porte :
  - un mouvement **absolu** (position cible explicite) ou **relatif** (transform de
    groupe : translation, rotation) ;
  - son **propre temps de fade** (transition) — deux activations du même bloc
    peuvent avoir des temps différents, comme le timing par paramètre sur une
    console ;
  - une **courbe d'automation à points clés** dessinée sur le bloc lui-même (façon
    Myelin Director / DAW) pour façonner le fade in/out, plutôt que des chiffres
    cachés dans un inspecteur.
- Un acteur **non activé** dans un bloc garde sa dernière position connue
  (**tracking**, voir §12.2).
- Un bloc ne "possède" que les acteurs qu'il active explicitement →
  **rien n'empêche deux blocs de se chevaucher dans le temps**. C'est ce qui
  résout le besoin de mouvements décalés/parallèles, sans système de "pistes"
  séparé : le bloc/cue est déjà la bonne unité, juste sans contrainte de
  non-chevauchement.
- Le mouvement **relatif est un outil de saisie, pas un état persistant** : la
  position stockée/évaluée par acteur est **toujours absolue** au final.
- Ce modèle remplace `Formation` pour **tous** les déplacements, pas seulement
  ceux des groupes.

### 12.2 Groupes d'acteurs et animation relative

- Un acteur peut appartenir à **plusieurs groupes** (pas de partition stricte).
- Deux portées de groupe :
  - **Groupes globaux**, nommés, définis au niveau du roster, réutilisables sur
    n'importe quel bloc.
  - **Sélections locales/ponctuelles** attachées à un seul bloc, non nommées, pas
    besoin de les sauver pour un mouvement one-shot. Bouton **"Enregistrer comme
    groupe"** pour promouvoir une sélection ponctuelle en groupe global si elle
    sert finalement ailleurs.
- **Animation de groupe** = translation (A→B) et/ou rotation en degrés (peut
  dépasser 360°, plusieurs tours), autour d'un **pivot placé manuellement, façon
  compas** (propriété de l'animation, pas du groupe — un même groupe peut tourner
  autour de pivots différents selon la cue).
- **Résolution de conflit : LTP (Latest Takes Precedence)**, comme Pan/Tilt/Position
  sur une console. Le **dernier** groupe/activation qui touche un acteur donné
  gagne — y compris un groupe local de cue qui prend le pas sur un groupe global.
  Pas de flag bloquant dans ce cas ; un flag ne se justifierait que pour un vrai
  cas ambigu (deux activations qui démarrent **au même instant** sur le même
  acteur, sans "dernier" identifiable — comportement non détaillé, à définir).
- **Tracking après la fin de l'animation gagnante** : l'acteur garde sa position,
  comme une valeur sur une console lumière — pas de retour en arrière automatique
  vers un état antérieur.

### 12.3 Hauteur (Z) par acteur

Corrige/remplace le §4 : la hauteur n'est **pas une constante globale unique**
("hauteur de porté paramétrable") mais une **propriété par acteur, animable dans
le temps** — un projecteur peut être porté plus haut/plus bas qu'un autre, ou levé
à un moment du show. Alimente directement le champ Z envoyé en PSN.

### 12.4 Vue scène : un seul environnement 3D, quatre caméras

Un seul moteur de rendu 3D sert les deux usages — pas de canvas 2D et de vue 3D
comme deux systèmes séparés.

- **Dessus** — vue d'édition principale, caméra orthographique verrouillée,
  **rotation (lacet/yaw) éditable directement** ici.
- **Face** et **Côté** — caméras orthographiques verrouillées, pour éditer Z
  (hauteur) et la rotation là où la vue de dessus ne montre rien. Coût marginal
  quasi nul : ce sont d'autres préréglages de caméra sur la même scène (comme les
  vues Haut/Face/Droite de Blender), pas un système à part.
- **3D libre** — caméra perspective navigable, **non éditable**, pour un contrôle
  visuel ponctuel. Justification : la vérification "ça a l'air de quoi en vrai"
  se fait de toute façon **en direct sur la vraie prévisu** via le PSN envoyé
  pendant l'édition (§12.9) — la 3D libre n'est pas la surface de travail
  principale.
- **Terrain** : un terrain générique simple par défaut, plus un **import 3D
  (glTF 2.0)** pour un terrain réaliste texturé. Le glTF est **produit en amont**
  dans un outil comme Blender puis exporté — l'app ne fait qu'importer/afficher
  un glTF, elle **n'embarque jamais Blender lui-même** (Blender n'est pas conçu
  pour être une lib embarquable, et il est en GPL — l'embarquer serait un vrai
  problème de licence pour un produit fermé, voir §12.11).
- **Synergie utile** : un glTF de terrain peut porter nativement l'origine et
  l'orientation réelles du lieu, ce qui peut résoudre le point le plus casse-tête
  du §4 (caler la convention d'axes PSN) sans avoir à deviner puis tester avec un
  point unique.

### 12.5 Orientation ("sens") des acteurs

Les acteurs portent des **bâtons lumineux** : leur orientation compte autant que
leur position.

- **Icône = sphère + légère pointe directionnelle**, pas un simple point — visible
  immédiatement dans la vue de dessus. Convention déjà répandue pour les movers
  dans les logiciels de prévisu (flèche = axe du faisceau).
- **L'orientation devient une donnée de première classe, animable**, envoyée via
  le chunk PSN `PSN_DATA_TRACKER_ORI` qui existait déjà dans le protocole
  (§2.3) mais était classé "amélioration" optionnelle → **corrigé : obligatoire**,
  au même titre que la position.
- Deux modes de contrôle, plus un troisième supposé :
  1. **Focus** (acteur statique) — l'orientation vise un point cliqué sur la
     scène. Terme repris du vocabulaire lumière (viser un projecteur), à garder
     tel quel dans l'UI.
  2. **Suivi de trajectoire** (acteur en mouvement) — l'orientation suit
     automatiquement la tangente du déplacement.
  3. **Manuel/fixe** (hypothèse, non confirmée explicitement) — un cap choisi à la
     main, indépendant d'un point de focus ou d'une trajectoire.
- **Tracé vectoriel des trajectoires** — étend la "poignée de mi-parcours" de
  Stancz (une seule courbure) vers un vrai outil façon Illustrator : plusieurs
  points de contrôle/Bézier. Rend le mode "suivi de trajectoire" du sens
  réellement utile, la tangente variant le long d'un tracé riche.

### 12.6 Visualisation des trajectoires

- **Mode piloté par la sélection de bloc**, pas par un bouton séparé : aucun bloc
  sélectionné → vue live (temps réel, comme Stancz). Un bloc sélectionné → mode
  édition de ce bloc, trajectoires statiques disponibles.
- **Calcul du point de départ d'une trajectoire = résoudre la vraie chaîne de
  tracking** de cet acteur (le dernier bloc qui l'a réellement activé), **pas**
  simplement le bloc voisin précédent dans le temps — sinon le tracé affiché
  serait faux dès qu'un acteur a été "sauté" par un bloc qui ne le concernait pas.
- **Par défaut (bloc sélectionné, aucun acteur sélectionné) : toutes les
  trajectoires du bloc sont affichées.**
- Sélectionner un/des acteur(s) → **highlight au premier plan**, le reste reste
  visible mais atténué (contexte conservé).
- **Mode isolation** en plus du highlight : masque complètement tout le reste —
  utile si même atténué c'est encore trop chargé (jusqu'à 95 acteurs).
- **Dégradé de couleur le long de chaque trajectoire selon la vitesse
  instantanée** — réutilise le calcul déjà nécessaire pour le champ `SPEED` du
  PSN et pour la vérification de faisabilité (§12.7) : vert/bleu = lent, rouge =
  dépasse le seuil de vitesse humaine réaliste. Rend la vérification de vitesse
  visuelle et immédiate sur le tracé, pas juste une alerte séparée.
- **Option en vue live (hors édition)** : le tracé d'un bloc s'affiche
  automatiquement dès qu'il devient actif — activable indépendamment du mode
  édition.
- **Export vidéo = enregistrer ce qui est affiché en lecture live**, pas un
  système séparé — avec cette option de trajectoire auto activable pendant
  l'enregistrement.

### 12.7 Outils d'édition

- Sélection multiple par **lasso**, **copier/coller**, drag.
- **Snap/magnet** sur la grille + sur des **repères/guides spatiaux** (distinct
  des "Repères" de timeline du §12.8) — Stancz a déjà un champ `snapDistance`
  dans son format, dont le comportement exact reste à observer (§9, question
  ouverte non traitée dans cette session).
- **Alignement/distribution façon Illustrator + Capture** :
  - référence : bounding box de la sélection, centre de la scène/terrain, un
    acteur "ancre" (dernier sélectionné), ou le pivot manuel façon compas
    (réutilisé de §12.2) ;
  - axes X (gauche/centre/droite), Y-profondeur (haut/centre/bas), Z-hauteur en
    3D (bas/milieu/haut) ;
  - distribution par espacement égal, ou par nombre le long d'une ligne/arc/
    cercle — recoupe directement les formations prédéfinies déjà vues chez
    Stancz (ligne, cercle, V, grille), même moteur des deux côtés ;
  - miroir/flip de sélection, rotation autour du pivot ;
  - snap au sol/grille en plus du snap 2D.
- **Saisie numérique de la taille du terrain** (largeur/profondeur) + application
  d'une image de fond — vérifié dans le code v0.1 : le chargement d'image existe
  déjà (`_choose_floor_image`), la **saisie numérique de taille n'existe pas** (un
  nouveau projet prend une taille codée en dur) → vrai manque à combler.
- **Menu Préférences unique** pour l'I/O : device audio, device MIDI (pour MTC),
  interface réseau (pour PSN + Art-Net TC entrant) — aujourd'hui éparpillé entre
  plusieurs panneaux de la v0.1.
- **Code couleur d'état des acteurs, façon MA3** : **mauve** = immobile à
  l'instant courant (peu importe pourquoi), **vert cyan** = en mouvement à
  l'instant courant. Affiché à la fois dans la **vue scène** et dans la **liste
  Roster** (pastille d'état à côté du nom) — utile pour repérer un acteur déjà
  engagé ailleurs avant de l'activer dans un nouveau bloc qui chevauche.

### 12.8 Validation, export et documentation

- **Détection de collision/proximité** entre trajectoires à un instant donné —
  risque physique réel pour des porteurs de projecteurs en mouvement rapide, pas
  qu'une question esthétique.
- **Vérification de vitesse réalisable** (distance/durée vs vitesse humaine
  plausible) — réutilisée pour le dégradé de couleur du §12.6.
- **Vue tableau / feuille de conduite** façon "Table view" de Myelin Director ou
  feuille de cue de console : liste plate de tous les blocs/activations, éditable
  en grille, exportable en PDF pour la régie — complète la vue graphique, ne la
  remplace pas. Recoupe l'export "Scene sheets (PDF)" déjà vu chez Stancz.
- **Export vidéo** (recoupe l'export MP4 de Stancz), voir §12.6 pour le
  comportement des trajectoires pendant l'export.
- **Export "feuille perso" par acteur** — un document montrant uniquement le
  trajet d'UN acteur à travers tout le show, pour les porteurs de projecteurs pas
  forcément entraînés à lire un plan de scène global. **Reporté, pas prioritaire
  pour le MVP.**
- **Undo/redo** — **obligatoire**, déjà signalé critique dans le document
  d'origine (§11.5) et reconfirmé explicitement dans cette session. Non
  négociable, même pour un MVP restreint.
- **Écarté** : bouton "Go" manuel par bloc en lecture live (déclenchement
  indépendant du scrub/timecode) — jugé non pertinent par l'utilisateur.

### 12.9 PSN envoyé en direct pendant l'édition

Le panneau Output actuel (v0.1) a un bouton "Start PSN" pensé pour le mode show,
séparé de l'édition. **Nouveau besoin : l'envoi PSN doit pouvoir rester actif
pendant l'édition elle-même** (drag d'un point, scrub de la timeline), pour voir
le résultat en direct sur la vraie prévisu (Capture/MA3) **pendant** qu'on
construit la chorégraphie — pas seulement au moment de jouer le show. C'est cette
vérification en direct qui rend la vue 3D libre secondaire non-critique (§12.4).

### 12.10 Interface générale — disposition

Inspirée de Myelin Director (lui-même inspiré de Logic Pro) et de la capture
d'écran de l'éditeur Stancz réel :

```
┌──────────────────────────────────────────────────────────────────┐
│ Fichier  Édition  Affichage  Sortie             ⏵ 00:01:52.200   │ ← transport
├───────────┬──────────────────────────────────┬───────────────────┤
│ ROSTER     │                                  │  INSPECTEUR        │
│ (pastille   │        VUE SCÈNE                │  (contextuel selon │
│  d'état)    │  Dessus / Face / Côté / 3D libre │   sélection)       │
│            │                                  │                    │
├───────────┴──────────────────────────────────┴───────────────────┤
│ piste Repères   : ★INTRO     ★ENTREE RAPH     ★DANSEURS           │
│ piste Blocs/Cue : [bloc, courbe d'automation fade in/out]          │
│ piste Groupes   : [animation de groupe, chevauchement possible]    │
│ piste LED/média : [ cue 1 ][   cue 2   ]                           │
└──────────────────────────────────────────────────────────────────┘
```

- **Roster à gauche** (recherche/filtre, statut sur scène/hors scène, pastille
  d'état mauve/vert cyan, Créer/Importer) — confirmé conforme à l'UI Stancz
  réelle vue en capture d'écran.
- **Inspecteur contextuel à droite** — palette d'objets quand rien n'est
  sélectionné, propriétés dès qu'un objet est sélectionné (confirmé conforme à
  Stancz : couleur, largeur, profondeur, hauteur 3D, rotation pour un accessoire).
- **Timeline multi-pistes** façon Logic/Myelin (pistes empilées par nature
  d'objet), plutôt qu'une seule piste fourre-tout comme Stancz. Pistes de groupe
  repliables/colorées, nesting limité à 2 niveaux (repris de Myelin).
  Easing sélectionnable directement sur le bloc, pas seulement dans l'inspecteur
  (confirmé conforme à Stancz).
- **Panneau Output (PSN)** en dock séparé, pas toujours visible pendant
  l'édition — sauf que l'envoi lui-même doit pouvoir rester actif en tâche de
  fond pendant l'édition (§12.9), indépendamment de la visibilité du panneau.
- **Écarté** : le "Region Player" de Myelin (bouton play par repère pour
  déclenchement manuel en répétition) — recoupe le point écarté du §12.8 (Go
  manuel), jugé non pertinent.

### 12.11 Stack technique — remplace le choix du §5.4

Le §5.4 avait tranché PySide6/Qt en supposant une 3D en lecture seule. La 3D à
parité d'édition avec le 2D (§12.4) invalide cette hypothèse : Qt seul
(`QGraphicsView`) ne suffit plus, et l'écosystème "éditeur 3D avec gizmos" de Qt3D
est pauvre. **Décision révisée**, sous contrainte explicite de "future-proof
commercial" (l'app pourrait devenir un produit vendu) :

- **Frontend** : **Tauri** (coquille Rust + webview native de l'OS) + **React** +
  **react-three-fiber** / **drei** (scène 3D/2D unifiée : caméras ortho/
  perspective, gizmos de transform, chargement glTF, grille) + **wavesurfer.js**
  (+ plugin Regions, pour waveform et piste Repères) + **react-timeline-editor**
  (timeline multi-pistes à keyframes).
- **Backend** : le `core/` Python de la v0.1 (`project.py`, `timeline.py`,
  `psn.py`, `timecode.py`, `engine.py`) est **conservé tel quel** — confirmé sans
  aucune dépendance à Qt, déjà testé (34 tests), déjà validé contre `pypsn`. Il
  tourne en **sidecar local** (process séparé, packagé comme aujourd'hui via
  PyInstaller/`packaging/stanczpsn.spec`), communication via WebSocket local.
  Seul `ui/` (3 fichiers, spécifique à Qt) est abandonné et reconstruit dans la
  nouvelle stack.
- **Pourquoi Tauri plutôt qu'Electron** : Electron est plus rapide à câbler
  (Node peut lancer un sidecar Python en quelques lignes) mais embarque son
  propre Chromium (~150-200 Mo par install, mémoire élevée) — pas le standard du
  métier (MA3, Capture, Myelin Director sont tous natifs). Tauri (~10-20 Mo,
  webview native) colle mieux au niveau attendu par un public professionnel, et
  ouvre la voie à terme à une réécriture du moteur en Rust pour se passer
  complètement du sidecar Python si le produit décolle. Coût : un peu plus de
  friction pour empaqueter le sidecar (`externalBin` dans la config Tauri),
  ponctuel, pas récurrent.
- **Licences — tout compatible avec un futur produit fermé/commercial** :
  `react-three-fiber` (MIT), `drei` (MIT), `wavesurfer.js` (BSD-3),
  `react-timeline-editor` (MIT), Tauri (MIT/Apache-2.0). Rien d'AGPL comme
  OpenMarch/Theatre.js (§5.1/5.2, qui restent écartés pour cette raison). Le
  projet lui-même reste en licence MIT — toutes les options restent ouvertes
  (rester open source, fermer le code, double-licencier).

### 12.12 Ressources externes identifiées

| Ressource | Rôle | État |
|---|---|---|
| [`fiverecords/SuperTimecodeConverter`](https://github.com/fiverecords/SuperTimecodeConverter) | Outil **standalone** (C++/JUCE, MIT) à lancer à côté de l'app — convertit LTC / Pro DJ Link / StageLinQ vers **MTC** ou **Art-Net TC**, que la v0.1 sait déjà recevoir. **Élimine entièrement** le manque LTC du §8 sans écrire une ligne de code. | 124★, actif |
| [`pmndrs/react-three-fiber`](https://github.com/pmndrs/react-three-fiber) + [`pmndrs/drei`](https://github.com/pmndrs/drei) | Rendu 3D, caméras, gizmos, chargement glTF | ~9,7k★, très actif |
| [`katspaugh/wavesurfer.js`](https://github.com/katspaugh/wavesurfer.js) | Waveform audio + plugin **Regions** (= piste Repères) | 10,3k★, très actif |
| [`xzdarcy/react-timeline-editor`](https://github.com/xzdarcy/react-timeline-editor) | Timeline multi-pistes à keyframes | 775★, MIT, correct mais plus modeste — à surveiller |
| [`open-stage/python-psn`](https://github.com/open-stage/python-psn) | Référence de validation croisée uniquement (déjà utilisée dans les tests v0.1) | 4★, pas une dépendance de prod |

**Constat honnête** : il n'existe pas d'appli "éditeur 3D" toute faite à forker
pour ce créneau précis (les résultats trouvés sur ce point sont à 0-3★, souvent
générés par IA, pas fiables comme fondation). On assemble à partir de briques
matures et éprouvées, pas d'un template complet.

### 12.13 Ce qui reste ouvert / non tranché dans cette session

- **Objectif "24h" jugé irréaliste** pour le périmètre complet ci-dessus, même en
  s'appuyant au maximum sur les briques du §12.12 — décision prise : **MVP
  restreint**, le reste devient feuille de route. **Le contenu exact du MVP n'a
  pas encore été défini** (quelles fonctions du §12 sont dedans/dehors).
- Tangage/roulis de l'orientation (au-delà du lacet) : je pars du principe que
  seul le lacet compte pour un bâton porté à la main — **non confirmé
  explicitement**.
- Mode "manuel/fixe" du sens (§12.5, point 3) : ajouté par hypothèse, **non
  confirmé explicitement**.
- Comportement en cas de **conflit LTP simultané** (deux activations démarrant au
  même instant sur le même acteur, sans "dernier" identifiable) — non défini.
- Détail de l'algorithme de collision (seuil de distance ? par paire d'acteurs ?
  où l'alerte s'affiche-t-elle ?) — non défini.
- Valeur par défaut et réglage du seuil de vitesse réaliste — non défini.
- Contenu exact de la vue tableau (colonnes, édition inline ?) — non défini.
- Détails d'implémentation du packaging Tauri + sidecar Python — non abordés.
- **Le §9 de la partie historique (questions ouvertes sur le format `.stancz` :
  noms des courbes d'easing, `stageFloorTexture`, `groups[]`, comportement d'un
  point absent des formations précédentes) reste entièrement d'actualité et n'a
  pas été traité dans cette session.**
