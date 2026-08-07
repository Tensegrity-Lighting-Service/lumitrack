// Retour visuel IMMÉDIAT des gestes (audit fluidité 2026-08-07) : depuis
// le mode aperçu, l'acteur ne bougeait qu'au retour du tick (~100 ms de
// latence souris→écran, ressenti « lent » même à 60 fps). Ce store porte
// des positions D'AFFICHAGE éphémères écrites à CHAQUE pointermove (jamais
// throttlées) : les marqueurs suivent le curseur immédiatement, le moteur
// (aperçu → tick) reste l'autorité et reprend seul la main au relâchement.
// Aucune donnée n'est calculée ici — pur affichage, §13.1.7 respecté.
import { useSyncExternalStore } from 'react'

export type DragOverrides = Record<string, [number, number]>

let overrides: DragOverrides | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const fn of listeners) fn()
}

// COALESCING par frame d'affichage (fix 2026-08-07, "10 fps en
// déplacement") : les pointermove arrivent à 60-120 Hz — émettre à chaque
// événement re-rendait la scène React à cette fréquence et ÉCROULAIT le
// GPU/CPU pendant les gestes. On stocke la dernière valeur et on n'émet
// qu'une fois par requestAnimationFrame : le suivi reste collé au curseur
// (1 mise à jour par frame affichée, par définition suffisant).
let raf = 0

function scheduleEmit() {
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    emit()
  })
}

export function setDragOverrides(next: DragOverrides | null) {
  overrides = next
  scheduleEmit()
}

export function clearDragOverrides() {
  if (overrides === null) return
  overrides = null
  if (raf) { cancelAnimationFrame(raf); raf = 0 }
  emit()
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useDragOverrides(): DragOverrides | null {
  return useSyncExternalStore(subscribe, () => overrides)
}
