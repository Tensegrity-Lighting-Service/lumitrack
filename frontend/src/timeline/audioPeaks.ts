// Pics de waveform déjà décodés — partagés en lecture seule (mission
// "panneau détail du bloc synchronisé", 2026-08-03) : AudioTrack.tsx reste
// le SEUL propriétaire du moteur audio (wavesurfer, décodage, lecture) —
// dupliquer une deuxième instance ferait jouer le son deux fois. Ce store
// ne fait que republier les pics qu'AudioTrack a déjà calculés/chargés du
// cache, pour qu'un second consommateur PUREMENT VISUEL (MiniWaveform dans
// BlockDetailPanel) puisse dessiner la même forme d'onde sans son propre
// moteur audio.
import { useSyncExternalStore } from 'react'

export interface Peaks {
  min: Float32Array
  max: Float32Array
  bucketMs: number
  durationS: number
}

let currentPath: string | null = null
let currentPeaks: Peaks | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const fn of listeners) fn()
}

export function setAudioPeaks(path: string, peaks: Peaks | null) {
  currentPath = path
  currentPeaks = peaks
  emit()
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** null tant que non décodés, ou si `path` ne correspond plus au dernier
 * fichier publié (changement d'audio en cours de décodage). */
export function useAudioPeaks(path: string | null): Peaks | null {
  return useSyncExternalStore(subscribe, () => (path !== null && path === currentPath ? currentPeaks : null))
}
