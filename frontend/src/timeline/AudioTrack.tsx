// Piste audio de la timeline (mission "timeline pro + son").
//
// wavesurfer.js reste le moteur audio (décodage + lecture locale synchro,
// stack approuvée §12.11) mais son rendu propre est masqué : la waveform
// est dessinée ICI, sur un canvas qui partage le système de coordonnées de
// la timeline (pxPerMs/scrollLeft). C'est ce qui garantit l'alignement au
// pixel entre waveform, règle, blocs et playhead — l'ancien composant
// Waveform.tsx vivait dans son propre repère et ne pouvait pas le garantir
// (constat n°4 de l'inspection du 2026-07-28).
//
// Le son ne pilote jamais le temps : le sidecar Python reste maître
// (§13.1.7). play/pause suivent `playing`, la position n'est corrigée
// qu'au-delà d'un seuil de dérive pour ne pas se battre avec les ticks.
import { useEffect, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import { convertFileSrc } from '@tauri-apps/api/core'
import { sidecar } from '../sidecar'

const DRIFT_THRESHOLD_S = 0.2
const PEAK_BUCKETS_PER_S = 100 // résolution des pics précalculés
const MAX_PEAK_BUCKETS = 60_000

interface Peaks {
  min: Float32Array
  max: Float32Array
  bucketMs: number
  durationS: number
}

function computePeaks(buffer: AudioBuffer): Peaks {
  const buckets = Math.min(MAX_PEAK_BUCKETS, Math.max(1, Math.floor(buffer.duration * PEAK_BUCKETS_PER_S)))
  const min = new Float32Array(buckets).fill(0)
  const max = new Float32Array(buckets).fill(0)
  const samplesPerBucket = buffer.length / buckets
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let b = 0; b < buckets; b++) {
      const start = Math.floor(b * samplesPerBucket)
      const end = Math.min(data.length, Math.floor((b + 1) * samplesPerBucket))
      let lo = 0, hi = 0
      // Pas d'échantillonnage exhaustif nécessaire pour un affichage : un
      // pas de 8 échantillons suffit et divise le coût d'autant.
      for (let i = start; i < end; i += 8) {
        const v = data[i]
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      if (lo < min[b]) min[b] = lo
      if (hi > max[b]) max[b] = hi
    }
  }
  return { min, max, bucketMs: (buffer.duration * 1000) / buckets, durationS: buffer.duration }
}

export function AudioTrack({ audioPath, knownDurationS, tMs, playing, pxPerMs, scrollLeft, viewportWidth, height }: {
  audioPath: string
  knownDurationS: number | null
  tMs: number
  playing: boolean
  pxPerMs: number
  scrollLeft: number
  viewportWidth: number
  height: number
}) {
  const hiddenRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const [peaks, setPeaks] = useState<Peaks | null>(null)

  // Moteur audio : instance wavesurfer cachée, source des pics + lecture.
  useEffect(() => {
    if (!hiddenRef.current) return
    const ws = WaveSurfer.create({
      container: hiddenRef.current,
      height: 1,
      url: convertFileSrc(audioPath),
      interact: false,
    })
    wsRef.current = ws
    ws.on('decode', () => {
      const buffer = ws.getDecodedData()
      if (!buffer) return
      setPeaks(computePeaks(buffer))
      // Le backend intègre la durée réelle au transport ; on ne l'envoie
      // que si elle manque ou diverge (> 50 ms) pour éviter un broadcast
      // projet inutile à chaque chargement.
      if (knownDurationS === null || Math.abs(knownDurationS - buffer.duration) > 0.05) {
        sidecar.setAudio({ durationS: buffer.duration })
      }
    })
    return () => {
      ws.destroy()
      wsRef.current = null
      setPeaks(null)
    }
    // knownDurationS volontairement absent des deps : il ne sert qu'au
    // moment du décodage, et en dépendre recréerait l'instance audio (et
    // couperait le son) dès que le backend renvoie la durée fraîche.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioPath])

  // Lecture locale asservie au transport Python.
  useEffect(() => {
    const ws = wsRef.current
    if (!ws) return
    if (playing && !ws.isPlaying()) ws.play()
    if (!playing && ws.isPlaying()) ws.pause()
  }, [playing])

  useEffect(() => {
    const ws = wsRef.current
    if (!ws) return
    const targetS = tMs / 1000
    if (Math.abs(ws.getCurrentTime() - targetS) > DRIFT_THRESHOLD_S) {
      ws.setTime(targetS)
    }
  }, [tMs])

  // Dessin de la fenêtre visible uniquement : le canvas fait la largeur du
  // viewport et se repositionne à scrollLeft — un canvas à la largeur du
  // contenu complet exploserait à fort zoom (plusieurs millions de px).
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || viewportWidth <= 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.floor(viewportWidth * dpr)
    canvas.height = Math.floor(height * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, viewportWidth, height)
    if (!peaks) {
      ctx.fillStyle = '#3a405230'
      ctx.fillRect(0, height / 2 - 1, viewportWidth, 2)
      return
    }
    const mid = height / 2
    const amp = (height / 2) * 0.92
    ctx.fillStyle = '#4f6df5'
    for (let x = 0; x < viewportWidth; x++) {
      const t0 = (scrollLeft + x) / pxPerMs
      const t1 = (scrollLeft + x + 1) / pxPerMs
      const b0 = Math.floor(t0 / peaks.bucketMs)
      const b1 = Math.min(peaks.max.length - 1, Math.max(b0, Math.floor(t1 / peaks.bucketMs)))
      if (b0 >= peaks.max.length || b0 < 0) continue
      let lo = 0, hi = 0
      for (let b = b0; b <= b1; b++) {
        if (peaks.min[b] < lo) lo = peaks.min[b]
        if (peaks.max[b] > hi) hi = peaks.max[b]
      }
      const y0 = mid - hi * amp
      const y1 = mid - lo * amp
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0))
    }
  }, [peaks, pxPerMs, scrollLeft, viewportWidth, height])

  return (
    <>
      {/* position:sticky left:0 : le canvas reste collé au viewport pendant
          le scroll, son contenu est redessiné en fonction de scrollLeft. */}
      <canvas ref={canvasRef} className="tl-audio-canvas" style={{ width: viewportWidth, height }} />
      <div ref={hiddenRef} style={{ display: 'none' }} />
    </>
  )
}
