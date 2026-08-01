// Overlay de trajectoire à la sélection (mission "refonte AE/Reaper",
// 2026-08-01) : remplace la ligne d'automation x/y/z retirée du bloc
// (BlockAutomation, restreinte au seul lacet) — plutôt qu'une ligne
// permanente par bloc pour tout le monde ("le foutoir" craint par
// Florian), sélectionner un ou plusieurs acteurs affiche leur courbe de
// déplacement (X et Y) en overlay, une ligne par acteur, dans l'ORDRE DE
// SÉLECTION (`selectedPointIds`, déjà suivi par App.tsx — aucun nouveau
// suivi d'ordre à écrire, cf. discussion du 2026-08-01).
//
// Données 100% backend (resolveTrajectories -> resolve_positions rejoué à
// un échantillonnage régulier, §13.1.7) : ce composant ne fait que
// dessiner, jamais interpoler.
import type { Point, TrajectoriesMessage } from '../types'

export const TRAJECTORY_ROW_H = 34
const ROW_H = TRAJECTORY_ROW_H
const PAD_V = 3

export function TrajectoryOverlay({ pointIds, projectPoints, trajectories, pxPerMs, durationMs }: {
  pointIds: string[]
  projectPoints: Point[]
  trajectories: TrajectoriesMessage | null
  pxPerMs: number
  durationMs: number
}) {
  if (pointIds.length === 0 || !trajectories) return null
  const widthPx = Math.max(4, durationMs * pxPerMs)
  const tToX = (t: number) => t * pxPerMs

  return (
    <div className="trajectory-overlay" style={{ height: pointIds.length * ROW_H }}>
      {pointIds.map((pointId, i) => {
        const samples = trajectories.trajectories[pointId]
        const point = projectPoints.find((p) => p.id === pointId)
        if (!samples) return null

        // Cadrage vertical commun à X et Y (une seule échelle par ligne,
        // pas une par axe) : les deux courbes restent comparables entre
        // elles sur la même rangée.
        let vMin = 0, vMax = 0, any = false
        for (const s of samples) {
          if (!s) continue
          vMin = any ? Math.min(vMin, s[0], s[1]) : Math.min(s[0], s[1])
          vMax = any ? Math.max(vMax, s[0], s[1]) : Math.max(s[0], s[1])
          any = true
        }
        const span = vMax - vMin || 1
        const vToY = (v: number) => PAD_V + ((vMax - v) / span) * (ROW_H - 2 * PAD_V)

        const pathFor = (axis: 0 | 1) => {
          let d = ''
          let pen = false
          trajectories.timesMs.forEach((t, idx) => {
            const s = samples[idx]
            if (!s) { pen = false; return }
            const cmd = pen ? 'L' : 'M'
            d += `${d ? ' ' : ''}${cmd} ${tToX(t)} ${vToY(s[axis])}`
            pen = true
          })
          return d
        }

        return (
          <div key={pointId} className="trajectory-row" style={{ top: i * ROW_H, height: ROW_H }}>
            <svg width={widthPx} height={ROW_H}>
              <path className="trajectory-line trajectory-line-x" d={pathFor(0)} />
              <path className="trajectory-line trajectory-line-y" d={pathFor(1)} />
            </svg>
            <span className="trajectory-row-label" style={{ '--dot-color': point?.color ?? '#666' } as React.CSSProperties}>
              {point?.name ?? pointId}
            </span>
          </div>
        )
      })}
    </div>
  )
}
