// Graph editor lié aux blocs (spec = KeysView/graphboxeslist de Friction,
// rapport-friction-code.md). Rendu DANS le tl-content de la timeline : même
// pxPerMs, même scroll, même playhead — le lien visuel bloc <-> courbes est
// structurel, pas simulé. Panneau visible quand un bloc est sélectionné et
// que « Courbes » est activé.
//
// Ce qui s'édite : les courbes PAR AXE de l'activation du point sélectionné
// dans le bloc. Chaque geste est optimiste localement, committé au lâcher
// via set_activation {curves} (§13.1.7 : la lecture reste backend-only).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Activation, Cue } from '../types'
import { sidecar } from '../sidecar'
import {
  AXES, AXIS_COLORS, AXIS_LABEL_KEYS, bakeEasing, insertNode, linearNodes,
  segmentControls, smoothNodes, sortNodes,
} from './curves'
import type { Axis, CurveNode, HandleMode } from './curves'
import { useT } from '../i18n'

const PAD_V = 14
const NODE_R = 4.5
const HANDLE_R = 3

// Presse-papier de courbe (module : survit aux re-rendus, pas au reload).
let curveClipboard: CurveNode[] | null = null

interface Selection { axis: Axis; index: number }

function axisHasTarget(act: Activation, axis: Axis): boolean {
  switch (axis) {
    case 'x': return act.targetXCm !== null
    case 'y': return act.targetYCm !== null
    case 'z': return act.targetZCm !== null
    case 'yaw': return act.targetYawDeg !== null
  }
}

export function GraphEditor({ cue, act, pointId, pointName, pxPerMs, height, contentWidth, scrollLeft }: {
  cue: Cue
  act: Activation | null
  pointId: string | null
  pointName: string | null
  pxPerMs: number
  height: number
  contentWidth: number
  scrollLeft: number
}) {
  const t = useT()
  // Courbes en cours d'édition : état local initialisé depuis l'activation,
  // réinitialisé quand le backend renvoie un nouveau snapshot (identité de
  // `act` change) SAUF pendant un drag.
  const [draft, setDraft] = useState<Partial<Record<Axis, CurveNode[]>>>({})
  const [activeAxis, setActiveAxis] = useState<Axis>('x')
  const [hiddenAxes, setHiddenAxes] = useState<Set<Axis>>(new Set())
  const [selection, setSelection] = useState<Selection | null>(null)
  const draggingRef = useRef(false)
  const svgRef = useRef<SVGSVGElement>(null)

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

  /** Courbe affichée pour un axe : brouillon local sinon celle de
   * l'activation, sinon l'easing nommé converti (affiché en pointillés tant
   * qu'il n'est pas édité). */
  const curveFor = useCallback((axis: Axis): { nodes: CurveNode[]; custom: boolean } => {
    const local = draft[axis]
    if (local) return { nodes: local, custom: true }
    const stored = act?.curves?.[axis]
    if (stored && stored.length >= 2) return { nodes: stored as CurveNode[], custom: true }
    return { nodes: bakeEasing(act?.easing ?? 'linear'), custom: false }
  }, [draft, act])

  // ---- cadrage vertical automatique (spec: graphUpdateDimensions) ----
  const [vMin, vMax] = useMemo(() => {
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

  const fadeMs = Math.max(1, act?.fadeMs ?? cue.durationMs)
  const x0 = cue.startMs * pxPerMs
  const fadeW = fadeMs * pxPerMs
  const tToX = useCallback((t: number) => x0 + t * fadeW, [x0, fadeW])
  const vToY = useCallback(
    (v: number) => PAD_V + ((vMax - v) / (vMax - vMin)) * (height - 2 * PAD_V),
    [vMin, vMax, height],
  )
  const xToT = useCallback((x: number) => (x - x0) / fadeW, [x0, fadeW])
  const yToV = useCallback(
    (y: number) => vMax - ((y - PAD_V) / (height - 2 * PAD_V)) * (vMax - vMin),
    [vMin, vMax, height],
  )

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
    setSelection({ axis, index })
    const el = e.currentTarget as Element
    el.setPointerCapture(e.pointerId)
    draggingRef.current = true
    const base = sortNodes(curveFor(axis).nodes)
    const first = index === 0
    const last = index === base.length - 1

    const onMove = (ev: PointerEvent) => {
      const p = pointerToCurve(ev)
      if (!p) return
      const nodes = [...base]
      const orig = base[index]
      const lo = first ? orig.t : base[index - 1].t + 0.005
      const hi = last ? orig.t : base[index + 1].t - 0.005
      const t = Math.min(hi, Math.max(lo, first || last ? orig.t : p.t))
      const dv = p.v - orig.v
      const dt = t - orig.t
      nodes[index] = {
        ...orig, t, v: p.v,
        inT: orig.inT === null ? null : orig.inT + dt,
        inV: orig.inV === null ? null : orig.inV + dv,
        outT: orig.outT === null ? null : orig.outT + dt,
        outV: orig.outV === null ? null : orig.outV + dv,
      }
      setLocal(axis, nodes)
    }
    const onUp = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId)
      el.removeEventListener('pointermove', onMove as EventListener)
      el.removeEventListener('pointerup', onUp as EventListener)
      draggingRef.current = false
      setDraft((d) => {
        const nodes = d[axis]
        if (nodes) commit(axis, nodes)
        return d
      })
    }
    el.addEventListener('pointermove', onMove as EventListener)
    el.addEventListener('pointerup', onUp as EventListener)
  }, [curveFor, pointerToCurve, setLocal, commit])

  const beginHandleDrag = useCallback((e: React.PointerEvent, axis: Axis, index: number, side: 'in' | 'out') => {
    e.stopPropagation()
    e.preventDefault()
    setActiveAxis(axis)
    setSelection({ axis, index })
    const el = e.currentTarget as Element
    el.setPointerCapture(e.pointerId)
    draggingRef.current = true
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
      setDraft((d) => {
        const nodes = d[axis]
        if (nodes) commit(axis, nodes)
        return d
      })
    }
    el.addEventListener('pointermove', onMove as EventListener)
    el.addEventListener('pointerup', onUp as EventListener)
  }, [curveFor, pointerToCurve, setLocal, commit])

  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    const p = pointerToCurve(e)
    if (!p || p.t <= 0 || p.t >= 1) return
    const { nodes } = curveFor(activeAxis)
    const next = insertNode(nodes, p.t)
    setLocal(activeAxis, next)
    commit(activeAxis, next)
  }, [pointerToCurve, curveFor, activeAxis, setLocal, commit])

  // Suppr : retire le nœud sélectionné (jamais les extrémités).
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
      if (selection.index === 0 || selection.index === sorted.length - 1) return
      const next = sorted.filter((_, i) => i !== selection.index)
      setSelection(null)
      setLocal(selection.axis, next)
      commit(selection.axis, next)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [selection, curveFor, setLocal, commit])

  // ---- actions de barre ---------------------------------------------------

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
    if (!selection) return
    const sorted = sortNodes(curveFor(selection.axis).nodes)
    const n = { ...sorted[selection.index], mode }
    if (mode === 'symmetric' && n.inT !== null && n.outT !== null) {
      // Rend immédiatement symétrique autour du nœud (côté out gagnant).
      n.inT = n.t - ((n.outT ?? n.t) - n.t)
      n.inV = n.v - ((n.outV ?? n.v) - n.v)
    }
    const nodes = sorted.map((m, i) => (i === selection.index ? n : m))
    setLocal(selection.axis, nodes)
    commit(selection.axis, nodes)
  }, [selection, curveFor, setLocal, commit])

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
          return (
            <g key={axis}>
              <path
                d={d}
                className={`graph-curve${isActive ? ' graph-curve-active' : ''}${custom ? '' : ' graph-curve-baked'}`}
                style={{ stroke: color }}
                onPointerDown={() => setActiveAxis(axis)}
              />
              {isActive && sorted.map((n, i) => {
                const selected = selection?.axis === axis && selection.index === i
                return (
                  <g key={i}>
                    {selected && n.inT !== null && n.inV !== null && (
                      <>
                        <line x1={tToX(n.t)} y1={vToY(n.v)} x2={tToX(n.inT)} y2={vToY(n.inV)} className="graph-handle-line" />
                        <circle
                          cx={tToX(n.inT)} cy={vToY(n.inV)} r={HANDLE_R}
                          className="graph-handle" style={{ fill: color }}
                          onPointerDown={(e) => beginHandleDrag(e, axis, i, 'in')}
                        />
                      </>
                    )}
                    {selected && n.outT !== null && n.outV !== null && (
                      <>
                        <line x1={tToX(n.t)} y1={vToY(n.v)} x2={tToX(n.outT)} y2={vToY(n.outV)} className="graph-handle-line" />
                        <circle
                          cx={tToX(n.outT)} cy={vToY(n.outV)} r={HANDLE_R}
                          className="graph-handle" style={{ fill: color }}
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
      </svg>
    </div>
  )
}
