// Gestes de navigation partagés timeline principale + panneau détail
// (2026-08-07, "la sensibilité de la souris au scroll est trop sensible").
//
// Le zoom molette appliquait ×1.25 par ÉVÉNEMENT, quelle que soit son
// amplitude : parfait pour une molette crantée (1 événement par cran),
// fulgurant pour un trackpad ou une molette libre (dizaines de
// micro-événements par seconde). Ici le facteur est CONTINU, proportionnel
// au delta normalisé — un cran de souris classique (±100 px) garde
// exactement son ×1.25 historique, un micro-événement de trackpad ne
// zoome que d'un poil.
//
// Routage trackpad : pincement (le navigateur l'émet en wheel+ctrlKey) =
// zoom ; balayage deux doigts horizontal (deltaX dominant) = panoramique
// sans modificateur ; vertical = zoom (convention du soft) ; Shift =
// panoramique (inchangé). Écran tactile : DEUX doigts = panoramique +
// pincement combinés (attachTouchPinch) ; un doigt garde les
// interactions normales (drag de bloc, scrub de règle).

/** Facteur d'un cran de molette classique — la sensation historique. */
export const NOTCH_ZOOM = 1.25

/** deltaY normalisé en pixels (deltaMode 1 = lignes, 2 = pages). */
function wheelDeltaPx(e: WheelEvent): number {
  if (e.deltaMode === 1) return e.deltaY * 33
  if (e.deltaMode === 2) return e.deltaY * 120
  return e.deltaY
}

/** Facteur de zoom continu : exp(-delta·k), calibré pour qu'un cran de
 * souris (±100 px) donne ×1.25 / ×0.8. Le pincement trackpad (ctrlKey)
 * reçoit un gain plus fort pour une sensation directe. */
export function wheelZoomFactor(e: WheelEvent): number {
  const px = wheelDeltaPx(e)
  const k = e.ctrlKey ? 0.008 : Math.log(NOTCH_ZOOM) / 100
  return Math.exp(-px * k)
}

export type WheelIntent =
  | { kind: 'pan'; deltaPx: number }
  | { kind: 'zoom'; factor: number }

/** Classe un événement wheel en intention : panoramique ou zoom. Retourne
 * null si l'événement ne porte aucun delta utile (ne pas preventDefault). */
export function classifyWheel(e: WheelEvent): WheelIntent | null {
  if (e.ctrlKey) return { kind: 'zoom', factor: wheelZoomFactor(e) }
  const ax = Math.abs(e.deltaX)
  const ay = Math.abs(e.deltaY)
  if (e.shiftKey || ax > ay) {
    const d = ax > ay ? e.deltaX : e.deltaY
    return d !== 0 ? { kind: 'pan', deltaPx: d } : null
  }
  return e.deltaY !== 0 ? { kind: 'zoom', factor: wheelZoomFactor(e) } : null
}

/** Pincement/panoramique tactile à DEUX doigts sur `el` (un doigt =
 * interactions normales). Nécessite `touch-action: none` sur l'élément
 * pour que le navigateur ne confisque pas le geste. Retourne le dispose. */
export function attachTouchPinch(
  el: HTMLElement,
  apply: (g: { panDeltaPx: number; zoomFactor: number; centerX: number }) => void,
): () => void {
  const touches = new Map<number, { x: number; y: number }>()
  let last: { dist: number; centerX: number } | null = null
  const refresh = () => {
    if (touches.size === 2) {
      const [a, b] = [...touches.values()]
      last = { dist: Math.hypot(b.x - a.x, b.y - a.y), centerX: (a.x + b.x) / 2 }
    } else {
      last = null
    }
  }
  const onDown = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
    refresh()
  }
  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (touches.size !== 2 || !last) return
    const [a, b] = [...touches.values()]
    const dist = Math.hypot(b.x - a.x, b.y - a.y)
    const centerX = (a.x + b.x) / 2
    // Garde anti-jitter : le ratio de pincement n'a de sens qu'avec un
    // écartement franc (>30 px), sinon la division explose.
    const zoomFactor = last.dist > 30 && dist > 30 ? dist / last.dist : 1
    apply({ panDeltaPx: last.centerX - centerX, zoomFactor, centerX })
    last = { dist, centerX }
  }
  const onUp = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return
    touches.delete(e.pointerId)
    refresh()
  }
  el.addEventListener('pointerdown', onDown, { capture: true })
  window.addEventListener('pointermove', onMove, { capture: true })
  window.addEventListener('pointerup', onUp, { capture: true })
  window.addEventListener('pointercancel', onUp, { capture: true })
  return () => {
    el.removeEventListener('pointerdown', onDown, { capture: true })
    window.removeEventListener('pointermove', onMove, { capture: true })
    window.removeEventListener('pointerup', onUp, { capture: true })
    window.removeEventListener('pointercancel', onUp, { capture: true })
  }
}
