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
import { useRef } from 'react'
import type { Activation, Cue, PathPoint } from '../types'
import { sidecar } from '../sidecar'
import { showContextMenu } from '../ui/contextMenuStore'
import { t } from '../i18n'

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

const DRAG_SEND_MS = 33

/** Rangée de losanges d'UNE activation. `baseMs` = temps du bord gauche du
 * conteneur positionné (cue.startMs quand on rend DANS le bloc, 0 dans un
 * contenu absolu du panneau détail). */
export function WaypointDiamonds({ cue, act, pointId, pxPerMs, baseMs, centerY, xOffsetPx = 0 }: {
  cue: Cue
  act: Activation
  pointId: string
  pxPerMs: number
  baseMs: number
  centerY: number
  /** Décalage écran supplémentaire (repère viewport du panneau détail :
   * scrollLeft en pixels) — 0 dans le contenu scrollé de la timeline. */
  xOffsetPx?: number
}) {
  const wps = act.pathPoints ?? []
  const dragRef = useRef<{
    index: number
    startClientX: number
    moved: boolean
    lastSent: number
    fracs: number[]
  } | null>(null)
  if (wps.length === 0) return null

  const fadeMs = Math.max(1, act.fadeMs ?? cue.durationMs)
  const offsetMs = act.startOffsetMs ?? 0
  const fracs = waypointTimeFracs(wps)

  const writeTiming = (index: number, tFrac: number, preview: boolean) => {
    const next = wps.map((wp, i) => (i === index ? { ...wp, tFrac } : { ...wp }))
    if (preview) sidecar.setActivationPreview(cue.id, pointId, { pathPoints: next })
    else sidecar.setActivation(cue.id, pointId, { pathPoints: next })
  }

  const onDown = (e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const el = e.currentTarget as Element
    el.setPointerCapture(e.pointerId)
    dragRef.current = { index, startClientX: e.clientX, moved: false, lastSent: 0, fracs }
    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const dx = ev.clientX - drag.startClientX
      if (!drag.moved && Math.abs(dx) < 3) return
      drag.moved = true
      const lo = (drag.index > 0 ? drag.fracs[drag.index - 1] : 0) + 0.005
      const hi = (drag.index < drag.fracs.length - 1 ? drag.fracs[drag.index + 1] : 1) - 0.005
      const target = Math.min(hi, Math.max(lo, drag.fracs[drag.index] + dx / pxPerMs / fadeMs))
      const now = performance.now()
      if (now - drag.lastSent < DRAG_SEND_MS) return
      drag.lastSent = now
      writeTiming(drag.index, target, true)
    }
    const onUp = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId)
      el.removeEventListener('pointermove', onMove as EventListener)
      el.removeEventListener('pointerup', onUp as EventListener)
      const drag = dragRef.current
      dragRef.current = null
      if (!drag) return
      if (!drag.moved) {
        // Clic sec : sélectionne le waypoint dans la scène (poignées).
        emitSelectWaypoint(pointId, drag.index)
        return
      }
      const dx = ev.clientX - drag.startClientX
      const lo = (drag.index > 0 ? drag.fracs[drag.index - 1] : 0) + 0.005
      const hi = (drag.index < drag.fracs.length - 1 ? drag.fracs[drag.index + 1] : 1) - 0.005
      const target = Math.min(hi, Math.max(lo, drag.fracs[drag.index] + dx / pxPerMs / fadeMs))
      writeTiming(drag.index, target, false)
    }
    el.addEventListener('pointermove', onMove as EventListener)
    el.addEventListener('pointerup', onUp as EventListener)
  }

  const onMenu = (e: React.MouseEvent, index: number) => {
    showContextMenu(e, [
      [{
        label: t('timeline.waypointDelete'),
        danger: true,
        onClick: () => {
          const next = wps.filter((_, i) => i !== index)
          sidecar.setActivation(cue.id, pointId, { pathPoints: next })
        },
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
      {wps.map((wp, i) => (
        <div
          key={i}
          className={`tl-waypoint${wp.tFrac !== null && wp.tFrac !== undefined ? ' tl-waypoint-timed' : ''}`}
          style={{
            left: (cue.startMs - baseMs + offsetMs + fracs[i] * fadeMs) * pxPerMs - xOffsetPx,
            top: centerY,
          }}
          title={t('timeline.waypointHint', { n: i + 1 })}
          onPointerDown={(e) => onDown(e, i)}
          onContextMenu={(e) => onMenu(e, i)}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      ))}
    </>
  )
}
