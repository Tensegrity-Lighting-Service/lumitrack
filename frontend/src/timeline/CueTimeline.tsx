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
import { useEffect, useMemo, useRef } from 'react'
import { Timeline as TimelineEditor, type TimelineState } from '@xzdarcy/react-timeline-editor'
import type { TimelineRow } from '@xzdarcy/timeline-engine'
import '@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css'
import type { Cue, Project } from '../types'
import { sidecar } from '../sidecar'

const MS_PER_S = 1000

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

  const editorData: TimelineRow[] = useMemo(() => [{
    id: 'cues',
    actions: project.cues.map((cue) => ({
      id: cue.id,
      start: cue.startMs / MS_PER_S,
      end: (cue.startMs + cue.durationMs) / MS_PER_S,
      effectId: 'cue',
      movable: true,
      flexible: true,
      selected: cue.id === selectedCueId,
    })),
  }], [project.cues, selectedCueId])

  // The sidecar pushes ~30 ticks/s while playing; keep the cursor locked to
  // that instead of letting the widget's own clock run.
  useEffect(() => {
    stateRef.current?.setTime(tMs / MS_PER_S)
  }, [tMs])

  return (
    <div className="cue-timeline">
      <div className="cue-timeline-toolbar">
        <button onClick={() => sidecar.addCue('Cue', project.cues.length ? totalEndMs(project.cues) : 0, 2000)}>
          + Cue
        </button>
        {selectedCueId && (
          <button onClick={() => { sidecar.deleteCue(selectedCueId); onSelectCue(null) }}>
            Supprimer
          </button>
        )}
      </div>
      <TimelineEditor
        ref={stateRef}
        editorData={editorData}
        effects={effects}
        scale={1}
        scaleWidth={120}
        scaleSplitCount={10}
        startLeft={20}
        rowHeight={40}
        gridSnap
        autoScroll
        getActionRender={(action) => {
          const cue = project.cues.find((c) => c.id === action.id)
          const count = cue ? Object.keys(cue.activations).length : 0
          return (
            <div className="cue-block">
              <span className="cue-block-name">{cue?.name ?? action.id}</span>
              <span className="cue-block-count">{count}</span>
            </div>
          )
        }}
        onClickActionOnly={(_e, { action }) => onSelectCue(action.id)}
        onClickTimeArea={(time) => {
          sidecar.seek(time * MS_PER_S)
          return true
        }}
        onCursorDrag={(time) => {
          sidecar.seek(time * MS_PER_S)
        }}
        onActionMoveEnd={({ action, start }) => {
          const cue = project.cues.find((c) => c.id === action.id)
          if (!cue) return
          sidecar.updateCue(cue.id, { startMs: start * MS_PER_S })
        }}
        onActionResizeEnd={({ action, start, end }) => {
          const cue = project.cues.find((c) => c.id === action.id)
          if (!cue) return
          sidecar.updateCue(cue.id, { startMs: start * MS_PER_S, durationMs: (end - start) * MS_PER_S })
        }}
      />
    </div>
  )
}

function totalEndMs(cues: Cue[]): number {
  return Math.max(...cues.map((c) => c.startMs + c.durationMs), 0)
}
