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
  // Les acteurs marqués "servir de point de focus" (une chanteuse que les
  // autres visent, 2026-08-06) sont visables au même titre que les vrais
  // repères — la résolution vise par id, peu importe le type de point.
  const focusPoints = points.filter((p) => p.isFocusPoint || p.isFocusTarget)
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{t('cue.focusPointNone')}</option>
      {focusPoints.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  )
}
