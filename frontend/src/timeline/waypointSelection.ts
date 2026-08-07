// Sélection MULTIPLE de waypoints dans la timeline (2026-08-07, "une
// espèce de lasso de sélection de plusieurs points dans la timeline").
//
// Store module (pattern dragOverride) : la sélection vit hors React et
// est partagée entre la timeline principale et le panneau détail — les
// losanges s'abonnent pour leur état visuel, le lasso du panneau la
// remplace d'un coup, Suppr supprime tout le lot en un setActivations.
import { useSyncExternalStore } from 'react'

let selected = new Set<string>()
// Delta de timing appliqué EN DIRECT à toute la sélection pendant un drag
// groupé (affichage seul — l'écriture part au relâchement).
let liveDelta = 0
const listeners = new Set<() => void>()
let version = 0

function emit() {
  version++
  for (const fn of listeners) fn()
}

export function waypointKey(pointId: string, index: number): string {
  return `${pointId}:${index}`
}

export function isWaypointSelected(pointId: string, index: number): boolean {
  return selected.has(waypointKey(pointId, index))
}

export function selectedWaypointKeys(): string[] {
  return [...selected]
}

export function selectedWaypointCount(): number {
  return selected.size
}

export function getLiveDelta(): number {
  return liveDelta
}

export function setLiveDelta(delta: number) {
  liveDelta = delta
  emit()
}

export function replaceWaypointSelection(keys: string[]) {
  selected = new Set(keys)
  emit()
}

export function toggleWaypointSelection(pointId: string, index: number) {
  const k = waypointKey(pointId, index)
  if (selected.has(k)) selected.delete(k)
  else selected.add(k)
  emit()
}

export function clearWaypointSelection() {
  if (selected.size === 0 && liveDelta === 0) return
  selected = new Set()
  liveDelta = 0
  emit()
}

/** Groupe les clés sélectionnées par acteur -> indices triés. */
export function selectionByActor(): Map<string, number[]> {
  const by = new Map<string, number[]>()
  for (const k of selected) {
    const at = k.lastIndexOf(':')
    const pid = k.slice(0, at)
    const idx = Number(k.slice(at + 1))
    const arr = by.get(pid) ?? []
    arr.push(idx)
    by.set(pid, arr)
  }
  for (const arr of by.values()) arr.sort((a, b) => a - b)
  return by
}

/** Abonnement React : re-rend au changement de sélection OU de delta live. */
export function useWaypointSelectionVersion(): number {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    () => version,
  )
}
