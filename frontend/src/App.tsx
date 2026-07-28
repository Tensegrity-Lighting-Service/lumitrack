import { useMemo, useState } from 'react'
import './App.css'
import { Scene } from './scene/Scene'
import { CueTimeline } from './timeline/CueTimeline'
import { Waveform } from './audio/Waveform'
import { sidecar, useConnected, useProject, usePsnRunning, useTick } from './sidecar'
import type { Activation, Cue, Point } from './types'

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

  if (!project) {
    return (
      <div className="app-loading">
        {connected ? 'Connexion au sidecar…' : 'En attente du sidecar Python (ws://127.0.0.1:17845)…'}
      </div>
    )
  }

  return (
    <div className="app">
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

      <main className="scene-view">
        <Scene project={project} positions={positions} selectedPointId={selectedPointId} />
      </main>

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
      <h3>{cue.name}</h3>
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
