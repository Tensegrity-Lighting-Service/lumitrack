# Lumitrack — Guide de démarrage rapide

*Ce guide sert aussi de checklist de test : chaque section se termine par
« ✔ Vérifier », le comportement attendu. Parcours complet : ~15 minutes.*

## 1. Lancer

Double-clique `Lancer Lumitrack (dev).bat`. Il libère le port du sidecar,
installe les dépendances si besoin, puis ouvre la fenêtre. Ta dernière
session reprend automatiquement (autosauvegarde continue dans
`%APPDATA%\Lumitrack\autosave.json` — même après un crash, tout est là).

**✔ Vérifier** : la pastille en bas à gauche de la timeline est verte
(sidecar connecté) et ton dernier projet est rouvert tel quel.

## 2. La scène

Molette = zoom au curseur. **Clic droit** (ou gauche+droit ensemble) =
déplacer la vue. **Clic gauche sur le vide = lasso de sélection** (Ctrl =
ajouter à la sélection). Tactile : 1 doigt sélectionne, 2 doigts
pincent/déplacent. Boutons en haut à droite : zoom, ajuster, aimant de
grille, ⚙ (opacité de grille, **rotation du modèle 3D**, taille de grille
en mètres).

**✔ Vérifier** : le lasso dessine un rectangle bleu et sélectionne les
acteurs englobés ; le ⚙ reste ouvert quand on clique dedans ; la rotation
du modèle 3D tourne l'aréna ; la grille est visible au-dessus du sol.

## 3. Acteurs, roster, backstage

`+ Acteurs` en haut du roster (champ nombre = ajout en lot). Un nouvel
acteur apparaît aussitôt **dans sa zone backstage** (rectangle pointillé
sarcelle, rangé en grille). Ctrl-clic / Shift-clic dans le roster =
sélection multiple (le dernier cliqué est l'acteur « principal »).

**Glisse un acteur du roster vers la scène** : il s'active dans le bloc
sélectionné à l'endroit du drop — sans bloc sélectionné, un bloc « Entrée »
se crée au playhead. **Alt+glisser sur une zone backstage** = changer sa
coulisse d'attache. Les zones s'éditent en mode « Éditer la zone de jeu »
(menu Affichage) : corps = déplacer, coin = redimensionner, panneau de
droite = renommer/ajouter/supprimer.

**✔ Vérifier** : acteur ajouté → visible en coulisse immédiatement ;
glissé sur scène puis lecture → il **entre en fondu depuis la coulisse**
(pas de téléportation).

## 4. Timeline multi-pistes

`+ Cue` crée un bloc. Les blocs se déplacent **horizontalement** (temps,
aimantés à la grille et aux bords des autres blocs — Alt désactive) et
**verticalement** (changement de piste ; une piste vide attend toujours en
bas). Poignées gauche/droite = redimensionner. Double-clic = renommer.
Ctrl+molette = zoom au curseur ; molette = défilement ; règle = seek au
clic/drag. Espace = lecture/pause (le bouton vit sous le roster, avec le
timecode).

Chaque bloc affiche sa **ligne d'automation 0→100 %** (profil du
mouvement). Bloc sélectionné : glisse les nœuds, clique un nœud pour ses
poignées (Alt casse la symétrie), double-clic sur la ligne insère,
Alt+clic retire. Cette ligne écrit le profil de TOUT le bloc.

**✔ Vérifier** : un bloc glissé sur la piste vide du bas crée une nouvelle
piste ; deux blocs qui se chevauchent sur le même acteur s'enchaînent
**sans téléportation** (le second reprend l'acteur où il est) ; le
playhead est fluide pendant la lecture.

## 5. Trajectoires courbes (motion path)

Sélectionne un bloc puis un acteur : sa trajectoire passe en surbrillance.
**Double-clic sur le tracé** = insérer un point de passage (losange).
Glisse les losanges ; sélectionne-en un pour ses poignées de Bézier
(symétriques, Alt casse) ; les poignées de départ/cible sont toujours
visibles. Suppr retire le waypoint. Bouton « Tracé droit » dans
l'inspecteur pour tout remettre à plat. Le moteur parcourt la courbe à
**vitesse constante** (longueur d'arc).

**✔ Vérifier** : la lecture suit exactement la courbe dessinée ; le PSN
(moniteur, §8) émet ces positions courbes.

## 6. Transformation de sélection multiple

Dès 2 acteurs sélectionnés avec un bloc actif : rectangle englobant avec
**8 poignées** (coins = 2 axes, milieux d'arêtes = 1 axe, arêtes
saisissables sur toute leur longueur), intérieur saisissable = déplacer
tout le groupe, **sphère dorée** au-dessus = rotation. La rotation écrit un
**arc de cercle par acteur** autour du centre — personne ne coupe tout
droit — et tourne les lacets du même angle.

**✔ Vérifier** : rotation de 90° puis lecture → chaque acteur suit son
arc ; sélectionner un acteur après coup montre son arc retouchable.

Le panneau « Timing groupé » (inspecteur, sélection multiple) applique
fade et courbe à toutes les activations sélectionnées du bloc d'un coup.

## 7. Courbes fines : le graph editor

Bloc sélectionné → bouton **Courbes** dans la barre de la timeline. Une
piste s'ouvre : les courbes de progression par axe (X/Y/Z/Lacet) de
l'acteur sélectionné, sur le même axe de temps que les blocs. Chips = axe
actif ; drag nœuds/poignées, double-clic insère, Suppr retire, easing
prédéfinis, Linéaire/Lisser, copier/coller, « → tout le bloc ».

**✔ Vérifier** : la ligne d'automation du bloc et le graph editor
racontent la même courbe ; modifier l'un se reflète dans l'autre.

## 8. PSN

**Menu Sortie → Réglages PSN…** : carte réseau (IPv4 détectées), adresse
multicast, port, nom, fréquence ; repère de sortie (origine en mètres,
inversions, échange X/Y) ; **table des trackers** (ID PSN par acteur, ID
émis résolu) ; **moniteur live** de ce qui part sur le réseau. Convention
officielle spec 2.03 : **Y est l'axe vertical** (hauteur en pos_y, lacet en
ori_y) — Capture et MA3 suivent la spec.

**✔ Vérifier** : Démarrer → compteur de trames qui monte ; le moniteur
montre les acteurs (coulisses comprises) ; pos_y ↑ = hauteur en mètres.
Avec Capture sur le même sous-réseau : choisir la bonne carte, les
trackers apparaissent aux bonnes positions.

## 9. Audio

Glisse un MP3/WAV sur la fenêtre (ou Fichier → Importer un audio…, vrai
dialogue). « Décodage de l'audio… » s'affiche sans bloquer l'interface,
puis la waveform arrive, alignée au pixel sur la règle à tous les zooms.
Le son suit le transport (Espace, seek à la règle).

**✔ Vérifier** : l'app reste utilisable pendant le décodage ; la waveform
reste alignée avec la règle en zoomant (Ctrl+molette).

## 10. Fichiers

Tout passe par de vrais dialogues (Fichier → Importer .stancz / Enregistrer
/ Ouvrir) et par **glisser-déposer** sur la fenêtre : audio → piste,
`.stancz` → import, projet → ouverture. L'autosauvegarde tourne en continu ;
les bundles versionnés restent tes archives explicites.

## Raccourcis

| Geste | Effet |
|---|---|
| Espace | Lecture / pause |
| Suppr | Bloc sélectionné : supprimer · nœud/waypoint sélectionné : retirer |
| Échap | Tout désélectionner (waypoint d'abord) |
| Ctrl+clic (roster/scène) | Ajouter/retirer de la sélection |
| Shift+clic (roster) | Sélection en plage |
| Ctrl+molette (timeline) | Zoom au curseur |
| Alt pendant un drag | Désactiver l'aimantation / casser la symétrie des poignées |
| Alt+clic (ligne d'automation) | Retirer un nœud |
| Alt+drop (roster → zone) | Changer la coulisse d'attache |
| Clic droit / gauche+droit (scène) | Déplacer la vue |
