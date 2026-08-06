# Lumitrack — Guide rapide

Lumitrack est un éditeur de chorégraphies de déplacements : on place des
**acteurs** sur un **terrain**, on décrit leurs déplacements dans une
**timeline** de blocs, et l'app émet en continu la position et
l'orientation de chacun en **PSN** (PosiStageNet) vers les consoles
lumière/vidéo.

L'interface a quatre zones : le **roster** (gauche), le **terrain**
(centre), l'**inspecteur** (droite) et la **timeline** (bas).

---

## Le roster (colonne de gauche)

La liste de tout ce qui existe dans le projet.

- **+ Acteur** : crée un ou plusieurs acteurs numérotés. Le numéro sert
  d'identifiant PSN par défaut (modifiable par acteur dans l'inspecteur).
- **+ Groupe** : crée un dossier. Glisser des acteurs dedans pour les
  organiser ; cliquer l'en-tête sélectionne tout le groupe, et **glisser
  l'en-tête vers le terrain place tous ses acteurs d'un coup**.
- **+ Point de focus** : crée un repère de visée (Focus A, B, …). Ce
  n'est pas un acteur : jamais émis en PSN, jamais placé en coulisse. On
  le positionne en le glissant sur le terrain, puis les acteurs peuvent
  le « viser » (voir orientation ci-dessous).
- **Sélection** : clic simple = un acteur ; Ctrl-clic = ajouter/retirer ;
  Maj-clic = plage. Le dernier cliqué est l'acteur « principal » affiché
  dans l'inspecteur.
- **Glisser un acteur (ou un groupe) vers le terrain** le place à
  l'endroit du dépôt — voir « geste libre » plus bas pour ce que ça crée
  dans la timeline.
- Clic droit sur un acteur : renommer, couleur, zone de coulisse
  (backstage), suppression, etc.

## Le terrain (vue centrale)

Vue du dessus, orthographique, de la zone de jeu.

- **Navigation** : molette = zoom, clic droit (ou gauche+droit) = déplacer
  la vue, clic gauche = lasso de sélection.
- **Boutons en haut à droite** : zoom +/−, ajuster à la fenêtre, grille
  on/off, et le popover de réglages du terrain (opacité de la grille,
  couleur noir↔blanc, taille de maille, magnétisme/snap). Ces réglages
  sont sauvegardés dans le projet.
- **Geste libre** : glisser un acteur directement dans la scène. Le
  résultat dépend de la position du playhead :
  - un bloc est sélectionné → le geste édite ce bloc ;
  - le playhead est dans le **fondu** d'un bloc → insère un point de
    passage dans la trajectoire ;
  - le playhead est dans un **maintien** → modifie la cible du bloc
    gouvernant ;
  - le playhead est dans un **trou** → crée un nouveau bloc « Entrée »
    dont la durée s'ajuste en direct à la distance parcourue (selon la
    vitesse de référence).
- **Sélection multiple** : un gizmo apparaît au centre du groupe —
  déplacement (translation de toutes les cibles), poignées
  d'**écartement** (homothétie depuis le centre) et **rotation** (les
  arcs de rotation ne s'appliquent qu'aux rotations sur place).
- Les **zones backstage** (coulisses) sont les rectangles nommés : un
  acteur sans activation y attend, rangé automatiquement en grille.
  « Éditer la zone de jeu » permet de déplacer/redimensionner tout ça.

## La timeline (bas)

Le temps du spectacle : piste audio (forme d'onde) + pistes de **blocs**.

- **Espace** = lecture/pause (partout, sauf champ texte actif).
- **+ Ajouter un bloc** : crée un bloc à la position du playhead.
- Un **bloc** (cue) est une fenêtre de temps : chaque acteur activé dedans
  a une **cible** (x, y, z), un **fondu** (le déplacement) puis un
  **maintien** jusqu'à la fin du bloc. Par défaut la durée est
  **automatique** : distance ÷ vitesse de référence (réglable dans le
  menu Réglages).
- Glisser un bloc = le déplacer ; tirer ses bords = le redimensionner.
- **Clic droit sur un bloc** : renommer, dupliquer, copier/coller sur une
  piste vide, **diviser au playhead** (fige les positions réelles au
  moment de la coupe), copier le timing d'un acteur vers les autres.
- La règle de résolution est **LTP** : à un instant t, c'est la dernière
  activation démarrée qui gouverne chaque acteur.

## L'inspecteur (droite)

Il affiche **soit un bloc, soit une sélection d'acteurs** — jamais les
deux.

### Bloc sélectionné

- Nom, couleur, timing (début, durée, durée auto).
- **Orientation par défaut du bloc** — appliquée à toute activation non
  personnalisée, en deux phases :
  - **En trajet** (pendant le fondu) : *Fixe* (angle + boussole 8
    directions), *Suivre la trajectoire* (tangente du déplacement,
    défaut), ou *Focus* (viser un point de focus en continu) ;
  - **À l'arrivée** (pendant le maintien) : *Ne rien changer* (fige ce
    que le trajet donnait à la fin du fondu, défaut), *Fixe*, ou
    *Focus*.
- **Preset orientation** du bloc (« ne rien changer » = laisse courir le
  preset précédent) et **Fade orientation** (durée de rotation du lacet,
  0,5 s par défaut, 0 = cut).

### Acteur(s) sélectionné(s)

- Un seul acteur : identité (nom, couleur, numéro, ID PSN, hauteur, zone
  de coulisse) + case **« Servir de point de focus »** (un vrai acteur —
  une chanteuse par exemple — que les autres peuvent viser, tout en
  restant émis en PSN), puis sa **carte d'activation** dans le bloc au
  playhead : cible, fondu, décalage, easing, orientation
  trajet/arrivée, preset, fade orientation. Un bouton permet de revenir
  aux défauts du bloc.
- Plusieurs acteurs : édition groupée (mêmes champs, « (mixte) » quand
  les valeurs divergent, bouton « Tracé droit » pour effacer les
  trajectoires personnalisées).

## Réglages généraux (menu Réglages)

Langue, diamètre des acteurs, vitesse de référence, puis le panneau
**Réglages généraux** : catalogue des **presets orientation** (rX/rZ
selon le montage du fixture — vertical, horizontal, posé au sol — plus la
hauteur d'émission du tracker), réglages réseau **PSN** (interface,
multicast, port, cadence, repère de sortie), table des **trackers** et
**moniteur** en direct des données émises.
