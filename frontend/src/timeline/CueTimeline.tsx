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
import { flushSync } from 'react-dom'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import type { BlockContextMessage, Cue, Pose, Project } from '../types'
import { sidecar } from '../sidecar'
import { AudioTrack } from './AudioTrack'
import { GraphEditor } from './GraphEditor'
import { BlockAutomation } from './BlockAutomation'
import { maxSpeedMs, msToKmh, speedCategory } from './speed'
import { useT } from '../i18n'
import { showContextMenu } from '../ui/contextMenuStore'
import { pickColor } from '../ui/colorPicker'
import { NumericInput } from '../ui/NumericInput'
import { chooseTickStep, computeTicks } from './ticks'
import { setTimelineView } from './timelineView'
import {
  canSplitAtPlayhead, copyCueToClipboard, copyTimingToOtherActors, duplicateCue,
  hasCueClipboard, pasteCueFromClipboard, splitCueAtPlayhead,
} from './blockOps'

// Exportées : le panneau détail du bloc (BlockDetailPanel.tsx) partage ces
// mêmes hauteurs pour rester visuellement aligné (même règle, même piste
// audio) — mission "panneau détail du bloc synchronisé", 2026-08-03.
export const RULER_H = 26
export const AUDIO_H = 52
export const LANE_H = 36
const GRAPH_H = 190
const MIN_CUE_MS = 100
const SNAP_PX = 8
const SEEK_THROTTLE_MS = 33
// "Zoom par défaut trop petit à l'ouverture" (DIRECTIVES.md point 9) : le
// premier cadrage ajuste toute la durée du projet dans la fenêtre — pour un
// projet long, ça rendait les blocs minuscules/injouables au clic. Plancher
// relevé de 0.001 (~16 min/1000px) à 0.02 (~1s/20px, blocs de quelques
// secondes restent cliquables) MÊME en mode "ajuster" — un projet très long
// devient alors scrollable plutôt que microscopique, compromis assumé
// explicitement par la directive plutôt que de garder "tout visible, mais
// illisible".
const MIN_PX_PER_MS = 0.02
const MAX_PX_PER_MS = 2 // 0.5 s par 1000 px
const CONTENT_PAD_PX = 160

const CUE_PALETTE = ['#4F6DF5', '#F5734F', '#B06FE0', '#4FF58C', '#4FF5E0', '#F5C84F']


// Graduations : extraites dans ./ticks.ts (mission "panneau détail du bloc
// synchronisé", 2026-08-03) pour que le panneau détail du bloc partage
// EXACTEMENT le même calcul.

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

export function CueTimeline({ project, tMs, playing, durationMs, connected, selectedCueId, selectedPointId, onSelectCue, blockContext, positions, onOpenBlockDetail }: {
  project: Project
  tMs: number
  playing: boolean
  durationMs: number
  connected: boolean
  selectedCueId: string | null
  selectedPointId: string | null
  onSelectCue: (cueId: string | null) => void
  /** Contexte du bloc sélectionné (départ/cible résolus) — pilote le badge
   * de vitesse affiché directement sur le bloc, pas seulement dans
   * l'inspecteur ("la vitesse peut pas s'afficher dans le bloc même ?"). */
  blockContext: BlockContextMessage | null
  /** Positions RÉSOLUES par le backend (tick, même source que la scène) —
   * jamais recalculées ici : "diviser au playhead" fige exactement ce qui
   * est déjà affiché, pas une approximation frontend (§13.1.7). */
  positions: Record<string, Pose>
  /** Ouvre le panneau détail du bloc (menu contextuel) — le bloc visé est
   * déjà sélectionné par `onSelectCue` avant l'appel. */
  onOpenBlockDetail: () => void
}) {
  const t = useT()
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

  // ---- Sélection de plage temporelle (DIRECTIVES.md point 9) ----
  // Glisser sur la règle/le vide, PAS un bloc — "reprend une plage
  // sélectionnée" pour "nouveau bloc ici" (menu contextuel, point 8) et
  // sert d'ancrage pour "zoom sur la sélection".
  const [rangeSelection, setRangeSelection] = useState<{ startMs: number; endMs: number } | null>(null)
  const [rangeDragPreview, setRangeDragPreview] = useState<{ clientX: number; clientY: number; startMs: number; endMs: number } | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setRangeSelection(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // Le temps d'un geste de zoom, les blocs/playhead doivent suivre pxPerMs
  // AU PIXEL PRÈS, comme la règle/le waveform (aucune transition) — sinon
  // leurs transitions CSS respectives (`.cue-block` lissage d'écho backend,
  // `.tl-playhead` lissage entre ticks 30 Hz, toutes deux pensées pour un
  // AUTRE contexte) chassent une cible qui bouge à chaque frame de
  // l'animation de zoom et donnent un mouvement amplifié/qui déborde par
  // rapport au reste (signalé 2026-07-31 : "les blocs et la playhead sont
  // exagérés par rapport au reste").
  const [zooming, setZooming] = useState(false)

  const effPxPerMs = pxPerMs ?? 0.05

  // Miroir en lecture seule pour BlockDetailPanel (mission "panneau détail
  // du bloc synchronisé", 2026-08-03) — CueTimeline reste seul propriétaire
  // du scroll/zoom réel, ce useEffect ne fait que publier.
  useEffect(() => {
    setTimelineView({ pxPerMs: effPxPerMs, scrollLeft })
  }, [effPxPerMs, scrollLeft])

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

  // Zoom LISSÉ (« apple style », 2026-07-29) : chaque cran de molette
  // pousse une CIBLE de zoom ; une boucle rAF fait converger le zoom réel
  // par approche exponentielle (~1/4 de l'écart par frame) en maintenant
  // l'instant sous le curseur immobile À CHAQUE frame — fluide, ancré au
  // pointeur, et les crans successifs s'enchaînent sans à-coup.
  const zoomAnimRef = useRef<{ target: number; anchorT: number; offsetX: number; raf: number } | null>(null)
  const pxPerMsRef = useRef(effPxPerMs)
  pxPerMsRef.current = effPxPerMs

  const zoomAt = useCallback((factor: number, clientX?: number) => {
    const el = scrollRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const offsetX = clientX !== undefined ? clientX - rect.left : el.clientWidth / 2
    const cur = pxPerMsRef.current
    const anim = zoomAnimRef.current
    const base = anim ? anim.target : cur
    const target = Math.min(MAX_PX_PER_MS, Math.max(MIN_PX_PER_MS, base * factor))
    const anchorT = (el.scrollLeft + offsetX) / cur

    if (anim) {
      anim.target = target
      anim.anchorT = anchorT
      anim.offsetX = offsetX
      return
    }
    const state = { target, anchorT, offsetX, raf: 0 }
    zoomAnimRef.current = state
    setZooming(true)
    const step = () => {
      const current = pxPerMsRef.current
      const remaining = state.target / current
      // Convergence : ~25 % de l'écart logarithmique par frame.
      const next = Math.abs(Math.log(remaining)) < 0.01
        ? state.target
        : current * Math.exp(Math.log(remaining) * 0.25)
      // Commit ATOMIQUE : sans flushSync, React re-rend les blocs en
      // asynchrone alors que scrollLeft part tout de suite au DOM — le
      // navigateur peignait une frame avec le nouveau scroll mais les
      // anciennes positions de blocs ("les blocs vibrent en partant loin
      // avant de revenir"). flushSync force le re-layout des blocs AVANT
      // de poser scrollLeft : les deux arrivent dans la même peinture.
      //
      // `setScrollLeft` DANS le même flush : la fenêtre de graduations
      // (règle + grille temporelle) est calculée depuis cet état — en le
      // laissant au scroll-event (asynchrone, frame suivante), la grille
      // était générée avec l'ANCIEN scroll et le NOUVEAU zoom pendant
      // toute l'animation → règle/grille désynchronisées des blocs.
      //
      // `el.scrollLeft` posé AVANT le flushSync, pas après (résiduel
      // trouvé le 2026-07-31 : « le zoom timeline est toujours
      // asynchrone ») : AudioTrack lit `scroller.scrollLeft` en DIRECT
      // depuis le DOM (pas l'état React) dans un useLayoutEffect qui se
      // redéclenche PENDANT ce même flushSync (pxPerMs a changé). Poser
      // scrollLeft après le flush le laissait lire l'ANCIENNE position à
      // chaque frame de l'animation → les tuiles de waveform visibles
      // restaient calculées pour la fenêtre précédente jusqu'à ce que
      // l'event 'scroll' natif (asynchrone) rattrape, un vrai retard
      // pendant toute la durée du zoom lissé. L'écriture DOM d'une
      // propriété comme scrollLeft est synchrone (contrairement à
      // l'event 'scroll' qu'elle déclenche) : la faire précéder le
      // flushSync garantit que tout ce qui se relit pendant le re-rendu
      // voit déjà la valeur à jour.
      const nsl = Math.max(0, state.anchorT * next - state.offsetX)
      el.scrollLeft = nsl
      flushSync(() => {
        setPxPerMs(next)
        setScrollLeft(nsl)
      })
      if (next !== state.target) {
        state.raf = requestAnimationFrame(step)
      } else {
        zoomAnimRef.current = null
        setZooming(false)
      }
    }
    state.raf = requestAnimationFrame(step)
  }, [])

  // Molette seule = zoom au curseur (geste standard DAW : Logic/Ableton/
  // Premiere zooment direct à la molette, pas besoin de modificateur) ;
  // Maj+molette = défilement horizontal (2026-07-31, remplace l'ancienne
  // convention Ctrl+molette=zoom / molette seule=scroll, jugée moins
  // naturelle). Listener non-passif obligatoire pour empêcher le
  // scroll/zoom natif du navigateur.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.shiftKey) {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
        if (d !== 0) {
          e.preventDefault()
          el.scrollLeft += d
        }
      } else {
        e.preventDefault()
        zoomAt(e.deltaY < 0 ? 1.25 : 0.8, e.clientX)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  // Clic molette + glisser = panoramique horizontal façon surface tactile :
  // le contenu suit le curseur au pixel près (1:1, aucune accélération), et
  // preventDefault() sur le pointerdown coupe court à l'auto-scroll natif du
  // navigateur (icône à 4 flèches + vitesse proportionnelle à la distance
  // au clic) qui s'active sinon sur tout conteneur scrollable — c'est cet
  // auto-scroll natif, pas notre code, qui donnait la sensation "pourrie"
  // signalée le 2026-07-31.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let lastX = 0
    const onMove = (e: PointerEvent) => {
      el.scrollLeft -= e.clientX - lastX
      lastX = e.clientX
    }
    const onUp = (e: PointerEvent) => {
      el.releasePointerCapture(e.pointerId)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.style.cursor = ''
    }
    const onDown = (e: PointerEvent) => {
      if (e.button !== 1) return
      e.preventDefault()
      lastX = e.clientX
      el.setPointerCapture(e.pointerId)
      el.style.cursor = 'grabbing'
      el.addEventListener('pointermove', onMove)
      el.addEventListener('pointerup', onUp)
    }
    el.addEventListener('pointerdown', onDown)
    // auxclick : filet de sécurité si un navigateur déclenche quand même
    // son geste d'auto-scroll natif malgré le preventDefault ci-dessus.
    const onAuxClick = (e: MouseEvent) => { if (e.button === 1) e.preventDefault() }
    el.addEventListener('auxclick', onAuxClick)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('auxclick', onAuxClick)
    }
  }, [])

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
  const ticks = useMemo(
    () => computeTicks(effPxPerMs, scrollLeft, viewportWidth),
    [effPxPerMs, scrollLeft, viewportWidth],
  )

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
    // Seul le clic gauche sélectionne/déplace un bloc — le clic milieu
    // (panoramique tactile) au-dessus d'un bloc ne doit ni le sélectionner
    // ni le faire bouger (signalé 2026-07-31).
    if (e.button !== 0) return
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
    const name = window.prompt(t('timeline.renameCuePrompt'), cue.name)
    if (name && name !== cue.name) sidecar.updateCue(cue.id, { name })
  }, [t])

  // ---- Menu contextuel (clic droit, DIRECTIVES.md point 8) ----
  const handleBlockContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>, cue: Cue) => {
    onSelectCue(cue.id)
    const anchorActivated = selectedPointId !== null && !!cue.activations[selectedPointId]
    const otherActivatedCount = Object.keys(cue.activations).length - (anchorActivated ? 1 : 0)
    showContextMenu(e, [
      [
        { label: t('contextMenu.rename'), onClick: () => renameCue(cue) },
        { label: t('cue.openBlockDetail'), onClick: onOpenBlockDetail },
        { label: t('contextMenu.duplicate'), onClick: () => duplicateCue(cue) },
        { label: t('contextMenu.copy'), onClick: () => copyCueToClipboard(cue) },
      ],
      [
        { label: t('contextMenu.color'), onClick: () => pickColor(cue.color, (hex) => sidecar.updateCue(cue.id, { color: hex })) },
        {
          label: cue.autoDuration ? t('contextMenu.autoDurationOff') : t('contextMenu.autoDurationOn'),
          onClick: () => sidecar.updateCue(cue.id, { autoDuration: !cue.autoDuration }),
        },
        {
          label: t('contextMenu.copyTimingToOthers'),
          disabled: !anchorActivated || otherActivatedCount === 0,
          onClick: () => { if (selectedPointId) copyTimingToOtherActors(cue, selectedPointId) },
        },
      ],
      [
        {
          label: t('contextMenu.splitAtPlayhead'),
          disabled: !canSplitAtPlayhead(cue, tMs),
          onClick: () => {
            const secondId = splitCueAtPlayhead(cue, tMs, positions)
            if (secondId) onSelectCue(secondId)
          },
        },
      ],
      [
        { label: t('contextMenu.delete'), danger: true, onClick: () => { sidecar.deleteCue(cue.id); onSelectCue(null) } },
      ],
    ])
  }, [onOpenBlockDetail, onSelectCue, renameCue, selectedPointId, t, tMs, positions])

  // Glisser sur la règle/le vide (PAS un bloc) pour sélectionner une plage
  // temporelle — bouton gauche uniquement, seuil de 3px avant de compter
  // comme un vrai glisser (sinon un simple clic créerait une plage nulle).
  // `onPlainClick` couvre le cas "pas de mouvement" (ex. la désélection du
  // clic sur le fond des pistes, comportement historique préservé).
  const beginRangeSelect = useCallback((e: React.PointerEvent<HTMLElement>, onPlainClick?: () => void) => {
    if (e.button !== 0) return
    const scrollEl = scrollRef.current
    if (!scrollEl) return
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const rect = scrollEl.getBoundingClientRect()
    const toMs = (clientX: number) => Math.max(0, (scrollEl.scrollLeft + clientX - rect.left) / effPxPerMs)
    const originMs = toMs(e.clientX)
    const startClientX = e.clientX
    let moved = false
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startClientX) > 3) moved = true
      if (!moved) return
      const ms = toMs(ev.clientX)
      setRangeDragPreview({
        clientX: ev.clientX, clientY: ev.clientY,
        startMs: Math.min(originMs, ms), endMs: Math.max(originMs, ms),
      })
    }
    const onUp = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      setRangeDragPreview(null)
      if (!moved) { onPlainClick?.(); return }
      const ms = toMs(ev.clientX)
      const startMs = Math.min(originMs, ms)
      const endMs = Math.max(originMs, ms)
      if (endMs - startMs > 20) setRangeSelection({ startMs, endMs })
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
  }, [effPxPerMs])

  const handleLanesContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Laissé au bloc lui-même (son propre onContextMenu, avec sa propre
    // stopPropagation) si le clic droit tombe dessus.
    if (e.target !== e.currentTarget) return
    const scrollEl = scrollRef.current
    if (!scrollEl) return
    const contentX = e.clientX - scrollEl.getBoundingClientRect().left + scrollEl.scrollLeft
    const ms = snap(Math.max(0, contentX / effPxPerMs), '', false)
    const rect = e.currentTarget.getBoundingClientRect()
    const lane = Math.max(0, Math.floor((e.clientY - rect.top) / LANE_H))
    // "Reprend une plage sélectionnée si il y en a une" (DIRECTIVES.md
    // point 8/9) : le nouveau bloc utilise la plage active plutôt que le
    // point de clic quand une sélection temporelle existe.
    const newBlockStartMs = rangeSelection ? rangeSelection.startMs : ms
    const newBlockDurationMs = rangeSelection ? rangeSelection.endMs - rangeSelection.startMs : 2000
    showContextMenu(e, [
      [
        {
          label: t('contextMenu.newBlockHere'),
          onClick: () => {
            const color = CUE_PALETTE[cues.length % CUE_PALETTE.length]
            sidecar.addCue('Cue', newBlockStartMs, newBlockDurationMs, color, lane)
          },
        },
        {
          label: t('contextMenu.pasteBlock'),
          disabled: !hasCueClipboard(),
          onClick: () => pasteCueFromClipboard(ms, lane),
        },
      ],
    ])
  }, [cues.length, effPxPerMs, rangeSelection, snap, t])

  const handleRulerContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    showContextMenu(e, [
      [
        { label: t('contextMenu.goToStart'), onClick: () => sidecar.seek(0) },
        { label: t('contextMenu.goToEnd'), onClick: () => sidecar.seek(durationMs) },
      ],
    ])
  }, [durationMs, t])

  const handleAudioContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    showContextMenu(e, [
      [
        {
          label: t('contextMenu.importAudio'),
          onClick: async () => {
            const path = await openDialog({
              title: t('menu.file.importAudioDialogTitle'),
              filters: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac'] }],
            })
            if (typeof path === 'string') sidecar.setAudio({ path })
          },
        },
        { label: t('contextMenu.removeAudio'), onClick: () => sidecar.setAudio({ path: null }) },
      ],
    ])
  }, [t])

  const lanesHeight = laneCount * LANE_H
  const playheadPx = tMs * effPxPerMs

  return (
    <div className="tl">
      <div className="tl-toolbar">
        {/* Transport : déplacé de l'ancienne barre du haut (supprimée) —
            près de la timeline, sous le roster, comme demandé. Le scrub
            redondant a disparu : la règle fait déjà le seek. */}
        <span className={`conn-dot ${connected ? 'conn-ok' : 'conn-bad'}`} title={connected ? t('timeline.sidecarConnected') : t('timeline.sidecarDisconnected')} />
        <button
          className="tl-goto-start"
          title={t('timeline.gotoStart')}
          onClick={() => sidecar.seek(0)}
        >
          ⏮
        </button>
        <button
          className="tl-play"
          title={playing ? t('timeline.pause') : t('timeline.play')}
          onClick={() => (playing ? sidecar.pause() : sidecar.play())}
        >
          {playing ? '⏸' : '⏵'}
        </button>
        <span className="tl-timecode">{formatTimecodeMs(tMs)}</span>
        <span className="tl-toolbar-sep" />
        <button onClick={addCue}>{t('timeline.addCue')}</button>
        {selectedCueId && <button onClick={deleteSelected}>{t('timeline.deleteCue')}</button>}
        {selectedCueId && (
          <button
            className={showGraph ? 'tl-btn-active' : ''}
            title={t('timeline.curveEditorHint')}
            onClick={() => setShowGraph((v) => !v)}
          >
            {t('timeline.curves')}
          </button>
        )}
        <span className="tl-toolbar-spacer" />
        <button title={t('timeline.zoomOutHint')} onClick={() => zoomAt(0.8)}>−</button>
        <button title={t('timeline.zoomInHint')} onClick={() => zoomAt(1.25)}>+</button>
        <button title={t('timeline.fit')} onClick={fit}>{t('timeline.fitBtn')}</button>
      </div>
      <div className="tl-main">
        <div className="tl-headers">
          <div className="tl-header-spacer" style={{ height: RULER_H }} />
          {project.audioPath && (
            <div className="tl-header tl-header-audio" style={{ height: AUDIO_H }}>
              <span className="tl-header-chip" style={{ background: '#4f6df5' }} />
              {t('timeline.audio')}
            </div>
          )}
          {Array.from({ length: laneCount }, (_, i) => (
            <div key={i} className="tl-header tl-header-lane" style={{ height: LANE_H }}>
              <span className="tl-header-chip" style={{ background: i === 0 ? '#f5734f' : '#3a3f4a' }} />
              {t('timeline.track', { n: i + 1 })}
            </div>
          ))}
          {graphVisible && (
            <div className="tl-header tl-header-graph" style={{ height: GRAPH_H }}>
              <span className="tl-header-chip" style={{ background: '#4ff5e0' }} />
              {t('timeline.curves')}
            </div>
          )}
        </div>
        <div
          className="tl-scroll"
          ref={scrollRef}
          onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
        >
          <div className="tl-content" style={{ width: contentWidth }}>
            <div
              className="tl-ruler"
              style={{ height: RULER_H }}
              onPointerDown={(e) => {
                // Maj-glisser sur la règle = sélection de plage (garde le
                // glisser normal = scrub, un geste déjà bien ancré).
                if (e.shiftKey) beginRangeSelect(e)
                else onRulerPointerDown(e)
              }}
              onContextMenu={handleRulerContextMenu}
            >
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

            {rangeSelection && (
              <div
                className="tl-range-overlay"
                style={{
                  left: rangeSelection.startMs * effPxPerMs,
                  width: Math.max(1, (rangeSelection.endMs - rangeSelection.startMs) * effPxPerMs),
                }}
              >
                <div className="tl-range-popover" onPointerDown={(e) => e.stopPropagation()}>
                  <label>{t('timeline.rangeStart')}
                    <NumericInput value={rangeSelection.startMs / 1000} step={0.1}
                      onCommit={(v) => { if (v !== null && v * 1000 < rangeSelection.endMs) setRangeSelection({ ...rangeSelection, startMs: Math.max(0, v * 1000) }) }} />
                  </label>
                  <label>{t('timeline.rangeEnd')}
                    <NumericInput value={rangeSelection.endMs / 1000} step={0.1}
                      onCommit={(v) => { if (v !== null && v * 1000 > rangeSelection.startMs) setRangeSelection({ ...rangeSelection, endMs: v * 1000 }) }} />
                  </label>
                  <label>{t('timeline.rangeDuration')}
                    <NumericInput value={(rangeSelection.endMs - rangeSelection.startMs) / 1000} step={0.1}
                      onCommit={(v) => { if (v !== null && v > 0) setRangeSelection({ ...rangeSelection, endMs: rangeSelection.startMs + v * 1000 }) }} />
                  </label>
                  <button
                    title={t('timeline.rangeZoomHint')}
                    onClick={() => {
                      const el = scrollRef.current
                      if (!el) return
                      const span = Math.max(1, rangeSelection.endMs - rangeSelection.startMs)
                      const px = Math.min(MAX_PX_PER_MS, Math.max(MIN_PX_PER_MS, (el.clientWidth - 60) / span))
                      setPxPerMs(px)
                      el.scrollLeft = Math.max(0, rangeSelection.startMs * px - 30)
                    }}
                  >🔍</button>
                  <button title={t('timeline.rangeClear')} onClick={() => setRangeSelection(null)}>✕</button>
                </div>
              </div>
            )}
            {rangeDragPreview && (
              <div
                className="tl-range-tooltip"
                style={{ left: rangeDragPreview.clientX + 12, top: rangeDragPreview.clientY - 30 }}
              >
                {formatTimecodeMs(rangeDragPreview.startMs)} → {formatTimecodeMs(rangeDragPreview.endMs)}
                {' '}({((rangeDragPreview.endMs - rangeDragPreview.startMs) / 1000).toFixed(2)}s)
              </div>
            )}

            {project.audioPath && (
              <div className="tl-track-audio" style={{ height: AUDIO_H }} onContextMenu={handleAudioContextMenu}>
                <AudioTrack
                  audioPath={project.audioPath}
                  knownDurationS={project.audioDurationS}
                  tMs={tMs}
                  playing={playing}
                  pxPerMs={effPxPerMs}
                  scrollElRef={scrollRef}
                  height={AUDIO_H}
                />
              </div>
            )}

            <div
              className="tl-lanes"
              style={{ height: lanesHeight }}
              onPointerDown={(e) => {
                // Glisser = sélection de plage temporelle ; simple clic
                // (pas de mouvement, pas sur un bloc) = désélection, comme
                // avant.
                if (e.target !== e.currentTarget) return
                beginRangeSelect(e, () => { onSelectCue(null); setRangeSelection(null) })
              }}
              onContextMenu={handleLanesContextMenu}
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
                const speed = cue.id === selectedCueId ? maxSpeedMs(cue, blockContext) : null
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
                      transition: zooming ? 'none' : undefined,
                    } as React.CSSProperties}
                    onPointerDown={(e) => beginBlockDrag(e, cue, 'move')}
                    onDoubleClick={() => { onSelectCue(cue.id); onOpenBlockDetail() }}
                    onContextMenu={(e) => handleBlockContextMenu(e, cue)}
                  >
                    <div className="cue-block-header">
                      <span className="cue-block-name">{cue.name}</span>
                      {speed !== null && (() => {
                        const [key, color] = speedCategory(speed)
                        const kmh = msToKmh(speed)
                        return (
                          <span className="tl-block-speed" style={{ '--speed-color': color } as React.CSSProperties}
                            title={t('cue.speedHint', { kmh: kmh.toFixed(1), label: t(`speed.${key}`) })}>
                            {kmh.toFixed(0)} km/h
                          </span>
                        )
                      })()}
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

            <div className="tl-playhead" style={{ left: playheadPx, transition: zooming ? 'none' : undefined }} />
          </div>
        </div>
      </div>
    </div>
  )
}
