// Thermomètre de vitesse + presets (mission "refonte AE/Reaper") : indicateur
// visuel seul, jamais une contrainte (tranché explicitement par Florian).
// Seuils (m/s) et valeurs représentatives issus de la recherche vitesses
// humaines (population générale, rien de spécifique à la danse trouvé,
// cf. DIRECTIVES.md) : marche ~1,3 m/s, jogging ~2,2 m/s, course soutenue
// ~2,2-2,8 m/s (pointe ~3,6-4), sprint tenable 5-10s ~4,5-5,8 m/s.
import type { BlockContextMessage, Cue } from '../types'

/** Clé stable (traduite via t('speed.'+key) à l'affichage, voir i18n/) —
 * jamais le texte affiché directement, pour rester bilingue FR/EN. */
export type SpeedKey = 'walk' | 'jog' | 'run' | 'sprint'

export const SPEED_THRESHOLDS: [number, SpeedKey, string][] = [
  [1.6, 'walk', '#4FB6F5'],
  [2.5, 'jog', '#4FF58C'],
  [4.0, 'run', '#F5C84F'],
  [Infinity, 'sprint', '#F5734F'],
]

/** Valeurs représentatives par catégorie, pour les boutons preset de
 * l'inspecteur — demandés par Florian ("il n'y a aucun endroit pour donner
 * la vitesse qu'on veut... des presets avec les termes que tu as trouvé"). */
export const SPEED_PRESETS: { key: SpeedKey; ms: number; color: string }[] = [
  { key: 'walk', ms: 1.3, color: '#4FB6F5' },
  { key: 'jog', ms: 2.2, color: '#4FF58C' },
  { key: 'run', ms: 2.8, color: '#F5C84F' },
  { key: 'sprint', ms: 5.0, color: '#F5734F' },
]

/** Affichage seulement (km/h, "plus humain à comprendre" — Florian) : tous
 * les calculs internes restent en m/s / cm/s, cohérents avec le backend. */
export function msToKmh(ms: number): number {
  return ms * 3.6
}

export function speedCategory(ms: number): [SpeedKey, string] {
  for (const [max, key, color] of SPEED_THRESHOLDS) {
    if (ms < max) return [key, color]
  }
  return ['sprint', '#F5734F']
}

/** Vitesse (m/s) du point le plus rapide de ce bloc, résolue depuis le
 * blockContext déjà calculé par le backend (départ/cible réels, pas une
 * approximation frontend) — null si le contexte ne correspond pas encore à
 * ce bloc (bascule de sélection) ou si rien ne s'y déplace. */
export function maxSpeedMs(cue: Cue, blockContext: BlockContextMessage | null): number | null {
  if (!blockContext || blockContext.cueId !== cue.id) return null
  let max: number | null = null
  for (const entry of Object.values(blockContext.entries)) {
    const { startPose, targetPose, timing } = entry
    if (!startPose || !targetPose || timing.fadeMs <= 0) continue
    const distCm = Math.hypot(targetPose[0] - startPose[0], targetPose[1] - startPose[1])
    const speed = (distCm / 100) / (timing.fadeMs / 1000)
    if (max === null || speed > max) max = speed
  }
  return max
}

const MIN_AUTO_DURATION_MS = 200

/** Fade (ms) nécessaire pour CHAQUE acteur de ce bloc à parcourir SA
 * distance à la vitesse donnée (m/s) — même principe que le
 * `required_fade_ms_per_point` backend (core/timeline.py), calculé ici
 * directement depuis le blockContext déjà en main pour un retour instantané
 * au clic sur un preset (pas d'aller-retour serveur nécessaire avant
 * d'écrire les fades). Un acteur avec moins de chemin à faire reçoit un
 * fade PLUS COURT, pas celui du bloc entier — sinon la boîte change de
 * vitesse affichée mais les acteurs continuent de bouger à leur ancien
 * fade_ms ("la boîte a changé de vitesse mais les acteurs non", signalé
 * 2026-08-03). null si le contexte ne correspond pas encore à ce bloc.
 */
export function requiredFadeMsPerPointFromContext(
  cue: Cue, blockContext: BlockContextMessage | null, speedMs: number,
): Record<string, number> | null {
  if (!blockContext || blockContext.cueId !== cue.id || speedMs <= 0) return null
  const speedCmsPerS = speedMs * 100
  const result: Record<string, number> = {}
  for (const [pointId, entry] of Object.entries(blockContext.entries)) {
    const { startPose, targetPose } = entry
    if (!startPose || !targetPose) continue
    const distCm = Math.hypot(targetPose[0] - startPose[0], targetPose[1] - startPose[1])
    result[pointId] = Math.max(MIN_AUTO_DURATION_MS, (distCm / speedCmsPerS) * 1000)
  }
  return result
}
