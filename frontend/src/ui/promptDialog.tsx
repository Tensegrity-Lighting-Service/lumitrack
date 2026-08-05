// Dialogue de saisie de texte maison (Mission 3, "dialogues natifs" —
// dernier reliquat des window.prompt, 2026-08-05) : les prompt() natifs de
// la WebView sont laids, non stylables, et hors de la langue de l'app. Même
// pattern que contextMenuStore : un store module-level + UN composant monté
// dans App — n'importe quel code appelle promptText() et attend la promesse
// (null = annulé), sans prop-drilling.
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { t } from '../i18n'

type PromptState = { title: string; initial: string; resolve: (v: string | null) => void } | null

let state: PromptState = null
const listeners = new Set<() => void>()
const emit = () => { for (const fn of listeners) fn() }

export function promptText(title: string, initial = ''): Promise<string | null> {
  return new Promise((resolve) => {
    state?.resolve(null) // un dialogue déjà ouvert est annulé, jamais empilé
    state = { title, initial, resolve }
    emit()
  })
}

export function PromptDialog() {
  const s = useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    () => state,
  )
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (s) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [s])
  if (!s) return null
  const close = (v: string | null) => { s.resolve(v); state = null; emit() }
  const submit = () => {
    const value = inputRef.current?.value.trim() ?? ''
    close(value || null) // vide = comme annuler, jamais un nom vide
  }
  return (
    <div className="prompt-overlay" onClick={() => close(null)}>
      <div className="prompt-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{s.title}</h3>
        <input
          ref={inputRef}
          defaultValue={s.initial}
          onKeyDown={(e) => {
            // Les raccourcis globaux (Espace=lecture, Suppr=supprimer,
            // Échap=désélection) ne doivent JAMAIS réagir pendant la saisie.
            e.stopPropagation()
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') close(null)
          }}
        />
        <div className="prompt-actions">
          <button onClick={() => close(null)}>{t('prompt.cancel')}</button>
          <button className="prompt-ok" onClick={submit}>{t('prompt.ok')}</button>
        </div>
      </div>
    </div>
  )
}
