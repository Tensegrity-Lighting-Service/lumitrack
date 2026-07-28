// "Piste Blocs/Cue" of CONCEPTION.md §12.10, styled after Myelin Director's
// track/region look (colored track header, two-tone region blocks). Cues
// are free to overlap in time (§12.1) — packed into as many visual lanes as
// needed so overlapping blocks never collide; lanes are a display-only
// packing, not a semantic "track" (Repères/Groupes/LED tracks from §12.10
// remain deferred, §13.2).
//
// The engine's own clock is never started (`autoReRender` covers repaint,
// we drive the cursor by hand): playback time always comes from the
// sidecar's `tick` messages (§13.1.7, backend-autoritaire). A local drag
// gesture is allowed to move the cursor optimistically for feel, but it
// immediately calls `sidecar.seek()` so the backend stays the source of
// truth and the next tick corrects any drift.
//
// All callback props below are wrapped in useCallback: `CueTimeline`
// re-renders on every tick (~30/s), and passing a fresh function identity
// each time to <TimelineEditor> — which mounts react-virtualized internals
// with their own effects — was enough to push it into a real "Maximum
// update depth exceeded" render loop in practice (observed 2026-07-28).
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Timeline as TimelineEditor, type TimelineState } from '@xzdarcy/react-timeline-editor'
import type { TimelineRow } from '@xzdarcy/timeline-engine'
import '@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css'
import type { Cue, Project } from '../types'
import { sidecar } from '../sidecar'

const MS_PER_S = 1000
const ROW_HEIGHT = 40
const TIME_AREA_HEIGHT = 32 // matches the library's own .timeline-editor-time-area CSS

const CUE_PALETTE = ['#4F6DF5', '#F5734F', '#B06FE0', '#4FF58C', '#4FF5E0', '#F5C84F']

const effects = {
  cue: { id: 'cue', name: 'Cue' },
}

/** Greedy interval packing: each cue goes in the first lane whose last cue
 * has already ended by the time this one starts, else it opens a new lane.
 * Same idea as packing overlapping events onto columns in a calendar. */
function packLanes(cues: Cue[]): Cue[][] {
  const sorted = [...cues].sort((a, b) => a.startMs - b.startMs)
  const lanes: Cue[][] = []
  for (const cue of sorted) {
    const lane = lanes.find((l) => l[l.length - 1].startMs + l[l.length - 1].durationMs <= cue.startMs)
    if (lane) lane.push(cue)
    else lanes.push([cue])
  }
  return lanes.length ? lanes : [[]]
}

export function CueTimeline({ project, tMs, selectedCueId, onSelectCue }: {
  project: Project
  tMs: number
  selectedCueId: string | null
  onSelectCue: (cueId: string | null) => void
}) {
  const stateRef = useRef<TimelineState>(null)
  const cues = project.cues

  const lanes = useMemo(() => packLanes(cues), [cues])

  const editorData: TimelineRow[] = useMemo(() => lanes.map((laneCues, i) => ({
    id: `lane-${i}`,
    actions: laneCues.map((cue) => ({
      id: cue.id,
      start: cue.startMs / MS_PER_S,
      end: (cue.startMs + cue.durationMs) / MS_PER_S,
      effectId: 'cue',
      movable: true,
      flexible: true,
      selected: cue.id === selectedCueId,
    })),
  })), [lanes, selectedCueId])

  // The sidecar pushes ~30 ticks/s while playing; keep the cursor locked to
  // that instead of letting the widget's own clock run.
  useEffect(() => {
    stateRef.current?.setTime(tMs / MS_PER_S)
  }, [tMs])

  const getActionRender = useCallback((action: { id: string; selected?: boolean }) => {
    const cue = cues.find((c) => c.id === action.id)
    if (!cue) return null
    const count = Object.keys(cue.activations).length
    return (
      <div
        className={`cue-block${action.selected ? ' cue-block-selected' : ''}`}
        style={{ '--cue-color': cue.color } as React.CSSProperties}
      >
        <div className="cue-block-header">
          <span className="cue-block-name">{cue.name}</span>
          <span className="cue-block-count">{count}</span>
        </div>
        <div className="cue-block-body" />
      </div>
    )
  }, [cues])

  const onClickActionOnly = useCallback((_e: unknown, { action }: { action: { id: string } }) => {
    onSelectCue(action.id)
  }, [onSelectCue])

  const onClickTimeArea = useCallback((time: number) => {
    sidecar.seek(time * MS_PER_S)
    return true
  }, [])

  const onCursorDrag = useCallback((time: number) => {
    sidecar.seek(time * MS_PER_S)
  }, [])

  const onActionMoveEnd = useCallback(({ action, start }: { action: { id: string }; start: number }) => {
    const cue = cues.find((c) => c.id === action.id)
    if (!cue) return
    sidecar.updateCue(cue.id, { startMs: start * MS_PER_S })
  }, [cues])

  const onActionResizeEnd = useCallback(({ action, start, end }: { action: { id: string }; start: number; end: number }) => {
    const cue = cues.find((c) => c.id === action.id)
    if (!cue) return
    sidecar.updateCue(cue.id, { startMs: start * MS_PER_S, durationMs: (end - start) * MS_PER_S })
  }, [cues])

  const addCue = useCallback(() => {
    const color = CUE_PALETTE[cues.length % CUE_PALETTE.length]
    sidecar.addCue('Cue', cues.length ? totalEndMs(cues) : 0, 2000, color)
  }, [cues])

  const deleteSelected = useCallback(() => {
    if (selectedCueId) {
      sidecar.deleteCue(selectedCueId)
      onSelectCue(null)
    }
  }, [selectedCueId, onSelectCue])

  const widgetHeight = TIME_AREA_HEIGHT + editorData.length * ROW_HEIGHT

  return (
    <div className="cue-timeline">
      <div className="cue-timeline-toolbar">
        <button onClick={addCue}>+ Cue</button>
        {selectedCueId && <button onClick={deleteSelected}>Supprimer</button>}
      </div>
      <div className="cue-timeline-body">
        <div className="cue-track-header" style={{ top: TIME_AREA_HEIGHT, height: editorData.length * ROW_HEIGHT }}>
          <span>Cues</span>
        </div>
        <div className="cue-timeline-editor-wrap">
          <TimelineEditor
            ref={stateRef}
            style={{ height: widgetHeight }}
            editorData={editorData}
            effects={effects}
            scale={1}
            scaleWidth={120}
            scaleSplitCount={10}
            startLeft={10}
            rowHeight={ROW_HEIGHT}
            gridSnap
            autoScroll
            getActionRender={getActionRender}
            onClickActionOnly={onClickActionOnly}
            onClickTimeArea={onClickTimeArea}
            onCursorDrag={onCursorDrag}
            onActionMoveEnd={onActionMoveEnd}
            onActionResizeEnd={onActionResizeEnd}
          />
        </div>
      </div>
    </div>
  )
}

function totalEndMs(cues: Cue[]): number {
  return Math.max(...cues.map((c) => c.startMs + c.durationMs), 0)
}
