// Waveform PUREMENT VISUELLE (mission "panneau détail du bloc synchronisé",
// 2026-08-03) : contrairement à AudioTrack.tsx, ne crée AUCUNE instance
// wavesurfer — juste un canvas qui redessine la tranche `[scrollLeft,
// scrollLeft+width]` (repère contenu, px) à partir des pics déjà publiés
// par AudioTrack via `audioPeaks.ts`. Deux instances d'AudioTrack feraient
// jouer le son deux fois ; deux instances de MiniWaveform ne coûtent qu'un
// redessin canvas.
import { useEffect, useRef } from 'react'
import type { Peaks } from './audioPeaks'

export function MiniWaveform({ peaks, pxPerMs, scrollLeft, width, height }: {
  peaks: Peaks | null
  pxPerMs: number
  scrollLeft: number
  width: number
  height: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || width <= 0 || height <= 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.floor(width * dpr)
    canvas.height = Math.floor(height * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    if (!peaks) {
      ctx.fillStyle = '#3a405230'
      ctx.fillRect(0, height / 2 - 1, width, 2)
      return
    }
    const mid = height / 2
    const amp = (height / 2) * 0.92
    ctx.fillStyle = '#4f6df5'
    for (let x = 0; x < width; x++) {
      const t0 = (scrollLeft + x) / pxPerMs
      const t1 = (scrollLeft + x + 1) / pxPerMs
      const b0 = Math.floor(t0 / peaks.bucketMs)
      const b1 = Math.min(peaks.max.length - 1, Math.max(b0, Math.floor(t1 / peaks.bucketMs)))
      if (b0 >= peaks.max.length || b0 < 0) continue
      let lo = 0
      let hi = 0
      for (let b = b0; b <= b1; b++) {
        if (peaks.min[b] < lo) lo = peaks.min[b]
        if (peaks.max[b] > hi) hi = peaks.max[b]
      }
      const y0 = mid - hi * amp
      const y1 = mid - lo * amp
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0))
    }
  }, [peaks, pxPerMs, scrollLeft, width, height])

  return <canvas ref={canvasRef} className="mini-waveform-canvas" style={{ width, height }} />
}
