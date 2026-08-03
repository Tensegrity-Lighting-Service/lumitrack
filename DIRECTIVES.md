# DIRECTIVES.md — Supervision du développement Lumitrack

**Qui écrit ici** : le superviseur (session Claude/Cowork pilotée par Florian),
qui relit le code, teste l'application **en vrai** (souris/clavier sur la
fenêtre Lumitrack) et confronte chaque livraison à la barre de qualité du
projet : **timeline Logic Pro / Myelin Director, manipulation 2D/3D After
Effects, vocabulaire grandMA** (CONCEPTION.md, intro + §12/§13).

**À qui ce fichier s'adresse** : à qui code, quel qu'il soit. Depuis le
2026-07-28 au soir, **le superviseur code lui-même** (décision de Florian) —
le fichier reste le journal de bord : missions, critères d'acceptation,
verdicts. Si un Claude VSCode reprend un jour la main : prendre la première
mission non terminée, dans l'ordre.

**Boucle de travail** :

1. Tu exécutes la mission en cours (commits ciblés, messages clairs).
2. À la fin : `pytest` vert, `npm run build` propre, mise à jour de
   CONCEPTION.md §14 si l'état documenté change, et coche la mission dans la
   section « État » ci-dessous. Puis **arrête-toi** et demande la revue.
3. Le superviseur relit le diff, teste l'UI en conditions réelles, et écrit
   son verdict ici (✅ validé / 🔴 corrections demandées + détail).

**Règles invariantes** (jamais négociables, quelle que soit la mission) :

- Backend-autoritaire (§13.1.7) : aucune interpolation ni horloge côté
  frontend ; toute résolution temporelle/spatiale se fait dans `core/` Python.
- `core/` reste sans dépendance UI, couvert par des tests.
- Positions jamais clampées aux limites de la scène ; point sans position
  connue jamais envoyé en PSN.
- Licences : contrainte « permissif uniquement » **levée le 2026-07-29**
  (décision Florian : pas de produit commercial fermé, GPL acceptable). La
  stack actuelle reste tout-MIT/Apache de fait. Friction (GPL-3) demeure
  écarté comme base de code pour raison purement technique (moteur 2D
  vectoriel sans rapport avec le métier) — conservé comme référence UX.

---

## Inspection UI du 2026-07-28 (superviseur) — constats

Première vraie session d'usage humain-supervisé de l'app (la priorité n°1 du
§14.5). Lecture, seek par la règle, sélection de cue, drag d'acteur, saisie
inspecteur, zoom viewport : tout fonctionne de bout en bout — bravo pour le
socle. Quatre écarts sérieux avec la barre visée, par gravité décroissante :

1. **🔴 BUG — Les champs numériques de l'inspecteur se font écraser par le
   round-trip WebSocket pendant la saisie.** Taper `5000` dans X donne `50` ;
   retenter dans Y a produit `10100` (caret déplacé par le re-render, saisie
   insérée au mauvais endroit). Cause : `onChange` à chaque frappe →
   `setActivation` → broadcast `project` → l'input contrôlé est réécrit en
   pleine frappe. Reproduit à 100 % sur la table d'activations du CueInspector.
2. **🔴 PIÈGE UX — Édition muette hors du contexte temporel du bloc.** Bloc
   « Entree » (0→4 s) sélectionné, playhead à 8 s : un drag d'acteur écrit la
   cible dans le cue (visible dans l'inspecteur) mais **rien ne bouge à
   l'écran** — l'instant affiché est gouverné par un autre cue. Aucun feedback,
   modification silencieuse de données invisibles. C'est l'anti-pattern exact
   que le mode d'édition de bloc du §12.6 doit empêcher : dans After Effects on
   ne modifie jamais un keyframe qu'on ne voit pas.
3. **🟠 Lisibilité des acteurs.** Au zoom « fit » sur l'arène, un acteur fait
   ~5 px : à peine visible, et la pointe directionnelle (cône vu de dessus =
   un petit rond) est illisible. Les poignées de zone ont déjà résolu ce
   problème (taille écran constante via `useFrame`/`camera.zoom`) ; les
   acteurs doivent bénéficier de la même technique (taille écran minimale),
   avec un marqueur de direction plat type flèche/triangle au sol, lisible du
   dessus (convention movers des logiciels de prévisu, §12.5).
4. **🟠 Transport/timeline en dessous de la barre Logic/Myelin.** Scrub =
   `<input type="range">` natif ; timecode non éditable ni cliquable ; pas de
   retour-à-zéro ; règle en secondes nues (pas de HH:MM:SS) ; aucun zoom
   horizontal de timeline ; waveform (quand il y a de l'audio) dans un
   composant séparé, sans règle ni zoom partagés avec la piste de cues.

---

## Missions

### Mission 1 — Mode édition de bloc + trajectoires (barre After Effects)

Réfs : §12.6, §13.1.11, constat n°2. C'est le chantier prioritaire choisi par
Florian (« Trajectoires qualité AE »).

- **Sélectionner un bloc fait entrer la scène en mode édition de ce bloc**
  (§12.6) : la scène affiche les **cibles** des activations du bloc et les
  **trajectoires statiques** de chaque acteur activé — chemin du point de
  départ réel à la cible.
- **Point de départ = résolution de la vraie chaîne de tracking** côté Python
  (le dernier cue qui a réellement activé l'acteur avant ce bloc — pas le bloc
  voisin) : nouvelle commande sidecar du type `resolve_block_context`, jamais
  de calcul dans le frontend. Tests pytest sur cette résolution (acteur sauté
  par un bloc intermédiaire, chevauchements, LTP).
- **Drag d'acteur en mode édition = déplacer la cible, avec preview visible** :
  ghost/marqueur à la position cible + trajectoire mise à jour en direct. Plus
  aucune édition sans retour visuel possible.
- Acteurs sélectionnés en **surbrillance**, le reste atténué mais visible
  (§12.6) ; l'état live (positions à l'instant du playhead) reste affiché en
  parallèle, discret.
- Trajectoires : polyline échantillonnée par le backend suffit pour cette
  mission (l'éditeur Bézier/tracé vectoriel du §12.5 viendra après) — mais la
  structure de données envoyée doit déjà distinguer chemin spatial et timing
  (§13.1.11).

**Acceptation** : le scénario du constat n°2 devient impossible à reproduire
(toute édition a un feedback immédiat dans la scène) ; trajectoires visibles
et correctes pour un projet avec cues chevauchants ; `pytest` couvre la chaîne
de tracking ; aucune interpolation frontend.

### Mission 2 — Inspecteur fiable + saisie numérique pro

Réfs : constat n°1, §12.7.

- Inputs numériques avec **état local d'édition** : commit sur Enter/blur,
  Échap annule, plus jamais écrasés par un broadcast en cours de frappe.
- Incréments clavier (flèches haut/bas, Maj = ×10) et, si raisonnable, drag
  horizontal sur le label façon After Effects.
- Exposer dans l'inspecteur ce que le modèle supporte déjà : **Z (hauteur)**,
  **lacet (yaw)**, **easing par activation**.

**Acceptation** : taper `5000` donne toujours `5000`, quelle que soit la
cadence des ticks ; Échap restaure la valeur d'avant ; Z/yaw/easing éditables
et pris en compte dans la lecture.

### Mission 3 — Finitions desktop

Réfs : constat n°4 (transport), §13.1.10, choix « Finitions desktop ».

- **Dialogues fichiers natifs Tauri** (plugin dialog) pour : nouveau projet,
  import `.stancz`, ouvrir/enregistrer le bundle, import glTF/audio.
  Suppression de tous les `window.prompt`.
- **Undo/redo** — le « non négociable » du §13.1.10, toujours absent :
  historique côté **sidecar** (backend-autoritaire oblige), commande
  `undo`/`redo` exposée, Ctrl+Z / Ctrl+Maj+Z au frontend, menu Édition.
  Couvrir par des tests (édition → undo → état identique à l'original).
- **Rotation (lacet) à la souris** sur l'acteur sélectionné en mode édition
  de bloc (poignée de rotation, cohérente avec celle de la zone de jeu).
- Transport : timecode cliquable/éditable, bouton retour-à-zéro, scrub stylé
  (pas le `<input range>` natif).

**Acceptation** : plus un seul `window.prompt` ; Ctrl+Z fonctionne sur drag
d'acteur, saisie inspecteur, création/suppression/déplacement de cue ; la
rotation d'un acteur est éditable à la souris et part en PSN (`TRACKER_ORI`).

### Mission 4 — Timeline pro (barre Logic Pro / Myelin Director)

Réfs : constat n°4, §12.10, §12.1.

- **Zoom horizontal** (Ctrl+molette + boutons) et scroll, **règle en
  HH:MM:SS** avec graduations adaptatives.
- **Waveform et cues sous la même règle** : zoom/scroll partagés, alignement
  au pixel (aujourd'hui deux composants indépendants).
- **Piste Repères** (markers nommés, posables au playhead — §12.10).
- **Courbe de fade dessinée sur le bloc** (automation à points clés, §12.1) —
  au minimum l'affichage de la courbe d'easing existante sur le bloc.
- **Avant d'implémenter** : livrer dans DIRECTIVES.md un court verdict —
  `@xzdarcy/react-timeline-editor` peut-il porter tout ça (zoom dynamique,
  règle custom, pistes hétérogènes, rendu de courbes sur blocs), ou faut-il
  une timeline canvas maison ? Décision supervisée avant le gros du code.

**Acceptation** : zoomer/scroller garde waveform, blocs, repères et playhead
alignés au pixel ; les repères sont sauvegardés dans le bundle ; verdict
timeline documenté et validé par le superviseur.

---

## État

- [x] Mission 1 — Mode édition de bloc + trajectoires *(✅ validée en UI le
  2026-07-28 soir, voir verdict)*
- [x] Mission 2 — Inspecteur fiable *(✅ validée en UI le 2026-07-28 soir,
  codée par le superviseur, voir verdict)*
- [ ] Mission 3 — Finitions desktop (dialogues natifs, undo/redo, rotation)
  *(mission courante — undo/redo livré le 2026-07-31, voir note ci-dessous ;
  restent : 2 `window.prompt` (nouveau projet, renommage de bloc dans
  CueTimeline.tsx) et à vérifier si la rotation souris existe déjà pour un
  acteur seul en mode édition de bloc, distincte de la boîte de
  transformation multi-sélection déjà livrée)*
- [ ] Mission 4 — Timeline pro

## Verdicts du superviseur

### Mission 1 — 2026-07-28 — ✅ VALIDÉE (code + UI)

Mise à jour du soir : test UI complet effectué sur l'app relancée, tout est
conforme. Sélection de « Rassemblement » → 3 trajectoires du bon départ
(cibles d'« Entree ») vers les cibles, ghosts anneau+tick à taille écran
constante. **Scénario du constat n°2 rejoué : bloc sélectionné, playhead
gouverné par un autre cue, drag du ghost → le ghost et sa trajectoire
suivent la souris en direct, l'acteur live ne bouge pas — plus aucune
édition muette.** Cue yaw-seul « Contre-jour » : ghost sans trajectoire,
axes non touchés affichés « — ». Emphase par sélection OK (surbrillance +
atténuation), et la retouche du point c (acteur sélectionné hors bloc → tout
en normal) vérifiée. Le verdict initial ci-dessous est conservé pour
l'historique :

a) **Revue de diff (92aaa6f, ae3a2d3, afaf48c) : conforme.** La résolution de
   chaîne de tracking réutilise l'ordre LTP du moteur de lecture au lieu de le
   réimplémenter ; la commande `resolve_block_context` est en lecture seule et
   répond au seul demandeur (leçon du bug seek bien retenue) ; la scène ignore
   un contexte périmé (`blockContext.cueId === selectedCueId`) ; chemin spatial
   et timing sont bien séparés (§13.1.11). Suite de tests **reproduite
   indépendamment par le superviseur : 57 verts.**

b) **Test UI interrompu** : au moment de la vérification, le serveur de dev
   était arrêté (fenêtre ERR_CONNECTION_REFUSED). À la prochaine relance, le
   superviseur vérifiera : le scénario du constat n°2 (bloc sélectionné,
   playhead hors bloc, drag → ghost/trajectoire suivent), le cue yaw-seul
   « Contre-jour » (ghost sans trajectoire, tick à 225°), et la fluidité du
   double aller-retour pendant un drag de ghost. Ne pas re-stopper le dev
   server en fin de session : le superviseur ne peut pas le relancer.

c) **Décision sur le choix d'interprétation soulevé** : quand l'acteur
   sélectionné n'est **pas** activé dans le bloc, ne pas tout atténuer —
   traiter comme « aucune sélection » (tout en `normal`). L'atténuation
   générale donne l'impression d'un état désactivé sans rien mettre en avant.
   Retouche à faire en ouverture de Mission 2.

d) Non bloquant, à garder en tête : le conflit LTP à départ strictement
   simultané reste non défini (§12.13) — l'ordre actuel (tri stable par
   start_ms) est accepté comme comportement de fait pour l'instant.

### Mission 2 — 2026-07-28 soir — ✅ VALIDÉE (codée par le superviseur)

- **`ui/NumericInput.tsx`** : champ numérique à état local — tant que le
  champ a le focus, le brouillon appartient à l'utilisateur, un écho
  `project` du sidecar ne le réécrit jamais. Commit sur Entrée/blur, Échap
  annule, flèches ±step (Maj ×10), virgule décimale acceptée, focus+blur
  sans modification n'envoie rien (pas d'arrondi involontaire de la valeur
  serveur). Vider un champ X/Y/Z/lacet committe `null` = axe détouché, il
  repasse en tracking (§12.1).
- **Inspecteur** : la table 4 colonnes devient des **cartes d'activation**
  exposant tout le modèle — X, Y, Z, lacet, fade, courbe d'easing (liste
  miroir de `EASING_NAMES`). Le clic sur la carte sélectionne l'acteur.
- Mêmes champs sûrs dans le panneau Zone de jeu et la taille de grille.
- `sidecar.ts::setActivation` accepte `null` (détoucher un axe).
- **Test UI** : « 2500 » tapé d'une traite reste « 2500 » (l'ancien bug
  donnait « 25 ») ; le ghost suit la valeur committée immédiatement.
- **Vérifié** : `tsc` propre, `vite build` OK, 57 tests pytest verts
  (aucun changement Python dans cette mission).

### Note d'exploitation dev (2026-07-28 soir)

- Trois faux départs au relancement : d'abord un sidecar orphelin sur le
  port 17845 (fenêtres zombies, point de connexion rouge), aggravé par le
  superviseur qui relançait des instances via son outil d'ouverture
  d'application — à ne plus faire : observation passive par captures.
- **Fix durable** : `Lancer Lumitrack (dev).bat` tue désormais tout
  processus à l'écoute sur 17845 avant de démarrer.
- **Règle** : ne jamais fermer la fenêtre de terminal du .bat pendant
  l'utilisation — elle héberge Vite + Tauri + sidecar ; la fermer tue tout
  en laissant la fenêtre Lumitrack zombie à l'écran.


---

## Décision d'architecture — 2026-07-28 (soir) : moteur Rust intégré

Arbitrage final de Florian (après avoir envisagé la réécriture native
complète) : **le moteur Python est réécrit en Rust À L'INTÉRIEUR du
processus Tauri ; l'interface React/react-three-fiber actuelle est
conservée.** Résultat visé : UN seul processus, UN seul `Lumitrack.exe`,
plus de sidecar Python, plus de WebSocket, plus de port local — le ressenti
« serveur web avec une façade » disparaît, sans jeter l'UI validée
aujourd'hui (trajectoires, ghosts, timeline maison, inspecteur).

Friction (friction.graphics) : retenu comme **référence UX** (timeline,
graph editor) — écarté comme base de code (GPL-3.0, critère §12.16, et
moteur 2D vectoriel hors sujet).

La suite pytest Python (58 tests) reste l'ORACLE du port. L'app actuelle
(sidecar Python) reste l'app de travail jusqu'à la bascule.

### Phases

- [x] **N0 — Moteur Rust : modèle + résolution** *(fait 2026-07-28 : crate
  `native/lumitrack-engine` — modèle serde au format fil camelCase (bundles
  existants lisibles tels quels), easing, résolution LTP 4 axes, contexte
  de bloc. 14 tests portés + **parité contre l'oracle Python** via fixture
  générée (`native/tests/generate_parity_fixture.py`) : identité à 1e-6.)*
- [x] **N1 — Moteur Rust : PSN + timecode + transport** *(fait 2026-07-29 :
  encodeur PSN v2 **byte-identique** au Python (fixture hex à timestamp
  figé : DATA/INFO, découpage MTU, Unicode, 92 trackers, cas vide),
  émetteur UDP multicast (socket2 pour IP_MULTICAST_IF), parsing/formatage
  timecode, décodage Art-Net OpTimeCode, décodeur MTC pur (quarter+full
  frame), Transport à horloge injectable, OutputTransform. `cargo test` :
  26 verts au total. Les threads d'E/S (socket Art-Net, port MIDI) seront
  branchés en N2 avec l'intégration Tauri.)*
- [ ] **N2 — Intégration Tauri** : le crate devient le backend du process
  Tauri (commands + events remplacent le WebSocket) ; `sidecar.ts` garde la
  même interface côté React, seul son transport change. Le sidecar Python
  n'est plus lancé.
- [ ] **N3 — Bascule + packaging** : retrait du code Python de l'app,
  `tauri build` → exe unique + installeur, icône, plus aucun terminal.
  Undo/redo s'implémente directement dans le moteur Rust (historique
  d'états), les dialogues natifs Tauri remplacent les window.prompt.

### Mission graph editor + lien blocs (2026-07-29) — LIVRÉE

Décision de Florian après l'examen du code de Friction
(rapport-friction-code.md) : Friction/Natron restent écartés comme base de
code ; leur graph editor (KeysView, ~3 900 l. mesurées) devient le CAHIER
DES CHARGES du nôtre. Réalisé :

- **Moteur** : courbes d'easing PAR AXE sur les activations (`curves`
  {x|y|z|yaw: [nœuds]}, nœud = t/v + poignées Bézier absolues + mode).
  Évaluation par bissection façon CSS cubic-bezier (`eval_curve`), repli sur
  l'easing nommé — bundles existants inchangés. Python (`timeline.py`) ET
  Rust (`native/src/curve.rs`) ; fixture de parité régénérée avec 40
  activations à courbes — Rust identique à 1e-6. 64 tests pytest + 30 cargo.
- **UI** : piste « Courbes » DANS la timeline (bouton quand un bloc est
  sélectionné) — même pxPerMs/scroll/playhead que les blocs, zone de fade
  teintée, zone de maintien, lignes départ/cible. Multi-courbes par axe
  (couleurs X/Y/Z/Lacet), axe actif éditable : drag de nœuds et de poignées
  (modes coin/lisse/symétrique), double-clic = insertion de nœud (découpe de
  Casteljau, forme préservée), Suppr = retrait, easing prédéfini appliqué à
  l'axe (les 4 classiques exacts, les autres échantillonnés puis lissés),
  Linéaire/Lisser, copier/coller de courbe, « → tout le bloc », Réinit
  (retour à l'easing nommé). Édition optimiste, commit au lâcher via
  `set_activation {curves}` (§13.1.7 respecté).
- Le port N2 devra brancher ces courbes telles quelles (déjà dans le moteur
  Rust). À tester à la relance : timeline+son (reste dû) + graph editor.

### Mission tracés courbes dans la scène (2026-07-29) — LIVRÉE

Correction de cap par Florian après la livraison du graph editor : « les
courbes que je voulais c'est sur le TRACÉ » — c'est-à-dire le motion path
d'AE dans la vue scène, pas (seulement) la courbe valeur/temps. Les deux
coexistent désormais : la piste Courbes de la timeline = profil de vitesse ;
le tracé dans la scène = géométrie du chemin. Réalisé :

- **Moteur** : `Activation.pathPoints` (waypoints absolus + poignées Bézier
  RELATIVES) + `startHandle`/`targetHandle` (offsets sur le départ dynamique
  et la cible). Évaluation `path_position` : segments cubiques 2D, poignée
  absente = tiers de corde, vitesse constante par table de longueur d'arc
  (PATH_LUT_STEPS=24/segment, même constante Rust). Résolution : quand le
  même cue gouverne x ET y en plein fade, la position vient du tracé (profil
  de vitesse = courbe/easing de l'axe X) ; si le LTP vole un axe, retour à
  la résolution par axe. Block context : échantillonnage courbe. Python +
  Rust, fixture régénérée (39 tracés) — parité 1e-6. 69 pytest, 33 cargo.
- **Scène** : sur l'activation mise en avant — waypoints (losanges taille
  écran), poignées départ/cible toujours visibles, poignées du waypoint
  sélectionné, drag plan-sol avec la mécanique existante (symétrie des
  poignées, Alt = casser), **double-clic sur le tracé = insertion**, Suppr =
  retrait (capture AVANT le raccourci qui supprime le bloc — même correction
  appliquée au graph editor), Échap = désélection. Inspecteur : bouton
  « Tracé droit ». Le tracé affiché reste backend-échantillonné (§13.1.7).

### Mission multi-sélection + transport (2026-07-29) — LIVRÉE

Demandes de Florian après validation des tracés courbes :

- **Roster multi-sélection** : Ctrl/Cmd-clic = bascule, Shift-clic = plage,
  clic nu = simple. Sélection ORDONNÉE (le dernier cliqué est le principal :
  inspecteur, graph editor, mise en avant scène). En-tête du roster : champ
  N + bouton « + Acteurs » (ajout en lot, numérotation continue).
- **Timing groupé** : panneau dans l'inspecteur dès que >1 acteur
  sélectionné avec un bloc actif — fade (ms) et easing appliqués d'un coup à
  toutes les activations des sélectionnés dans le bloc (valeur affichée =
  commune, sinon « mixte » ; les non-activés ne sont pas touchés, compte
  affiché).
- **Transport déplacé** : l'ancienne barre du haut (play + scrub + timecode)
  est SUPPRIMÉE — le scrub était redondant avec la règle. Play/pause,
  pastille de connexion et timecode vivent maintenant dans la barre de la
  timeline, sous le roster. Espace fonctionne toujours.

Hiérarchie du roster : LIVRÉE le 2026-07-31, voir en fin de fichier
« Mission hiérarchie du roster ». Portée réduite par rapport au souhait
initial (sous-groupes organisationnels seulement, pas d'appartenance
multiple ni de groupes animables — voir §12.2, reporté en v1.1).

### Mission timeline pro + entrées scène + fichiers (2026-07-29) — LIVRÉE

Trois demandes de Florian traitées ensemble :

- **Timeline multi-pistes** : `Cue.lane` persistant (Python+Rust+format,
  migration des projets sans lane par l'ancien empaquetage glouton). Blocs
  placés librement : drag vertical = changement de piste, piste vide
  permanente en bas pour déposer, min 3 pistes, en-têtes « Piste N ».
  Grille temporelle en arrière-plan alignée sur la règle (majeures +
  mineures), snap à la sous-graduation (Alt désactive). Polish « Logic » :
  bandes alternées, transitions douces sur les blocs (jamais pendant le
  drag), playhead lissé (transition 90 ms entre ticks 30 Hz) avec triangle
  et halo, ombres/hover.
- **Entrées scène 2026** : clic gauche = LASSO de sélection (rectangle
  écran, Ctrl = additif, projection des acteurs via la caméra), clic droit
  OU gauche+droit = pan (chord pan manuel, menu contextuel neutralisé),
  molette = zoom curseur, tactile : 1 doigt = sélection/drag, 2 doigts =
  pincement zoom + pan (MapControls touches). Multi-sélection surlignée.
- **Fichiers** : drag & drop sur la fenêtre (audio -> piste, .stancz ->
  import, .lumitrack/.bundle -> ouvrir ; événement natif Tauri, vrais
  chemins). Menus : vrais dialogues fichiers (tauri-plugin-dialog ajouté :
  Cargo.toml + lib.rs + capability + npm) à la place des window.prompt
  (restent : nouveau projet, renommage — dialogues texte à traiter en
  Mission dialogues natifs). Le .bat fait désormais `npm install` à chaque
  lancement (nouvelles dépendances auto-installées).

### Mission autosauvegarde (2026-07-29) — LIVRÉE

Sauvegarde de session CONTINUE (pas « au quit » : la fermeture kill le
sidecar sans lui laisser de handler sous Windows). Boucle asyncio : écrit
`%APPDATA%/Lumitrack/autosave.json` ~2 s après chaque mutation (flag dirty
armé sur tout broadcast de projet + set_project), écriture atomique
tmp+replace. Au démarrage : reprise de l'autosave si présente, sinon démo.
JSON simple, médias en chemins absolus (pas un bundle : pas de copie ni de
versions/ qui gonfle). Les bundles explicites restent inchangés.

### Validation PSN contre le SDK officiel (2026-07-29)

Florian a pointé posistage.net : spec 2.03 + SDK de référence VYV
(psn-cpp, MIT). Harnais `native/tests/official/` : le décodeur OFFICIEL
décode nos paquets (7 datagrammes, découpage MTU 92 trackers, Unicode) —
92 trackers vérifiés à 1e-5, constantes et version de header (2.0)
identiques à psn_defs.hpp. L'encodeur est conforme PSN 2.x selon
l'implémentation de référence, plus seulement selon pypsn. Chunks
optionnels non émis notés dans le README (SPEED en premier candidat).

### Mission boîte de transformation 2D (2026-07-29) — LIVRÉE

Arbitrages de Florian (AskUserQuestion) : sous-timeline = bandeau dans la
timeline ; ordre de cascade = ordre de sélection 2D ; boîte de transfo
d'abord. Livré :

- **SelectionBox** : dès 2 acteurs sélectionnés avec un bloc actif —
  rectangle englobant pointillé, 4 poignées d'échelle aux coins (échelle
  LIBRE autour du centre, coin opposé comme référence), poignée de rotation
  au-dessus (taille écran constante).
- **Rotation → arcs** : `scene/transformBox.ts::rotationArc` — arc de
  cercle exact converti en Béziers (segments <= 90°, poignée k=(4/3)tan(Δ/4)r),
  écrit au LÂCHER dans pathPoints/startHandle/targetHandle de chaque
  activation + rotation du lacet du même angle. Pendant le geste : cibles
  seules (léger). Chaque acteur suit son arc autour du pivot commun — pas
  de ligne droite.
- Échelle/translation : trajets directs (pas d'arcs), tracés existants non
  touchés par l'échelle.

**À FAIRE ENSUITE (validé par Florian, spec arrêtée)** : sous-timeline de
bloc — double-clic sur un bloc -> bandeau dans la timeline, une rangée par
acteur (barre délai+fade + courbe), time-stretch d'une sélection de
rangées, cascade de délais dans l'ORDRE DE SÉLECTION 2D (selectedPointIds
est déjà ordonné). Nécessite `Activation.delayMs` au modèle (Python + Rust
+ parité + block context) : un acteur peut démarrer après le début du bloc.

### Mission panneau PSN + conformité d'axes (2026-07-29) — LIVRÉE

Question de Florian (« dans Capture Y c'est l'axe vertical ») vérifiée dans
la spec officielle 2.03 (PDF dans psn-cpp/doc, p.8) : « positive x is
right, positive y is up, positive z is depth » — **Y VERTICAL est la
convention officielle** (MA Lighting co-auteur). Deux corrections de
conformité + panneau complet :

- **Moteur** : `transform_up_axis` ("y" défaut conforme / "z" héritage) —
  `OutputTransform.to_psn` envoie (x, hauteur, profondeur) en Y-up ; ORI
  corrigé en VECTEUR AXE-ANGLE (spec p.9) : le lacet porte sur ori_y en
  Y-up (avant : toujours ori_z, non conforme). Tracker Python/Rust : champs
  ori_x/y/z. Nouveaux champs projet : psn_iface_ip, psn_rate_hz. Fixtures
  octets régénérées, 70 pytest + 34 cargo verts, harnais SDK officiel
  revalidé (92 trackers, lacet vérifié sur ori_y).
- **Sidecar** : update_psn_config (tout voyage avec le projet),
  list_ifaces (énumération IPv4 locales), psn_preview (moniteur : MÊME
  build_trackers que l'émission), update_point (ID PSN, nom, n°, couleur,
  hauteur).
- **Panneau** (menu Sortie → Réglages PSN…) : état/start-stop/compteur de
  trames, carte réseau (liste détectée), multicast/port/nom/fréquence,
  repère (axe vertical Y/Z avec note spec, origine, inversions, swap),
  table des trackers (ID PSN éditable par acteur, ID émis résolu),
  moniteur live 2 Hz (pos_x/y/z + ori, colonne verticale surlignée ↑).

ATTENTION changement de sortie : les projets existants passent de Z-up à
Y-up par défaut — c'est la correction de conformité ; l'option Z reste dans
le panneau pour les outils qui dévient.

### Fix reprise entre blocs + unités m/s (2026-07-29)

Bug signalé par Florian : téléportation quand un bloc démarre pendant le
fade d'un autre. Cause : l'origine d'un keyframe gouvernant était la CIBLE
brute du précédent. Fix (Python + Rust, parité régénérée) : l'origine est
désormais la position RÉSOLUE à l'instant du départ du keyframe (récursion
sur la chaîne des prédécesseurs) — appliqué à la résolution par axe, au
tracé spatial ET au départ affiché du block context. Blocs séquentiels :
comportement inchangé. Tests : continuité au handoff (72 pytest, 34 cargo).
NOTE sémantique : ce n'est plus le LTP-cible strict des consoles — c'est le
« fade from current » attendu par Florian ; documenté ici comme choix.

Unités : AFFICHAGE en mètres (X/Y/Z, zone, grille, origines PSN) et
secondes (fades) — le modèle interne reste cm/ms, conversions dans les
champs uniquement. Moniteur PSN déjà en mètres (protocole).

### Mission zones backstage (2026-07-29) — LIVRÉE

Demande de Florian (acteur ajouté invisible) + concept validé par
AskUserQuestion : zone par défaut créée par projet, placement en grille
auto, drop sans bloc = bloc créé au playhead.

- **Modèle** : `Project.backstage_zones` [{id,name,xCm,yCm,widthCm,
  heightCm}], `Point.home_zone_id`, `ensure_backstage()` (zone « Backstage »
  par défaut au bord jardin + attaches manquantes — appelé au chargement,
  création, import, add_point). Sidecar : set_backstage_zones (état
  complet), update_point homeZoneId.
- **Moteur** (Python + Rust, parité régénérée avec 2 zones et des points
  SANS activation) : `backstage_slot` (grille auto 60 cm, ordre roster par
  zone, même constante des deux côtés) ; un acteur sans activation VIT dans
  sa zone (visible + émis PSN) ; première apparition = FONDU depuis le slot
  (fini le snap) — y compris tracés spatiaux et départ du block context
  (la trajectoire d'ENTRÉE se dessine depuis la coulisse). 76 pytest, 34
  cargo.
- **UI** : zones dessinées (pointillé sarcelle + nom en CanvasTexture
  hors-ligne), éditables en mode « Éditer la zone de jeu » (corps = move,
  coin BR = resize, panneau : renommer/supprimer/ajouter). Roster
  draggable : drop sur la scène = activer dans le bloc sélectionné à
  l'endroit du drop (ou bloc « Entrée » créé au playhead) ; Alt+drop sur
  une zone = changer l'ATTACHE. Sortir/se déplacer entre coulisses = blocs
  normaux ciblant les zones (tout l'attirail tracés/délais s'applique).

### Boucle de dev

Moteur : développé et testé dans le cloud du superviseur (`cargo test`).
Builds fenêtrés N2+ : sur la machine de Florian via `.bat`, ou
cross-compilation depuis le cloud. Le test UI « timeline + son » de l'app
actuelle reste à faire à la prochaine relance.

## Mission — Zoom fluide partout (scène + timeline) — 2026-07-29

Florian : « la gestion du zoom par rapport à l'emplacement de la souris
est tout sauf fluide » puis « les blocs vibrent en partant loin avant de
revenir à leur place » — deux bugs distincts, deux fixes (commit 065ea4b).

- **Scène** : le `zoomToCursor` de three.js calcule sa correction d'ancre
  UNE fois par cran de molette ; avec `enableDamping` le zoom s'étale sur
  plusieurs frames → l'ancre dérive. Remplacé par un zoom custom façon
  apps carto (MapLibre/camera-controls) : molette interceptée en CAPTURE
  sur le parent du canvas (les MapControls ne la voient plus), cible de
  zoom + point-monde mémorisé, convergence exponentielle en `useFrame`
  (rate 13/s, indépendante du framerate) avec re-verrouillage de l'ancre
  À CHAQUE frame (re-raycast du NDC mémorisé → translation caméra+target
  de la dérive exacte). Boutons +/- reroutés (ancre = centre). Pincement
  tactile inchangé (enableZoom des controls).
- **Timeline** : la boucle de zoom posait `scrollLeft` en synchrone
  pendant que React re-rendait les blocs en asynchrone → une frame peinte
  avec le nouveau scroll et les anciennes positions (la « vibration »).
  Fix : `flushSync(() => setPxPerMs(next))` AVANT `scrollLeft` — commit
  atomique, blocs et scroll dans la même peinture. Question de Florian sur
  une approche « vectorielle » : la vraie réponse pro est transform-based
  (scaleX pendant le geste, re-layout au repos, façon Figma/Maps) — gardée
  en plan B si le re-rendu par frame devenait lourd ; le bug réel était
  l'ordre de peinture, pas le coût du re-layout.

## Fix calage terrain → PSN + numéro/abrégé acteur — 2026-07-31

Florian a signalé un écart spatial entre Lumitrack et Capture sur un projet
réel (même terrain glTF des deux côtés, 91,4 m de largeur). Diagnostic :
`stage_map_origin_x_m/z_m/rotation_deg` (placement de la zone de jeu dans
le terrain, gizmo 3D) n'alimentait pas la sortie PSN — seul
`transform_origin_*` (ancré sur le coin haut-gauche de la zone) le faisait,
deux repères indépendants. Sur ce projet (zone 91,4×55 m centrée sur le
terrain), l'écart mesuré était d'~45 m (une demi-largeur de scène). Fixé
dans `OutputTransform.to_metres` (Python **et** son miroir Rust
`native/src/transform.rs`, tenu à parité) : le placement terrain est
maintenant plié dans le calcul, origin/invert/swap devenant un réglage fin
appliqué par-dessus. Défaut (0,0,0°) = no-op, aucun changement pour un
projet sans terrain. `update_stage_map` rafraîchit aussi le transform du
broadcaster en direct (oubli avant ce fix). Détail : CONCEPTION.md §14.4.
Numéro Stancz (ou initiales) affiché sur chaque acteur dans la scène et le
Roster (commit `3b899cf`), demande indépendante traitée dans la foulée.

## CI + undo/redo — 2026-07-31

Deux chantiers choisis par Florian (AskUserQuestion) suite à une demande
« conventions de codage standard + UI/UX robuste » :

- **CI** (`.github/workflows/ci.yml`) : rien ne tournait automatiquement
  jusqu'ici. Trois jobs indépendants sur `ubuntu-latest` — `pytest`,
  `cargo test` (native/), `npm run build` (frontend) — à chaque push/PR.
- **Undo/redo** — enfin livré, le manque le plus flagrant documenté depuis
  le début du MVP (§13.1.10). Historique backend-autoritaire dans
  `sidecar.py` (snapshots JSON du projet, commandes `undo`/`redo`) :
  **coalescé par fenêtre de temps** (0,7 s) plutôt qu'un snapshot par
  message réseau, sinon un simple drag d'acteur (~30 messages/s) aurait
  demandé des dizaines de Ctrl+Z pour être défait — un geste continu reste
  UN SEUL pas d'annulation, une vraie pause en ouvre un nouveau. Périmètre :
  commandes de contenu annulables (points, cues, activations, zones
  backstage, placement de la zone) ; transport, réglages réseau/sortie PSN
  et lecture seule hors périmètre ; remplacer le projet entier (nouveau/
  import/bundle) vide l'historique plutôt que de le rendre annulable.
  `project_message()` expose `undoAvailable`/`redoAvailable`. Frontend :
  Ctrl+Z/Ctrl+Maj+Z (désactivés pendant la saisie texte, même convention
  qu'Espace/Suppr) + menu Édition grisé en conséquence. 12 tests pytest
  dédiés (`tests/test_undo.py`) : aller-retour simple, coalescage de
  rafale, séparation par vraie pause, pile redo invalidée par une nouvelle
  édition, no-op silencieux sur pile vide, remplacement de projet.

**Non fait dans ce lot** (choix explicites de Florian, pas des oublis) :
corriger les 5 avertissements oxlint existants (react-hooks exhaustive-deps
dans Scene.tsx/AudioTrack.tsx), ajouter ruff côté Python, formaliser
rustfmt/clippy strict. Les 2 `window.prompt` restants (Mission 3) n'ont pas
non plus été traités — hors du périmètre choisi (undo/redo, pas dialogues
natifs).

## Mission hiérarchie du roster — 2026-07-31

Demande de Florian : remplacer la gestion inline du roster (« + Acteur » à
gauche, un par un, jamais de suppression) par un popup d'édition en lot, et
organiser les acteurs en sous-groupes reflétés dans la colonne de gauche.
Portée explicitement bornée par Florian aux sous-groupes ORGANISATIONNELS
(ordonner la vue, faciliter sélection/glisser-déposer d'un ensemble) — pas
les groupes animables complets du §12.2 (appartenance multiple, animation
relative, LTP inter-groupes), reportés en v1.1.

- **Modèle** (`core/project.py`) : `Point.rosterGroupId` (au plus un groupe
  par acteur, comme un dossier de fichiers), `Project.rosterGroups` (liste
  `{id, name}`). Premier ajout d'une vraie suppression d'acteur
  (`delete_point`, retire aussi ses activations dans tous les blocs — le
  roster ne savait qu'ajouter jusqu'ici), `reorder_points` (ordre complet),
  `prune_roster_groups` (détache les acteurs d'un groupe supprimé). Pas de
  miroir Rust — métadonnée d'organisation UI, hors du calcul de
  positions/PSN, même logique que les autres champs d'affichage seulement.
- **Sidecar** : commandes `delete_point`, `reorder_points`,
  `set_roster_groups` ; `update_point`/`add_point` acceptent `rosterGroupId`.
  Toutes annulables (undo/redo, mission précédente).
- **Frontend** : panneau `RosterManagerPanel` (ajout multiple avec compteur
  et groupe cible, sélection en lot Ctrl/Maj-clic, réassignation de groupe
  et suppression en masse, table éditable nom/N°/couleur/groupe/suppression
  par ligne, section sous-groupes créer/renommer/supprimer). Colonne
  Roster réécrite : groupes en en-têtes repliables (glisser-déposer du
  groupe entier vers la scène via un nouveau type MIME
  `application/x-lumitrack-points`, JSON d'ids — active tous les membres au
  même point de dépôt, sans étalement automatique), acteurs sans groupe
  affichés en dessous inchangés. L'ancien contrôle inline « + Acteur » est
  supprimé, remplacé par un bouton « Gérer… » ouvrant le panneau.
- 8 tests pytest dédiés (modèle + protocole fil), 119 tests au total.

**Non fait** (hors périmètre choisi par Florian) : pas d'étalement/
disposition en grille automatique au dépôt d'un groupe entier dans la
scène (la boîte de transformation multi-acteurs sert à réarranger ensuite
à la main) ; pas de groupes animables (§12.2) — pas d'appartenance
multiple, pas d'animation de groupe relative, pas de résolution LTP
inter-groupes.

**Correction le même jour** : Florian a préféré un vrai système façon
navigateur de fichiers (dossiers + glisser-déposer direct) au popup
d'édition en lot décrit ci-dessus — RosterManagerPanel est retiré, la
colonne de gauche EST maintenant l'explorateur (dossiers créés/renommés en
ligne, glisser un acteur sur un dossier range ET réordonne en un seul
geste, glisser un dossier sur un autre les réordonne entre eux, Suppr
supprime la sélection). Modèle et sidecar inchangés — seule la couche
frontend a changé de forme.

**Saga drag-and-drop du roster (2026-07-31/08-01)** : trois tentatives de
réimplémenter le geste à la main ont échoué dans cette WebView — HTML5
natif d'abord (bloqué par `dragDropEnabled` de Tauri, activé par défaut ;
puis, une fois désactivé, dragstart se déclenchait mais plus RIEN ne
suivait — dragover/drop/dragend absents même en écoutant au niveau window
en capture, diagnostiqué avec logs + vidéo), puis un système pointer-events
maison (fonctionnel mais entrait en course avec le lasso de sélection de la
scène — même bug de fond que celui déjà rencontré et à moitié corrigé sur
la boîte de transformation, cf. juste en dessous). Florian a tranché :
passer par une librairie éprouvée plutôt que de continuer à fabriquer.
**`@dnd-kit/core` + `@dnd-kit/sortable`** remplacent tout : `useSortable`
sur chaque ligne/dossier (glissable ET cible de dépôt en un seul hook,
anime le décalage des autres éléments), la scène 3D devient une zone
`useDroppable` avec le point d'impact recalculé via une méthode impérative
exposée par `Scene` (`placeActorsAt`, forwardRef/useImperativeHandle — plus
de listeners HTML5 sur le canvas). Un trait indique où l'élément tombera
(avant/après selon la moitié survolée, calculé depuis la position réelle du
curseur — pas le rectangle de l'élément traîné, qui décale le point de
bascule). `dragDropEnabled` de Tauri est resté à sa valeur par défaut
(plus rien ne dépend du HTML5 natif). Popup d'ajout d'acteurs en lot
ajouté au passage (nom de base + quantité, numérotation sur le premier
trou libre, couleur cyclée sur une palette).
**Leçon retenue pour la suite** : préférer une librairie éprouvée à du code
maison pour toute interaction un peu riche (drag-and-drop, gizmos 3D,
etc.) — voir la mission "refonte AE/Reaper" ci-dessous, qui applique le
même principe à la boîte de transformation.

### Mission "refonte inspirée After Effects / Reaper" (2026-08-01) — EN COURS

Florian trouve l'ensemble scène/timeline/graph editor/boîte de
transformation "trop rigide et pas assez visuel". Discussion complète
avant tout codage (résumée ici pour survivre à un redémarrage de
session) ; direction validée, à construire dans cet ordre de priorité
(le plus sûr/utile d'abord) :

**1. Boîte de transformation** — remplacer `SelectionTransform` (fabriqué
à la main : instabilité de rotation près du pivot, course avec le lasso
déjà partiellement corrigée) par `TransformControls`/`PivotControls` de
`@react-three/drei` (déjà une dépendance). Gizmo éprouvé par des milliers
de projets three.js, gère nativement la capture de pointeur et les
contraintes d'axe — contraindre au plan XZ + rotation Y seule (vue du
dessus). Analogie explicite avec la boîte AE : poignées claires, geste
fluide.

**2. Ligne d'automation dans un bloc** — supprimée pour x/y/z (déjà
visible dans la scène, redondant) ; gardée seulement pour le lacet (moins
lisible visuellement en vue du dessus). Remplacée pour le reste par un
**overlay de trajectoire à la sélection** : sélectionner un ou plusieurs
acteurs (scène ou roster) affiche leur courbe de déplacement en overlay
sur la timeline, plutôt qu'une ligne permanente par bloc pour tout le
monde (le "foutoir" que craignait Florian avec un modèle façon calques
AE — un bloc reste un bloc partagé entre acteurs, pas une ligne par
acteur).
**✅ LIVRÉ (2026-08-01)** : ligne d'automation retirée pour x/y/z, gardée
pour le seul lacet (exclut aussi path/focus, dont le lacet est dérivé).
Overlay de trajectoire à la sélection livré séparément le 08-01
(`resolve_trajectories` + `TrajectoryOverlay.tsx`), puis **retiré le
2026-08-03** ("pas très utile tel quel" — Florian) : l'affichage
(CueTimeline, App.tsx, TrajectoryOverlay.tsx) est supprimé, mais le
backend `resolve_trajectories` et les primitives sidecar.ts/types.ts
restent en place, testés, au cas où une version repensée serait voulue
plus tard. En l'état, x/y n'ont donc PLUS aucune visualisation dans la
timeline (seul le lacet en a une) — à rouvrir si le besoin revient.

**3. Geste libre de déplacement dans la scène** — plus besoin de
sélectionner un bloc avant de bouger un acteur ; sélectionner l'acteur
(scène ou roster) suffit. Selon la position du playhead au moment du
geste :
   - **Trou** (aucun bloc ne gouverne l'acteur ici) → crée un nouveau
     bloc, arrivée = playhead, début = playhead − distance/vitesse de
     référence (chevauchement toléré sur les blocs voisins, LTP tranche
     comme aujourd'hui pour deux blocs qui se chevauchent).
   - **Plein fade d'un bloc actif** → insère un nœud dans le tracé spatial
     à cet instant (réutilise le système de waypoints/tracé courbe déjà
     livré en Mission 1 — juste un nouveau déclencheur, pas un nouveau
     mécanisme).
   - **Maintien** (après la fin du fade) → modifie simplement la cible,
     comportement actuel inchangé.
   - **Vitesse de référence** : réglage PROJET (pas une constante), par
     défaut ~2 à 2,5 m/s (pas vif/jogging léger — cf. données générales de
     vitesse humaine : marche ~1,3 m/s, jogging ~2,2 m/s, course ~2,2-2,8
     m/s soutenue jusqu'à ~3,6-4 m/s en pointe, sprint tenable 5-10 s
     ~4,5-5,8 m/s ; rien de spécifique à la danse trouvé, ce sont des
     stats de population générale).
   - **Bloc "durée automatique"** (option par bloc) : recalcule la durée
     par défaut selon distance/vitesse — mais seulement pour les acteurs
     NON personnalisés (voir point 6) ; un acteur personnalisé sort du
     recalcul automatique tant qu'il reste personnalisé.
     **✅ LIVRÉ (2026-08-01)**, hors exclusion des acteurs personnalisés
     (point 6 n'existe pas encore, donc `auto_duration` recalcule pour
     TOUS les acteurs du bloc pour l'instant) : `Cue.auto_duration` +
     `Project.reference_speed_cms` (réglage projet, cf. ci-dessous) +
     `core/timeline.required_duration_ms`, recalcul câblé sur
     `set_activation`/`update_cue`/`update_project_settings`, case à
     cocher dans l'inspecteur de bloc.
   - **Thermomètre de vitesse** : indicateur visuel seul (jauge colorée
     marche/jogging/course/sprint), jamais une contrainte bloquante —
     tranché explicitement par Florian.
     **✅ LIVRÉ (2026-08-01)** dans l'inspecteur de bloc (vitesse du
     déplacement le plus rapide du bloc sélectionné, depuis le
     blockContext déjà résolu) — reste à faire : la version "pendant le
     geste" ci-dessous, qui n'existe pas tant que le geste lui-même n'est
     pas câblé.
   - **Aperçu pendant le geste** : bloc fantôme qui se dessine en temps
     réel dans la timeline (position + durée) pendant le glisser.
   - **⏳ Pas commencé** : le geste de glisser libre lui-même (créer/
     étendre/insérer un nœud selon le cas du playhead) — la pièce la plus
     grosse et la plus risquée de cette mission (change le modèle
     d'interaction de la scène), volontairement laissée pour une session
     avec retour visuel possible plutôt que construite à l'aveugle.

**4. Diviser un bloc au playhead** (nouvelle action, menu contextuel du
bloc) — fige la position de CHAQUE acteur activé à l'instant précis du
playhead (nouvelle cible = position interpolée à cet instant) dans le
premier bloc résultant ; le second bloc reçoit une nouvelle activation par
acteur avec pour cible la destination D'ORIGINE du bloc initial — la
trajectoire globale ne change pas, on ajoute juste un point de passage dur
et éditable au milieu. Si on éloigne le second bloc dans le temps après
coup, les acteurs attendent simplement plus longtemps à leur position
figée avant de repartir — automatique, c'est déjà le mécanisme de
maintien/LTP existant, aucune logique spéciale à écrire pour ça.
**✅ LIVRÉ (2026-08-03)** : `frontend/src/timeline/blockOps.ts`
(`splitCueAtPlayhead`/`canSplitAtPlayhead`), menu contextuel du bloc. Ne
recalcule AUCUNE position — fige exactement `positions` du tick (déjà
résolu par le backend, même source que la scène, §13.1.7), donc aucune
nouvelle route de résolution "à un instant arbitraire" n'a été
nécessaire. Ne fige que les axes que l'activation touchait déjà (un axe
non animé continue de suivre sa source précédente, comme avant la
coupe). Le second bloc recale son décalage de départ pour arriver au
MÊME instant absolu qu'avant la coupe (immédiatement si le mouvement
avait déjà commencé, après une attente résiduelle sinon). **Limite
connue** : courbes personnalisées (graph editor) et tracé spatial
(motion path) ne se reparamètrent pas à travers la coupure — remis à une
ligne droite/easing nommé des deux côtés plutôt que produire une
trajectoire déformée ; à reprendre si le besoin s'en fait sentir à
l'usage.

**5. Modes de rotation, par bloc OU par acteur** (3 modes) :
   - **Manuel** (existant, inchangé) : valeur animée comme aujourd'hui.
   - **Suivre la trajectoire** : le lacet devient la tangente de la
     trajectoire résolue à cet instant (`atan2` de la direction de
     déplacement) ; garde la dernière direction de marche pendant le
     maintien.
   - **Focus** : vise un point fixe (`focusXCm`/`focusYCm`, nouveaux
     champs), `atan2` recalculé en continu selon la position de l'acteur.
   - Le champ `orientationMode` existe DÉJÀ dans le modèle (Python ET TS,
     `manual`/`path`) mais n'est branché nulle part dans la résolution —
     juste à étendre à 3 valeurs et à réellement l'utiliser dans
     `resolve_positions`/`resolve_block_context` (Python + miroir Rust).
   - Réglage définitif par activation (bloc) ; un réglage par défaut au
     niveau Point préremplit simplement les nouvelles activations de cet
     acteur, sans autorité sur celles déjà réglées.
   - **✅ LIVRÉ (2026-08-01)** : les 3 modes tournent en Python
     (`resolve_positions` + `resolve_block_context`) ET en miroir Rust,
     sélecteur + champs focus dans l'inspecteur, garde anti-écrasement dans
     `SelectionTransform` lors d'une rotation de groupe.
   - **✅ Réglage par défaut au niveau Point LIVRÉ (2026-08-03)**, à
     l'occasion de la mission menus contextuels (point 8) :
     `Point.defaultOrientationMode` (backend + tests), sous-menu "orientation
     par défaut" du menu contextuel Acteur — préremplit uniquement les
     nouvelles activations, sans toucher celles déjà réglées.

**6. Timing global (bloc) vs sélectif (acteur)** — analogie validée par
Florian. Le bloc fournit une valeur par défaut (fade, et nouveau champ
**décalage de départ** par acteur, pour des effets d'entrée en escalier/
vague) ; un acteur peut personnaliser individuellement. Clic droit
"revenir au réglage du bloc" efface la personnalisation et réintègre
l'acteur dans le calcul automatique du point 3. **Décalage en escalier** :
respecte l'ORDRE DE SÉLECTION des acteurs (déjà suivi dans
`selectedPointIds`, aucun nouveau suivi à écrire) — incrément en ms
réglable par champ numérique ET par poignée à glisser directement dans la
sous-timeline de sélection du point 2 (façon "time stretch" AE).
**✅ LIVRÉ (2026-08-03)** : le "bloc = défaut, acteur peut personnaliser,
clic pour revenir" tourne pour de vrai, y compris HORS durée automatique
(jusque-là seul le cas auto-durée était câblé — un bug réel : "le
timing de l'acteur ne suit pas le timing du bloc", cf. le fix
Activation.fade_overridden + set_activation/update_cue). Décalage de
départ (`Activation.start_offset_ms`, miroir Rust inclus — affecte la
résolution de lecture) + bouton "décalage en escalier" dans le
GroupTimingPanel, respectant l'ordre de sélection.
**Découvrabilité (2026-08-03)** : le champ "Décalage" n'était visible que
dans la carte dépliée de CHAQUE acteur (petit champ numérique parmi
d'autres) — Florian ne le voyait pas et a proposé une mini-timeline dédiée
au bloc. Livré : `BlockDetailPanel.tsx`, un panneau DANS la même fenêtre
(pas une fenêtre OS séparée — confirmé par Florian), ouvert via le bouton
"Détail du bloc…" dans `CueInspector`. Une sous-piste horizontale par
acteur activé, temps LOCAL au bloc (0 = début du bloc) ; glisser le corps
d'une barre déplace le décalage de départ, glisser son bord droit change le
fade (marque `fadeOverridden`) ; bouton "revenir au bloc" par ligne quand
personnalisé. Glisser implémenté avec `@dnd-kit/core` (déjà une dépendance)
plutôt qu'un nouveau câblage pointerdown/move/up à la main.
**Refonte "panneau synchronisé" (2026-08-03, même jour)** : premier retour
de Florian sur le panneau ci-dessus — "c'est pas une timeline, on ne sait
pas dépasser le bloc, et on ne voit pas la piste audio". Trois options
proposées (enrichir le panneau isolé / le synchroniser sur le zoom-scroll
de la vraie timeline / tout replier dans la timeline principale) ;
Florian a choisi la synchronisation. Livré : le panneau devient DOCKÉ
au-dessus de CueTimeline (plus une fenêtre modale bloquante — la vraie
timeline reste utilisable pendant qu'il est ouvert) et partage son
zoom/scroll via un nouveau store `timelineView.ts` (miroir en lecture
seule, CueTimeline reste seul propriétaire du scroll/zoom réel). Règle
partagée via `ticks.ts` (extrait de CueTimeline, mêmes graduations
exactement). Piste audio via `MiniWaveform.tsx` + `audioPeaks.ts` : un
second `<AudioTrack>` aurait fait jouer le son deux fois (deuxième
instance wavesurfer) — `audioPeaks.ts` republie en lecture seule les pics
qu'AudioTrack a déjà décodés/mis en cache, `MiniWaveform` ne fait que
redessiner un canvas à partir de ces pics, aucun moteur audio à lui. Le
bloc n'est plus toute l'étendue affichée : une région surlignée dans un
référentiel de temps partagé — glisser une barre peut désormais dépasser
le bloc (plafond retiré, le modèle le permettait déjà côté backend).
**Accès au panneau (2026-08-03)** : trois chemins désormais équivalents —
bouton "Détail du bloc…" dans `CueInspector`, même libellé en tête du menu
contextuel du bloc (clic droit), et double-clic direct sur le bloc dans la
timeline (a remplacé le double-clic "renommer", resté disponible via le
menu contextuel).

**7. Refonte de l'inspecteur** — actuellement `CueInspector` affiche TOUTES
les activations d'un bloc dépliées en même temps (pas l'esprit AE, où le
panneau de propriétés suit la sélection du calque). Nouvelle version :
   - Par défaut, liste compacte des acteurs activés (nom + couleur,
     cliquables), pas leurs champs.
   - Sélectionner un acteur affiche SES champs en détail, un seul à la
     fois.
   - Sélection multiple → panneau de timing groupé existant (fade/easing/
     décalage en escalier).
   - Sections visuelles distinctes Position / Rotation / Timing plutôt
     qu'une grille plate.
   - Valeurs scrubables à la souris (glisser sur l'étiquette, façon AE/
     Blender) en plus du nudge clavier qui existe déjà (`NumericInput`,
     flèches Haut/Bas, Maj=×10).

**8. Table des menus contextuels (clic droit)** — validée :

| Cible | Actions |
|---|---|
| Acteur (scène/roster) | Renommer, couleur, mode d'orientation par défaut, assigner un dossier, dupliquer, supprimer, aller à sa zone backstage |
| Terrain/scène (vide) | Placer un acteur ici (popup, liste d'acteurs existants — pas création), grille on/off, ajuster à la fenêtre |
| Bloc (timeline) | Renommer, dupliquer, supprimer, couleur, durée auto/manuelle, diviser au playhead, copier le timing vers d'autres acteurs |
| Piste vide (timeline) | Nouveau bloc ici (reprend une plage sélectionnée si il y en a une, point 9), coller un bloc copié |
| Piste audio | Importer, retirer |
| Règle/playhead | Aller au début/fin |

**✅ LIVRÉ (2026-08-03)**, à l'exception de deux actions volontairement
reportées (détail plus bas) : bus générique `contextMenuStore.ts` +
`<ContextMenu>` (rendu une fois dans App.tsx, se ferme sur clic ailleurs/
Échap/molette/redimensionnement) — n'importe quel composant appelle
`showContextMenu`/`openContextMenu` directement, sans prop-drilling, même
principe que `sidecar.ts`/`i18n`. Terrain vide capté via `onPointerMissed`
du Canvas (mécanisme r3f prévu pour "aucun objet interactif sous le
clic" — pas de nouveau câblage pointerdown natif, pour ne pas toucher à
l'ordre déjà fragile documenté autour de `hitObjectRef`). "Dupliquer"/
"Copier-coller" un bloc composent uniquement des commandes déjà
existantes (`addCue` avec un id fourni par le client + N `set_activation`,
`blockOps.ts`) — aucune nouvelle route backend. Nouveau champ
`Point.defaultOrientationMode` (backend + tests) pour le sous-menu
"orientation par défaut" du menu Acteur, qui ne réécrit jamais une
activation déjà réglée.
Une action **reportée** (non construite, pas seulement désactivée) :
"Aller à sa zone backstage" (menu Acteur) : demande un nouveau mécanisme
de caméra (cadrer un rectangle de zone précis, pas le terrain entier) —
pas construit, même prudence que le point 3 (code caméra risqué sans
retour visuel possible).
"Diviser au playhead" (menu Bloc) : **✅ LIVRÉ (2026-08-03)**, voir le
point 4 plus bas — la table ci-dessus est donc désormais complète à une
action près.

**9. Polish visuel de la timeline, inspiré Reaper** :
   - **Grille du temps** : contraste actuel bien trop faible (vérifié —
     sous-graduation à 2,8% d'opacité, majeure à 7% seulement) ; refonte
     avec une vraie hiérarchie visuelle (mesures nettes/lumineuses,
     subdivisions modérées, sous-graduation discrète mais réellement
     visible).
   - **Zoom par défaut** trop petit à l'ouverture (le premier cadrage
     ajuste toute la durée du projet dans la fenêtre — minuscule pour un
     projet long) : zoom par défaut fixe raisonnable, ou plancher minimum
     même en mode "ajuster".
   - **Sélection de plage temporelle** (glisser sur la règle/le vide, PAS
     un bloc) : popup qui suit la souris avec départ/fin/durée en direct,
     éditable au clavier. Peut servir à créer un bloc directement avec ce
     timing (menu contextuel piste vide, point 8).
   - Idées complémentaires dans le même esprit : surlignage translucide de
     la plage sélectionnée sur toute la hauteur des pistes (pas juste la
     règle) ; raccourci "zoom sur la sélection" ; marqueurs de projet
     nommés ; vrai surlignage visuel de ce sur quoi on s'aligne pendant un
     glisser (pas juste l'aimantation silencieuse actuelle).
   - **✅ LIVRÉ (2026-08-03)**, sauf les deux dernières idées
     complémentaires (marqueurs nommés, surlignage de l'aimantation —
     reportées, pas essentielles) :
     - Grille : mineure 2,8%→5%, majeure 7%→16% d'opacité (`.tl-grid-line`/
       `.tl-grid-line-major`).
     - `MIN_PX_PER_MS` relevé de 0.001 à 0.02, puis **ANNULÉ (2026-08-04)** :
       s'appliquait aussi à "ajuster à la fenêtre" et au zoom manuel, rendant
       impossible de dézoomer sur un projet dépassant ~1 minute ("on ne sait
       plus dézoomer sur toute la longueur de la timeline", bug réel signalé
       par Florian) — remis à 0.001, "tout visible mais dense" l'emporte sur
       "impossible de tout voir".
     - Sélection de plage : glisser sur le vide des pistes, ou Maj+glisser
       sur la règle (le glisser normal de la règle reste le scrub existant,
       un geste déjà bien ancré — non retiré). Bulle flottante en direct
       pendant le geste (départ/fin/durée), popover éditable au clavier
       (`NumericInput` × 3) après relâchement, avec zoom-sur-sélection et
       effacer (✕/Échap). Surlignage plein-hauteur des pistes (pas juste la
       règle). "Nouveau bloc ici" (menu piste vide, point 8) reprend
       désormais la plage active si il y en a une.

**10. Petites finitions** : le seul vrai spinner natif (`<input
type="number">`, flèches minuscules) trouvé dans tout le frontend est le
champ "Nombre à ajouter" d'`AddActorsPanel` — à uniformiser vers
`NumericInput` comme partout ailleurs. **✅ LIVRÉ (2026-08-01)**.

**État au 2026-08-01 (fin de session)** : points 1, 2, 5, 10 livrés ;
point 3 moitié livré (durée auto + vitesse de référence + thermomètre) —
il ne manque plus que le geste de glisser libre lui-même, le plus gros
morceau qui reste, volontairement pas attaqué sans retour visuel
possible (change le modèle d'interaction de la scène). Points 4, 6, 7,
8, 9 pas commencés.

**Mise à jour 2026-08-03** : point 6 entièrement livré (fix "timing
acteur/bloc désynchronisé par défaut" + décalage de départ/escalier +
`BlockDetailPanel.tsx`, une mini-timeline par acteur pour le rendre
visible/éditable à la souris) ; point 4 livré (diviser un bloc au
playhead) ; point 8 livré (menus contextuels, table complète sauf "aller
à sa zone backstage", reportée) ; point 9 livré (grille de contraste,
plancher de zoom, sélection de plage temporelle), sauf marqueurs de
projet nommés et surlignage de l'aimantation (reportés, pas essentiels) ;
overlay de trajectoire à la sélection livré le 08-01 puis RETIRÉ le 08-03
("pas très utile tel quel" — Florian) — point 2 repasse donc en pratique
à "lacet seulement", sans overlay de remplacement pour x/y pour
l'instant.
Toujours pas commencé : point 3 (geste de glisser libre — volontairement
laissé pour une session avec retour visuel possible, change le modèle
d'interaction de la scène) et point 7 (refonte inspecteur).

**Périmètre volontairement pas encore tranché / à des sessions futures** :
un système de points de focus RÉUTILISABLES et nommés (comme les zones
backstage) plutôt que des coordonnées libres par activation, si le besoin
s'en fait sentir à l'usage.

## Régression signalée, pas encore diagnostiquée (2026-08-04)

Florian, en cours de session (redesign visuel des acteurs) : "le [app] ne
se lance plus, drag and drop des acteurs sur le terrain ne marche plus."
Reporté volontairement à une prochaine session ("continue celle qu'on a
mis en place récemment" — la refonte orientation/points de focus en
cours). Pas encore reproduit ni investigué — deux symptômes distincts
possibles (lancement de l'app ET glisser-déposer roster→scène), à
vérifier séparément avant de chercher une cause commune.
