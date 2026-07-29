import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { Scene } from './scene/Scene'
import { CueTimeline } from './timeline/CueTimeline'
import { sidecar, useBlockContext, useConnected, useProject, usePsnRunning, useTick } from './sidecar'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { NumericInput } from './ui/NumericInput'
import { PsnPanel } from './ui/PsnPanel'
import type { Activation, BackstageZone, Cue, Point, Project } from './types'

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

function App() {
  const project = useProject()
  const tick = useTick()
  const connected = useConnected()
  const psnRunning = usePsnRunning()
  const blockContext = useBlockContext()

  const [selectedCueId, setSelectedCueId] = useState<string | null>(null)
  // Sélection multiple d'acteurs (Ctrl/Shift-clic au roster). Ordonnée :
  // le DERNIER cliqué est l'acteur "principal" (inspecteur, graph editor,
  // mise en avant scène) ; les autres suivent pour les éditions groupées.
  const [selectedPointIds, setSelectedPointIds] = useState<string[]>([])
  const selectedPointId = selectedPointIds.length ? selectedPointIds[selectedPointIds.length - 1] : null
  const setSelectedPointId = useCallback((id: string | null) => {
    setSelectedPointIds(id === null ? [] : [id])
  }, [])

  const [rosterWidth, setRosterWidth] = useState(220)
  const [addCount, setAddCount] = useState(1)
  const [inspectorWidth, setInspectorWidth] = useState(300)
  const [timelineHeight, setTimelineHeight] = useState(220)
  const [cameraLocked, setCameraLocked] = useState(false)
  const [fitToken, setFitToken] = useState(0)
  const [editingZone, setEditingZone] = useState(false)
  const [gridOpacity, setGridOpacity] = useState(0.5)
  const [snapToGrid, setSnapToGrid] = useState(false)
  const [zoomAction, setZoomAction] = useState({ token: 0, factor: 1 })
  const [showGridSettings, setShowGridSettings] = useState(false)
  const [showPsnPanel, setShowPsnPanel] = useState(false)

  const zoomIn = () => setZoomAction((a) => ({ token: a.token + 1, factor: 1.2 }))
  const zoomOut = () => setZoomAction((a) => ({ token: a.token + 1, factor: 1 / 1.2 }))

  // Fermeture au clic extérieur — sur POINTERDOWN avec test d'appartenance
  // (ref.contains), pas sur `click` global : le clic d'ouverture sur ⚙
  // continuait de remonter jusqu'à window où l'écouteur fraîchement posé
  // (React flushe les effets synchronement sur les événements discrets) le
  // refermait dans la même frame — le popover semblait « ne pas marcher ».
  const gridSettingsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!showGridSettings) return
    const close = (e: PointerEvent) => {
      if (gridSettingsRef.current?.contains(e.target as Node)) return
      setShowGridSettings(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
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

  // Drag & drop de fichiers sur la fenêtre : routage par extension —
  // audio -> piste audio, .stancz -> import, .lumitrack/.bundle -> ouvrir.
  // (Événement natif Tauri : contrairement au drop HTML5, il porte les
  // vrais chemins disque, que le sidecar peut ouvrir.)
  useEffect(() => {
    const AUDIO_EXT = ['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac']
    let unlisten: (() => void) | null = null
    getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== 'drop') return
      for (const path of event.payload.paths) {
        const ext = path.split('.').pop()?.toLowerCase() ?? ''
        if (AUDIO_EXT.includes(ext)) sidecar.setAudio({ path })
        else if (ext === 'stancz') sidecar.importStancz(path)
        else if (ext === 'lumitrack' || ext === 'bundle') sidecar.loadBundle(path)
      }
    }).then((fn) => { unlisten = fn }).catch(() => { /* hors Tauri (dev navigateur) */ })
    return () => { if (unlisten) unlisten() }
  }, [])

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
        setSelectedPointIds([])
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
        { label: 'Importer .stancz…', onClick: async () => {
          const path = await openDialog({
            title: 'Importer un projet Stancz',
            filters: [{ name: 'Projet Stancz', extensions: ['stancz'] }],
          })
          if (typeof path === 'string') sidecar.importStancz(path)
        } },
        { separator: true } as const,
        { label: 'Importer un audio…', onClick: async () => {
          const path = await openDialog({
            title: 'Importer un fichier audio',
            filters: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac'] }],
          })
          if (typeof path === 'string') sidecar.setAudio({ path })
        } },
        { label: 'Retirer l’audio', disabled: !project.audioPath, onClick: () => {
          sidecar.setAudio({ path: null })
        } },
        { separator: true } as const,
        { label: 'Enregistrer (bundle)…', onClick: async () => {
          const path = await saveDialog({
            title: 'Enregistrer le projet',
            defaultPath: `${project.name || 'Projet'}.lumitrack`,
          })
          if (path) sidecar.saveBundle(path)
        } },
        { label: 'Ouvrir (bundle)…', onClick: async () => {
          const path = await openDialog({
            title: 'Ouvrir un projet (.lumitrack)',
            directory: true,
          })
          if (typeof path === 'string') sidecar.loadBundle(path)
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
        { separator: true } as const,
        { label: 'Réglages PSN…', onClick: () => setShowPsnPanel(true) },
      ],
    },
  ]

  return (
    <div
      className="app"
      style={{
        gridTemplateColumns: `${rosterWidth}px 6px 1fr 6px ${inspectorWidth}px`,
        gridTemplateRows: `26px 1fr 6px ${timelineHeight}px`,
      }}
    >
      <MenuBar menus={menus} />

      <aside className="roster">
        <div className="roster-head">
          <h2>Roster</h2>
          <span className="roster-spacer" />
          <input
            className="roster-add-count"
            type="number" min={1} max={99} value={addCount}
            title="Nombre d'acteurs à ajouter d'un coup"
            onChange={(e) => setAddCount(Math.max(1, Math.min(99, Number(e.target.value) || 1)))}
          />
          <button
            className="roster-add-btn"
            title={`Ajouter ${addCount} acteur${addCount > 1 ? 's' : ''}`}
            onClick={() => {
              const base = project.points.length
              for (let i = 0; i < addCount; i++) {
                sidecar.addPoint(`Acteur ${base + i + 1}`, base + i + 1)
              }
            }}
          >
            + Acteur{addCount > 1 ? 's' : ''}
          </button>
        </div>
        <ul>
          {project.points.map((point, index) => (
            <li
              key={point.id}
              className={selectedPointIds.includes(point.id) ? 'selected' : ''}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-lumitrack-point', point.id)
                e.dataTransfer.effectAllowed = 'copy'
              }}
              onClick={(e) => {
                // Ctrl/Cmd : bascule ; Shift : plage depuis le principal ;
                // clic nu : sélection simple (re-clic = désélection).
                if (e.ctrlKey || e.metaKey) {
                  setSelectedPointIds((prev) => prev.includes(point.id)
                    ? prev.filter((id) => id !== point.id)
                    : [...prev, point.id])
                } else if (e.shiftKey && selectedPointId) {
                  const anchorIdx = project.points.findIndex((p) => p.id === selectedPointId)
                  if (anchorIdx >= 0) {
                    const [lo, hi] = anchorIdx < index ? [anchorIdx, index] : [index, anchorIdx]
                    const range = project.points.slice(lo, hi + 1).map((p) => p.id)
                    // Le point cliqué devient le principal (dernier).
                    setSelectedPointIds([...range.filter((id) => id !== point.id), point.id])
                  }
                } else {
                  setSelectedPointIds(selectedPointIds.length === 1 && selectedPointId === point.id
                    ? [] : [point.id])
                }
              }}
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
          tMs={tMs}
          selectedPointId={selectedPointId}
          selectedPointIds={selectedPointIds}
          onSelectPoints={setSelectedPointIds}
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
          <div className="viewport-toolbar-settings" ref={gridSettingsRef}>
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
                  Rotation du modèle 3D (°)
                  <NumericInput
                    value={project.terrainRotationDeg ?? 0} step={15}
                    onCommit={(v) => { if (v !== null) sidecar.updateStageMap({ terrainRotationDeg: v }) }}
                  />
                </label>
                <label>
                  Taille de la grille (m)
                  <NumericInput
                    value={project.gridSizeCm / 100} step={0.1}
                    onCommit={(v) => { if (v !== null && v >= 0.01) sidecar.updateStageMap({ gridSizeCm: v * 100 }) }}
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
        {editingZone && <BackstagePanel project={project} />}
        {selectedCue && selectedPointIds.length > 1 && (
          <GroupTimingPanel
            cue={selectedCue}
            selectedPointIds={selectedPointIds}
            projectPoints={project.points}
          />
        )}
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

      {showPsnPanel && <PsnPanel project={project} onClose={() => setShowPsnPanel(false)} />}

      <footer className="timeline-dock">
        <CueTimeline
          project={project}
          tMs={tMs}
          playing={playing}
          durationMs={durationMs}
          connected={connected}
          selectedCueId={selectedCueId}
          selectedPointId={selectedPointId}
          onSelectCue={setSelectedCueId}
        />
      </footer>
    </div>
  )
}

// Numeric mirror of the drag handles in Scene.tsx (move/resize/rotate) —
// same underlying sidecar.updateStageMap() calls, for precise values or a
// mouse-free adjustment. Only shown while "Éditer la zone de jeu" is on.
function BackstagePanel({ project }: { project: Project }) {
  const zones = project.backstageZones ?? []
  const update = (id: string, patch: Partial<BackstageZone>) => {
    sidecar.setBackstageZones(zones.map((z) => (z.id === id ? { ...z, ...patch } : z)))
  }
  return (
    <div className="stage-placement">
      <h3>Zones backstage</h3>
      {zones.map((zone) => (
        <div key={zone.id} className="backstage-row">
          <input
            value={zone.name}
            onChange={(e) => update(zone.id, { name: e.target.value })}
            title="Nom de la zone"
          />
          <button
            title="Supprimer la zone"
            disabled={zones.length <= 1}
            onClick={() => sidecar.setBackstageZones(zones.filter((z) => z.id !== zone.id))}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        className="backstage-add"
        onClick={() => sidecar.setBackstageZones([...zones, {
          id: `backstage-${Date.now()}`,
          name: `Backstage ${zones.length + 1}`,
          xCm: project.stageWidthCm + 100,
          yCm: 0,
          widthCm: 400,
          heightCm: Math.min(1200, project.stageHeightCm),
        }])}
      >
        + Zone backstage
      </button>
      <p className="hint">Glisse un acteur du roster sur une zone avec Alt pour l’y attacher. Les zones se déplacent/redimensionnent dans la scène.</p>
    </div>
  )
}

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
        <label>Largeur (m)
          <NumericInput value={project.stageWidthCm / 100} step={0.5}
            onCommit={(v) => { if (v !== null && v >= 0.01) sidecar.updateStageMap({ widthCm: v * 100 }) }} />
        </label>
        <label>Profondeur (m)
          <NumericInput value={project.stageHeightCm / 100} step={0.5}
            onCommit={(v) => { if (v !== null && v >= 0.01) sidecar.updateStageMap({ heightCm: v * 100 }) }} />
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
/** Édition groupée du timing (mission multi-sélection) : applique fade et
 * easing d'un coup à toutes les activations des acteurs sélectionnés dans
 * le bloc. Valeur affichée = commune si partagée, sinon vide (« mixte »).
 * Chaque changement écrit N set_activation — le backend reste la seule
 * source de vérité, comme partout. */
function GroupTimingPanel({ cue, selectedPointIds, projectPoints }: {
  cue: Cue
  selectedPointIds: string[]
  projectPoints: Point[]
}) {
  const activated = selectedPointIds.filter((id) => cue.activations[id])
  const acts = activated.map((id) => cue.activations[id])
  const shared = <T,>(get: (a: Activation) => T): T | null =>
    acts.length && acts.every((a) => get(a) === get(acts[0])) ? get(acts[0]) : null
  const sharedFade = shared((a) => a.fadeMs)
  const sharedEasing = shared((a) => a.easing)

  const applyAll = (patch: { fadeMs?: number; easing?: string }) => {
    for (const id of activated) sidecar.setActivation(cue.id, id, patch)
  }

  const names = selectedPointIds
    .map((id) => projectPoints.find((p) => p.id === id)?.name ?? id)

  return (
    <div className="group-timing">
      <h3>Timing groupé — {selectedPointIds.length} acteurs</h3>
      <p className="group-timing-names" title={names.join(', ')}>{names.join(', ')}</p>
      {activated.length === 0 ? (
        <p className="hint">Aucun des acteurs sélectionnés n’est activé dans ce bloc.</p>
      ) : (
        <>
          {activated.length < selectedPointIds.length && (
            <p className="hint">{activated.length} activé{activated.length > 1 ? 's' : ''} sur {selectedPointIds.length} — les autres ne sont pas touchés.</p>
          )}
          <div className="group-timing-grid">
            <label>Fade (s)
              <NumericInput
                value={sharedFade === null ? null : sharedFade / 1000} step={0.1} nullable
                onCommit={(v) => { if (v !== null && v >= 0) applyAll({ fadeMs: v * 1000 }) }}
              />
            </label>
            <label>Courbe
              <select
                value={sharedEasing ?? ''}
                onChange={(e) => { if (e.target.value) applyAll({ easing: e.target.value }) }}
              >
                {sharedEasing === null && <option value="">(mixte)</option>}
                {['linear', 'smooth', 'ease-in', 'ease-out', 'bounce', 'spring', 'exponential'].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
          </div>
        </>
      )}
    </div>
  )
}

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
        <label>X (m)
          <NumericInput value={activation.targetXCm === null ? null : activation.targetXCm / 100} step={0.1} nullable
            onCommit={(v) => set({ targetXCm: v === null ? null : v * 100 })} />
        </label>
        <label>Y (m)
          <NumericInput value={activation.targetYCm === null ? null : activation.targetYCm / 100} step={0.1} nullable
            onCommit={(v) => set({ targetYCm: v === null ? null : v * 100 })} />
        </label>
        <label>Z (m)
          <NumericInput value={activation.targetZCm === null ? null : activation.targetZCm / 100} step={0.1} nullable
            onCommit={(v) => set({ targetZCm: v === null ? null : v * 100 })} />
        </label>
        <label>Lacet (°)
          <NumericInput value={activation.targetYawDeg} step={5} nullable
            onCommit={(v) => set({ targetYawDeg: v })} />
        </label>
        <label>Fade (s)
          <NumericInput value={activation.fadeMs / 1000} step={0.1}
            onCommit={(v) => { if (v !== null && v >= 0) set({ fadeMs: v * 1000 }) }} />
        </label>
        <label>Courbe
          {(activation.pathPoints?.length || activation.startHandle || activation.targetHandle) ? (
            <button
              className="inspector-clear-path"
              title="Supprimer les waypoints et poignées : retour à la ligne droite"
              onClick={() => sidecar.setActivation(cueId, pointId, { pathPoints: null, startHandle: null, targetHandle: null })}
            >
              Tracé droit
            </button>
          ) : null}
          <select value={activation.easing} onChange={(e) => set({ easing: e.target.value })}>
            {EASING_NAMES.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
      </div>
    </div>
  )
}

export default App
