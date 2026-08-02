// Piste audio de la timeline (mission "timeline pro + son").
//
// wavesurfer.js reste le moteur audio (décodage + lecture locale synchro,
// stack approuvée §12.11) mais son rendu propre est masqué : la waveform
// est dessinée ICI, en TUILES posées DANS le contenu scrollé (architecture
// DAW/Reaper, fix « la waveform bouge au scroll » 2026-07-29). Chaque
// tuile est un canvas absolu de TILE_W px à sa position de contenu : elle
// DÉFILE NATIVEMENT avec la règle et les blocs — zéro redessin, zéro
// retard au scroll. Au scroll on ne peint que les tuiles manquantes ; un
// changement de zoom invalide tout et repeint la fenêtre visible une fois.
// (Les versions précédentes redessinaient la fenêtre dans le repère écran
// à chaque scroll : toujours une frame derrière le défilement natif.)
//
// Le son ne pilote jamais le temps : le sidecar Python reste maître
// (§13.1.7). play/pause suivent `playing`, la position n'est corrigée
// qu'au-delà d'un seuil de dérive pour ne pas se battre avec les ticks.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import { convertFileSrc } from '@tauri-apps/api/core'
import { sidecar } from '../sidecar'
import { useT } from '../i18n'

const DRIFT_THRESHOLD_S = 0.2
const PEAK_BUCKETS_PER_S = 100 // résolution des pics précalculés
const MAX_PEAK_BUCKETS = 60_000
const TILE_W = 1024 // largeur d'une tuile de waveform (px contenu)

interface Peaks {
  min: Float32Array
  max: Float32Array
  bucketMs: number
  durationS: number
}

// ---- cache des pics (IndexedDB) ----
//
// computePeaksAsync est le coût réel de la réouverture d'un projet avec
// audio (le fix "chunké" ci-dessous existe justement parce que ça pouvait
// geler l'UI) — décodage mis à part (rapide, natif), reparcourir tous les
// buckets à chaque lancement de l'app pour un fichier qui n'a pas changé
// est du travail refait pour rien (demande de Florian, 2026-07-31).
// IndexedDB survit aux redémarrages complets de l'app (contrairement à une
// simple variable module) et stocke les Float32Array directement, sans
// sérialisation JSON. Clé = chemin du fichier ; la durée redécodée sert de
// vérification légère (si elle diverge, le fichier a changé sous ce
// chemin, on ignore le cache plutôt que d'afficher une forme fausse).
const PEAKS_DB_NAME = 'lumitrack-waveform-cache'
const PEAKS_STORE = 'peaks'

function openPeaksDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PEAKS_DB_NAME, 1)
    req.onupgradeneeded = () => { req.result.createObjectStore(PEAKS_STORE) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function loadCachedPeaks(key: string): Promise<Peaks | null> {
  try {
    const db = await openPeaksDb()
    return await new Promise((resolve, reject) => {
      const req = db.transaction(PEAKS_STORE, 'readonly').objectStore(PEAKS_STORE).get(key)
      req.onsuccess = () => resolve((req.result as Peaks | undefined) ?? null)
      req.onerror = () => reject(req.error)
    })
  } catch {
    return null // cache indisponible : on recalcule, jamais bloquant
  }
}

function saveCachedPeaks(key: string, peaks: Peaks): void {
  openPeaksDb()
    .then((db) => { db.transaction(PEAKS_STORE, 'readwrite').objectStore(PEAKS_STORE).put(peaks, key) })
    .catch(() => { /* best-effort : une écriture ratée ne doit rien casser */ })
}

/** Calcul des pics DÉCOUPÉ EN TRANCHES : chaque tranche de buckets rend la
 * main au navigateur (setTimeout 0) avant la suivante — l'interface reste
 * fluide pendant tout le calcul (fix « app freezée à l'import audio »).
 * `cancelled` interrompt proprement si le fichier change. */
async function computePeaksAsync(
  buffer: AudioBuffer,
  cancelled: () => boolean,
): Promise<Peaks | null> {
  const buckets = Math.min(MAX_PEAK_BUCKETS, Math.max(1, Math.floor(buffer.duration * PEAK_BUCKETS_PER_S)))
  const min = new Float32Array(buckets).fill(0)
  const max = new Float32Array(buckets).fill(0)
  const samplesPerBucket = buffer.length / buckets
  const SLICE = 2000 // buckets par tranche (~quelques ms de travail chacune)
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let sliceStart = 0; sliceStart < buckets; sliceStart += SLICE) {
      if (cancelled()) return null
      const sliceEnd = Math.min(buckets, sliceStart + SLICE)
      for (let b = sliceStart; b < sliceEnd; b++) {
        const start = Math.floor(b * samplesPerBucket)
        const end = Math.min(data.length, Math.floor((b + 1) * samplesPerBucket))
        let lo = 0, hi = 0
        // Un pas de 8 échantillons suffit pour un affichage.
        for (let i = start; i < end; i += 8) {
          const v = data[i]
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
        if (lo < min[b]) min[b] = lo
        if (hi > max[b]) max[b] = hi
      }
      // Rendre la main : l'UI respire entre deux tranches.
      await new Promise((r) => setTimeout(r, 0))
    }
  }
  return { min, max, bucketMs: (buffer.duration * 1000) / buckets, durationS: buffer.duration }
}

export function AudioTrack({ audioPath, knownDurationS, tMs, playing, pxPerMs, scrollElRef, height }: {
  audioPath: string
  knownDurationS: number | null
  tMs: number
  playing: boolean
  pxPerMs: number
  /** L'élément scrollé de la timeline : source de vérité du scroll pour
   * savoir quelles tuiles peindre. */
  scrollElRef: React.RefObject<HTMLDivElement | null>
  height: number
}) {
  const t = useT()
  const hiddenRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const [peaks, setPeaks] = useState<Peaks | null>(null)

  // Moteur audio : instance wavesurfer cachée, source des pics + lecture.
  useEffect(() => {
    if (!hiddenRef.current) return
    let cancelled = false
    const ws = WaveSurfer.create({
      container: hiddenRef.current,
      height: 1,
      url: convertFileSrc(audioPath),
      interact: false,
      // Décodage BASSE FRÉQUENCE pour la waveform uniquement : 12 kHz
      // suffisent à des pics d'affichage et divisent le coût de
      // decodeAudioData par ~4. La LECTURE passe par l'élément <audio>
      // natif (backend MediaElement de wavesurfer 7), qualité d'origine.
      sampleRate: 12000,
      // Rendu interne inutile (tuiles maison) : renderFunction vide.
      renderFunction: () => {},
    })
    wsRef.current = ws
    ws.on('decode', () => {
      const buffer = ws.getDecodedData()
      if (!buffer) return
      loadCachedPeaks(audioPath).then((cached) => {
        if (cancelled) return
        if (cached && Math.abs(cached.durationS - buffer.duration) < 0.05) {
          setPeaks(cached)
          return
        }
        computePeaksAsync(buffer, () => cancelled).then((result) => {
          if (!result || cancelled) return
          setPeaks(result)
          saveCachedPeaks(audioPath, result)
        })
      })
      // Le backend intègre la durée réelle au transport ; on ne l'envoie
      // que si elle manque ou diverge (> 50 ms).
      if (knownDurationS === null || Math.abs(knownDurationS - buffer.duration) > 0.05) {
        sidecar.setAudio({ durationS: buffer.duration })
      }
    })
    return () => {
      cancelled = true
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

  // ---- tuiles de waveform dans le contenu ----
  const containerRef = useRef<HTMLDivElement>(null)
  const tilesRef = useRef<Map<number, HTMLCanvasElement>>(new Map())

  // useLAYOUTEffect, pas useEffect : pendant l'animation de zoom, le
  // parent commet pxPerMs + scrollLeft en flushSync à chaque frame ; un
  // effet passif repeindrait les tuiles APRÈS la peinture → waveform en
  // retard d'une frame sur la règle et les blocs pendant toute
  // l'animation ("l'audio est asynchrone"). En layout effect, le
  // repeuplement se fait dans le même flush, avant la peinture.
  useLayoutEffect(() => {
    const container = containerRef.current
    const scroller = scrollElRef.current
    if (!container || !scroller) return
    const dpr = window.devicePixelRatio || 1

    // Zoom ou pics changés : toutes les tuiles sont invalides.
    tilesRef.current.forEach((c) => c.remove())
    tilesRef.current.clear()

    const drawTile = (index: number) => {
      const canvas = document.createElement('canvas')
      canvas.className = 'tl-audio-tile'
      canvas.width = Math.floor(TILE_W * dpr)
      canvas.height = Math.floor(height * dpr)
      canvas.style.cssText = `position:absolute;top:0;left:${index * TILE_W}px;width:${TILE_W}px;height:${height}px;`
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.scale(dpr, dpr)
      if (!peaks) {
        ctx.fillStyle = '#3a405230'
        ctx.fillRect(0, height / 2 - 1, TILE_W, 2)
      } else {
        const mid = height / 2
        const amp = (height / 2) * 0.92
        const base = index * TILE_W
        ctx.fillStyle = '#4f6df5'
        for (let x = 0; x < TILE_W; x++) {
          const t0 = (base + x) / pxPerMs
          const t1 = (base + x + 1) / pxPerMs
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
      }
      container.appendChild(canvas)
      tilesRef.current.set(index, canvas)
    }

    const ensure = () => {
      const sl = scroller.scrollLeft
      const vw = scroller.clientWidth
      const i0 = Math.max(0, Math.floor(sl / TILE_W) - 1)
      const i1 = Math.floor((sl + vw) / TILE_W) + 1
      for (let i = i0; i <= i1; i++) {
        if (!tilesRef.current.has(i)) drawTile(i)
      }
      // Élagage : au-delà de ±3 tuiles hors champ, on libère.
      tilesRef.current.forEach((canvas, i) => {
        if (i < i0 - 3 || i > i1 + 3) {
          canvas.remove()
          tilesRef.current.delete(i)
        }
      })
    }

    ensure()
    scroller.addEventListener('scroll', ensure, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', ensure)
      tilesRef.current.forEach((c) => c.remove())
      tilesRef.current.clear()
    }
  }, [peaks, pxPerMs, height, scrollElRef])

  return (
    <>
      {/* Conteneur des tuiles : dans le CONTENU scrollé — les tuiles
          défilent nativement avec la règle et les blocs. */}
      <div ref={containerRef} className="tl-audio-tiles" style={{ height }}>
        {!peaks && <span className="tl-audio-loading">{t('timeline.audioDecoding')}</span>}
      </div>
      <div ref={hiddenRef} style={{ display: 'none' }} />
    </>
  )
}
