// Helpers PURS de lisibilité des trajectoires terrain (tranche B2,
// 2026-08-07) — aucune dépendance R3F, testables isolément.
//
// Objectif : rendre le SENS DE LECTURE d'une trajectoire évident d'un coup
// d'œil — dégradé temporel (sombre au départ → couleur pleine à la cible)
// + chevrons de direction espacés à l'écran (espacement quantifié par
// bucket de zoom pour ne recalculer qu'aux changements de palier).

/** Couleur hex -> [r, g, b] 0..1. */
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** Hex assombri d'un facteur (0 = noir, 1 = inchangé). */
export function darkenHex(hex: string, factor: number): string {
  const [r, g, b] = hexToRgb(hex)
  const c = (v: number) => Math.round(v * factor * 255).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/** Dégradé temporel pour Line vertexColors : sombre (×darkFactor) au
 * premier sommet → couleur pleine au dernier. Un triplet par sommet. */
export function gradientColors(count: number, hex: string, darkFactor = 0.3): [number, number, number][] {
  const [r, g, b] = hexToRgb(hex)
  const out: [number, number, number][] = []
  if (count <= 0) return out
  for (let i = 0; i < count; i++) {
    const f = count === 1 ? 1 : darkFactor + (1 - darkFactor) * (i / (count - 1))
    out.push([r * f, g * f, b * f])
  }
  return out
}

export interface ChevronPlacement {
  xCm: number
  yCm: number
  zCm: number
  /** Angle de la direction locale du tracé dans le plan XY (radians). */
  angleRad: number
}

/** Chevrons de direction par abscisse curviligne : un chevron tous les
 * `spacingCm` le long du tracé (premier à spacing/2), plafonné à
 * `maxCount` pour les très longs tracés. Tracé en cm, Z du premier point
 * conservé. */
export function chevronPlacements(
  path: [number, number, number][],
  spacingCm: number,
  maxCount = 24,
): ChevronPlacement[] {
  if (path.length < 2 || spacingCm <= 0) return []
  // Abscisses cumulées (XY seulement : la scène est vue du dessus).
  const cum: number[] = [0]
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1])
    cum.push(cum[i - 1] + d)
  }
  const total = cum[cum.length - 1]
  if (total < spacingCm * 0.6) return []
  const out: ChevronPlacement[] = []
  let seg = 1
  for (let k = 0; k < maxCount; k++) {
    const s = spacingCm / 2 + k * spacingCm
    if (s >= total) break
    while (seg < cum.length - 1 && cum[seg] < s) seg++
    const a = path[seg - 1]
    const b = path[seg]
    const segLen = cum[seg] - cum[seg - 1]
    const f = segLen > 1e-6 ? (s - cum[seg - 1]) / segLen : 0
    out.push({
      xCm: a[0] + (b[0] - a[0]) * f,
      yCm: a[1] + (b[1] - a[1]) * f,
      zCm: a[2] + (b[2] - a[2]) * f,
      angleRad: Math.atan2(b[1] - a[1], b[0] - a[0]),
    })
  }
  return out
}

/** Quantifie le zoom ortho en paliers ×√2 : les recalculs dépendant du
 * zoom (espacement des chevrons) ne se refont qu'au changement de palier,
 * pas à chaque frame de molette. */
export function zoomBucket(zoom: number): number {
  return Math.pow(2, Math.round(Math.log2(Math.max(1e-3, zoom)) * 2) / 2)
}
