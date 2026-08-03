// Panneau "détail du bloc" (mission 2026-08-03) : une mini-timeline propre
// au bloc actuellement sélectionné, PAS dans la timeline principale — une
// sous-piste horizontale par acteur activé (offset/fade dans le temps LOCAL
// du bloc, 0 = début du bloc), pour rendre le décalage de départ visible et
// éditable à la souris plutôt que seulement via les petits champs
// numériques de l'inspecteur ("je ne vois pas l'option pour ajouter le
// décalage" — Florian, 2026-08-03).
//
// Glisser mécanique via @dnd-kit/core (déjà une dépendance, déjà utilisé
// pour le roster) plutôt qu'un nouveau câblage pointerdown/move/up à la
// main — préférence explicite de Florian pour les librairies mûres sur les
// mécaniques d'interaction (cf. la mission drag-and-drop roster).
// Glisser le CORPS d'une sous-barre déplace le décalage de départ (startMs
// figé) ; glisser sa POIGNÉE (bord droit) change la durée du fade. Le
// backend reste la seule source de vérité (§13.1.7) : la position pendant
// le geste n'est qu'un aperçu local, la valeur n'est écrite qu'au relâcher.
//
// Layout en deux colonnes SIBLINGS (étiquettes / pistes), pas une grille par
// ligne : `trackRef` doit mesurer UNIQUEMENT la largeur en pixels de la
// colonne des pistes pour convertir un delta de glisser en ms — si le
// conteneur mesuré incluait aussi la colonne des étiquettes, la conversion
// px→ms serait fausse (trop de pixels pour la même durée).
import { useMemo, useRef, useState } from 'react'
import {
  DndContext, PointerSensor, useDraggable, useSensor, useSensors,
  type DragEndEvent, type DragMoveEvent,
} from '@dnd-kit/core'
import { sidecar } from '../sidecar'
import type { Activation, Cue, Point } from '../types'
import { useT } from '../i18n'

// Aligné sur MIN_AUTO_DURATION_MS (core/timeline.py) : plancher de fade,
// jamais un bloc de durée nulle donc invisible/impossible à re-saisir.
const MIN_FADE_MS = 200

type DragKind = 'move' | 'resize'

function fmtS(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`
}

export function BlockDetailPanel({ cue, projectPoints, tMs, onClose }: {
  cue: Cue
  projectPoints: Point[]
  tMs: number
  onClose: () => void
}) {
  const t = useT()
  const tracksRef = useRef<HTMLDivElement>(null)
  const pxPerMsRef = useRef(1)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 3 } }))
  const [preview, setPreview] = useState<{ pointId: string; kind: DragKind; deltaMs: number } | null>(null)

  const durationMs = Math.max(cue.durationMs, 1)

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

  const handleDragStart = () => {
    pxPerMsRef.current = (tracksRef.current?.getBoundingClientRect().width || 1) / durationMs
  }
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
      const maxOffset = Math.max(0, durationMs - act.fadeMs)
      const next = Math.min(maxOffset, Math.max(0, act.startOffsetMs + deltaMs))
      if (Math.round(next) !== Math.round(act.startOffsetMs)) {
        sidecar.setActivation(cue.id, pointId, { startOffsetMs: next })
      }
    } else {
      const maxFade = Math.max(MIN_FADE_MS, durationMs - act.startOffsetMs)
      const next = Math.min(maxFade, Math.max(MIN_FADE_MS, act.fadeMs + deltaMs))
      if (Math.round(next) !== Math.round(act.fadeMs)) {
        sidecar.setActivation(cue.id, pointId, { fadeMs: next, fadeOverridden: true })
      }
    }
  }

  const playheadLocalMs = tMs - cue.startMs
  const showPlayhead = playheadLocalMs >= 0 && playheadLocalMs <= durationMs

  return (
    <div className="block-detail-overlay" onClick={onClose}>
      <div className="block-detail-panel" onClick={(e) => e.stopPropagation()}>
        <div className="block-detail-head">
          <span className="swatch" style={{ background: cue.color }} />
          <h2>{cue.name}</h2>
          <span className="block-detail-duration">{fmtS(durationMs)}</span>
          <span className="block-detail-spacer" />
          <button onClick={onClose} title={t('blockDetail.close')}>✕</button>
        </div>
        <p className="hint block-detail-hint">{t('blockDetail.hint')}</p>
        {rows.length === 0 ? (
          <p className="hint">{t('blockDetail.empty')}</p>
        ) : (
          <DndContext sensors={sensors} onDragStart={handleDragStart} onDragMove={handleDragMove} onDragEnd={handleDragEnd}>
            <div className="block-detail-body">
              <div className="block-detail-labels">
                <div className="block-detail-ruler-spacer" />
                {rows.map(({ pointId, act, point }) => (
                  <div className="block-detail-row-label" key={pointId}>
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
              <div className="block-detail-tracks" ref={tracksRef}>
                <div className="block-detail-ruler">
                  <span>0s</span>
                  <span>{fmtS(durationMs)}</span>
                </div>
                {showPlayhead && (
                  <div className="block-detail-playhead" style={{ left: `${(playheadLocalMs / durationMs) * 100}%` }} />
                )}
                {rows.map(({ pointId, act, point }) => (
                  <BlockDetailBar
                    key={pointId}
                    pointId={pointId}
                    act={act}
                    point={point}
                    durationMs={durationMs}
                    preview={preview?.pointId === pointId ? preview : null}
                  />
                ))}
              </div>
            </div>
          </DndContext>
        )}
      </div>
    </div>
  )
}

function BlockDetailBar({ pointId, act, point, durationMs, preview }: {
  pointId: string
  act: Activation
  point: Point | undefined
  durationMs: number
  preview: { kind: DragKind; deltaMs: number } | null
}) {
  const t = useT()
  const moveDrag = useDraggable({ id: `move:${pointId}` })
  const resizeDrag = useDraggable({ id: `resize:${pointId}` })

  let offsetMs = act.startOffsetMs
  let fadeMs = act.fadeMs
  if (preview?.kind === 'move') {
    const maxOffset = Math.max(0, durationMs - fadeMs)
    offsetMs = Math.min(maxOffset, Math.max(0, act.startOffsetMs + preview.deltaMs))
  } else if (preview?.kind === 'resize') {
    const maxFade = Math.max(MIN_FADE_MS, durationMs - offsetMs)
    fadeMs = Math.min(maxFade, Math.max(MIN_FADE_MS, act.fadeMs + preview.deltaMs))
  }

  const leftPct = (offsetMs / durationMs) * 100
  const widthPct = (fadeMs / durationMs) * 100

  return (
    <div className="block-detail-row-track">
      <div
        ref={moveDrag.setNodeRef}
        className="block-detail-bar"
        style={{ left: `${leftPct}%`, width: `${widthPct}%`, minWidth: '6px', background: point?.color ?? '#888' }}
        title={t('blockDetail.barHint', { start: fmtS(offsetMs), end: fmtS(offsetMs + fadeMs) })}
        {...moveDrag.listeners}
        {...moveDrag.attributes}
      >
        <span className="block-detail-bar-label">{fmtS(offsetMs)} → {fmtS(offsetMs + fadeMs)}</span>
        <div
          ref={resizeDrag.setNodeRef}
          className="block-detail-handle"
          onPointerDown={(e) => {
            // stopPropagation : sans ça, le pointerdown remonterait aussi au
            // <div> parent (poignée de déplacement) et démarrerait les DEUX
            // glissers (décalage + fade) en même temps.
            e.stopPropagation()
            resizeDrag.listeners?.onPointerDown?.(e)
          }}
        />
      </div>
    </div>
  )
}
