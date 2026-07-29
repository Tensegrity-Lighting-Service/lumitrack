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
