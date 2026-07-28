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
- Licences permissives uniquement (MIT/BSD/Apache) — rien de GPL/AGPL, pas de
  Remotion (§12.16).

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

## Décision d'architecture — 2026-07-28 (soir) : refonte native intégrale

Décision de Florian, actée après discussion : **Lumitrack devient une
application 100 % native** — un seul processus, un seul exe, zéro webview,
zéro serveur local. Chemin retenu : **Rust intégral** (egui pour l'UI, wgpu
pour la scène 3D, cpal + ffmpeg externe pour l'audio, PSN/timecode portés) —
seule voie native qui conserve la logique validée : la suite Python (58
tests) sert d'ORACLE au port. Friction (friction.graphics) est retenu comme
**référence UX** (timeline/graph editor) mais écarté comme base de code :
GPL-3.0 (critère §12.16) et moteur 2D vectoriel sans rapport avec le métier.

L'app Tauri/Python actuelle reste l'application de travail jusqu'à parité de
la native — on ne casse rien pendant la transition.

### Phases

- [x] **N0 — Moteur : modèle + résolution** *(fait 2026-07-28 : crate
  `native/lumitrack-engine` — modèle serde au format fil camelCase (les
  bundles existants restent lisibles), easing, résolution LTP 4 axes,
  contexte de bloc. 14 tests unitaires portés + **test de parité contre
  l'oracle Python** : fixture générée par `native/tests/
  generate_parity_fixture.py` (3 projets aléatoires, 120 instants, tous les
  contextes de bloc), identité à 1e-6. `cargo test` : 14 verts.)*
- [ ] **N1 — Moteur : PSN + timecode + transport** (encodeur PSN v2 +
  découpage MTU validés contre les captures pypsn des tests Python,
  récepteurs Art-Net TC/MTC, horloge de transport)
- [ ] **N2 — Coquille native + vue Dessus** (winit/egui/wgpu : fenêtre,
  caméra ortho, terrain glTF, acteurs, ghosts/trajectoires)
- [ ] **N3 — Timeline native + audio** (portage egui de la timeline maison
  écrite ce soir — zoom curseur, règle adaptative, waveform ; décodage via
  ffmpeg externe, lecture cpal)
- [ ] **N4 — Inspecteur/roster/menus + undo/redo + dialogues natifs**
- [ ] **N5 — Parité prononcée : retrait du sidecar Python et du frontend
  web, exe unique, installeur**

### Boucle de dev pendant la refonte

Le superviseur code et teste le moteur dans son cloud (`cargo test`) ; les
builds fenêtrés se font sur la machine de Florian via un `.bat` (à créer en
N2) ou par cross-compilation depuis le cloud. Le test UI de la mission
« timeline + son » de l'app actuelle reste à faire à la prochaine relance —
elle demeure l'app de production pendant la transition.
