// Graph editor lié aux blocs (spec = KeysView/graphboxeslist de Friction,
// rapport-friction-code.md). Rendu DANS le tl-content de la timeline : même
// pxPerMs, même scroll, même playhead — le lien visuel bloc <-> courbes est
// structurel, pas simulé. Panneau visible quand un bloc est sélectionné et
// que « Courbes » est activé.
//
// Ce qui s'édite : les courbes PAR AXE de l'activation du point sélectionné
// dans le bloc. Chaque geste est optimiste localement, committé au lâcher
// via set_activation {curves} (§13.1.7 : la lecture reste backend-only).
//
// Refonte B1 (2026-08-07, « le graph est devenu assez pourri ») :
// cadrage vertical FIGÉ pendant un drag (fini la courbe qui « respire »
// sous le curseur), grille graduée (horizontales à pas joli + verticales
// alignées sur les ticks de la règle), readout numérique du nœud (t en ms,
// v), snapping léger (v→0/1, t→playhead ; Alt désactive), poignées de tous
// les nœuds de l'axe actif (estompées hors sélection), sélection MULTIPLE
// par Maj-clic (déplacement/suppression groupés), marqueur de la valeur au
// playhead, hauteur redimensionnable (côté CueTimeline).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Activation, Cue } from '../types'
import { sidecar } from '../sidecar'
import {
  AXES, AXIS_COLORS, AXIS_LABEL_KEYS, bakeEasing, evalCurve, insertNode, linearNodes,
  segmentControls, smoothNodes, sortNodes,
} from './curves'
import type { Axis, CurveNode, HandleMode } from './curves'
import { computeTicks } from './ticks'
import { NumericInput } from '../ui/NumericInput'
import { useT } from '../i18n'

const PAD_V = 14
const NODE_R = 4.5
const HANDLE_R = 3
const SNAP_PX = 6

// Presse-papier de courbe (module : survit aux re-rendus, pas au reload).
let curveClipboard: CurveNode[] | null = null

/** Sélection MULTIPLE mono-axe (B1) : indices dans l'ordre de clic, le
 * DERNIER est le nœud « principal » (readout, modes de poignée). */
interface Selection { axis: Axis; indices: number[] }

function axisHasTarget(act: Activation, axis: Axis): boolean {
  switch (axis) {
    case 'x': return act.targetXCm !== null
    case 'y': return act.targetYCm !== null
    case 'z': return act.targetZCm !== null
  }
}

/** Pas « joli » pour ~44 px entre deux lignes horizontales. */
function niceStep(span: number, heightPx: number): number {
  const raw = (span * 44) / Math.max(1, heightPx)
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1e-6, raw))))
  const norm = raw / mag
  const base = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10
  return base * mag
}

export function GraphEditor({ cue, act, pointId, pointName, pxPerMs, height, contentWidth, scrollLeft, viewportWidth, tMs }: {
  cue: Cue
  act: Activation | null
  pointId: string | null
  pointName: string | null
  pxPerMs: number
  height: number
  contentWidth: number
  scrollLeft: number
  viewportWidth: number
  tMs: number
}) {
  const t = useT()
  const [draft, setDraft] = useState<Partial<Record<Axis, CurveNode[]>>>({})
  const [activeAxis, setActiveAxis] = useState<Axis>('x')
  const [hiddenAxes, setHiddenAxes] = useState<Set<Axis>>(new Set())
  const [selection, setSelection] = useState<Selection | null>(null)
  const [dragReadout, setDragReadout] = useState<{ x: number; y: number; text: string } | null>(null)
  const draggingRef = useRef(false)
  const svgRef = useRef<SVGSVGElement>(null)
  // Cadrage vertical FIGÉ pendant un drag (B1.1) : gelé au pointerdown,
  // relâché au pointerup — la courbe ne « respire » plus sous le curseur.
  const frozenRangeRef = useRef<[number, number] | null>(null)

  const availableAxes = useMemo(
    () => (act ? AXES.filter((a) => axisHasTarget(act, a)) : []),
    [act],
  )

  useEffect(() => {
    if (draggingRef.current) return
    setDraft({})
    setSelection(null)
  }, [act])

  useEffect(() => {
    if (availableAxes.length && !availableAxes.includes(activeAxis)) {
      setActiveAxis(availableAxes[0])
    }
  }, [availableAxes, activeAxis])

  const curveFor = useCallback((axis: Axis): { nodes: CurveNode[]; custom: boolean } => {
    const local = draft[axis]
    if (local) return { nodes: local, custom: true }
    const stored = act?.curves?.[axis]
    if (stored && stored.length >= 2) return { nodes: stored as CurveNode[], custom: true }
    return { nodes: bakeEasing(act?.easing ?? 'linear'), custom: false }
  }, [draft, act])

  // ---- cadrage vertical automatique (spec: graphUpdateDimensions) ----
  const [vMinAuto, vMaxAuto] = useMemo(() => {
    let lo = 0; let hi = 1
    for (const axis of availableAxes) {
      if (hiddenAxes.has(axis)) continue
      const { nodes } = curveFor(axis)
      for (const n of nodes) {
        for (const v of [n.v, n.inV, n.outV]) {
          if (v !== null && v !== undefined) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
        }
      }
    }
    const pad = (hi - lo) * 0.08 || 0.05
    return [lo - pad, hi + pad]
  }, [availableAxes, hiddenAxes, curveFor])
  const vMin = frozenRangeRef.current?.[0] ?? vMinAuto
  const vMax = frozenRangeRef.current?.[1] ?? vMaxAuto

  const fadeMs = Math.max(1, act?.fadeMs ?? cue.durationMs)
  const x0 = (cue.startMs + (act?.startOffsetMs ?? 0)) * pxPerMs
  const fadeW = fadeMs * pxPerMs
  const tToX = useCallback((tt: number) => x0 + tt * fadeW, [x0, fadeW])
  const vToY = useCallback(
    (v: number) => {
      const lo = frozenRangeRef.current?.[0] ?? vMinAuto
      const hi = frozenRangeRef.current?.[1] ?? vMaxAuto
      return PAD_V + ((hi - v) / (hi - lo)) * (height - 2 * PAD_V)
    },
    [vMinAuto, vMaxAuto, height],
  )
  const xToT = useCallback((x: number) => (x - x0) / fadeW, [x0, fadeW])
  const yToV = useCallback(
    (y: number) => {
      const lo = frozenRangeRef.current?.[0] ?? vMinAuto
      const hi = frozenRangeRef.current?.[1] ?? vMaxAuto
      return hi - ((y - PAD_V) / (height - 2 * PAD_V)) * (hi - lo)
    },
    [vMinAuto, vMaxAuto, height],
  )

  // Fraction du playhead dans la zone de fade (snap + marqueur).
  const playheadFrac = (tMs - cue.startMs - (act?.startOffsetMs ?? 0)) / fadeMs

  const commit = useCallback((axis: Axis, nodes: CurveNode[] | null) => {
    if (!pointId) return
    sidecar.setActivation(cue.id, pointId, { curves: { [axis]: nodes ?? [] } })
  }, [cue.id, pointId])

  const setLocal = useCallback((axis: Axis, nodes: CurveNode[]) => {
    setDraft((d) => ({ ...d, [axis]: nodes }))
  }, [])

  // ---- gestes -------------------------------------------------------------

  const pointerToCurve = useCallback((e: { clientX: number; clientY: number }) => {
    const svg = svgRef.current
    if (!svg) return null
    const rect = svg.getBoundingClientRect()
    return { t: xToT(e.clientX - rect.left), v: yToV(e.clientY - rect.top) }
  }, [xToT, yToV])

  const beginNodeDrag = useCallback((e: React.PointerEvent, axis: Axis, index: number) => {
    e.stopPropagation()
    e.preventDefault()
    setActiveAxis(axis)
    // Maj-clic = toggle dans la sélection multiple (B1.6), sans drag.
    if (e.shiftKey) {
      setSelection((prev) => {
        if (!prev || prev.axis !== axis) return { axis, indices: [index] }
        const has = prev.indices.includes(index)
        const indices = has ? prev.indices.filter((i) => i !== index) : [...prev.indices, index]
        return indices.length ? { axis, indices } : null
      })
      return
    }
    const alreadySelected = !!selection && selection.axis === axis && selection.indices.includes(index)
    const dragIndices = alreadySelected && selection ? selection.indices : [index]
    setSelection({ axis, indices: alreadySelected && selection ? [...selection.indices.filter((i) => i !== index), index] : [index] })
    const el = e.currentTarget as Element
    el.setPointerCapture(e.pointerId)
    draggingRef.current = true
    frozenRangeRef.current = [vMinAuto, vMaxAuto]
    const base = sortNodes(curveFor(axis).nodes)
    const lastIdx = base.length - 1
    // Marges de déplacement temporel du GROUPE : min des marges de chaque
    // nœud sélectionné vers ses voisins HORS sélection (extrémités : t figé).
    const selSet = new Set(dragIndices)
    let dtLo = -Infinity
    let dtHi = Infinity
    for (const i of dragIndices) {
      if (i === 0 || i === lastIdx) { dtLo = 0; dtHi = 0; continue }
      let prev = i - 1
      while (prev > 0 && selSet.has(prev)) prev--
      let next = i + 1
      while (next < lastIdx && selSet.has(next)) next++
      dtLo = Math.max(dtLo, base[prev].t + 0.005 - base[i].t)
      dtHi = Math.min(dtHi, base[next].t - 0.005 - base[i].t)
    }
    const orig = base[index]

    const onMove = (ev: PointerEvent) => {
      const p = pointerToCurve(ev)
      if (!p) return
      let targetT = p.t
      let targetV = p.v
      // Snapping léger (B1.4) — Alt désactive : v vers 0/1, t vers le
      // playhead, à moins de SNAP_PX px écran.
      if (!ev.altKey) {
        const vSnapTol = (SNAP_PX / Math.max(1, height - 2 * PAD_V)) * (vMax - vMin)
        if (Math.abs(targetV) < vSnapTol) targetV = 0
        else if (Math.abs(targetV - 1) < vSnapTol) targetV = 1
        if (playheadFrac > 0 && playheadFrac < 1
          && Math.abs(targetT - playheadFrac) * fadeW < SNAP_PX) targetT = playheadFrac
      }
      const isEdge = index === 0 || index === lastIdx
      const dt = isEdge ? 0 : Math.min(dtHi, Math.max(dtLo, targetT - orig.t))
      const dv = targetV - orig.v
      const nodes = base.map((n, i) => {
        if (!selSet.has(i)) return n
        const edge = i === 0 || i === lastIdx
        const ndt = edge ? 0 : dt
        return {
          ...n,
          t: n.t + ndt,
          v: n.v + dv,
          inT: n.inT === null ? null : n.inT + ndt,
          inV: n.inV === null ? null : n.inV + dv,
          outT: n.outT === null ? null : n.outT + ndt,
          outV: n.outV === null ? null : n.outV + dv,
        }
      })
      setLocal(axis, nodes)
      const moved = nodes[index]
      setDragReadout({
        x: tToX(moved.t),
        y: vToY(moved.v) - 12,
        text: `${Math.round(moved.t * fadeMs)} ms · ${moved.v.toFixed(3)}`,
      })
    }
    const onUp = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId)
      el.removeEventListener('pointermove', onMove as EventListener)
      el.removeEventListener('pointerup', onUp as EventListener)
      draggingRef.current = false
      frozenRangeRef.current = null
      setDragReadout(null)
      setDraft((d) => {
        const nodes = d[axis]
        if (nodes) commit(axis, nodes)
        return d
      })
    }
    el.addEventListener('pointermove', onMove as EventListener)
    el.addEventListener('pointerup', onUp as EventListener)
  }, [curveFor, pointerToCurve, setLocal, commit, selection, vMinAuto, vMaxAuto, vMin, vMax, height, fadeMs, fadeW, playheadFrac, tToX, vToY])

  const beginHandleDrag = useCallback((e: React.PointerEvent, axis: Axis, index: number, side: 'in' | 'out') => {
    e.stopPropagation()
    e.preventDefault()
    setActiveAxis(axis)
    setSelection({ axis, indices: [index] })
    const el = e.currentTarget as Element
    el.setPointerCapture(e.pointerId)
    draggingRef.current = true
    frozenRangeRef.current = [vMinAuto, vMaxAuto]
    const base = sortNodes(curveFor(axis).nodes)

    const onMove = (ev: PointerEvent) => {
      const p = pointerToCurve(ev)
      if (!p) return
      const nodes = [...base]
      const n = { ...base[index] }
      const mode: HandleMode = n.mode ?? 'smooth'
      if (side === 'out') { n.outT = Math.max(n.t, p.t); n.outV = p.v }
      else { n.inT = Math.min(n.t, p.t); n.inV = p.v }
      if (mode !== 'corner') {
        // Miroir de l'autre poignée : symmetric = longueur ET direction,
        // smooth = direction seule (longueur conservée) — spec Friction.
        const dt = (side === 'out' ? (n.outT ?? n.t) : (n.inT ?? n.t)) - n.t
        const dv = (side === 'out' ? (n.outV ?? n.v) : (n.inV ?? n.v)) - n.v
        const otherT = side === 'out' ? n.inT : n.outT
        const otherV = side === 'out' ? n.inV : n.outV
        if (otherT !== null && otherV !== null) {
          let mdt = -dt; let mdv = -dv
          if (mode === 'smooth') {
            const len = Math.hypot(otherT - n.t, otherV - n.v)
            const dragLen = Math.hypot(dt, dv) || 1
            mdt = (-dt / dragLen) * len
            mdv = (-dv / dragLen) * len
          }
          if (side === 'out') { n.inT = n.t + mdt; n.inV = n.v + mdv }
          else { n.outT = n.t + mdt; n.outV = n.v + mdv }
        }
      }
      nodes[index] = n
      setLocal(axis, nodes)
    }
    const onUp = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId)
      el.removeEventListener('pointermove', onMove as EventListener)
      el.removeEventListener('pointerup', onUp as EventListener)
      draggingRef.current = false
      frozenRangeRef.current = null
      setDraft((d) => {
        const nodes = d[axis]
        if (nodes) commit(axis, nodes)
        return d
      })
    }
    el.addEventListener('pointermove', onMove as EventListener)
    el.addEventListener('pointerup', onUp as EventListener)
  }, [curveFor, pointerToCurve, setLocal, commit, vMinAuto, vMaxAuto])

  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    const p = pointerToCurve(e)
    if (!p || p.t <= 0 || p.t >= 1) return
    const { nodes } = curveFor(activeAxis)
    const next = insertNode(nodes, p.t)
    setLocal(activeAxis, next)
    commit(activeAxis, next)
  }, [pointerToCurve, curveFor, activeAxis, setLocal, commit])

  // Suppr : retire les nœuds sélectionnés (jamais les extrémités).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (!selection) return
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') return
      // Un nœud est sélectionné : la touche nous appartient, même si le
      // nœud est une extrémité non supprimable — sinon le raccourci global
      // supprimerait le BLOC pendant l'édition de courbe.
      e.stopPropagation()
      e.preventDefault()
      const { nodes } = curveFor(selection.axis)
      const sorted = sortNodes(nodes)
      const removable = new Set(selection.indices.filter((i) => i !== 0 && i !== sorted.length - 1))
      if (removable.size === 0) return
      const next = sorted.filter((_, i) => !removable.has(i))
      setSelection(null)
      setLocal(selection.axis, next)
      commit(selection.axis, next)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [selection, curveFor, setLocal, commit])

  // ---- actions de barre ---------------------------------------------------

  const primaryIndex = selection ? selection.indices[selection.indices.length - 1] : null

  const applyPreset = useCallback((name: string) => {
    const nodes = bakeEasing(name)
    setLocal(activeAxis, nodes)
    commit(activeAxis, nodes)
  }, [activeAxis, setLocal, commit])

  const applyTransform = useCallback((fn: (nodes: CurveNode[]) => CurveNode[]) => {
    const next = fn(curveFor(activeAxis).nodes)
    setLocal(activeAxis, next)
    commit(activeAxis, next)
  }, [curveFor, activeAxis, setLocal, commit])

  const setSelectedMode = useCallback((mode: HandleMode) => {
    if (!selection || primaryIndex === null) return
    const sorted = sortNodes(curveFor(selection.axis).nodes)
    const n = { ...sorted[primaryIndex], mode }
    if (mode === 'symmetric' && n.inT !== null && n.outT !== null) {
      // Rend immédiatement symétrique autour du nœud (côté out gagnant).
      n.inT = n.t - ((n.outT ?? n.t) - n.t)
      n.inV = n.v - ((n.outV ?? n.v) - n.v)
    }
    const nodes = sorted.map((m, i) => (i === primaryIndex ? n : m))
    setLocal(selection.axis, nodes)
    commit(selection.axis, nodes)
  }, [selection, primaryIndex, curveFor, setLocal, commit])

  /** Readout numérique (B1.3) : édite le nœud principal — t en ms depuis
   * le début du fade (clampé entre voisins, extrémités figées), v libre. */
  const editPrimary = useCallback((patch: { tMsIn?: number; v?: number }) => {
    if (!selection || primaryIndex === null) return
    const sorted = sortNodes(curveFor(selection.axis).nodes)
    const i = primaryIndex
    const n = { ...sorted[i] }
    if (patch.tMsIn !== undefined && i !== 0 && i !== sorted.length - 1) {
      const lo = sorted[i - 1].t + 0.005
      const hi = sorted[i + 1].t - 0.005
      const nt = Math.min(hi, Math.max(lo, patch.tMsIn / fadeMs))
      const dt = nt - n.t
      n.t = nt
      n.inT = n.inT === null ? null : n.inT + dt
      n.outT = n.outT === null ? null : n.outT + dt
    }
    if (patch.v !== undefined) {
      const dv = patch.v - n.v
      n.v = patch.v
      n.inV = n.inV === null ? null : n.inV + dv
      n.outV = n.outV === null ? null : n.outV + dv
    }
    const nodes = sorted.map((m, j) => (j === i ? n : m))
    setLocal(selection.axis, nodes)
    commit(selection.axis, nodes)
  }, [selection, primaryIndex, curveFor, fadeMs, setLocal, commit])

  const resetAxis = useCallback(() => {
    setDraft((d) => ({ ...d, [activeAxis]: undefined }))
    commit(activeAxis, null)
  }, [activeAxis, commit])

  const copyCurve = useCallback(() => {
    curveClipboard = sortNodes(curveFor(activeAxis).nodes).map((n) => ({ ...n }))
  }, [curveFor, activeAxis])

  const pasteCurve = useCallback(() => {
    if (!curveClipboard) return
    const nodes = curveClipboard.map((n) => ({ ...n }))
    setLocal(activeAxis, nodes)
    commit(activeAxis, nodes)
  }, [activeAxis, setLocal, commit])

  const applyToAllPoints = useCallback(() => {
    if (!pointId) return
    const payload: Partial<Record<Axis, CurveNode[]>> = {}
    for (const axis of availableAxes) {
      const { nodes, custom } = curveFor(axis)
      if (custom) payload[axis] = nodes
    }
    for (const pid of Object.keys(cue.activations)) {
      if (pid === pointId) continue
      sidecar.setActivation(cue.id, pid, { curves: payload })
    }
  }, [pointId, availableAxes, curveFor, cue])

  // ---- rendu --------------------------------------------------------------

  if (!act || !pointId) {
    return (
      <div className="graph-track" style={{ height }}>
        <div className="graph-hint" style={{ left: Math.max(8, scrollLeft + 8) }}>
          {Object.keys(cue.activations).length === 0
            ? t('graph.emptyNoActivation')
            : t('graph.emptySelectPoint')}
        </div>
      </div>
    )
  }

  const holdW = Math.max(0, (cue.durationMs - fadeMs) * pxPerMs)
  const y0 = vToY(0)
  const y1 = vToY(1)

  // Grille graduée (B1.2) : horizontales à pas joli avec labels épinglés,
  // verticales = EXACTEMENT les ticks de la règle (alignement structurel).
  const hStep = niceStep(vMax - vMin, height - 2 * PAD_V)
  const hLines: number[] = []
  for (let v = Math.ceil(vMin / hStep) * hStep; v <= vMax + 1e-9; v += hStep) {
    hLines.push(Math.round(v * 1e6) / 1e6)
  }
  const vTicks = computeTicks(pxPerMs, scrollLeft, viewportWidth)

  // Nœud principal pour le readout de la toolbar.
  const primaryNode = selection && primaryIndex !== null
    ? sortNodes(curveFor(selection.axis).nodes)[primaryIndex] ?? null
    : null
  const primaryIsEdge = selection && primaryIndex !== null
    ? (primaryIndex === 0 || primaryIndex === sortNodes(curveFor(selection.axis).nodes).length - 1)
    : false

  return (
    <div className="graph-track" style={{ height }}>
      {/* Barre d'outils épinglée à gauche du viewport, pas du contenu. */}
      <div className="graph-toolbar" style={{ left: scrollLeft + 6 }}>
        {availableAxes.map((axis) => (
          <button
            key={axis}
            className={`graph-chip${axis === activeAxis ? ' graph-chip-active' : ''}${hiddenAxes.has(axis) ? ' graph-chip-hidden' : ''}`}
            style={{ '--axis-color': AXIS_COLORS[axis] } as React.CSSProperties}
            title={t('graph.axisHint', { label: t(AXIS_LABEL_KEYS[axis]) })}
            onClick={(e) => {
              if (e.altKey) {
                setHiddenAxes((prev) => {
                  const next = new Set(prev)
                  if (next.has(axis)) next.delete(axis)
                  else next.add(axis)
                  return next
                })
              } else {
                setActiveAxis(axis)
                setHiddenAxes((prev) => {
                  const next = new Set(prev)
                  next.delete(axis)
                  return next
                })
              }
            }}
          >
            {t(AXIS_LABEL_KEYS[axis])}
          </button>
        ))}
        <span className="graph-sep" />
        <select
          className="graph-select"
          value=""
          title={t('graph.easingApplyHint')}
          onChange={(e) => { if (e.target.value) applyPreset(e.target.value) }}
        >
          <option value="">{t('graph.easingPlaceholder')}</option>
          {['linear', 'smooth', 'ease-in', 'ease-out', 'bounce', 'spring', 'exponential'].map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
        <button title={t('graph.linearHint')} onClick={() => applyTransform(linearNodes)}>{t('graph.linear')}</button>
        <button title={t('graph.smoothHint')} onClick={() => applyTransform((n) => smoothNodes(n))}>{t('graph.smooth')}</button>
        {selection && (
          <>
            <span className="graph-sep" />
            <button title={t('graph.cornerHint')} onClick={() => setSelectedMode('corner')}>{t('graph.corner')}</button>
            <button title={t('graph.tangentHint')} onClick={() => setSelectedMode('smooth')}>{t('graph.tangent')}</button>
            <button title={t('graph.mirrorHint')} onClick={() => setSelectedMode('symmetric')}>{t('graph.mirror')}</button>
          </>
        )}
        {primaryNode && (
          <>
            <span className="graph-sep" />
            <label className="graph-readout" title={t('graph.timeHint')}>
              {t('graph.time')}
              <NumericInput
                value={Math.round(primaryNode.t * fadeMs)}
                step={10}
                onCommit={(v) => { if (v !== null && !primaryIsEdge) editPrimary({ tMsIn: v }) }}
              />
            </label>
            <label className="graph-readout" title={t('graph.valueHint')}>
              {t('graph.value')}
              <NumericInput
                value={Math.round(primaryNode.v * 1000) / 1000}
                step={0.05}
                onCommit={(v) => { if (v !== null) editPrimary({ v }) }}
              />
            </label>
            {selection && selection.indices.length > 1 && (
              <span className="graph-multi-count">{t('graph.multiCount', { count: selection.indices.length })}</span>
            )}
          </>
        )}
        <span className="graph-sep" />
        <button onClick={copyCurve} title={t('graph.copyHint')}>{t('graph.copy')}</button>
        <button onClick={pasteCurve} disabled={!curveClipboard} title={t('graph.pasteHint')}>{t('graph.paste')}</button>
        <button onClick={resetAxis} title={t('graph.resetHint')}>{t('graph.reset')}</button>
        {Object.keys(cue.activations).length > 1 && (
          <button onClick={applyToAllPoints} title={t('graph.applyAllHint')}>{t('graph.applyAll')}</button>
        )}
        <span className="graph-pointname">{pointName}</span>
      </div>

      <svg ref={svgRef} className="graph-svg" width={contentWidth} height={height} onDoubleClick={onDoubleClick}>
        {/* Zone de fade (éditable) + zone de maintien du bloc. */}
        <rect x={x0} y={0} width={fadeW} height={height} className="graph-fade-zone" />
        {holdW > 0 && <rect x={x0 + fadeW} y={0} width={holdW} height={height} className="graph-hold-zone" />}

        {/* Grille graduée (B1.2) : verticales = ticks de la règle. */}
        {vTicks.map((tick) => (
          <line
            key={`vt-${tick.ms}`}
            x1={tick.ms * pxPerMs} x2={tick.ms * pxPerMs} y1={0} y2={height}
            className={tick.label !== null ? 'graph-grid-v graph-grid-v-major' : 'graph-grid-v'}
          />
        ))}
        {hLines.map((v) => (
          <g key={`h-${v}`}>
            <line x1={scrollLeft} x2={scrollLeft + viewportWidth} y1={vToY(v)} y2={vToY(v)} className="graph-grid-h" />
            <text x={scrollLeft + viewportWidth - 6} y={vToY(v) - 2} className="graph-grid-label" textAnchor="end">
              {Math.round(v * 100) / 100}
            </text>
          </g>
        ))}

        {/* Lignes de référence progrès 0 (départ) et 1 (cible). */}
        <line x1={x0} x2={x0 + fadeW} y1={y1} y2={y1} className="graph-ref-line" />
        <line x1={x0} x2={x0 + fadeW} y1={y0} y2={y0} className="graph-ref-line" />
        <text x={x0 + fadeW + 4} y={y1 + 3.5} className="graph-ref-label">{t('graph.target')}</text>
        <text x={x0 + fadeW + 4} y={y0 + 3.5} className="graph-ref-label">{t('graph.start')}</text>

        {availableAxes.filter((a) => !hiddenAxes.has(a)).map((axis) => {
          const { nodes, custom } = curveFor(axis)
          const sorted = sortNodes(nodes)
          const isActive = axis === activeAxis
          const color = AXIS_COLORS[axis]
          let d = `M ${tToX(sorted[0].t)} ${vToY(sorted[0].v)}`
          for (let i = 0; i < sorted.length - 1; i++) {
            const a = sorted[i]; const b = sorted[i + 1]
            const { t1, v1, t2, v2 } = segmentControls(a, b)
            d += ` C ${tToX(t1)} ${vToY(v1)}, ${tToX(t2)} ${vToY(v2)}, ${tToX(b.t)} ${vToY(b.v)}`
          }
          // Marqueur au playhead (B1.7) : valeur de la courbe à l'instant lu.
          const phv = playheadFrac >= 0 && playheadFrac <= 1 ? evalCurve(sorted, playheadFrac) : null
          return (
            <g key={axis}>
              <path
                d={d}
                className={`graph-curve${isActive ? ' graph-curve-active' : ''}${custom ? '' : ' graph-curve-baked'}`}
                style={{ stroke: color }}
                onPointerDown={() => setActiveAxis(axis)}
              />
              {phv !== null && (
                <circle cx={tToX(playheadFrac)} cy={vToY(phv)} r={3} className="graph-playhead-dot" style={{ fill: color }} />
              )}
              {isActive && phv !== null && (
                <text x={tToX(playheadFrac) + 6} y={vToY(phv) - 6} className="graph-playhead-value">{phv.toFixed(2)}</text>
              )}
              {isActive && sorted.map((n, i) => {
                const selected = !!selection && selection.axis === axis && selection.indices.includes(i)
                // Poignées de TOUS les nœuds de l'axe actif (B1.5) —
                // pleines si le nœud est sélectionné, estompées sinon.
                const handleClass = selected ? 'graph-handle' : 'graph-handle graph-handle-dim'
                const lineClass = selected ? 'graph-handle-line' : 'graph-handle-line graph-handle-dim'
                return (
                  <g key={i}>
                    {n.inT !== null && n.inV !== null && (
                      <>
                        <line x1={tToX(n.t)} y1={vToY(n.v)} x2={tToX(n.inT)} y2={vToY(n.inV)} className={lineClass} />
                        <circle
                          cx={tToX(n.inT)} cy={vToY(n.inV)} r={HANDLE_R}
                          className={handleClass} style={{ fill: color }}
                          onPointerDown={(e) => beginHandleDrag(e, axis, i, 'in')}
                        />
                      </>
                    )}
                    {n.outT !== null && n.outV !== null && (
                      <>
                        <line x1={tToX(n.t)} y1={vToY(n.v)} x2={tToX(n.outT)} y2={vToY(n.outV)} className={lineClass} />
                        <circle
                          cx={tToX(n.outT)} cy={vToY(n.outV)} r={HANDLE_R}
                          className={handleClass} style={{ fill: color }}
                          onPointerDown={(e) => beginHandleDrag(e, axis, i, 'out')}
                        />
                      </>
                    )}
                    <circle
                      cx={tToX(n.t)} cy={vToY(n.v)} r={NODE_R}
                      className={`graph-node${selected ? ' graph-node-selected' : ''}`}
                      style={{ stroke: color }}
                      onPointerDown={(e) => beginNodeDrag(e, axis, i)}
                    />
                  </g>
                )
              })}
            </g>
          )
        })}

        {/* Readout flottant pendant un drag (B1.3). */}
        {dragReadout && (
          <text x={dragReadout.x + 8} y={dragReadout.y} className="graph-drag-readout">{dragReadout.text}</text>
        )}
      </svg>
    </div>
  )
}
