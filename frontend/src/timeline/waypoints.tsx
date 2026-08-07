// Losanges de keyframes (waypoints) dans la timeline (2026-08-07,
// "ce serait bien de voir des petits losanges dans le bloc").
//
// Chaque waypoint du tracé d'une activation apparaît comme un losange à
// son temps de passage dans le fade : clic = sélectionner l'acteur ET le
// waypoint dans la scène (poignées d'édition) ; glisser gauche/droite =
// imposer SON temps de passage (pathPoints[].tFrac, moteur v4) ; clic
// droit = menu (supprimer, revenir au timing automatique).
//
// Temps affiché : tFrac s'il est posé ; sinon interpolation uniforme
// entre les jalons temporisés voisins — approximation d'affichage (le
// moteur répartit par longueur d'arc), qui devient EXACTE dès qu'un
// timing est posé.
import { useRef, useState } from 'react'
import type { Activation, Cue, PathPoint } from '../types'
import { sidecar } from '../sidecar'
import { showContextMenu } from '../ui/contextMenuStore'
import { t } from '../i18n'
import {
  clearWaypointSelection, getLiveDelta, isWaypointSelected, replaceWaypointSelection,
  selectedWaypointCount, selectionByActor, setLiveDelta, toggleWaypointSelection,
  useWaypointSelectionVersion, waypointKey,
} from './waypointSelection'

/** Supprime tous les waypoints sélectionnés (groupé par acteur, un seul
 * setActivations) — utilisé par le menu des losanges et la touche Suppr
 * du panneau détail. */
export function deleteSelectedWaypoints(cue: Cue) {
  const by = selectionByActor()
  const entries: Array<{ pointId: string; pathPoints: PathPoint[] }> = []
  for (const [pid, indices] of by) {
    const act = cue.activations[pid]
    if (!act) continue
    const drop = new Set(indices)
    entries.push({ pointId: pid, pathPoints: (act.pathPoints ?? []).filter((_, i) => !drop.has(i)) })
  }
  if (entries.length) sidecar.setActivations(cue.id, entries)
  clearWaypointSelection()
}

/** Retiming GROUPÉ : applique un delta de fraction à toute la sélection
 * (clamp par waypoint entre ses voisins), une écriture par acteur. */
function commitGroupDelta(cue: Cue, delta: number) {
  const by = selectionByActor()
  const entries: Array<{ pointId: string; pathPoints: PathPoint[] }> = []
  for (const [pid, indices] of by) {
    const act = cue.activations[pid]
    if (!act) continue
    const wps = act.pathPoints ?? []
    const fr = waypointTimeFracs(wps)
    const sel = new Set(indices)
    const next = wps.map((wp, i) => {
      if (!sel.has(i)) return { ...wp }
      const lo = (i > 0 ? fr[i - 1] : 0) + 0.005
      const hi = (i < fr.length - 1 ? fr[i + 1] : 1) - 0.005
      return { ...wp, tFrac: Math.min(hi, Math.max(lo, fr[i] + delta)) }
    })
    entries.push({ pointId: pid, pathPoints: next })
  }
  if (entries.length) sidecar.setActivations(cue.id, entries)
}

/** Fraction temporelle effective de chaque waypoint (0..1 du fade). */
export function waypointTimeFracs(wps: PathPoint[]): number[] {
  const n = wps.length
  const out = new Array<number>(n).fill(0)
  const knots: Array<{ idx: number; t: number }> = []
  for (let i = 0; i < n; i++) {
    const tf = wps[i].tFrac
    if (tf !== null && tf !== undefined) {
      knots.push({ idx: i, t: Math.min(0.999, Math.max(0.001, tf)) })
    }
  }
  knots.push({ idx: n, t: 1 })
  let prevIdx = -1
  let prevT = 0
  for (const k of knots) {
    const kt = Math.max(k.t, prevT) // jalons désordonnés : jamais de retour
    for (let i = prevIdx + 1; i < k.idx; i++) {
      out[i] = prevT + ((kt - prevT) * (i - prevIdx)) / (k.idx - prevIdx)
    }
    if (k.idx < n) out[k.idx] = kt
    prevIdx = k.idx
    prevT = kt
  }
  return out
}

/** Événement global "sélectionner ce waypoint dans la scène" — écouté par
 * SceneContent (l'état selectedWaypoint y vit), émis par les losanges. */
export const SELECT_WAYPOINT_EVENT = 'lumitrack:select-waypoint'
export function emitSelectWaypoint(pointId: string, index: number) {
  window.dispatchEvent(new CustomEvent(SELECT_WAYPOINT_EVENT, { detail: { pointId, index } }))
}

/** Rangée de losanges d'UNE activation. `baseMs` = temps du bord gauche du
 * conteneur positionné (cue.startMs quand on rend DANS le bloc, 0 dans un
 * contenu absolu du panneau détail). */
export function WaypointDiamonds({ cue, act, pointId, pxPerMs, baseMs, centerY, xOffsetPx = 0, color, dim = false }: {
  cue: Cue
  act: Activation
  pointId: string
  pxPerMs: number
  baseMs: number
  centerY: number
  /** Décalage écran supplémentaire (repère viewport du panneau détail :
   * scrollLeft en pixels) — 0 dans le contenu scrollé de la timeline. */
  xOffsetPx?: number
  /** Couleur de l'acteur (losanges des acteurs NON courants dans le bloc
   * de la timeline principale) — les timings imposés restent turquoise. */
  color?: string
  /** Acteur non courant : losange plus petit et translucide. */
  dim?: boolean
}) {
  const wps = act.pathPoints ?? []
  const dragRef = useRef<{
    index: number
    startClientX: number
    moved: boolean
    fracs: number[]
  } | null>(null)
  // Suivi LOCAL du losange pendant le drag ("ça rame", 2026-08-07) : les
  // aperçus moteur ne rediffusent rien (par design), donc sans état local
  // le losange restait figé jusqu'au relâchement. Pendant le geste : zéro
  // réseau, le losange suit le curseur ; UNE écriture au relâchement.
  const [liveDrag, setLiveDrag] = useState<{ index: number; frac: number } | null>(null)
  // Re-rend au changement de sélection multiple / de delta groupé live.
  useWaypointSelectionVersion()
  if (wps.length === 0) return null

  const fadeMs = Math.max(1, act.fadeMs ?? cue.durationMs)
  const offsetMs = act.startOffsetMs ?? 0
  const fracs = waypointTimeFracs(wps)

  const clampTarget = (drag: { index: number; startClientX: number; fracs: number[] }, clientX: number) => {
    const dx = clientX - drag.startClientX
    const lo = (drag.index > 0 ? drag.fracs[drag.index - 1] : 0) + 0.005
    const hi = (drag.index < drag.fracs.length - 1 ? drag.fracs[drag.index + 1] : 1) - 0.005
    return Math.min(hi, Math.max(lo, drag.fracs[drag.index] + dx / pxPerMs / fadeMs))
  }

  const onDown = (e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    // Maj-clic : toggle dans la sélection multiple, sans drag.
    if (e.shiftKey) {
      toggleWaypointSelection(pointId, index)
      return
    }
    // Saisir un losange DÉJÀ sélectionné avec d'autres = drag GROUPÉ
    // (delta commun affiché en direct via le store, écrit au relâchement).
    const group = isWaypointSelected(pointId, index) && selectedWaypointCount() > 1
    const el = e.currentTarget as Element
    el.setPointerCapture(e.pointerId)
    dragRef.current = { index, startClientX: e.clientX, moved: false, fracs }
    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const dx = ev.clientX - drag.startClientX
      if (!drag.moved && Math.abs(dx) < 3) return
      drag.moved = true
      const frac = clampTarget(drag, ev.clientX)
      if (group) setLiveDelta(frac - drag.fracs[drag.index])
      else setLiveDrag({ index: drag.index, frac })
    }
    const onUp = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId)
      el.removeEventListener('pointermove', onMove as EventListener)
      el.removeEventListener('pointerup', onUp as EventListener)
      const drag = dragRef.current
      dragRef.current = null
      setLiveDrag(null)
      if (!drag) return
      if (!drag.moved) {
        // Clic sec : ce waypoint devient LA sélection + édition scène.
        replaceWaypointSelection([waypointKey(pointId, drag.index)])
        emitSelectWaypoint(pointId, drag.index)
        return
      }
      const frac = clampTarget(drag, ev.clientX)
      if (group) {
        const delta = frac - drag.fracs[drag.index]
        setLiveDelta(0)
        commitGroupDelta(cue, delta)
        return
      }
      const next = wps.map((wp, i) => (i === drag.index ? { ...wp, tFrac: frac } : { ...wp }))
      sidecar.setActivation(cue.id, pointId, { pathPoints: next })
    }
    el.addEventListener('pointermove', onMove as EventListener)
    el.addEventListener('pointerup', onUp as EventListener)
  }

  const onMenu = (e: React.MouseEvent, index: number) => {
    // Acteurs du bloc qui ont encore un tracé (pour la suppression groupée).
    const actorsWithWps = Object.entries(cue.activations)
      .filter(([, a]) => (a.pathPoints?.length ?? 0) > 0)
    const selCount = selectedWaypointCount()
    showContextMenu(e, [
      [{
        label: t('timeline.waypointDeleteSelection', { n: selCount }),
        danger: true,
        disabled: selCount < 2,
        onClick: () => deleteSelectedWaypoints(cue),
      },
      {
        label: t('timeline.waypointDelete'),
        danger: true,
        onClick: () => {
          const next = wps.filter((_, i) => i !== index)
          sidecar.setActivation(cue.id, pointId, { pathPoints: next })
        },
      },
      {
        label: t('timeline.waypointDeleteAllActor'),
        danger: true,
        disabled: wps.length < 2,
        onClick: () => sidecar.setActivation(cue.id, pointId, { pathPoints: [] }),
      },
      {
        label: t('timeline.waypointDeleteAllBlock', { n: actorsWithWps.length }),
        danger: true,
        disabled: actorsWithWps.length < 2,
        onClick: () => sidecar.setActivations(
          cue.id,
          actorsWithWps.map(([pid]) => ({ pointId: pid, pathPoints: [] })),
        ),
      }],
      [{
        label: t('timeline.waypointAutoTiming'),
        disabled: wps[index].tFrac === null || wps[index].tFrac === undefined,
        onClick: () => {
          const next = wps.map((wp, i) => (i === index ? { ...wp, tFrac: null } : { ...wp }))
          sidecar.setActivation(cue.id, pointId, { pathPoints: next })
        },
      }],
    ])
  }

  return (
    <>
      {wps.map((wp, i) => {
        const isSel = isWaypointSelected(pointId, i)
        // Fraction affichée : drag local > delta groupé live > état projet.
        let frac = fracs[i]
        if (liveDrag?.index === i) frac = liveDrag.frac
        else if (isSel && getLiveDelta() !== 0) {
          const lo = (i > 0 ? fracs[i - 1] : 0) + 0.005
          const hi = (i < fracs.length - 1 ? fracs[i + 1] : 1) - 0.005
          frac = Math.min(hi, Math.max(lo, fracs[i] + getLiveDelta()))
        }
        return (
        <div
          key={i}
          className={`tl-waypoint${wp.tFrac !== null && wp.tFrac !== undefined ? ' tl-waypoint-timed' : ''}${dim ? ' tl-waypoint-dim' : ''}${isSel ? ' tl-waypoint-selected' : ''}`}
          style={{
            left: (cue.startMs - baseMs + offsetMs + frac * fadeMs) * pxPerMs - xOffsetPx,
            top: centerY,
            ...(color && !(wp.tFrac !== null && wp.tFrac !== undefined) ? { background: color } : {}),
          }}
          title={t('timeline.waypointHint', { n: i + 1 })}
          onPointerDown={(e) => onDown(e, i)}
          onContextMenu={(e) => onMenu(e, i)}
          onDoubleClick={(e) => e.stopPropagation()}
        />
        )
      })}
    </>
  )
}
