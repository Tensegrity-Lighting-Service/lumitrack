import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'
import { Scene } from './scene/Scene'
import { CueTimeline } from './timeline/CueTimeline'
import { Waveform } from './audio/Waveform'
import { sidecar, useConnected, useProject, usePsnRunning, useTick } from './sidecar'
import type { Activation, Cue, Point } from './types'

const ROSTER_MIN = 160
const ROSTER_MAX = 420
const INSPECTOR_MIN = 220
const INSPECTOR_MAX = 480
const TIMELINE_MIN = 120
const TIMELINE_MAX = 560

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Panel-resize dividers (window/timeline sizing was previously fixed).
 * Plain pointer-capture drag, no library: drag deltas are applied directly
 * to the caller's setter, clamped to sane min/max there isn't a natural
 * bound from otherwise. */
// Pointer capture (not just a window listener) matters here: the scene
// panel's <Canvas> sits right next to every one of these handles, and
// MapControls attaches its own pointer listeners directly on the canvas
// and calls stopPropagation() on them. Without capture, the drag's very
// first pointermove that crosses onto the canvas has its propagation
// killed before it reaches a window-level listener, so the handle looked
// draggable but silently did nothing (observed 2026-07-28). Capturing the
// pointer on the handle itself routes every subsequent event straight to
// it regardless of what's physically under the cursor.
function VerticalResizer({ area, onDeltaX }: { area: string; onDeltaX: (dx: number) => void }) {
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    let lastX = e.clientX
    const onMove = (ev: PointerEvent) => {
      onDeltaX(ev.clientX - lastX)
      lastX = ev.clientX
    }
    const onUp = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
  }, [onDeltaX])
  return <div className="resizer resizer-v" style={{ gridArea: area }} onPointerDown={onPointerDown} />
}

function HorizontalResizer({ area, onDeltaY }: { area: string; onDeltaY: (dy: number) => void }) {
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    let lastY = e.clientY
    const onMove = (ev: PointerEvent) => {
      onDeltaY(ev.clientY - lastY)
      lastY = ev.clientY
    }
    const onUp = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
  }, [onDeltaY])
  return <div className="resizer resizer-h" style={{ gridArea: area }} onPointerDown={onPointerDown} />
}

function formatTimecode(ms: number): string {
  const totalMs = Math.max(0, Math.floor(ms))
  const h = Math.floor(totalMs / 3_600_000)
  const m = Math.floor((totalMs % 3_600_000) / 60_000)
  const s = Math.floor((totalMs % 60_000) / 1000)
  const millis = totalMs % 1000
  const pad = (n: number, len = 2) => n.toString().padStart(len, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(millis, 3)}`
}

function App() {
  const project = useProject()
  const tick = useTick()
  const connected = useConnected()
  const psnRunning = usePsnRunning()

  const [selectedCueId, setSelectedCueId] = useState<string | null>(null)
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null)

  const [rosterWidth, setRosterWidth] = useState(220)
  const [inspectorWidth, setInspectorWidth] = useState(300)
  const [timelineHeight, setTimelineHeight] = useState(220)

  const tMs = tick?.tMs ?? 0
  const playing = tick?.playing ?? false
  const durationMs = tick?.durationMs ?? 1000
  const positions = tick?.positions ?? {}

  const movingPointIds = useMemo(() => {
    const moving = new Set<string>()
    if (!project) return moving
    for (const cue of project.cues) {
      for (const [pointId, act] of Object.entries(cue.activations)) {
        if (tMs >= cue.startMs && tMs < cue.startMs + act.fadeMs) moving.add(pointId)
      }
    }
    return moving
  }, [project, tMs])

  const selectedCue = project?.cues.find((c) => c.id === selectedCueId) ?? null

  // Global shortcuts. Skipped while typing in an input/select/color-picker
  // so Space/Delete keep their normal text-editing meaning there.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target?.isContentEditable) return

      if (e.code === 'Space') {
        e.preventDefault()
        if (playing) sidecar.pause()
        else sidecar.play()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedCueId) {
          e.preventDefault()
          sidecar.deleteCue(selectedCueId)
          setSelectedCueId(null)
        }
      } else if (e.key === 'Escape') {
        setSelectedCueId(null)
        setSelectedPointId(null)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [playing, selectedCueId])

  if (!project) {
    return (
      <div className="app-loading">
        {connected ? 'Connexion au sidecar…' : 'En attente du sidecar Python (ws://127.0.0.1:17845)…'}
      </div>
    )
  }

  return (
    <div
      className="app"
      style={{
        gridTemplateColumns: `${rosterWidth}px 6px 1fr 6px ${inspectorWidth}px`,
        gridTemplateRows: `40px 1fr 6px ${timelineHeight}px`,
      }}
    >
      <header className="transport-bar">
        <span className={`conn-dot ${connected ? 'conn-ok' : 'conn-bad'}`} title={connected ? 'Sidecar connecté' : 'Sidecar déconnecté'} />
        <button onClick={() => (playing ? sidecar.pause() : sidecar.play())}>
          {playing ? '⏸' : '⏵'}
        </button>
        <input
          className="scrub"
          type="range"
          min={0}
          max={durationMs}
          value={tMs}
          onChange={(e) => sidecar.seek(Number(e.target.value))}
        />
        <span className="timecode">{formatTimecode(tMs)}</span>
        <span className="project-name">{project.name}</span>
        <FileMenu />
        <button
          className={psnRunning ? 'psn-on' : ''}
          onClick={() => (psnRunning ? sidecar.psnStop() : sidecar.psnStart())}
        >
          {psnRunning ? 'PSN actif' : 'Démarrer PSN'}
        </button>
      </header>

      <aside className="roster">
        <h2>Roster</h2>
        <ul>
          {project.points.map((point) => (
            <li
              key={point.id}
              className={point.id === selectedPointId ? 'selected' : ''}
              onClick={() => setSelectedPointId(point.id === selectedPointId ? null : point.id)}
            >
              <span
                className={`status-dot ${movingPointIds.has(point.id) ? 'moving' : 'idle'}`}
                title={movingPointIds.has(point.id) ? 'En mouvement' : 'Immobile'}
              />
              <span className="swatch" style={{ background: point.color }} />
              <span className="point-name">{point.name}</span>
              {!positions[point.id] && <span className="offstage" title="Hors scène">•</span>}
            </li>
          ))}
        </ul>
      </aside>

      <VerticalResizer area="vhandle1" onDeltaX={(dx) => setRosterWidth((w) => clamp(w + dx, ROSTER_MIN, ROSTER_MAX))} />

      <main className="scene-view">
        <Scene
          project={project}
          positions={positions}
          selectedPointId={selectedPointId}
          selectedCueId={selectedCueId}
          onSelectPoint={setSelectedPointId}
        />
      </main>

      <VerticalResizer area="vhandle2" onDeltaX={(dx) => setInspectorWidth((w) => clamp(w - dx, INSPECTOR_MIN, INSPECTOR_MAX))} />

      <aside className="inspector">
        <h2>Inspecteur</h2>
        {selectedCue ? (
          <CueInspector
            cue={selectedCue}
            projectPoints={project.points}
            selectedPointId={selectedPointId}
            onSelectPoint={setSelectedPointId}
          />
        ) : (
          <p className="hint">Sélectionne un bloc dans la timeline.</p>
        )}
      </aside>

      <HorizontalResizer area="hhandle" onDeltaY={(dy) => setTimelineHeight((h) => clamp(h - dy, TIMELINE_MIN, TIMELINE_MAX))} />

      <footer className="timeline-dock">
        {project.audioPath && <Waveform audioPath={project.audioPath} tMs={tMs} playing={playing} />}
        <CueTimeline project={project} tMs={tMs} selectedCueId={selectedCueId} onSelectCue={setSelectedCueId} />
      </footer>
    </div>
  )
}

// Bundle path entry via window.prompt for now — no native file dialog
// plugin wired up yet (would need @tauri-apps/plugin-dialog + a capability
// entry); the sidecar itself only needs a plain filesystem path either way.
function FileMenu() {
  return (
    <details className="file-menu">
      <summary>Fichier</summary>
      <div className="file-menu-items">
        <button onClick={() => {
          const name = window.prompt('Nom du nouveau projet ?', 'Untitled')
          if (name) sidecar.newProject(name)
        }}>Nouveau</button>
        <button onClick={() => {
          const path = window.prompt('Chemin du fichier .stancz à importer :')
          if (path) sidecar.importStancz(path)
        }}>Importer .stancz…</button>
        <button onClick={() => {
          const path = window.prompt('Dossier .bundle où enregistrer :')
          if (path) sidecar.saveBundle(path)
        }}>Enregistrer (bundle)…</button>
        <button onClick={() => {
          const path = window.prompt('Dossier .bundle à ouvrir :')
          if (path) sidecar.loadBundle(path)
        }}>Ouvrir (bundle)…</button>
      </div>
    </details>
  )
}

function CueInspector({ cue, projectPoints, selectedPointId, onSelectPoint }: {
  cue: Cue
  projectPoints: Point[]
  selectedPointId: string | null
  onSelectPoint: (id: string | null) => void
}) {
  const activatedIds = new Set(Object.keys(cue.activations))
  const availablePoints = projectPoints.filter((p) => !activatedIds.has(p.id))

  return (
    <div className="cue-inspector">
      <div className="cue-inspector-title">
        <input
          type="color"
          value={cue.color}
          onChange={(e) => sidecar.updateCue(cue.id, { color: e.target.value })}
          title="Couleur du bloc"
        />
        <h3>{cue.name}</h3>
      </div>
      <table>
        <thead>
          <tr><th>Point</th><th>X</th><th>Y</th><th>Fade (ms)</th></tr>
        </thead>
        <tbody>
          {Object.entries(cue.activations).map(([pointId, act]) => {
            const point = projectPoints.find((p) => p.id === pointId)
            return (
              <ActivationRow
                key={pointId}
                cueId={cue.id}
                pointId={pointId}
                pointName={point?.name ?? pointId}
                activation={act}
                selected={pointId === selectedPointId}
                onSelect={() => onSelectPoint(pointId === selectedPointId ? null : pointId)}
              />
            )
          })}
        </tbody>
      </table>
      {availablePoints.length > 0 && (
        <select
          defaultValue=""
          onChange={(e) => {
            if (!e.target.value) return
            sidecar.setActivation(cue.id, e.target.value, { fadeMs: 1000, easing: 'linear' })
            e.target.value = ''
          }}
        >
          <option value="" disabled>+ Activer un point…</option>
          {availablePoints.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
    </div>
  )
}

function ActivationRow({ cueId, pointId, pointName, activation, selected, onSelect }: {
  cueId: string
  pointId: string
  pointName: string
  activation: Activation
  selected: boolean
  onSelect: () => void
}) {
  return (
    <tr className={selected ? 'selected' : ''} onClick={onSelect}>
      <td>{pointName}</td>
      <td>
        <input type="number" value={activation.targetXCm ?? ''} placeholder="—"
          onChange={(e) => sidecar.setActivation(cueId, pointId, { targetXCm: Number(e.target.value) })} />
      </td>
      <td>
        <input type="number" value={activation.targetYCm ?? ''} placeholder="—"
          onChange={(e) => sidecar.setActivation(cueId, pointId, { targetYCm: Number(e.target.value) })} />
      </td>
      <td>
        <input type="number" value={activation.fadeMs}
          onChange={(e) => sidecar.setActivation(cueId, pointId, { fadeMs: Number(e.target.value) })} />
      </td>
    </tr>
  )
}

export default App
