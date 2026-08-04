// Liste déroulante d'un point de focus (mission "modes d'orientation",
// 2026-08-04) — utilisée aussi bien par l'ActivationCard (par activation)
// que par la section "orientation par défaut du bloc" du CueInspector.
import type { Point } from '../types'
import { useT } from '../i18n'

export function FocusPointSelect({ points, value, onChange }: {
  points: Point[]
  value: string | null
  onChange: (id: string | null) => void
}) {
  const t = useT()
  const focusPoints = points.filter((p) => p.isFocusPoint)
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{t('cue.focusPointNone')}</option>
      {focusPoints.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  )
}
