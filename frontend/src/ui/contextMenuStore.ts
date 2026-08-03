// Bus de menu contextuel (mission "clic droit", DIRECTIVES.md point 8) —
// même principe que sidecar.ts/i18n/index.ts : un état module-level avec
// des abonnés (useSyncExternalStore), pas un React Context — n'importe quel
// composant (scène, roster, timeline) appelle `openContextMenu` directement
// sans prop-drilling, et un unique <ContextMenu /> monté une fois à la
// racine (App.tsx) affiche/ferme le menu.
//
// Fichier nommé `contextMenuStore.ts` (pas `contextMenu.ts`) : Windows a un
// système de fichiers insensible à la casse — un fichier `contextMenu.ts`
// à côté du composant `ContextMenu.tsx` ne diffère que par la casse, ce que
// TypeScript refuse catégoriquement (TS1149) même si le reste de la chaîne
// d'outils s'en accommoderait.
import { useSyncExternalStore } from 'react'

export interface ContextMenuItem {
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  /** Coche affichée devant le libellé — pour une liste de choix à plat
   * (mode d'orientation, dossier…) plutôt qu'un sous-menu à construire. */
  checked?: boolean
}

/** Un menu = une ou plusieurs sections séparées par un séparateur visuel. */
export type ContextMenuSections = ContextMenuItem[][]

interface ContextMenuState {
  x: number
  y: number
  sections: ContextMenuSections
}

let state: ContextMenuState | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const fn of listeners) fn()
}

export function openContextMenu(x: number, y: number, sections: ContextMenuSections) {
  state = { x, y, sections }
  emit()
}

export function closeContextMenu() {
  if (state === null) return
  state = null
  emit()
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useContextMenuState(): ContextMenuState | null {
  return useSyncExternalStore(subscribe, () => state)
}

/** Raccourci pour un gestionnaire `onContextMenu` React : empêche le menu
 * natif du navigateur/webview et la remontée vers un parent (ex. la scène
 * ne doit pas aussi désélectionner en dessous d'un acteur cliqué-droit). */
export function showContextMenu(e: { preventDefault: () => void; stopPropagation: () => void; clientX: number; clientY: number }, sections: ContextMenuSections) {
  e.preventDefault()
  e.stopPropagation()
  openContextMenu(e.clientX, e.clientY, sections)
}
