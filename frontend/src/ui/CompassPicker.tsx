// Sélecteur de direction à 8 points cardinaux — préréglages rapides pour un
// angle "Fixe" (mission "modes d'orientation", 2026-08-04). Mapping degré <->
// direction : convention mathématique standard (0°=Est, 90°=Nord), cohérente
// avec atan2(dy,dx) déjà utilisé partout ailleurs dans la résolution/scène
// (voir Scene.tsx::SelectionTransform). Signalé au plan : quel coin de
// l'écran correspond réellement à "Nord" doit être confirmé en direct dans
// l'app (placer un point de focus au nord d'un acteur, lire l'angle résolu),
// pas déduit à froid de la convention caméra — à ajuster si besoin une fois
// vérifié visuellement.
import { useT } from '../i18n'

const DIRECTIONS: Array<{ deg: number; label: string; area: string }> = [
  { deg: 135, label: 'NW', area: 'nw' },
  { deg: 90, label: 'N', area: 'n' },
  { deg: 45, label: 'NE', area: 'ne' },
  { deg: 180, label: 'W', area: 'w' },
  { deg: 0, label: 'E', area: 'e' },
  { deg: 225, label: 'SW', area: 'sw' },
  { deg: 270, label: 'S', area: 's' },
  { deg: 315, label: 'SE', area: 'se' },
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
