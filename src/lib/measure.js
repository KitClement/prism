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

// Ruler variant of `snapValue`: snaps to the nearest *labeled* candidate and returns
// the whole candidate, so the caller learns whether the endpoint landed on a trackable
// measure (carrying a stat `spec`) or a plain constant (`spec: null` — a data dot or a
// free position). Candidates are `{ value, spec, label }`; a miss returns the free value
// with `spec: null`. Same constant-on-screen snap radius as `snapValue`.
// `cursorY` (in the same svg pixel space as each candidate's marker `y`) lets the caller
// disambiguate candidates that share an x: among those within the horizontal snap radius,
// the one nearest the cursor in 2-D wins, so moving the pointer up/down chooses between a
// coincident dot / mean / median. When `cursorY` is null only horizontal distance is used.
export function snapMeasure(v, candidates, pxPerUnit, cursorY = null, threshold = 8) {
  let best = { value: v, spec: null, label: null }, bestDist = Infinity;
  if (!candidates || !pxPerUnit) return best;
  const xRadius = threshold / pxPerUnit; // horizontal snap radius, in data units
  for (const c of candidates) {
    if (!c || c.value === undefined || c.value === null || isNaN(c.value)) continue;
    const dxu = Math.abs(c.value - v);
    if (dxu > xRadius) continue; // outside the horizontal grab range
    const dxpx = dxu * pxPerUnit;
    const dypx = (cursorY !== null && c.y != null) ? Math.abs(c.y - cursorY) : 0;
    const d = Math.hypot(dxpx, dypx);
    // Strict `<` so the first candidate wins an exact tie (callers list measures first).
    if (d < bestDist) { best = c; bestDist = d; }
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
