// Timeline maison (mission "timeline pro + son", barre Logic Pro / Myelin
// Director). Remplace @xzdarcy/react-timeline-editor — verdict de la
// Mission 4 : la lib imposait un zoom figé, ses rows virtualisées et son
// CSS, et ne pouvait porter ni la règle partagée avec la waveform, ni les
// courbes sur blocs à venir (§12.1). Ici, règle, piste audio, blocs et
// playhead vivent dans UN seul système de coordonnées : `pxPerMs` (zoom) et
// le scrollLeft du conteneur. L'alignement au pixel est structurel, pas un
// réglage.
//
// Le temps reste backend-autoritaire (§13.1.7) : la position de lecture
// vient exclusivement des ticks du sidecar ; le scrub/seek envoie des
// commandes. Pendant un drag de bloc, le déplacement est optimiste et
// purement visuel (delta local), la vraie écriture (`update_cue`) part au
// relâchement — même modèle que la lib remplacée, sans tempête de
// broadcasts pendant le geste.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Cue, Project } from '../types'
import { sidecar } from '../sidecar'
import { AudioTrack } from './AudioTrack'
import { GraphEditor } from './GraphEditor'
import { BlockAutomation } from './BlockAutomation'

const MS_PER_S = 1000
const RULER_H = 26
const AUDIO_H = 52
const LANE_H = 36
const GRAPH_H = 190
const MIN_CUE_MS = 100
const SNAP_PX = 8
const SEEK_THROTTLE_MS = 33
const MIN_PX_PER_MS = 0.001 // ~16 min par 1000 px
const MAX_PX_PER_MS = 2 // 0.5 s par 1000 px
const CONTENT_PAD_PX = 160

const CUE_PALETTE = ['#4F6DF5', '#F5734F', '#B06FE0', '#4FF58C', '#4FF5E0', '#F5C84F']


// Pas de graduation adaptatif : le plus petit pas qui laisse >= ~80 px
// entre deux labels. Les sous-graduations (step/5) apparaissent dès 12 px.
const TICK_STEPS_MS = [
  50, 100, 250, 500,
  1000, 2000, 5000, 10_000, 15_000, 30_000,
  60_000, 120_000, 300_000, 600_000,
]

function chooseTickStep(pxPerMs: number): number {
  for (const step of TICK_STEPS_MS) {
    if (step * pxPerMs >= 80) return step
  }
  return TICK_STEPS_MS[TICK_STEPS_MS.length - 1]
}

function formatTick(ms: number, stepMs: number): string {
  const totalS = ms / MS_PER_S
  const h = Math.floor(totalS / 3600)
  const m = Math.floor((totalS % 3600) / 60)
  const s = Math.floor(totalS % 60)
  const pad = (n: number) => n.toString().padStart(2, '0')
  const base = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
  if (stepMs < 1000) {
    const millis = Math.round(ms % 1000)
    return `${base}.${millis.toString().padStart(3, '0')}`
  }
  return base
}

interface DragState {
  cueId: string
  mode: 'move' | 'resize-l' | 'resize-r'
  startClientX: number
  startClientY: number
  origStartMs: number
  origDurationMs: number
  origLane: number
  /** Proposition courante (affichée pendant le geste, committée au lâcher). */
  startMs: number
  durationMs: number
  lane: number
  moved: boolean
}

function formatTimecodeMs(ms: number): string {
  const totalS = Math.max(0, ms) / 1000
  const h = Math.floor(totalS / 3600)
  const m = Math.floor((totalS % 3600) / 60)
  const sec = totalS % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${sec.toFixed(3).padStart(6, '0')}`
}

export function CueTimeline({ project, tMs, playing, durationMs, connected, selectedCueId, selectedPointId, onSelectCue }: {
  project: Project
  tMs: number
  playing: boolean
  durationMs: number
  connected: boolean
  selectedCueId: string | null
  selectedPointId: string | null
  onSelectCue: (cueId: string | null) => void
}) {
  const cues = project.cues
  // Pistes persistantes (mission multi-pistes) : chaque bloc porte sa
  // `lane`, plus d'empilement automatique. Toujours au moins 3 pistes et
  // une piste vide en bas pour y déposer un bloc.
  const laneCount = Math.max(3, ...cues.map((c) => (c.lane ?? 0) + 2))
  const [showGraph, setShowGraph] = useState(false)

  // Le graph editor édite l'activation du point sélectionné dans le bloc
  // sélectionné ; sans sélection de point, repli sur le premier point activé
  // par le bloc (l'utilisateur voit lequel dans la barre du graphe).
  const selectedCue = cues.find((c) => c.id === selectedCueId) ?? null
  const graphPointId = selectedCue
    ? (selectedPointId && selectedCue.activations[selectedPointId]
        ? selectedPointId
        : Object.keys(selectedCue.activations)[0] ?? null)
    : null
  const graphAct = selectedCue && graphPointId ? selectedCue.activations[graphPointId] ?? null : null
  const graphPointName = graphPointId
    ? project.points.find((p) => p.id === graphPointId)?.name ?? graphPointId
    : null
  const graphVisible = showGraph && selectedCue !== null

  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [pxPerMs, setPxPerMs] = useState<number | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const lastSeekRef = useRef(0)

  const effPxPerMs = pxPerMs ?? 0.05

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewportWidth(el.clientWidth))
    ro.observe(el)
    setViewportWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const fit = useCallback(() => {
    const el = scrollRef.current
    if (!el || durationMs <= 0) return
    const px = Math.min(MAX_PX_PER_MS, Math.max(MIN_PX_PER_MS, (el.clientWidth - 60) / durationMs))
    setPxPerMs(px)
    el.scrollLeft = 0
  }, [durationMs])

  // Premier cadrage automatique, une seule fois (ne pas re-cadrer à chaque
  // changement de durée : ça volerait le zoom choisi par l'utilisateur).
  const didFitRef = useRef(false)
  useEffect(() => {
    if (!didFitRef.current && viewportWidth > 0 && durationMs > 0) {
      didFitRef.current = true
      fit()
    }
  }, [viewportWidth, durationMs, fit])

  const zoomAt = useCallback((factor: number, clientX?: number) => {
    const el = scrollRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const offsetX = clientX !== undefined ? clientX - rect.left : el.clientWidth / 2
    setPxPerMs((prev) => {
      const cur = prev ?? 0.05
      const next = Math.min(MAX_PX_PER_MS, Math.max(MIN_PX_PER_MS, cur * factor))
      // Garde l'instant sous le curseur immobile pendant le zoom.
      const tAtCursor = (el.scrollLeft + offsetX) / cur
      requestAnimationFrame(() => {
        el.scrollLeft = Math.max(0, tAtCursor * next - offsetX)
      })
      return next
    })
  }, [])

  // Ctrl+molette = zoom au curseur (geste standard DAW) ; molette seule =
  // défilement horizontal. Listener non-passif obligatoire pour pouvoir
  // empêcher le zoom navigateur du Ctrl+molette.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        zoomAt(e.deltaY < 0 ? 1.25 : 0.8, e.clientX)
      } else {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
        if (d !== 0) {
          e.preventDefault()
          el.scrollLeft += d
        }
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  // Suivi automatique du playhead pendant la lecture (façon Logic : la vue
  // saute quand le curseur atteint le bord droit, jamais pendant l'édition).
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !playing) return
    const px = tMs * effPxPerMs
    if (px < el.scrollLeft || px > el.scrollLeft + el.clientWidth - 60) {
      el.scrollLeft = Math.max(0, px - 60)
    }
  }, [tMs, playing, effPxPerMs])

  const contentWidth = Math.max(viewportWidth, durationMs * effPxPerMs + CONTENT_PAD_PX)

  // ---- règle : graduations visibles uniquement ----
  const ticks = useMemo(() => {
    const step = chooseTickStep(effPxPerMs)
    const minor = step / 5
    const showMinor = minor * effPxPerMs >= 12
    const t0 = Math.max(0, Math.floor(scrollLeft / effPxPerMs / step - 1) * step)
    const t1 = (scrollLeft + viewportWidth) / effPxPerMs + step
    const out: { ms: number; label: string | null }[] = []
    for (let t = t0; t <= t1; t += showMinor ? minor : step) {
      const isMajor = Math.round(t) % step === 0
      out.push({ ms: t, label: isMajor ? formatTick(t, step) : null })
    }
    return out
  }, [effPxPerMs, scrollLeft, viewportWidth])

  // ---- seek au clic/drag sur la règle ----
  const seekTo = useCallback((clientX: number) => {
    const el = scrollRef.current
    if (!el) return
    const now = performance.now()
    if (now - lastSeekRef.current < SEEK_THROTTLE_MS) return
    lastSeekRef.current = now
    const rect = el.getBoundingClientRect()
    const ms = Math.max(0, (el.scrollLeft + clientX - rect.left) / effPxPerMs)
    sidecar.seek(ms)
  }, [effPxPerMs])

  const onRulerPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    lastSeekRef.current = 0
    seekTo(e.clientX)
    const onMove = (ev: PointerEvent) => seekTo(ev.clientX)
    const onUp = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
  }, [seekTo])

  // ---- drag de bloc (déplacement / redimensionnement) ----
  const snapCandidates = useMemo(() => {
    const out = [0, tMs, durationMs]
    for (const c of cues) {
      out.push(c.startMs, c.startMs + c.durationMs)
    }
    return out
  }, [cues, tMs, durationMs])

  const snap = useCallback((ms: number, excludeCueId: string, disable: boolean): number => {
    if (disable) return ms
    const threshold = SNAP_PX / effPxPerMs
    let best = ms
    let bestDist = threshold
    // Grille temporelle : aimante aussi sur la sous-graduation courante
    // (comportement Logic « snap to grid », Alt pour désactiver).
    const minor = chooseTickStep(effPxPerMs) / 5
    const gridCand = Math.round(ms / minor) * minor
    if (Math.abs(gridCand - ms) < bestDist) { bestDist = Math.abs(gridCand - ms); best = gridCand }
    const excluded = cues.find((c) => c.id === excludeCueId)
    for (const cand of snapCandidates) {
      // Ne pas snapper un bloc sur ses propres bords d'origine.
      if (excluded && (cand === excluded.startMs || cand === excluded.startMs + excluded.durationMs)) continue
      const d = Math.abs(cand - ms)
      if (d < bestDist) { bestDist = d; best = cand }
    }
    return best
  }, [snapCandidates, cues, effPxPerMs])

  const beginBlockDrag = useCallback((e: React.PointerEvent<HTMLDivElement>, cue: Cue, mode: DragState['mode']) => {
    e.stopPropagation()
    e.preventDefault()
    onSelectCue(cue.id)
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const initial: DragState = {
      cueId: cue.id, mode, startClientX: e.clientX, startClientY: e.clientY,
      origStartMs: cue.startMs, origDurationMs: cue.durationMs,
      origLane: cue.lane ?? 0,
      startMs: cue.startMs, durationMs: cue.durationMs, lane: cue.lane ?? 0,
      moved: false,
    }
    dragRef.current = initial
    setDrag(initial)

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const deltaMs = (ev.clientX - d.startClientX) / effPxPerMs
      const noSnap = ev.altKey
      let startMs = d.origStartMs
      let dur = d.origDurationMs
      let lane = d.origLane
      if (d.mode === 'move') {
        // Déplacement vertical = changement de piste (drop possible sur la
        // piste vide du bas — une nouvelle piste vide apparaît derrière).
        lane = Math.max(0, d.origLane + Math.round((ev.clientY - d.startClientY) / LANE_H))
        startMs = Math.max(0, d.origStartMs + deltaMs)
        const snappedStart = snap(startMs, d.cueId, noSnap)
        if (snappedStart !== startMs) {
          startMs = snappedStart
        } else {
          const snappedEnd = snap(startMs + dur, d.cueId, noSnap)
          if (snappedEnd !== startMs + dur) startMs = snappedEnd - dur
        }
        startMs = Math.max(0, startMs)
      } else if (d.mode === 'resize-r') {
        dur = Math.max(MIN_CUE_MS, d.origDurationMs + deltaMs)
        const end = snap(d.origStartMs + dur, d.cueId, noSnap)
        dur = Math.max(MIN_CUE_MS, end - d.origStartMs)
      } else {
        const end = d.origStartMs + d.origDurationMs
        startMs = Math.min(end - MIN_CUE_MS, Math.max(0, d.origStartMs + deltaMs))
        startMs = Math.min(end - MIN_CUE_MS, Math.max(0, snap(startMs, d.cueId, noSnap)))
        dur = end - startMs
      }
      const moved = d.moved || Math.abs(ev.clientX - d.startClientX) > 3
        || Math.abs(ev.clientY - d.startClientY) > LANE_H / 2
      const next = { ...d, startMs, durationMs: dur, lane, moved }
      dragRef.current = next
      setDrag(next)
    }
    const onUp = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      const d = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (d && d.moved) {
        sidecar.updateCue(d.cueId, { startMs: d.startMs, durationMs: d.durationMs, lane: d.lane })
      }
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
  }, [effPxPerMs, onSelectCue, snap])

  const addCue = useCallback(() => {
    const color = CUE_PALETTE[cues.length % CUE_PALETTE.length]
    const lastEnd = cues.length ? Math.max(...cues.map((c) => c.startMs + c.durationMs)) : 0
    sidecar.addCue('Cue', lastEnd, 2000, color)
  }, [cues])

  const deleteSelected = useCallback(() => {
    if (selectedCueId) {
      sidecar.deleteCue(selectedCueId)
      onSelectCue(null)
    }
  }, [selectedCueId, onSelectCue])

  const renameCue = useCallback((cue: Cue) => {
    // window.prompt temporaire — remplacé par un vrai édit inline/dialogue
    // natif en Mission 3.
    const name = window.prompt('Nom du bloc :', cue.name)
    if (name && name !== cue.name) sidecar.updateCue(cue.id, { name })
  }, [])

  const lanesHeight = laneCount * LANE_H
  const playheadPx = tMs * effPxPerMs

  return (
    <div className="tl">
      <div className="tl-toolbar">
        {/* Transport : déplacé de l'ancienne barre du haut (supprimée) —
            près de la timeline, sous le roster, comme demandé. Le scrub
            redondant a disparu : la règle fait déjà le seek. */}
        <span className={`conn-dot ${connected ? 'conn-ok' : 'conn-bad'}`} title={connected ? 'Sidecar connecté' : 'Sidecar déconnecté'} />
        <button
          className="tl-play"
          title={playing ? 'Pause (Espace)' : 'Lecture (Espace)'}
          onClick={() => (playing ? sidecar.pause() : sidecar.play())}
        >
          {playing ? '⏸' : '⏵'}
        </button>
        <span className="tl-timecode">{formatTimecodeMs(tMs)}</span>
        <span className="tl-toolbar-sep" />
        <button onClick={addCue}>+ Cue</button>
        {selectedCueId && <button onClick={deleteSelected}>Supprimer</button>}
        {selectedCueId && (
          <button
            className={showGraph ? 'tl-btn-active' : ''}
            title="Éditeur de courbes du bloc sélectionné"
            onClick={() => setShowGraph((v) => !v)}
          >
            Courbes
          </button>
        )}
        <span className="tl-toolbar-spacer" />
        <button title="Zoom arrière (Ctrl+molette)" onClick={() => zoomAt(0.8)}>−</button>
        <button title="Zoom avant (Ctrl+molette)" onClick={() => zoomAt(1.25)}>+</button>
        <button title="Ajuster à la fenêtre" onClick={fit}>Ajuster</button>
      </div>
      <div className="tl-main">
        <div className="tl-headers">
          <div className="tl-header-spacer" style={{ height: RULER_H }} />
          {project.audioPath && (
            <div className="tl-header tl-header-audio" style={{ height: AUDIO_H }}>
              <span className="tl-header-chip" style={{ background: '#4f6df5' }} />
              Audio
            </div>
          )}
          {Array.from({ length: laneCount }, (_, i) => (
            <div key={i} className="tl-header tl-header-lane" style={{ height: LANE_H }}>
              <span className="tl-header-chip" style={{ background: i === 0 ? '#f5734f' : '#3a3f4a' }} />
              Piste {i + 1}
            </div>
          ))}
          {graphVisible && (
            <div className="tl-header tl-header-graph" style={{ height: GRAPH_H }}>
              <span className="tl-header-chip" style={{ background: '#4ff5e0' }} />
              Courbes
            </div>
          )}
        </div>
        <div
          className="tl-scroll"
          ref={scrollRef}
          onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
        >
          <div className="tl-content" style={{ width: contentWidth }}>
            <div className="tl-ruler" style={{ height: RULER_H }} onPointerDown={onRulerPointerDown}>
              {ticks.map((tick) => (
                <div
                  key={tick.ms}
                  className={`tl-tick${tick.label !== null ? ' tl-tick-major' : ''}`}
                  style={{ left: tick.ms * effPxPerMs }}
                >
                  {tick.label !== null && <span>{tick.label}</span>}
                </div>
              ))}
            </div>

            {project.audioPath && (
              <div className="tl-track-audio" style={{ height: AUDIO_H }}>
                <AudioTrack
                  audioPath={project.audioPath}
                  knownDurationS={project.audioDurationS}
                  tMs={tMs}
                  playing={playing}
                  pxPerMs={effPxPerMs}
                  scrollLeft={scrollLeft}
                  viewportWidth={viewportWidth}
                  height={AUDIO_H}
                />
              </div>
            )}

            <div
              className="tl-lanes"
              style={{ height: lanesHeight }}
              onPointerDown={(e) => {
                // Clic sur le fond (pas sur un bloc) : désélection.
                if (e.target === e.currentTarget) onSelectCue(null)
              }}
            >
              {/* Bandes de pistes alternées + séparateurs (sous les blocs). */}
              {Array.from({ length: laneCount }, (_, i) => (
                <div
                  key={i}
                  className={`tl-lane-stripe${i % 2 ? ' tl-lane-stripe-alt' : ''}${drag && drag.mode === 'move' && drag.lane === i ? ' tl-lane-stripe-drop' : ''}`}
                  style={{ top: i * LANE_H, height: LANE_H }}
                />
              ))}
              {/* Grille temporelle en arrière-plan, alignée sur la règle. */}
              <div className="tl-grid">
                {ticks.map((tick) => (
                  <div
                    key={tick.ms}
                    className={`tl-grid-line${tick.label !== null ? ' tl-grid-line-major' : ''}`}
                    style={{ left: tick.ms * effPxPerMs }}
                  />
                ))}
              </div>
              {cues.map((cue) => {
                const isDragging = drag?.cueId === cue.id
                const startMs = isDragging ? drag.startMs : cue.startMs
                const dur = isDragging ? drag.durationMs : cue.durationMs
                const laneIndex = isDragging ? drag.lane : (cue.lane ?? 0)
                const count = Object.keys(cue.activations).length
                return (
                  <div
                    key={cue.id}
                    className={`cue-block${cue.id === selectedCueId ? ' cue-block-selected' : ''}${isDragging ? ' cue-block-dragging' : ''}`}
                    style={{
                      '--cue-color': cue.color,
                      left: startMs * effPxPerMs,
                      width: Math.max(4, dur * effPxPerMs),
                      top: laneIndex * LANE_H + 2,
                      height: LANE_H - 6,
                    } as React.CSSProperties}
                    onPointerDown={(e) => beginBlockDrag(e, cue, 'move')}
                    onDoubleClick={() => renameCue(cue)}
                  >
                    <div className="cue-block-header">
                      <span className="cue-block-name">{cue.name}</span>
                      <span className="cue-block-count">{count}</span>
                    </div>
                    <div className="cue-block-body" />
                    {count > 0 && (
                      <BlockAutomation
                        cue={cue}
                        selected={cue.id === selectedCueId}
                        selectedPointId={selectedPointId}
                        widthPx={Math.max(4, dur * effPxPerMs)}
                        heightPx={LANE_H - 6}
                        pxPerMs={effPxPerMs}
                      />
                    )}
                    <div className="cue-resize cue-resize-l" onPointerDown={(e) => beginBlockDrag(e, cue, 'resize-l')} />
                    <div className="cue-resize cue-resize-r" onPointerDown={(e) => beginBlockDrag(e, cue, 'resize-r')} />
                  </div>
                )
              })}
            </div>

            {graphVisible && selectedCue && (
              <GraphEditor
                cue={selectedCue}
                act={graphAct}
                pointId={graphPointId}
                pointName={graphPointName}
                pxPerMs={effPxPerMs}
                height={GRAPH_H}
                contentWidth={contentWidth}
                scrollLeft={scrollLeft}
              />
            )}

            <div className="tl-playhead" style={{ left: playheadPx }} />
          </div>
        </div>
      </div>
    </div>
  )
}
