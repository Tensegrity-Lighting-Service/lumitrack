// Utilitaires du graph editor (mission "graph editor + lien blocs", spec =
// KeysView de Friction). Le frontend n'interpole JAMAIS la lecture
// (§13.1.7) — ces fonctions servent uniquement à ÉDITER la géométrie des
// courbes ; la résolution temporelle reste backend-autoritaire.
//
// Une courbe = nœuds {t, v, poignées ABSOLUES, mode} triés par t, t ∈ [0,1]
// (fraction du fade), v = progrès (dépassements autorisés). Même format que
// core/timeline.py::eval_curve et native/src/curve.rs.

export type HandleMode = 'smooth' | 'symmetric' | 'corner'

export interface CurveNode {
  t: number
  v: number
  inT: number | null
  inV: number | null
  outT: number | null
  outV: number | null
  mode: HandleMode
}

export type Axis = 'x' | 'y' | 'z' | 'yaw'
export const AXES: Axis[] = ['x', 'y', 'z', 'yaw']
export const AXIS_COLORS: Record<Axis, string> = {
  x: '#f5734f', y: '#4ff58c', z: '#4fa8f5', yaw: '#b06fe0',
}
export const AXIS_LABELS: Record<Axis, string> = { x: 'X', y: 'Y', z: 'Z', yaw: 'Lacet' }
/** Clés i18n (t()) pour l'affichage — AXIS_LABELS ci-dessus reste utilisé
 * tel quel où le FR en dur suffit encore (pas de composant React). */
export const AXIS_LABEL_KEYS: Record<Axis, string> = {
  x: 'graph.axisX', y: 'graph.axisY', z: 'graph.axisZ', yaw: 'graph.axisYaw',
}

export function node(t: number, v: number, partial?: Partial<CurveNode>): CurveNode {
  return { t, v, inT: null, inV: null, outT: null, outV: null, mode: 'smooth', ...partial }
}

export function sortNodes(nodes: CurveNode[]): CurveNode[] {
  return [...nodes].sort((a, b) => a.t - b.t)
}

/** Points de contrôle effectifs d'un segment (poignées absentes -> tiers de
 * corde, exactement comme le moteur). */
export function segmentControls(a: CurveNode, b: CurveNode) {
  const t1 = a.outT ?? a.t + (b.t - a.t) / 3
  const v1 = a.outV ?? a.v + (b.v - a.v) / 3
  const t2 = b.inT ?? b.t - (b.t - a.t) / 3
  const v2 = b.inV ?? b.v - (b.v - a.v) / 3
  return { t1: Math.min(b.t, Math.max(a.t, t1)), v1, t2: Math.min(b.t, Math.max(a.t, t2)), v2 }
}

function bez(p0: number, p1: number, p2: number, p3: number, s: number): number {
  const m = 1 - s
  return m * m * m * p0 + 3 * m * m * s * p1 + 3 * m * s * s * p2 + s * s * s * p3
}

/** Évaluation locale (affichage/insertion uniquement — pas la lecture). */
export function evalCurve(nodes: CurveNode[], u: number): number {
  if (nodes.length < 2) return Math.max(0, Math.min(1, u))
  const pts = sortNodes(nodes)
  u = Math.max(pts[0].t, Math.min(pts[pts.length - 1].t, u))
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]; const b = pts[i + 1]
    if (u < a.t || u > b.t) continue
    if (b.t <= a.t) return b.v
    const { t1, v1, t2, v2 } = segmentControls(a, b)
    let lo = 0; let hi = 1
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2
      if (bez(a.t, t1, t2, b.t, mid) < u) lo = mid
      else hi = mid
    }
    const s = (lo + hi) / 2
    return bez(a.v, v1, v2, b.v, s)
  }
  return pts[pts.length - 1].v
}

/** Insertion d'un nœud à la fraction u par découpe de de Casteljau : la
 * forme de la courbe est EXACTEMENT préservée. */
export function insertNode(nodes: CurveNode[], u: number): CurveNode[] {
  const pts = sortNodes(nodes)
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]; const b = pts[i + 1]
    if (u <= a.t || u >= b.t) continue
    const { t1, v1, t2, v2 } = segmentControls(a, b)
    // Paramètre s du point de découpe (abscisse = u).
    let lo = 0; let hi = 1
    for (let k = 0; k < 48; k++) {
      const mid = (lo + hi) / 2
      if (bez(a.t, t1, t2, b.t, mid) < u) lo = mid
      else hi = mid
    }
    const s = (lo + hi) / 2
    const lerp = (p: number, q: number) => p + (q - p) * s
    const t01 = lerp(a.t, t1); const v01 = lerp(a.v, v1)
    const t12 = lerp(t1, t2); const v12 = lerp(v1, v2)
    const t23 = lerp(t2, b.t); const v23 = lerp(v2, b.v)
    const t012 = lerp(t01, t12); const v012 = lerp(v01, v12)
    const t123 = lerp(t12, t23); const v123 = lerp(v12, v23)
    const tm = lerp(t012, t123); const vm = lerp(v012, v123)
    const mid = node(tm, vm, { inT: t012, inV: v012, outT: t123, outV: v123, mode: 'smooth' })
    const newA = { ...a, outT: t01, outV: v01 }
    const newB = { ...b, inT: t23, inV: v23 }
    return [...pts.slice(0, i), newA, mid, newB, ...pts.slice(i + 2)]
  }
  return pts
}

/** Poignées auto façon Catmull-Rom : tangente = corde entre voisins. */
export function smoothNodes(nodes: CurveNode[], strength = 1 / 3): CurveNode[] {
  const pts = sortNodes(nodes)
  return pts.map((n, i) => {
    const prev = pts[i - 1]
    const next = pts[i + 1]
    const pt = prev ? prev.t : n.t
    const pv = prev ? prev.v : n.v
    const nt = next ? next.t : n.t
    const nv = next ? next.v : n.v
    const span = nt - pt || 1
    const slope = (nv - pv) / span
    const inSpan = prev ? (n.t - prev.t) * strength : 0
    const outSpan = next ? (next.t - n.t) * strength : 0
    return {
      ...n,
      mode: 'smooth' as HandleMode,
      inT: prev ? n.t - inSpan : null,
      inV: prev ? n.v - slope * inSpan : null,
      outT: next ? n.t + outSpan : null,
      outV: next ? n.v + slope * outSpan : null,
    }
  })
}

/** Tout en segments linéaires (poignées sur la corde = spec "make segments
 * linear" de Friction ; en pratique on les efface, le moteur retombe sur le
 * tiers de corde qui EST la droite). */
export function linearNodes(nodes: CurveNode[]): CurveNode[] {
  return sortNodes(nodes).map((n) => ({ ...n, mode: 'corner' as HandleMode, inT: null, inV: null, outT: null, outV: null }))
}

// ---- conversion easing nommé -> courbe éditable ("bake") -------------------
// Copies LOCALES des fonctions du moteur (core/timeline.py). Utilisées
// uniquement pour générer une courbe éditable équivalente — après le bake,
// c'est la courbe qui fait foi côté moteur.

function easeSmooth(t: number) { return t * t * (3 - 2 * t) }
function easeIn(t: number) { return t * t * t }
function easeOut(t: number) { return 1 - Math.pow(1 - t, 3) }
function easeBounce(t: number) {
  const n1 = 7.5625; const d1 = 2.75
  if (t < 1 / d1) return n1 * t * t
  if (t < 2 / d1) { t -= 1.5 / d1; return n1 * t * t + 0.75 }
  if (t < 2.5 / d1) { t -= 2.25 / d1; return n1 * t * t + 0.9375 }
  t -= 2.625 / d1
  return n1 * t * t + 0.984375
}
function easeSpring(t: number) {
  if (t <= 0) return 0
  if (t >= 1) return 1
  const c4 = (2 * Math.PI) / 3
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1
}
function easeExponential(t: number) {
  if (t <= 0) return 0
  if (t >= 1) return 1
  return Math.pow(2, 10 * t - 10)
}

/** Courbe éditable équivalente à un easing nommé. Les quatre classiques
 * sont EXACTS (2 nœuds, cubique) ; les autres sont échantillonnés puis
 * lissés (approximation fidèle, désormais éditable). */
export function bakeEasing(name: string): CurveNode[] {
  const key = (name || 'linear').trim().toLowerCase()
  const exact: Record<string, CurveNode[]> = {
    linear: [node(0, 0, { mode: 'corner' }), node(1, 1, { mode: 'corner' })],
    smooth: [node(0, 0, { outT: 1 / 3, outV: 0, mode: 'smooth' }),
             node(1, 1, { inT: 2 / 3, inV: 1, mode: 'smooth' })],
    'ease-in': [node(0, 0, { outT: 1 / 3, outV: 0, mode: 'smooth' }),
                node(1, 1, { inT: 2 / 3, inV: 0, mode: 'smooth' })],
    'ease-out': [node(0, 0, { outT: 1 / 3, outV: 1, mode: 'smooth' }),
                 node(1, 1, { inT: 2 / 3, inV: 1, mode: 'smooth' })],
  }
  const aliases: Record<string, string> = {
    'lineaire': 'linear', 'linéaire': 'linear', doux: 'smooth', ease: 'smooth',
    'ease-in-out': 'smooth', rebond: 'bounce', ressort: 'spring', exponentiel: 'exponential',
  }
  const canonical = aliases[key] ?? key
  if (exact[canonical]) return exact[canonical]
  const fns: Record<string, (t: number) => number> = {
    // Les 4 premiers ont une forme exacte ci-dessus et ne passent jamais
    // ici — présents pour qu'un futur preset échantillonné les trouve.
    smooth: easeSmooth, 'ease-in': easeIn, 'ease-out': easeOut,
    bounce: easeBounce, spring: easeSpring, exponential: easeExponential,
  }
  const fn = fns[canonical]
  if (!fn) return exact.linear
  const samples = canonical === 'linear' ? 2 : 13
  const pts: CurveNode[] = []
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1)
    pts.push(node(t, fn(t), { mode: 'smooth' }))
  }
  return smoothNodes(pts)
}
