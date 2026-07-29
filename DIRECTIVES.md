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
  *(mission courante)*
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

Reste ouvert (souhait exprimé, pas encore construit) : hiérarchie du roster
(équipes en sous-dossiers, appartenance multiple — spec §12.2/§12.10,
référence UX ContainerBox de Friction). Prochaine mission logique.

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
