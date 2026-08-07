// Panneau "détail du bloc" (mission 2026-08-03, revu le même jour après
// retour de Florian : "c'est pas une timeline, on ne sait pas dépasser le
// bloc, et on ne voit pas la piste audio") — un panneau DOCKÉ (pas une
// fenêtre modale bloquante) juste au-dessus de la vraie timeline, qui en
// PARTAGE le zoom/scroll (`timelineView.ts`) : même règle, même piste audio
// (miroir visuel via `MiniWaveform`, pas un second moteur audio), mêmes
// coordonnées de temps absolues. Le bloc lui-même n'est plus toute
// l'étendue affichée mais une simple région surlignée — glisser une barre
// peut donc désormais dépasser le bloc, exactement comme le modèle le
// permet déjà côté backend (`Activation.start_offset_ms`/`fade_ms` peuvent
// dépasser `cue.duration_ms`, cf. DIRECTIVES.md point 6).
//
// Glisser mécanique via @dnd-kit/core (déjà une dépendance, déjà utilisé
// pour le roster) plutôt qu'un nouveau câblage pointerdown/move/up à la
// main — préférence explicite de Florian pour les librairies mûres sur les
// mécaniques d'interaction. Le backend reste la seule source de vérité
// (§13.1.7) : la position pendant le geste n'est qu'un aperçu local, la
// valeur n'est écrite qu'au relâcher.
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext, PointerSensor, useDraggable, useSensor, useSensors,
  type DragEndEvent, type DragMoveEvent,
} from '@dnd-kit/core'
import { sidecar } from '../sidecar'
import type { Activation, Cue, Point } from '../types'
import { useT } from '../i18n'
import { useTimelineView, sendTimelineViewCommand } from '../timeline/timelineView'
import { useAudioPeaks } from '../timeline/audioPeaks'
import { MiniWaveform } from '../timeline/MiniWaveform'
import { computeTicks } from '../timeline/ticks'

// Aligné sur MIN_AUTO_DURATION_MS (core/timeline.py) : plancher de fade,
// jamais un bloc de durée nulle donc invisible/impossible à re-saisir.
const MIN_FADE_MS = 200
const LABELS_W = 132
const ROW_H = 28
const RULER_MINI_H = 20
const MINI_AUDIO_H = 34

type DragKind = 'move' | 'resize'

function fmtS(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`
}

export function BlockDetailPanel({ cue, projectPoints, tMs, audioPath, bottomPx, onClose }: {
  cue: Cue
  projectPoints: Point[]
  tMs: number
  audioPath: string | null
  /** Bord bas du panneau flottant = juste au-dessus de la timeline. */
  bottomPx: number
  onClose: () => void
}) {
  const t = useT()
  const { pxPerMs, scrollLeft } = useTimelineView()
  const peaks = useAudioPeaks(audioPath)
  // Panneau FLOTTANT (fix 2026-08-07, "seulement 4 blocs rendus") : le
  // dock vivait DANS le rail timeline à hauteur fixe — toute hauteur
  // au-delà était coupée par le parent, scroll interne impuissant. Sorti
  // du flux : hauteur redimensionnable INDÉPENDANTE de la timeline
  // (poignée en haut, persistée), il se superpose au bas du terrain quand
  // on l'agrandit, + mode PLEIN ÉCRAN façon YouTube (bouton à côté de ✕).
  const [panelHeight, setPanelHeight] = useState(() => {
    const saved = Number(localStorage.getItem('lumitrack.blockDetailHeight'))
    return Number.isFinite(saved) && saved >= 180 ? Math.min(saved, window.innerHeight * 0.85) : 320
  })
  const [fullscreen, setFullscreen] = useState(false)
  const beginPanelResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = panelHeight
    const onMove = (ev: PointerEvent) => {
      const h = Math.max(180, Math.min(window.innerHeight * 0.85, startH + (startY - ev.clientY)))
      setPanelHeight(h)
      localStorage.setItem('lumitrack.blockDetailHeight', String(Math.round(h)))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  // Ref CALLBACK, pas un useRef classique : si ce bloc n'a encore aucun
  // acteur activé à l'ouverture du panneau, `.block-detail-tracks` ne
  // monte pas tout de suite (branche `rows.length === 0` plus bas) — un
  // useEffect à deps vides ne se redéclencherait jamais quand l'élément
  // apparaît enfin (premier acteur activé pendant que le panneau reste
  // ouvert), laissant viewportWidth bloqué à 0.
  const [tracksEl, setTracksEl] = useState<HTMLDivElement | null>(null)

  // Zoom/pan à la molette DANS le panneau (tranche E, 2026-08-07) : la
  // timeline principale est masquée par l'overlay — on lui DÉLÈGUE les
  // gestes (elle seule possède le scroll DOM et l'animation de zoom).
  // L'ancre part en TEMPS : les deux fenêtres n'ont pas le même bord
  // gauche. Mêmes conventions que la vraie timeline : molette = zoom au
  // curseur, Maj+molette = défilement.
  const viewRef = useRef({ pxPerMs, scrollLeft })
  viewRef.current = { pxPerMs, scrollLeft }
  useEffect(() => {
    if (!tracksEl) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.shiftKey) {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
        if (d !== 0) sendTimelineViewCommand({ scrollDeltaPx: d })
      } else {
        const rect = tracksEl.getBoundingClientRect()
        const v = viewRef.current
        const anchorMs = Math.max(0, (v.scrollLeft + e.clientX - rect.left) / v.pxPerMs)
        sendTimelineViewCommand({ zoomFactor: e.deltaY < 0 ? 1.25 : 0.8, anchorMs })
      }
    }
    tracksEl.addEventListener('wheel', onWheel, { passive: false })
    return () => tracksEl.removeEventListener('wheel', onWheel)
  }, [tracksEl])
  const [viewportWidth, setViewportWidth] = useState(0)
  const pxPerMsRef = useRef(pxPerMs)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 3 } }))
  const [preview, setPreview] = useState<{ pointId: string; kind: DragKind; deltaMs: number } | null>(null)

  useEffect(() => {
    if (!tracksEl) return
    const ro = new ResizeObserver(() => setViewportWidth(tracksEl.clientWidth))
    ro.observe(tracksEl)
    setViewportWidth(tracksEl.clientWidth)
    return () => ro.disconnect()
  }, [tracksEl])

  const ticks = useMemo(() => computeTicks(pxPerMs, scrollLeft, viewportWidth), [pxPerMs, scrollLeft, viewportWidth])

  const rows = useMemo(() => {
    return Object.entries(cue.activations)
      .map(([pointId, act]) => ({ pointId, act, point: projectPoints.find((p) => p.id === pointId) }))
      // Ordre stable = ordre du roster plutôt que l'ordre d'insertion de
      // l'objet JS (non garanti visuellement significatif).
      .sort((a, b) => projectPoints.indexOf(a.point as Point) - projectPoints.indexOf(b.point as Point))
  }, [cue.activations, projectPoints])

  const parseDragId = (id: string | number): [DragKind, string] => {
    const s = String(id)
    const i = s.indexOf(':')
    return [s.slice(0, i) as DragKind, s.slice(i + 1)]
  }

  const handleDragStart = () => { pxPerMsRef.current = pxPerMs }
  const handleDragMove = (e: DragMoveEvent) => {
    const [kind, pointId] = parseDragId(e.active.id)
    setPreview({ pointId, kind, deltaMs: e.delta.x / pxPerMsRef.current })
  }
  const handleDragEnd = (e: DragEndEvent) => {
    const [kind, pointId] = parseDragId(e.active.id)
    const act = cue.activations[pointId]
    setPreview(null)
    if (!act) return
    const deltaMs = e.delta.x / pxPerMsRef.current
    if (kind === 'move') {
      // Plus de plafond à durationMs - fadeMs : un acteur peut désormais
      // dépasser visuellement le bloc, comme le modèle le permet déjà
      // (§ commentaire de fichier).
      const next = Math.max(0, act.startOffsetMs + deltaMs)
      if (Math.round(next) !== Math.round(act.startOffsetMs)) {
        sidecar.setActivation(cue.id, pointId, { startOffsetMs: next })
      }
    } else {
      const next = Math.max(MIN_FADE_MS, act.fadeMs + deltaMs)
      if (Math.round(next) !== Math.round(act.fadeMs)) {
        sidecar.setActivation(cue.id, pointId, { fadeMs: next, fadeOverridden: true })
      }
    }
  }

  const worldToLocalPx = (worldMs: number) => worldMs * pxPerMs - scrollLeft
  const playheadPx = worldToLocalPx(tMs)
  const showPlayhead = playheadPx >= 0 && playheadPx <= viewportWidth
  const blockLeft = worldToLocalPx(cue.startMs)
  const blockWidth = cue.durationMs * pxPerMs

  return (
    <div
      className={`block-detail-dock${fullscreen ? ' block-detail-fullscreen' : ''}`}
      style={fullscreen ? undefined : { bottom: bottomPx, height: panelHeight }}
    >
      {!fullscreen && (
        <div
          className="block-detail-resize-grip"
          title={t('blockDetail.resizeHint')}
          onPointerDown={beginPanelResize}
        />
      )}
      <div className="block-detail-head">
        <span className="swatch" style={{ background: cue.color }} />
        <h2>{cue.name}</h2>
        <span className="block-detail-duration">{fmtS(cue.durationMs)}</span>
        <span className="block-detail-spacer" />
        <button
          onClick={() => setFullscreen((v) => !v)}
          title={fullscreen ? t('blockDetail.exitFullscreen') : t('blockDetail.fullscreen')}
        >
          {fullscreen ? '🗗' : '⛶'}
        </button>
        <button onClick={onClose} title={t('blockDetail.close')}>✕</button>
      </div>
      {rows.length === 0 ? (
        <p className="hint">{t('blockDetail.empty')}</p>
      ) : (
        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragMove={handleDragMove} onDragEnd={handleDragEnd}>
          <div className="block-detail-body">
            <div className="block-detail-labels" style={{ width: LABELS_W }}>
              <div className="block-detail-ruler-spacer" style={{ height: RULER_MINI_H }} />
              {audioPath && <div className="block-detail-audio-spacer" style={{ height: MINI_AUDIO_H }} />}
              {rows.map(({ pointId, act, point }) => (
                <div className="block-detail-row-label" key={pointId} style={{ height: ROW_H }}>
                  <span className="swatch" style={{ background: point?.color ?? '#666' }} />
                  <span className="block-detail-row-name">{point?.name ?? pointId}</span>
                  {act.fadeOverridden && (
                    <button
                      className="inspector-revert-fade block-detail-revert"
                      title={t('cue.revertFadeHint')}
                      onClick={() => sidecar.setActivation(cue.id, pointId, { fadeOverridden: false })}
                    >
                      {t('cue.revertFade')}
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="block-detail-tracks" ref={setTracksEl}>
              {/* Mini-règle CLIQUABLE (tranche E, 2026-08-07) : seek au
                  clic + scrub au glisser, même comportement que la règle
                  principale — le playhead vit déjà (tMs). */}
              <div
                className="block-detail-ruler block-detail-ruler-seek"
                style={{ height: RULER_MINI_H }}
                onPointerDown={(e) => {
                  e.preventDefault()
                  const rect = e.currentTarget.getBoundingClientRect()
                  const seekAt = (clientX: number) =>
                    sidecar.seek(Math.max(0, (scrollLeft + clientX - rect.left) / pxPerMs))
                  seekAt(e.clientX)
                  const onMove = (ev: PointerEvent) => seekAt(ev.clientX)
                  const onUp = () => {
                    window.removeEventListener('pointermove', onMove)
                    window.removeEventListener('pointerup', onUp)
                  }
                  window.addEventListener('pointermove', onMove)
                  window.addEventListener('pointerup', onUp)
                }}
              >
                {ticks.map((tick) => (
                  <div
                    key={tick.ms}
                    className={`tl-tick${tick.label !== null ? ' tl-tick-major' : ''}`}
                    style={{ left: tick.ms * pxPerMs - scrollLeft }}
                  >
                    {tick.label !== null && <span>{tick.label}</span>}
                  </div>
                ))}
              </div>
              {audioPath && (
                <div className="block-detail-audio" style={{ height: MINI_AUDIO_H }}>
                  <MiniWaveform peaks={peaks} pxPerMs={pxPerMs} scrollLeft={scrollLeft} width={viewportWidth} height={MINI_AUDIO_H} />
                </div>
              )}
              {/* Le bloc n'est plus toute l'étendue affichée : juste une
                  région surlignée dans un référentiel de temps partagé avec
                  la vraie timeline ("on ne sait pas dépasser le bloc"). */}
              <div className="block-detail-extent" style={{ left: blockLeft, width: Math.max(1, blockWidth) }} />
              {showPlayhead && <div className="block-detail-playhead" style={{ left: playheadPx }} />}
              {rows.map(({ pointId, act, point }) => (
                <BlockDetailBar
                  key={pointId}
                  pointId={pointId}
                  point={point}
                  cueStartMs={cue.startMs}
                  pxPerMs={pxPerMs}
                  scrollLeft={scrollLeft}
                  act={act}
                  preview={preview?.pointId === pointId ? preview : null}
                />
              ))}
            </div>
          </div>
        </DndContext>
      )}
    </div>
  )
}

function BlockDetailBar({ pointId, point, cueStartMs, pxPerMs, scrollLeft, act, preview }: {
  pointId: string
  point: Point | undefined
  cueStartMs: number
  pxPerMs: number
  scrollLeft: number
  act: Activation
  preview: { kind: DragKind; deltaMs: number } | null
}) {
  const t = useT()
  const moveDrag = useDraggable({ id: `move:${pointId}` })
  const resizeDrag = useDraggable({ id: `resize:${pointId}` })

  let offsetMs = act.startOffsetMs
  let fadeMs = act.fadeMs
  if (preview?.kind === 'move') {
    offsetMs = Math.max(0, act.startOffsetMs + preview.deltaMs)
  } else if (preview?.kind === 'resize') {
    fadeMs = Math.max(MIN_FADE_MS, act.fadeMs + preview.deltaMs)
  }

  const left = (cueStartMs + offsetMs) * pxPerMs - scrollLeft
  const width = Math.max(6, fadeMs * pxPerMs)

  return (
    <div className="block-detail-row-track" style={{ height: ROW_H }}>
      <div
        ref={moveDrag.setNodeRef}
        className="block-detail-bar"
        style={{ left, width, background: point?.color ?? '#888' }}
        title={t('blockDetail.barHint', { start: fmtS(offsetMs), end: fmtS(offsetMs + fadeMs) })}
        {...moveDrag.listeners}
        {...moveDrag.attributes}
      >
        <span className="block-detail-bar-label">{fmtS(offsetMs)} → {fmtS(offsetMs + fadeMs)}</span>
        <div
          ref={resizeDrag.setNodeRef}
          className="block-detail-handle"
          onPointerDown={(e) => {
            e.stopPropagation()
            resizeDrag.listeners?.onPointerDown?.(e)
          }}
        />
      </div>
    </div>
  )
}
