// Numeric field safe against backend echoes (DIRECTIVES.md mission 2,
// constat n°1 de l'inspection du 2026-07-28) : taper "5000" donnait "50"
// puis "10100", parce que chaque frappe partait en `set_activation`, dont
// l'écho `project` réécrivait l'input contrôlé en pleine saisie.
//
// Principe : tant que le champ a le focus, le brouillon appartient à
// l'utilisateur — la valeur poussée par le sidecar ne réécrit JAMAIS un
// champ en cours d'édition. Le commit n'a lieu que sur Entrée ou blur ;
// Échap annule et restaure la valeur serveur ; flèches Haut/Bas incrémentent
// de `step` (Maj = ×10) et committent immédiatement (nudge façon After
// Effects). Un brouillon vide committe `null` quand `nullable` — c'est ce
// qui permet de "détoucher" un axe (il repasse en tracking, §12.1).
import { useRef, useState } from 'react'

function formatNum(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return ''
  // 1 décimale max, sans zéros traînants : les valeurs résolues par le
  // backend peuvent être des flottants longs (drag interpolé).
  return String(Math.round(v * 10) / 10)
}

export function NumericInput({ value, onCommit, step = 1, nullable = false, placeholder = '—', className, title }: {
  value: number | null
  onCommit: (v: number | null) => void
  /** Increment for ArrowUp/ArrowDown (Shift multiplies by 10). */
  step?: number
  /** Allow an empty draft to commit null ("axe non touché", tracking). */
  nullable?: boolean
  placeholder?: string
  className?: string
  title?: string
}) {
  // null = not editing (display the server value). The ref mirrors the
  // state so commit() always reads the latest draft even when Enter's
  // commit and the subsequent blur-commit run in the same tick.
  const [draft, setDraftState] = useState<string | null>(null)
  const draftRef = useRef<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const setDraft = (v: string | null) => {
    draftRef.current = v
    setDraftState(v)
  }

  const commit = () => {
    const current = draftRef.current
    if (current === null) return // already committed or cancelled
    setDraft(null)
    // Focus puis blur sans modification ne doit rien envoyer — sinon le
    // simple passage dans un champ arrondirait la valeur serveur (l'écran
    // affiche 1 décimale, le modèle peut en porter plus).
    if (current === formatNum(value)) return
    const trimmed = current.trim().replace(',', '.') // clavier FR : virgule décimale
    if (trimmed === '') {
      if (nullable && value !== null) onCommit(null)
      return
    }
    const parsed = Number(trimmed)
    if (Number.isFinite(parsed) && parsed !== value) onCommit(parsed)
  }

  const nudge = (dir: 1 | -1, big: boolean) => {
    const current = draftRef.current
    const base = current !== null && current.trim() !== ''
      ? Number(current.trim().replace(',', '.'))
      : value
    const from = base !== null && Number.isFinite(base) ? base : 0
    setDraft(null)
    onCommit(from + dir * step * (big ? 10 : 1))
  }

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="decimal"
      className={className}
      title={title}
      placeholder={placeholder}
      value={draft !== null ? draft : formatNum(value)}
      onFocus={() => setDraft(formatNum(value))}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit()
          inputRef.current?.blur()
        } else if (e.key === 'Escape') {
          setDraft(null) // abandon du brouillon → blur ne committera rien
          inputRef.current?.blur()
          e.stopPropagation() // ne pas désélectionner le bloc (raccourci global)
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          nudge(1, e.shiftKey)
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          nudge(-1, e.shiftKey)
        }
      }}
    />
  )
}
