// Ligne d'automation SUR le bloc (mission « type Logic Pro », 2026-07-29 ;
// restreinte au lacet le 2026-08-01) : le transfert 0 -> 100 % du bloc,
// dessiné sur la zone de fade du bloc lui-même, éditable à même le bloc
// quand il est sélectionné — nœuds déplaçables, poignées de Bézier
// (symétriques par défaut, Alt casse), double-clic pour insérer, Alt+clic
// pour retirer.
//
// Restreinte au SEUL lacet (Florian, 2026-08-01) : x/y/z sont déjà visibles
// dans la scène (redondant, "je n'ai pas besoin d'un graph par paramètre"),
// le lacet reste moins lisible en vue du dessus donc garde sa ligne dédiée.
// Sémantique inchangée pour cet axe : cette ligne est le PROFIL DU BLOC
// ENTIER — au lâcher, la courbe est écrite sur le lacet de TOUTES les
// activations manuelles (mode "path"/"focus" : le lacet est dérivé, une
// courbe dessus serait un no-op silencieux, donc exclues) qui le touchent.
// Le graph editor (piste « Courbes ») reste l'outil fin par axe et par
// acteur ; la ligne affichée ici est celle de l'activation représentative
// (acteur sélectionné s'il touche le lacet en manuel, sinon la première
// qui le touche).
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Cue } from '../types'
import { sidecar } from '../sidecar'
import { bakeEasing, insertNode, segmentControls, sortNodes } from './curves'
import type { CurveNode } from './curves'

const PAD_V = 3.5
const NODE_R = 3.2
const HANDLE_R = 2.4

function touchesYaw(act: Cue['activations'][string]): boolean {
  return act.targetYawDeg !== null && (act.orientationMode ?? 'manual') === 'manual'
}

export function BlockAutomation({ cue, selected, selectedPointId, widthPx, heightPx }: {
  cue: Cue
  selected: boolean
  selectedPointId: string | null
  widthPx: number
  heightPx: number
}) {
  const pointIds = Object.keys(cue.activations).filter((pid) => touchesYaw(cue.activations[pid]))
  const repId = selectedPointId && pointIds.includes(selectedPointId) ? selectedPointId : pointIds[0]
  const rep = repId ? cue.activations[repId] : null

  const [draft, setDraft] = useState<CurveNode[] | null>(null)
  const [selNode, setSelNode] = useState<number | null>(null)
  const draggingRef = useRef(false)
  const svgRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    if (draggingRef.current) return
    setDraft(null)
    setSelNode(null)
  }, [rep])

  const nodes = useMemo(() => {
    if (draft) return draft
    const stored = rep?.curves?.yaw
    if (stored && stored.length >= 2) return sortNodes(stored as CurveNode[])
    return bakeEasing(rep?.easing ?? 'linear')
  }, [draft, rep])

  if (!rep || pointIds.length === 0) return null

  // La ligne occupe TOUJOURS 100% de la largeur du bloc (2026-07-31) — pas
  // seulement la fenêtre de fade_ms de l'activation représentative. Avant
  // ce fix, un bloc plus long que le fade (le cas courant : un fade de 1,5s
  // dans un bloc de 4s) laissait une portion du bloc sans aucune ligne
  // dessinée, ET pour le lacet (fenêtre de fondu propre, plafonnée à 400 ms
  // — voir YAW_TURN_MS côté Python/Rust) la ligne semblait mentir sur la
  // durée réelle du virage, dessinée sur la largeur du fade_ms STOCKÉ (non
  // plafonné) plutôt que sur celle du bloc. Purement visuel : ne change
  // rien à la sémantique des nœuds de courbe (toujours interprétés côté
  // backend comme une fraction de la fenêtre de fade réelle de l'axe).
  const fadeW = Math.max(4, widthPx)

  // Cadrage vertical : [0,1] étendu par l'overshoot éventuel.
  let vMin = 0
  let vMax = 1
  for (const n of nodes) {
    for (const v of [n.v, n.inV, n.outV]) {
      if (v !== null && v !== undefined) { vMin = Math.min(vMin, v); vMax = Math.max(vMax, v) }
    }
  }
  const tToX = (t: number) => t * fadeW
  const vToY = (v: number) => PAD_V + ((vMax - v) / (vMax - vMin || 1)) * (heightPx - 2 * PAD_V)
  const xToT = (x: number) => x / fadeW
  const yToV = (y: number) => vMax - ((y - PAD_V) / (heightPx - 2 * PAD_V || 1)) * (vMax - vMin || 1)

  const commit = (next: CurveNode[]) => {
    for (const pid of pointIds) {
      sidecar.setActivation(cue.id, pid, { curves: { yaw: next } })
    }
  }

  const pointerToCurve = (e: { clientX: number; clientY: number }) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return null
    return { t: xToT(e.clientX - rect.left), v: yToV(e.clientY - rect.top) }
  }

  const dragLoop = (
    e: React.PointerEvent,
    onMove: (p: { t: number; v: number }, ev: PointerEvent) => void,
  ) => {
    const el = e.currentTarget as Element
    el.setPointerCapture(e.pointerId)
    draggingRef.current = true
    const move = (ev: PointerEvent) => {
      const p = pointerToCurve(ev)
      if (p) onMove(p, ev)
    }
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId)
      el.removeEventListener('pointermove', move as EventListener)
      el.removeEventListener('pointerup', up as EventListener)
      draggingRef.current = false
      setDraft((d) => {
        if (d) commit(d)
        return d
      })
    }
    el.addEventListener('pointermove', move as EventListener)
    el.addEventListener('pointerup', up as EventListener)
  }

  const beginNodeDrag = (e: React.PointerEvent, index: number) => {
    e.stopPropagation()
    e.preventDefault()
    if (e.altKey) {
      // Alt+clic : retirer le nœud (jamais les extrémités).
      if (index === 0 || index === nodes.length - 1) return
      const next = nodes.filter((_, i) => i !== index)
      setSelNode(null)
      setDraft(next)
      commit(next)
      return
    }
    setSelNode(index)
    const base = [...nodes]
    const first = index === 0
    const last = index === nodes.length - 1
    dragLoop(e, (p) => {
      const orig = base[index]
      const lo = first ? orig.t : base[index - 1].t + 0.01
      const hi = last ? orig.t : base[index + 1].t - 0.01
      const t = Math.min(hi, Math.max(lo, first || last ? orig.t : p.t))
      const dt = t - orig.t
      const dv = p.v - orig.v
      const next = [...base]
      next[index] = {
        ...orig, t, v: p.v,
        inT: orig.inT === null ? null : orig.inT + dt,
        inV: orig.inV === null ? null : orig.inV + dv,
        outT: orig.outT === null ? null : orig.outT + dt,
        outV: orig.outV === null ? null : orig.outV + dv,
      }
      setDraft(next)
    })
  }

  const beginHandleDrag = (e: React.PointerEvent, index: number, side: 'in' | 'out') => {
    e.stopPropagation()
    e.preventDefault()
    const base = [...nodes]
    dragLoop(e, (p, ev) => {
      const n = { ...base[index] }
      if (side === 'out') { n.outT = Math.max(n.t, p.t); n.outV = p.v }
      else { n.inT = Math.min(n.t, p.t); n.inV = p.v }
      if (!ev.altKey && (n.mode ?? 'smooth') !== 'corner') {
        const dt = (side === 'out' ? (n.outT ?? n.t) : (n.inT ?? n.t)) - n.t
        const dv = (side === 'out' ? (n.outV ?? n.v) : (n.inV ?? n.v)) - n.v
        if (side === 'out') { n.inT = n.t - dt; n.inV = n.v - dv }
        else { n.outT = n.t - dt; n.outV = n.v - dv }
      }
      const next = [...base]
      next[index] = n
      setDraft(next)
    })
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    if (!selected) return
    e.stopPropagation()
    const p = pointerToCurve(e)
    if (!p || p.t <= 0.02 || p.t >= 0.98) return
    const next = insertNode(nodes, p.t)
    setDraft(next)
    commit(next)
  }

  // Tracé exact : chaque segment est une cubique -> commande SVG C.
  let d = `M ${tToX(nodes[0].t)} ${vToY(nodes[0].v)}`
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i]
    const b = nodes[i + 1]
    const c = segmentControls(a, b)
    d += ` C ${tToX(c.t1)} ${vToY(c.v1)}, ${tToX(c.t2)} ${vToY(c.v2)}, ${tToX(b.t)} ${vToY(b.v)}`
  }
  // Remplissage sous la courbe (lisibilité façon Logic).
  const fill = `${d} L ${tToX(1)} ${vToY(vMin)} L ${tToX(0)} ${vToY(vMin)} Z`

  return (
    <svg
      ref={svgRef}
      className={`block-auto${selected ? ' block-auto-editable' : ''}`}
      width={fadeW}
      height={heightPx}
      onDoubleClick={onDoubleClick}
    >
      <path className="block-auto-fill" d={fill} />
      <path className="block-auto-line" d={d} />
      {selected && nodes.map((n, i) => {
        const isSel = selNode === i
        return (
          <g key={i}>
            {isSel && n.inT !== null && n.inV !== null && (
              <>
                <line className="block-auto-hline" x1={tToX(n.t)} y1={vToY(n.v)} x2={tToX(n.inT)} y2={vToY(n.inV)} />
                <circle className="block-auto-handle" cx={tToX(n.inT)} cy={vToY(n.inV)} r={HANDLE_R}
                  onPointerDown={(e) => beginHandleDrag(e, i, 'in')} />
              </>
            )}
            {isSel && n.outT !== null && n.outV !== null && (
              <>
                <line className="block-auto-hline" x1={tToX(n.t)} y1={vToY(n.v)} x2={tToX(n.outT)} y2={vToY(n.outV)} />
                <circle className="block-auto-handle" cx={tToX(n.outT)} cy={vToY(n.outV)} r={HANDLE_R}
                  onPointerDown={(e) => beginHandleDrag(e, i, 'out')} />
              </>
            )}
            <circle
              className={`block-auto-node${isSel ? ' block-auto-node-sel' : ''}`}
              cx={tToX(n.t)} cy={vToY(n.v)} r={NODE_R}
              onPointerDown={(e) => beginNodeDrag(e, i)}
            />
          </g>
        )
      })}
    </svg>
  )
}
