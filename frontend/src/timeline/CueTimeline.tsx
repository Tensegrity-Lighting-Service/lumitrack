// "Piste Blocs/Cue" of CONCEPTION.md §12.10. Repères/Groupes/LED tracks are
// deferred (§13.2); this first pass wires exactly one row: one block per
// Cue, draggable/resizable, backed by the sidecar's update_cue command.
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

const effects = {
  cue: { id: 'cue', name: 'Cue' },
}

export function CueTimeline({ project, tMs, selectedCueId, onSelectCue }: {
  project: Project
  tMs: number
  selectedCueId: string | null
  onSelectCue: (cueId: string | null) => void
}) {
  const stateRef = useRef<TimelineState>(null)
  const cues = project.cues

  const editorData: TimelineRow[] = useMemo(() => [{
    id: 'cues',
    actions: cues.map((cue) => ({
      id: cue.id,
      start: cue.startMs / MS_PER_S,
      end: (cue.startMs + cue.durationMs) / MS_PER_S,
      effectId: 'cue',
      movable: true,
      flexible: true,
      selected: cue.id === selectedCueId,
    })),
  }], [cues, selectedCueId])

  // The sidecar pushes ~30 ticks/s while playing; keep the cursor locked to
  // that instead of letting the widget's own clock run.
  useEffect(() => {
    stateRef.current?.setTime(tMs / MS_PER_S)
  }, [tMs])

  const getActionRender = useCallback((action: { id: string }) => {
    const cue = cues.find((c) => c.id === action.id)
    const count = cue ? Object.keys(cue.activations).length : 0
    return (
      <div className="cue-block">
        <span className="cue-block-name">{cue?.name ?? action.id}</span>
        <span className="cue-block-count">{count}</span>
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
    sidecar.addCue('Cue', cues.length ? totalEndMs(cues) : 0, 2000)
  }, [cues])

  const deleteSelected = useCallback(() => {
    if (selectedCueId) {
      sidecar.deleteCue(selectedCueId)
      onSelectCue(null)
    }
  }, [selectedCueId, onSelectCue])

  return (
    <div className="cue-timeline">
      <div className="cue-timeline-toolbar">
        <button onClick={addCue}>+ Cue</button>
        {selectedCueId && <button onClick={deleteSelected}>Supprimer</button>}
      </div>
      <TimelineEditor
        ref={stateRef}
        style={{ height: TIME_AREA_HEIGHT + editorData.length * ROW_HEIGHT }}
        editorData={editorData}
        effects={effects}
        scale={1}
        scaleWidth={120}
        scaleSplitCount={10}
        startLeft={20}
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
  )
}

function totalEndMs(cues: Cue[]): number {
  return Math.max(...cues.map((c) => c.startMs + c.durationMs), 0)
}
