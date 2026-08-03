// Opérations sur un bloc entier réutilisées par le menu contextuel timeline
// (DIRECTIVES.md point 8) : dupliquer, copier/coller, copier le timing vers
// d'autres acteurs. Compose uniquement des commandes sidecar déjà
// existantes (addCue avec un id fourni par le client + N set_activation) —
// aucune nouvelle route backend, le backend reste la seule source de
// vérité pour chaque commande individuelle (§13.1.7).
import { sidecar } from '../sidecar'
import type { Activation, Cue } from '../types'

function cloneActivationPatch(act: Activation) {
  return {
    targetXCm: act.targetXCm, targetYCm: act.targetYCm, targetZCm: act.targetZCm,
    targetYawDeg: act.targetYawDeg, fadeMs: act.fadeMs, fadeOverridden: act.fadeOverridden,
    startOffsetMs: act.startOffsetMs, easing: act.easing, orientationMode: act.orientationMode,
    focusXCm: act.focusXCm ?? null, focusYCm: act.focusYCm ?? null,
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
  for (const [pointId, act] of Object.entries(source.activations)) {
    sidecar.setActivation(newId, pointId, cloneActivationPatch(act))
  }
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
