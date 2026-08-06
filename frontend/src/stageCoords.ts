// Repère AFFICHÉ = 3D absolu centré (demande Florian 2026-08-06, "à tous
// niveaux du soft, les positions des acteurs soient 1:1 celles du 3D
// absolu") : tous les champs numériques x/y montrent et acceptent des
// MÈTRES mesurés depuis le CENTRE de la zone de jeu — exactement les
// valeurs que le PSN émet (OutputTransform centré) et que la prévisu
// affiche avec un GLB de salle centré. Le stockage interne reste en cm
// coin haut-gauche (0..largeur) : seule la PRÉSENTATION change, la
// résolution/les sauvegardes ne bougent pas.
//
// Singleton de module mis à jour par App à chaque rendu (le parent rend
// toujours avant ses enfants, donc les valeurs sont fraîches pour tout
// champ affiché) — évite d'enfiler les dimensions de scène dans chaque
// composant d'inspecteur.

let centerXCm = 0
let centerYCm = 0

export function setStageCenter(stageWidthCm: number, stageHeightCm: number) {
  centerXCm = stageWidthCm / 2
  centerYCm = stageHeightCm / 2
}

/** cm scène (coin) -> mètres affichés (centre). */
export function displayXM(xCm: number): number {
  return (xCm - centerXCm) / 100
}
export function displayYM(yCm: number): number {
  return (yCm - centerYCm) / 100
}

/** mètres affichés (centre) -> cm scène (coin). */
export function storeXCm(xM: number): number {
  return xM * 100 + centerXCm
}
export function storeYCm(yM: number): number {
  return yM * 100 + centerYCm
}
