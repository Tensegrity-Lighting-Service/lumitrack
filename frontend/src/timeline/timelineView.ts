// État de zoom/scroll de la VRAIE timeline (mission "panneau détail du bloc
// synchronisé", 2026-08-03) — même principe que sidecar.ts/i18n/
// contextMenuStore.ts : un état module-level avec des abonnés
// (useSyncExternalStore), pas un React Context.
//
// CueTimeline.tsx reste seul propriétaire de la position de scroll RÉELLE
// (le DOM de `.tl-scroll`) et de l'animation de zoom lissée — ce store n'est
// qu'un MIROIR publié à chaque changement, lu en lecture seule par
// BlockDetailPanel.tsx pour que son échelle de temps, sa règle et sa piste
// audio soient EXACTEMENT celles actuellement visibles dans la vraie
// timeline (Florian : "c'est pas une timeline, on ne sait pas dépasser le
// bloc, et on ne voit pas la piste audio").
import { useSyncExternalStore } from 'react'

interface TimelineViewState {
  pxPerMs: number
  scrollLeft: number
}

let state: TimelineViewState = { pxPerMs: 0.05, scrollLeft: 0 }
const listeners = new Set<() => void>()

function emit() {
  for (const fn of listeners) fn()
}

export function setTimelineView(patch: Partial<TimelineViewState>) {
  if (patch.pxPerMs === state.pxPerMs && patch.scrollLeft === state.scrollLeft) return
  state = { ...state, ...patch }
  emit()
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useTimelineView(): TimelineViewState {
  return useSyncExternalStore(subscribe, () => state)
}

// ---- Canal de COMMANDES inverse (tranche E, 2026-08-07) -------------------
// Le BlockDetailPanel doit pouvoir zoomer/défiler « comme la timeline
// principale » alors que celle-ci est masquée par l'overlay. Le miroir
// ci-dessus reste en lecture seule (CueTimeline le réécraserait) : le
// panneau envoie des COMMANDES, CueTimeline (seul propriétaire du scroll
// DOM et de l'animation de zoom) les exécute. L'ancre de zoom est un
// INSTANT (ms), pas un pixel — les deux fenêtres n'ont ni la même largeur
// ni le même bord gauche.

export interface TimelineViewCommand {
  /** Facteur de zoom (ex. 1.15 / 0.87), ancré sur anchorMs. */
  zoomFactor?: number
  anchorMs?: number
  /** Défilement horizontal, en pixels. */
  scrollDeltaPx?: number
}

let commandHandler: ((cmd: TimelineViewCommand) => void) | null = null

export function registerTimelineViewCommands(fn: (cmd: TimelineViewCommand) => void) {
  commandHandler = fn
  return () => { if (commandHandler === fn) commandHandler = null }
}

export function sendTimelineViewCommand(cmd: TimelineViewCommand) {
  commandHandler?.(cmd)
}
