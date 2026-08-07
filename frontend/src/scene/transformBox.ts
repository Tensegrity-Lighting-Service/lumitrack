// Géométrie de la boîte de transformation (mission « transformation de
// sélection multiple », 2026-07-29). Le morceau central : la conversion
// d'une ROTATION de groupe en tracés spatiaux — chaque acteur suit son arc
// de cercle autour du pivot commun, il ne va pas tout droit à sa nouvelle
// position. Un arc se convertit exactement en Béziers cubiques : découpe en
// segments <= 90°, longueur de poignée k = (4/3)·tan(Δ/4)·r le long de la
// tangente (identité classique arc→Bézier).
import type { PathHandle, PathPoint } from '../types'

export interface ArcResult {
  targetXCm: number
  targetYCm: number
  pathPoints: PathPoint[] | null
  startHandle: PathHandle | null
  targetHandle: PathHandle | null
}

/** Rotation de `theta` radians autour de (cx, cy) : position d'arrivée +
 * tracé en arc. Rayon quasi nul -> pas de tracé (pivot lui-même). */
export function rotationArc(
  baseX: number, baseY: number, cx: number, cy: number, theta: number,
): ArcResult {
  const dx = baseX - cx
  const dy = baseY - cy
  const r = Math.hypot(dx, dy)
  const targetXCm = cx + dx * Math.cos(theta) - dy * Math.sin(theta)
  const targetYCm = cy + dx * Math.sin(theta) + dy * Math.cos(theta)
  if (r < 1e-6 || Math.abs(theta) < 1e-4) {
    return { targetXCm, targetYCm, pathPoints: null, startHandle: null, targetHandle: null }
  }

  const a0 = Math.atan2(dy, dx)
  const n = Math.max(1, Math.ceil(Math.abs(theta) / (Math.PI / 2)))
  const step = theta / n
  const k = (4 / 3) * Math.tan(Math.abs(step) / 4) * r
  const sign = Math.sign(theta)

  const pointAt = (a: number) => ({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  /** Tangente unitaire dans le sens du parcours à l'angle a. */
  const tangentAt = (a: number) => ({ x: -Math.sin(a) * sign, y: Math.cos(a) * sign })

  const startTan = tangentAt(a0)
  const endTan = tangentAt(a0 + theta)
  const startHandle: PathHandle = { dxCm: startTan.x * k, dyCm: startTan.y * k }
  const targetHandle: PathHandle = { dxCm: -endTan.x * k, dyCm: -endTan.y * k }

  const pathPoints: PathPoint[] = []
  for (let i = 1; i < n; i++) {
    const a = a0 + step * i
    const p = pointAt(a)
    const t = tangentAt(a)
    pathPoints.push({
      xCm: p.x, yCm: p.y,
      inDxCm: -t.x * k, inDyCm: -t.y * k,
      outDxCm: t.x * k, outDyCm: t.y * k,
    })
  }
  return { targetXCm, targetYCm, pathPoints: pathPoints.length ? pathPoints : null, startHandle, targetHandle }
}

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

export function boundsOf(points: { baseX: number; baseY: number }[], padCm = 60): Bounds | null {
  if (points.length === 0) return null
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
  for (const p of points) {
    minX = Math.min(minX, p.baseX); maxX = Math.max(maxX, p.baseX)
    minY = Math.min(minY, p.baseY); maxY = Math.max(maxY, p.baseY)
  }
  return { minX: minX - padCm, minY: minY - padCm, maxX: maxX + padCm, maxY: maxY + padCm }
}

// ---- TransformBox (tranches C1-C3, 2026-08-07) ---------------------------
// Helpers PURS de la boîte de transformation type After Effects : 8
// poignées indépendantes, ancre = point opposé (ou l'ancre déplaçable si
// Maj), facteurs d'échelle PAR AXE — l'ancien gizmo ne savait faire qu'une
// homothétie uniforme depuis le centre.

export interface BoxHandleDef {
  key: string
  /** Position de la poignée en fractions de la bbox (0, 0.5 ou 1). */
  fx: number
  fz: number
  axis: 'x' | 'z' | 'both'
  cursor: string
}

export const BOX_HANDLES: BoxHandleDef[] = [
  { key: 'nw', fx: 0, fz: 0, axis: 'both', cursor: 'nwse-resize' },
  { key: 'n', fx: 0.5, fz: 0, axis: 'z', cursor: 'ns-resize' },
  { key: 'ne', fx: 1, fz: 0, axis: 'both', cursor: 'nesw-resize' },
  { key: 'e', fx: 1, fz: 0.5, axis: 'x', cursor: 'ew-resize' },
  { key: 'se', fx: 1, fz: 1, axis: 'both', cursor: 'nwse-resize' },
  { key: 's', fx: 0.5, fz: 1, axis: 'z', cursor: 'ns-resize' },
  { key: 'sw', fx: 0, fz: 1, axis: 'both', cursor: 'nesw-resize' },
  { key: 'w', fx: 0, fz: 0.5, axis: 'x', cursor: 'ew-resize' },
]

export function handlePointCm(h: { fx: number; fz: number }, b: Bounds): { x: number; y: number } {
  return { x: b.minX + h.fx * (b.maxX - b.minX), y: b.minY + h.fz * (b.maxY - b.minY) }
}

/** Le point FIXE par défaut : la poignée diamétralement opposée. */
export function oppositePointCm(h: BoxHandleDef, b: Bounds): { x: number; y: number } {
  return handlePointCm({ fx: 1 - h.fx, fz: 1 - h.fz }, b)
}

/** Facteurs d'échelle par axe : le curseur tire la poignée saisie, le
 * point fixe ne bouge pas. Arête = un seul axe ; coin = deux axes à ratio
 * LIBRE (comme AE). Miroir autorisé (facteur négatif = la formation se
 * retourne) ; bbox dégénérée sur un axe (|dénominateur| < 1 cm) → facteur
 * 1 sur cet axe ; plancher |f| ≥ 1e-3 pour ne jamais écraser à zéro
 * exact (les positions deviendraient indistinguables). */
export function scaleFactors(
  handle: BoxHandleDef,
  fixedPt: { x: number; y: number },
  handleStart: { x: number; y: number },
  cursorCm: { x: number; y: number },
): { fx: number; fy: number } {
  const safe = (f: number) => (Math.abs(f) < 1e-3 ? (f < 0 ? -1e-3 : 1e-3) : f)
  let fx = 1
  let fy = 1
  if (handle.axis !== 'z') {
    const denom = handleStart.x - fixedPt.x
    if (Math.abs(denom) >= 1) fx = safe((cursorCm.x - fixedPt.x) / denom)
  }
  if (handle.axis !== 'x') {
    const denom = handleStart.y - fixedPt.y
    if (Math.abs(denom) >= 1) fy = safe((cursorCm.y - fixedPt.y) / denom)
  }
  return { fx, fy }
}
