// Sélecteur de direction à 8 points cardinaux — préréglages rapides pour un
// angle "Fixe" (mission "modes d'orientation", 2026-08-04). Mapping VÉRIFIÉ
// en direct le 2026-08-05 (retour de Florian "quart de tour pas bon") :
// le lacet backend = atan2(dy, dx) dans le repère scène, x → droite mais
// y → BAS d'écran (origine en haut à gauche) — donc 0° = Est, 90° = SUD
// (pas nord : l'axe y est inversé par rapport à la convention math
// habituelle), 270° = Nord. Les libellés N/S de ce widget désignent le
// haut/bas de l'ÉCRAN en vue du dessus.
import { useT } from '../i18n'

const DIRECTIONS: Array<{ deg: number; label: string; area: string }> = [
  { deg: 225, label: 'NW', area: 'nw' },
  { deg: 270, label: 'N', area: 'n' },
  { deg: 315, label: 'NE', area: 'ne' },
  { deg: 180, label: 'W', area: 'w' },
  { deg: 0, label: 'E', area: 'e' },
  { deg: 135, label: 'SW', area: 'sw' },
  { deg: 90, label: 'S', area: 's' },
  { deg: 45, label: 'SE', area: 'se' },
]

export function CompassPicker({ valueDeg, onPick }: { valueDeg: number; onPick: (deg: number) => void }) {
  const t = useT()
  const norm = ((valueDeg % 360) + 360) % 360
  return (
    <div className="compass-picker" title={t('cue.compassHint')}>
      {DIRECTIONS.map(({ deg, label, area }) => (
        <button
          key={label}
          type="button"
          className={`compass-btn compass-${area}${Math.abs(norm - deg) < 1e-6 ? ' active' : ''}`}
          onClick={() => onPick(deg)}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
