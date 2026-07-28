import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'
import { Scene } from './scene/Scene'
import { CueTimeline } from './timeline/CueTimeline'
import { sidecar, useBlockContext, useConnected, useProject, usePsnRunning, useTick } from './sidecar'
import { NumericInput } from './ui/NumericInput'
import type { Activation, Cue, Point, Project } from './types'

const ROSTER_MIN = 160
const ROSTER_MAX = 420
const INSPECTOR_MIN = 220
const INSPECTOR_MAX = 480
const TIMELINE_MIN = 120
const TIMELINE_MAX = 560

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// "Zoom to fit" icon: a square with its edge midpoints cut away, leaving
// just the 4 corner brackets — the requested "petit carré coupé à ses
// médianes pour ne garder que ses 4 coins".
function FitIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <path
        d="M1 4V1H4 M9 1H12V4 M12 9V12H9 M4 12H1V9"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
      />
    </svg>
  )
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

// Classic Windows-style dropdown menu bar (File/View/...), replacing the
// earlier ad hoc <details> dropdown and loose buttons per user feedback:
// "un bandeau de menu déroulant... truc classique à la Windows".
type MenuItemDef =
  | { label: string; onClick: () => void; checked?: boolean; disabled?: boolean }
  | { separator: true }

function MenuBar({ menus }: { menus: { label: string; items: MenuItemDef[] }[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  useEffect(() => {
    if (openIndex === null) return
    const close = () => setOpenIndex(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [openIndex])

  return (
    <nav className="menu-bar">
      {menus.map((menu, i) => (
        <div key={menu.label} className="menu">
          <button
            type="button"
            className={`menu-label${openIndex === i ? ' open' : ''}`}
            onClick={(e) => { e.stopPropagation(); setOpenIndex(openIndex === i ? null : i) }}
            onMouseEnter={() => { if (openIndex !== null) setOpenIndex(i) }}
          >
            {menu.label}
          </button>
          {openIndex === i && (
            <div className="menu-dropdown" onClick={(e) => e.stopPropagation()}>
              {menu.items.map((item, j) => (
                'separator' in item
                  ? <div key={j} className="menu-separator" />
                  : (
                    <button
                      key={j}
                      type="button"
                      className="menu-item"
                      disabled={item.disabled}
                      onClick={() => { item.onClick(); setOpenIndex(null) }}
                    >
                      <span className="menu-item-check">{item.checked ? '✓' : ''}</span>
                      <span>{item.label}</span>
                    </button>
                  )
              ))}
            </div>
          )}
        </div>
      ))}
    </nav>
  )
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
  const blockContext = useBlockContext()

  const [selectedCueId, setSelectedCueId] = useState<string | null>(null)
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null)

  const [rosterWidth, setRosterWidth] = useState(220)
  const [inspectorWidth, setInspectorWidth] = useState(300)
  const [timelineHeight, setTimelineHeight] = useState(220)
  const [cameraLocked, setCameraLocked] = useState(false)
  const [fitToken, setFitToken] = useState(0)
  const [editingZone, setEditingZone] = useState(false)
  const [gridOpacity, setGridOpacity] = useState(0.5)
  const [snapToGrid, setSnapToGrid] = useState(false)
  const [zoomAction, setZoomAction] = useState({ token: 0, factor: 1 })
  const [showGridSettings, setShowGridSettings] = useState(false)

  const zoomIn = () => setZoomAction((a) => ({ token: a.token + 1, factor: 1.2 }))
  const zoomOut = () => setZoomAction((a) => ({ token: a.token + 1, factor: 1 / 1.2 }))

  useEffect(() => {
    if (!showGridSettings) return
    const close = () => setShowGridSettings(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [showGridSettings])

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

  // Selecting a block puts the scene in that block's edit mode (§12.6):
  // fetch its context (targets + trajectories) and keep it fresh across
  // every project snapshot, since any edit can move a target or change
  // which cue a start position tracks from. Depends on `project` (the
  // snapshot object), not on individual fields, so a set_activation echo
  // triggers a re-request too.
  useEffect(() => {
    if (selectedCue) sidecar.resolveBlockContext(selectedCue.id)
    else sidecar.clearBlockContext()
  }, [selectedCue, project])

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

  const menus = [
    {
      label: 'Fichier',
      items: [
        { label: 'Nouveau', onClick: () => {
          const name = window.prompt('Nom du nouveau projet ?', 'Untitled')
          if (name) sidecar.newProject(name)
        } },
        { label: 'Importer .stancz…', onClick: () => {
          const path = window.prompt('Chemin du fichier .stancz à importer :')
          if (path) sidecar.importStancz(path)
        } },
        { separator: true } as const,
        { label: 'Importer un audio…', onClick: () => {
          const path = window.prompt('Chemin du fichier audio (mp3, m4a, wav…) :')
          if (path) sidecar.setAudio({ path })
        } },
        { label: 'Retirer l’audio', disabled: !project.audioPath, onClick: () => {
          sidecar.setAudio({ path: null })
        } },
        { separator: true } as const,
        { label: 'Enregistrer (bundle)…', onClick: () => {
          const path = window.prompt('Dossier .bundle où enregistrer :')
          if (path) sidecar.saveBundle(path)
        } },
        { label: 'Ouvrir (bundle)…', onClick: () => {
          const path = window.prompt('Dossier .bundle à ouvrir :')
          if (path) sidecar.loadBundle(path)
        } },
      ],
    },
    {
      label: 'Affichage',
      items: [
        { label: 'Ajuster la vue 3D à la fenêtre', onClick: () => setFitToken((t) => t + 1) },
        { separator: true } as const,
        { label: 'Verrouiller la caméra 3D', checked: cameraLocked, onClick: () => setCameraLocked((v) => !v) },
        { label: 'Éditer la zone de jeu', checked: editingZone, onClick: () => setEditingZone((v) => !v) },
      ],
    },
    {
      label: 'Sortie',
      items: [
        {
          label: psnRunning ? 'Arrêter PSN' : 'Démarrer PSN',
          checked: psnRunning,
          onClick: () => (psnRunning ? sidecar.psnStop() : sidecar.psnStart()),
        },
      ],
    },
  ]

  return (
    <div
      className="app"
      style={{
        gridTemplateColumns: `${rosterWidth}px 6px 1fr 6px ${inspectorWidth}px`,
        gridTemplateRows: `26px 40px 1fr 6px ${timelineHeight}px`,
      }}
    >
      <MenuBar menus={menus} />

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
          blockContext={blockContext}
          onSelectPoint={setSelectedPointId}
          cameraLocked={cameraLocked}
          fitToken={fitToken}
          editingZone={editingZone}
          gridOpacity={gridOpacity}
          snapToGrid={snapToGrid}
          zoomAction={zoomAction}
        />

        <div className="viewport-toolbar">
          <button title="Zoom avant" onClick={zoomIn}>+</button>
          <button title="Zoom arrière" onClick={zoomOut}>−</button>
          <button title="Ajuster à la fenêtre" onClick={() => setFitToken((t) => t + 1)}>
            <FitIcon />
          </button>
          <button
            title="Aligner sur la grille"
            className={snapToGrid ? 'active' : ''}
            onClick={() => setSnapToGrid((v) => !v)}
          >
            #
          </button>
          <div className="viewport-toolbar-settings">
            <button title="Réglages de la grille" onClick={() => setShowGridSettings((v) => !v)}>⚙</button>
            {showGridSettings && (
              <div className="viewport-popover" onClick={(e) => e.stopPropagation()}>
                <label>
                  Opacité de la grille
                  <input
                    type="range" min={0} max={1} step={0.05}
                    value={gridOpacity}
                    onChange={(e) => setGridOpacity(Number(e.target.value))}
                  />
                </label>
                <label>
                  Taille de la grille (cm)
                  <NumericInput
                    value={project.gridSizeCm} step={10}
                    onCommit={(v) => { if (v !== null && v >= 1) sidecar.updateStageMap({ gridSizeCm: v }) }}
                  />
                </label>
              </div>
            )}
          </div>
        </div>
      </main>

      <VerticalResizer area="vhandle2" onDeltaX={(dx) => setInspectorWidth((w) => clamp(w - dx, INSPECTOR_MIN, INSPECTOR_MAX))} />

      <aside className="inspector">
        <h2>Inspecteur</h2>
        {editingZone && <StagePlacementPanel project={project} />}
        {selectedCue ? (
          <CueInspector
            cue={selectedCue}
            projectPoints={project.points}
            selectedPointId={selectedPointId}
            onSelectPoint={setSelectedPointId}
          />
        ) : (
          !editingZone && <p className="hint">Sélectionne un bloc dans la timeline.</p>
        )}
      </aside>

      <HorizontalResizer area="hhandle" onDeltaY={(dy) => setTimelineHeight((h) => clamp(h - dy, TIMELINE_MIN, TIMELINE_MAX))} />

      <footer className="timeline-dock">
        <CueTimeline
          project={project}
          tMs={tMs}
          playing={playing}
          durationMs={durationMs}
          selectedCueId={selectedCueId}
          onSelectCue={setSelectedCueId}
        />
      </footer>
    </div>
  )
}

// Numeric mirror of the drag handles in Scene.tsx (move/resize/rotate) —
// same underlying sidecar.updateStageMap() calls, for precise values or a
// mouse-free adjustment. Only shown while "Éditer la zone de jeu" is on.
function StagePlacementPanel({ project }: { project: Project }) {
  return (
    <div className="stage-placement">
      <h3>Zone de jeu</h3>
      <div className="stage-placement-grid">
        <label>Origine X (m)
          <NumericInput value={project.stageMapOriginXM} step={0.1}
            onCommit={(v) => { if (v !== null) sidecar.updateStageMap({ originXM: v }) }} />
        </label>
        <label>Origine Z (m)
          <NumericInput value={project.stageMapOriginZM} step={0.1}
            onCommit={(v) => { if (v !== null) sidecar.updateStageMap({ originZM: v }) }} />
        </label>
        <label>Rotation (°)
          <NumericInput value={project.stageMapRotationDeg} step={1}
            onCommit={(v) => { if (v !== null) sidecar.updateStageMap({ rotationDeg: v }) }} />
        </label>
        <label>Largeur (cm)
          <NumericInput value={project.stageWidthCm} step={10}
            onCommit={(v) => { if (v !== null && v >= 1) sidecar.updateStageMap({ widthCm: v }) }} />
        </label>
        <label>Profondeur (cm)
          <NumericInput value={project.stageHeightCm} step={10}
            onCommit={(v) => { if (v !== null && v >= 1) sidecar.updateStageMap({ heightCm: v }) }} />
        </label>
      </div>
      <p className="hint">Ou fais glisser directement dans la vue 3D : centre = déplacer, coin orange = redimensionner, poignée verte = pivoter.</p>
    </div>
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
      <div className="activation-list">
        {Object.entries(cue.activations).map(([pointId, act]) => {
          const point = projectPoints.find((p) => p.id === pointId)
          return (
            <ActivationCard
              key={pointId}
              cueId={cue.id}
              pointId={pointId}
              point={point}
              activation={act}
              selected={pointId === selectedPointId}
              onSelect={() => onSelectPoint(pointId === selectedPointId ? null : pointId)}
            />
          )
        })}
      </div>
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

// Mirror of core/timeline.py EASING_NAMES — keep in sync by hand (same
// caveat as types.ts: no shared schema yet).
const EASING_NAMES = ['linear', 'smooth', 'ease-in', 'ease-out', 'bounce', 'spring', 'exponential']

/** One activation of the selected cue: every field the model supports
 * (X/Y/Z/lacet/fade/courbe, mission 2), each through NumericInput so a
 * mid-typing backend echo can never rewrite the field (constat n°1). A
 * cleared X/Y/Z/lacet commits null = axe détouché, il repasse en tracking
 * (§12.1) ; le fade, lui, est toujours défini. */
function ActivationCard({ cueId, pointId, point, activation, selected, onSelect }: {
  cueId: string
  pointId: string
  point: Point | undefined
  activation: Activation
  selected: boolean
  onSelect: () => void
}) {
  const set = (patch: Partial<{
    targetXCm: number | null; targetYCm: number | null; targetZCm: number | null
    targetYawDeg: number | null; fadeMs: number; easing: string
  }>) => sidecar.setActivation(cueId, pointId, patch)

  return (
    <div className={`activation-card${selected ? ' selected' : ''}`} onClick={onSelect}>
      <div className="activation-card-head">
        <span className="swatch" style={{ background: point?.color ?? '#666' }} />
        <span className="activation-card-name">{point?.name ?? pointId}</span>
      </div>
      {/* stopPropagation : cliquer dans un champ ne doit pas basculer la
          sélection de l'acteur portée par la carte entière. */}
      <div className="activation-grid" onClick={(e) => e.stopPropagation()}>
        <label>X (cm)
          <NumericInput value={activation.targetXCm} step={10} nullable
            onCommit={(v) => set({ targetXCm: v })} />
        </label>
        <label>Y (cm)
          <NumericInput value={activation.targetYCm} step={10} nullable
            onCommit={(v) => set({ targetYCm: v })} />
        </label>
        <label>Z (cm)
          <NumericInput value={activation.targetZCm} step={10} nullable
            onCommit={(v) => set({ targetZCm: v })} />
        </label>
        <label>Lacet (°)
          <NumericInput value={activation.targetYawDeg} step={5} nullable
            onCommit={(v) => set({ targetYawDeg: v })} />
        </label>
        <label>Fade (ms)
          <NumericInput value={activation.fadeMs} step={100}
            onCommit={(v) => { if (v !== null && v >= 0) set({ fadeMs: v }) }} />
        </label>
        <label>Courbe
          <select value={activation.easing} onChange={(e) => set({ easing: e.target.value })}>
            {EASING_NAMES.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
      </div>
    </div>
  )
}

export default App
