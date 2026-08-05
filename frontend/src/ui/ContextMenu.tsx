// Rendu du menu contextuel — monté UNE SEULE FOIS (App.tsx), pilote par le
// bus module-level `contextMenu.ts`. Se ferme sur clic ailleurs, Échap,
// molette, redimensionnement ou perte de focus de la fenêtre.
import { useEffect, useRef } from 'react'
import { closeContextMenu, useContextMenuState } from './contextMenuStore'

const MENU_MARGIN = 8

export function ContextMenu() {
  const state = useContextMenuState()
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!state) return
    const close = () => closeContextMenu()
    // pointerdown (pas click) : se ferme dès l'appui, avant qu'un éventuel
    // second clic droit ailleurs n'ouvre un nouveau menu par-dessus.
    // FILTRE par cible (fix 2026-08-05, "clic droit pour renommer bloc
    // marche pas") : ce listener est en phase CAPTURE — le stopPropagation
    // du menu (phase bubble) ne l'atteignait jamais, l'appui sur un ITEM
    // fermait donc le menu qui pouvait se démonter avant que le `click` de
    // l'item ne parte. Course perdue systématiquement pour "Renommer"
    // (dialogue jamais ouvert), gagnée par chance pour d'autres items.
    const closeIfOutside = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return
      closeContextMenu()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('pointerdown', closeIfOutside, true)
    window.addEventListener('wheel', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', closeIfOutside, true)
      window.removeEventListener('wheel', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [state])

  if (!state) return null

  // Coller au viewport plutôt que déborder hors écran (clic droit près
  // d'un bord) — mesuré après montage, donc un premier frame peut déborder
  // légèrement ; négligeable visuellement pour un menu de cette taille.
  const el = menuRef.current
  let left = state.x
  let top = state.y
  if (el) {
    const rect = el.getBoundingClientRect()
    left = Math.min(state.x, window.innerWidth - rect.width - MENU_MARGIN)
    top = Math.min(state.y, window.innerHeight - rect.height - MENU_MARGIN)
  }

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left, top }}
      // Un clic gauche à L'INTÉRIEUR du menu ne doit pas se propager au
      // pointerdown global ci-dessus (sinon le menu se fermerait avant que
      // l'item n'ait eu le temps de réagir au clic).
      onPointerDown={(e) => e.stopPropagation()}
    >
      {state.sections.map((section, i) => (
        <div className="context-menu-section" key={i}>
          {i > 0 && <div className="context-menu-sep" />}
          {section.map((item, j) => (
            <button
              key={j}
              className={`context-menu-item${item.danger ? ' danger' : ''}`}
              disabled={item.disabled}
              onClick={() => { closeContextMenu(); item.onClick() }}
            >
              <span className="context-menu-item-check">{item.checked ? '✓' : ''}</span>
              {item.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
