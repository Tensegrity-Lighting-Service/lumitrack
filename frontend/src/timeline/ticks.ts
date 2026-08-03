// Graduations de règle temporelle — extrait de CueTimeline.tsx (mission
// "panneau détail du bloc synchronisé", 2026-08-03) pour que le panneau
// détail du bloc produise EXACTEMENT les mêmes graduations que la vraie
// timeline (même pas, mêmes libellés) plutôt que de dupliquer/diverger.
export interface Tick {
  ms: number
  label: string | null
}

// Pas de graduation adaptatif : le plus petit pas qui laisse >= ~80 px
// entre deux labels. Les sous-graduations (step/5) apparaissent dès 12 px.
const TICK_STEPS_MS = [
  50, 100, 250, 500,
  1000, 2000, 5000, 10_000, 15_000, 30_000,
  60_000, 120_000, 300_000, 600_000,
]

export function chooseTickStep(pxPerMs: number): number {
  for (const step of TICK_STEPS_MS) {
    if (step * pxPerMs >= 80) return step
  }
  return TICK_STEPS_MS[TICK_STEPS_MS.length - 1]
}

export function formatTick(ms: number, stepMs: number): string {
  const totalS = ms / 1000
  const h = Math.floor(totalS / 3600)
  const m = Math.floor((totalS % 3600) / 60)
  const s = Math.floor(totalS % 60)
  const pad = (n: number) => n.toString().padStart(2, '0')
  const base = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
  if (stepMs < 1000) {
    const millis = Math.round(ms % 1000)
    return `${base}.${millis.toString().padStart(3, '0')}`
  }
  return base
}

/** Graduations visibles dans `[scrollLeft, scrollLeft + viewportWidth]`
 * (repère contenu, px) à ce niveau de zoom. */
export function computeTicks(pxPerMs: number, scrollLeft: number, viewportWidth: number): Tick[] {
  const step = chooseTickStep(pxPerMs)
  const minor = step / 5
  const showMinor = minor * pxPerMs >= 12
  const t0 = Math.max(0, Math.floor(scrollLeft / pxPerMs / step - 1) * step)
  const t1 = (scrollLeft + viewportWidth) / pxPerMs + step
  const out: Tick[] = []
  for (let t = t0; t <= t1; t += showMinor ? minor : step) {
    const isMajor = Math.round(t) % step === 0
    out.push({ ms: t, label: isMajor ? formatTick(t, step) : null })
  }
  return out
}
