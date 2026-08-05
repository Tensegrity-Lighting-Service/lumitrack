// Opérations sur un bloc entier réutilisées par le menu contextuel timeline
// (DIRECTIVES.md point 8) : dupliquer, copier/coller, copier le timing vers
// d'autres acteurs. Compose uniquement des commandes sidecar déjà
// existantes (addCue avec un id fourni par le client + N set_activation) —
// aucune nouvelle route backend, le backend reste la seule source de
// vérité pour chaque commande individuelle (§13.1.7).
import { sidecar } from '../sidecar'
import type { Activation, Cue, Pose } from '../types'

// Aligné sur MIN_AUTO_DURATION_MS (core/timeline.py) : jamais un sous-bloc
// de durée nulle après une coupe.
const MIN_SPLIT_MS = 200

function cloneActivationPatch(act: Activation) {
  return {
    targetXCm: act.targetXCm, targetYCm: act.targetYCm, targetZCm: act.targetZCm,
    fadeMs: act.fadeMs, fadeOverridden: act.fadeOverridden,
    startOffsetMs: act.startOffsetMs, easing: act.easing,
    orientationOverridden: act.orientationOverridden,
    travelOrientationMode: act.travelOrientationMode, travelFixedYawDeg: act.travelFixedYawDeg,
    travelFocusPointId: act.travelFocusPointId ?? null,
    arrivalOrientationMode: act.arrivalOrientationMode, arrivalFixedYawDeg: act.arrivalFixedYawDeg,
    arrivalFocusPointId: act.arrivalFocusPointId ?? null,
    mountPresetId: act.mountPresetId ?? null,
    yawTurnMs: act.yawTurnMs,
    curves: act.curves ?? null, pathPoints: act.pathPoints ?? null,
    startHandle: act.startHandle ?? null, targetHandle: act.targetHandle ?? null,
  }
}

/** Crée un nouveau bloc avec les mêmes activations qu'un bloc source — un
 * id généré côté client (accepté par `add_cue`) pour pouvoir enchaîner
 * immédiatement les `set_activation` sans attendre l'écho du projet. */
function cloneCueInto(source: Cue, name: string, startMs: number, durationMs: number, lane: number) {
  const newId = crypto.randomUUID()
  sidecar.addCue(name, startMs, durationMs, source.color, lane, newId)
  if (source.autoDuration) sidecar.updateCue(newId, { autoDuration: true })
  // UN message groupé (optimisation 2026-08-06) : dupliquer un bloc de N
  // acteurs déclenchait N rediffusions complètes du projet.
  sidecar.setActivations(newId, Object.entries(source.activations)
    .map(([pointId, act]) => ({ pointId, ...cloneActivationPatch(act) })))
  return newId
}

/** "Dupliquer" (menu contextuel du bloc) : copie posée juste après le bloc
 * source, même piste. */
export function duplicateCue(cue: Cue) {
  return cloneCueInto(cue, `${cue.name} (copie)`, cue.startMs + cue.durationMs, cue.durationMs, cue.lane ?? 0)
}

// Presse-papier interne (pas le presse-papier OS — un bloc n'est pas du
// texte) : "Copier" un bloc puis "Coller" sur une piste vide, à l'instant
// du clic droit (DIRECTIVES.md point 8, "piste vide").
let cueClipboard: Cue | null = null

export function copyCueToClipboard(cue: Cue) {
  cueClipboard = cue
}

export function hasCueClipboard(): boolean {
  return cueClipboard !== null
}

export function pasteCueFromClipboard(startMs: number, lane: number) {
  if (!cueClipboard) return null
  return cloneCueInto(cueClipboard, cueClipboard.name, Math.max(0, startMs), cueClipboard.durationMs, lane)
}

/** Le playhead tombe-t-il STRICTEMENT à l'intérieur du bloc, en laissant au
 * moins MIN_SPLIT_MS de chaque côté ? (DIRECTIVES.md point 4, "diviser un
 * bloc au playhead" — désactive l'action plutôt que produire un sous-bloc
 * dégénéré près d'un bord.) */
export function canSplitAtPlayhead(cue: Cue, tMs: number): boolean {
  return tMs > cue.startMs + MIN_SPLIT_MS && tMs < cue.startMs + cue.durationMs - MIN_SPLIT_MS
}

/** "Diviser au playhead" (DIRECTIVES.md point 4) : fige la position
 * RÉELLE (déjà résolue par le backend, `positions` du tick — jamais
 * recalculée ici, §13.1.7) de chaque acteur activé à l'instant du playhead
 * comme nouvelle cible du bloc TRONQUÉ, et crée un second bloc dont chaque
 * acteur reçoit une nouvelle activation visant la cible D'ORIGINE du bloc
 * initial, calée pour arriver au MÊME instant absolu qu'avant la coupe — la
 * trajectoire globale ne change pas, on ajoute juste un point de passage dur
 * au milieu. Limite connue : les courbes personnalisées (graph editor) et
 * le tracé spatial (motion path) ne se reparamètrent pas à travers la
 * coupure — remis à une ligne droite/easing nommé des deux côtés plutôt que
 * produire une trajectoire déformée. */
export function splitCueAtPlayhead(cue: Cue, tMs: number, positions: Record<string, Pose>): string | null {
  if (!canSplitAtPlayhead(cue, tMs)) return null
  const firstDurationMs = tMs - cue.startMs
  const secondDurationMs = cue.durationMs - firstDurationMs
  const secondId = crypto.randomUUID()
  sidecar.addCue(`${cue.name} (suite)`, tMs, secondDurationMs, cue.color, cue.lane ?? 0, secondId)
  sidecar.updateCue(cue.id, { durationMs: firstDurationMs, autoDuration: false })

  // Deux messages groupés (un par bloc) au lieu de 2 N unitaires
  // (optimisation 2026-08-06).
  const firstEntries: Array<Record<string, unknown> & { pointId: string }> = []
  const secondEntries: Array<Record<string, unknown> & { pointId: string }> = []
  for (const [pointId, act] of Object.entries(cue.activations)) {
    const pose = positions[pointId]
    if (!pose) continue
    const [xCm, yCm, zCm, yawDeg] = pose
    const effectiveStart = cue.startMs + act.startOffsetMs
    const originalArrivalMs = effectiveStart + act.fadeMs

    // Bloc tronqué : fige SEULEMENT les axes x/y/z que cette activation
    // animait déjà (un axe non touché continue de suivre son ancienne
    // source, comme avant la coupe) ; arrive pile à la nouvelle fin du
    // bloc. Le lacet À L'ARRIVÉE est TOUJOURS figé sur la valeur déjà
    // résolue et visible à l'instant de la coupe (mission "modes
    // d'orientation", 2026-08-04) — la trajectoire visuelle ne saute pas,
    // quel que soit le mode de trajet d'origine (fixed/path/focus, inchangé
    // ici, seule l'arrivée du sous-bloc tronqué est réglée).
    firstEntries.push({
      pointId,
      targetXCm: act.targetXCm !== null ? xCm : null,
      targetYCm: act.targetYCm !== null ? yCm : null,
      targetZCm: act.targetZCm !== null ? zCm : null,
      fadeMs: Math.max(MIN_SPLIT_MS, tMs - effectiveStart),
      fadeOverridden: true,
      startOffsetMs: Math.min(act.startOffsetMs, Math.max(0, firstDurationMs - MIN_SPLIT_MS)),
      orientationOverridden: true,
      arrivalOrientationMode: 'fixed',
      arrivalFixedYawDeg: yawDeg,
      curves: null, pathPoints: null, startHandle: null, targetHandle: null,
    })

    // Second bloc : reprend la cible D'ORIGINE et le réglage d'orientation
    // D'ORIGINE tel quel (trajet ET arrivée inchangés), calé pour arriver
    // au même instant absolu qu'avant la coupe (immédiatement si le
    // mouvement avait déjà commencé, après une attente résiduelle sinon).
    const secondOffsetMs = Math.max(0, effectiveStart - tMs)
    secondEntries.push({
      pointId,
      targetXCm: act.targetXCm, targetYCm: act.targetYCm,
      targetZCm: act.targetZCm,
      fadeMs: Math.max(MIN_SPLIT_MS, originalArrivalMs - (tMs + secondOffsetMs)),
      fadeOverridden: true,
      startOffsetMs: secondOffsetMs,
      easing: act.easing,
      orientationOverridden: act.orientationOverridden,
      travelOrientationMode: act.travelOrientationMode,
      travelFixedYawDeg: act.travelFixedYawDeg,
      travelFocusPointId: act.travelFocusPointId ?? null,
      arrivalOrientationMode: act.arrivalOrientationMode,
      arrivalFixedYawDeg: act.arrivalFixedYawDeg,
      arrivalFocusPointId: act.arrivalFocusPointId ?? null,
      mountPresetId: act.mountPresetId ?? null,
      yawTurnMs: act.yawTurnMs,
    })
  }
  sidecar.setActivations(cue.id, firstEntries)
  sidecar.setActivations(secondId, secondEntries)
  return secondId
}

/** "Copier le timing vers d'autres acteurs" : le fade/easing/décalage d'UN
 * acteur du bloc (l'ancre) appliqué à tous les autres acteurs déjà activés
 * dans ce même bloc — chacun sort du recalcul automatique (fadeOverridden),
 * même logique que l'édition groupée (GroupTimingPanel). */
export function copyTimingToOtherActors(cue: Cue, anchorPointId: string) {
  const anchor = cue.activations[anchorPointId]
  if (!anchor) return
  for (const pointId of Object.keys(cue.activations)) {
    if (pointId === anchorPointId) continue
    sidecar.setActivation(cue.id, pointId, {
      fadeMs: anchor.fadeMs, easing: anchor.easing,
      startOffsetMs: anchor.startOffsetMs, fadeOverridden: true,
    })
  }
}
