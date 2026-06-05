// Plot measurement-tool foundation (Phase 6a). Pure helpers shared by the divider
// (and, later, the ruler): clamp a handle to the axis domain, snap it to nearby data
// dots / visible measures, and split a set of plotted values into proportions either
// side of one or two cut points. No stats-engine or React dependencies.

// Clamp a value into [lo, hi] (handles lo > hi defensively).
export function clampVal(v, lo, hi) {
  const a = Math.min(lo, hi), b = Math.max(lo, hi);
  return v < a ? a : v > b ? b : v;
}

// Snap `v` to the nearest candidate value if it is within `threshold` pixels of one,
// else return `v` unchanged. `pxPerUnit` converts data units → pixels so the snap
// radius is a constant on-screen distance regardless of the axis scale. Candidates are
// data-dot values and currently-visible measures (mean/median/Q1/Q3); a free constant
// drag falls through when nothing is close.
export function snapValue(v, candidates, pxPerUnit, threshold = 8) {
  if (!candidates || !candidates.length || !pxPerUnit) return v;
  let best = v, bestDist = threshold / pxPerUnit;
  for (const c of candidates) {
    if (c === undefined || c === null || isNaN(c)) continue;
    const d = Math.abs(c - v);
    if (d <= bestDist) { best = c; bestDist = d; }
  }
  return best;
}

// Split `values` (finite plotted numbers) into proportion regions about `cuts`.
//   cuts = [v]      → [{<v}, {≥v}]                using x < v / x ≥ v
//   cuts = [lo, hi] → [{<lo}, {lo–hi}, {>hi}]     using x < lo / lo ≤ x ≤ hi / x > hi
// Each region is { key, lo, hi, n, p } with p = n / total; counts always sum to total.
export function regions(values, cuts) {
  const total = values.length;
  const prop = n => (total ? n / total : NaN);
  if (!cuts || cuts.length < 2) {
    const v = cuts ? cuts[0] : NaN;
    const below = values.filter(x => x < v).length;
    return [
      { key: "lt", lo: -Infinity, hi: v, n: below, p: prop(below) },
      { key: "ge", lo: v, hi: Infinity, n: total - below, p: prop(total - below) },
    ];
  }
  const lo = Math.min(cuts[0], cuts[1]), hi = Math.max(cuts[0], cuts[1]);
  const below = values.filter(x => x < lo).length;
  const above = values.filter(x => x > hi).length;
  const mid = total - below - above;
  return [
    { key: "lt", lo: -Infinity, hi: lo, n: below, p: prop(below) },
    { key: "mid", lo, hi, n: mid, p: prop(mid) },
    { key: "gt", lo: hi, hi: Infinity, n: above, p: prop(above) },
  ];
}
