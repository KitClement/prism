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

// Snap a middle band to the **smallest achievable central band that covers ≥ `target`** — a
// conservative CI: setting 0.95 yields an interval whose coverage is at least 0.95 (never
// under, even though discrete data rarely lands exactly on the nominal level). Builds the
// nested family of *central* bands — start at the median value and repeatedly extend whichever
// side currently has the larger excluded tail (ties → the upper side, matching the divider's
// inclusive-upper convention) — and stops at the first band reaching the target (else the full
// range). Returns [lo, hi] data values. O(N + k log k) in the number of *distinct* values.
export function conservativeBand(values, target) {
  const N = values.length;
  if (!N) return [NaN, NaN];
  const cnt = new Map();
  for (const v of values) cnt.set(v, (cnt.get(v) || 0) + 1);
  const xs = [...cnt.keys()].sort((a, b) => a - b);
  const k = xs.length;
  const cum = new Array(k); // cum[i] = count of values ≤ xs[i]
  let run = 0;
  for (let c = 0; c < k; c++) { run += cnt.get(xs[c]); cum[c] = run; }
  let med = 0; while (med < k - 1 && cum[med] < N / 2) med++; // first value reaching the median
  let i = med, j = med;
  const cov = () => (cum[j] - (i ? cum[i - 1] : 0)) / N;
  while (cov() < target && (i > 0 || j < k - 1)) {
    const below = i > 0 ? cum[i - 1] : 0, above = N - cum[j];
    if (i > 0 && (below > above || j >= k - 1)) i--; else j++; // extend the larger excluded tail; tie → upper
  }
  return [xs[i], xs[j]];
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

// Multi-divider bins: k cuts → k+1 regions, each left-closed / right-open (c_j ≤ x < c_j+1,
// the outer two unbounded) — R's `cut(right = FALSE)`. Unlike `regions`, every region carries
// explicit `loOpen`/`hiOpen` so a tracked bin spec reproduces it exactly. One sort + one sweep.
export function binRegions(values, cuts) {
  const cs = [...cuts].sort((a, b) => a - b), total = values.length;
  const xs = [...values].sort((a, b) => a - b);
  const prop = n => (total ? n / total : NaN);
  const out = [];
  let i = 0;
  for (let j = 0; j <= cs.length; j++) {
    const hi = j < cs.length ? cs[j] : Infinity, start = i;
    while (i < xs.length && xs[i] < hi) i++;
    const n = i - start;
    out.push({ key: "b" + j, lo: j ? cs[j - 1] : -Infinity, hi, n, p: prop(n), loOpen: false, hiOpen: hi !== Infinity });
  }
  return out;
}

// k evenly spaced cuts over `values`: equal-WIDTH steps across [min, max], or equal-COUNT
// cuts at the j/(k+1) quantiles (`quantile` passed in — the interpolating one from stats.js,
// constraint #5 — so this module stays dependency-free). Discrete data may yield duplicate
// cuts; that only produces an empty bin.
export function evenCuts(values, k, how, quantile) {
  if (!values.length) return [];
  const xs = [...values].sort((a, b) => a - b), mn = xs[0], mx = xs[xs.length - 1];
  return Array.from({ length: k }, (_, j) => how === "count"
    ? quantile(xs, (j + 1) / (k + 1))
    : mn + (j + 1) * (mx - mn) / (k + 1));
}

// ── Reference line (scatter) ────────────────────────────────────────────────────
// The part of y = m·x + b inside the box [xlo, xhi] × [ylo, yhi], as two data points
// (left end first), or null when the line misses the box.
export function clipLine(m, b, xlo, xhi, ylo, yhi) {
  let a = xlo, c = xhi;
  if (m === 0) { if (b < ylo || b > yhi) return null; }
  else {
    const x1 = (ylo - b) / m, x2 = (yhi - b) / m;
    a = Math.max(a, Math.min(x1, x2)); c = Math.min(c, Math.max(x1, x2));
    if (!(a <= c)) return null;
  }
  return [{ x: a, y: m * a + b }, { x: c, y: m * c + b }];
}

// ── Numeric binning (a numeric variable as interval categories) ──────────────────
// Equal-width bins with "nice" edges, left-closed / right-open except the last, which also
// holds its upper edge when the max lands on it ({ n } only: a typed width keeps every bin
// that wide, so a max on an edge opens one more bin). `spec` is { n } or { w } (a bin width).
// For { n } the width is (range / n) rounded UP to a nice step (25, 30, 40, 0.2, …),
// whole for integer data, and the start is the largest multiple of the width ≤ min; if that
// shift leaves the max uncovered the width steps up. Returns { start, w, k, labels, index }
// (index(v) → bin 0..k-1), or null with no finite values. Integer data with whole edges
// gets "0–29" labels (an integer range); otherwise "1.5 to <3" ("a to b" for a closed last bin).
export const MAX_BINS = 10, MAX_WIDTH_BINS = 30;
export function makeBins(values, spec) {
  const xs = values.filter(Number.isFinite);
  if (!xs.length) return null;
  let mn = Infinity, mx = -Infinity;
  for (const v of xs) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const intData = xs.every(Number.isInteger), eps = 1e-9;
  // Round a width UP to the next "nice" step: 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 (× a power of 10).
  const NICE = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  const ceil1 = x => { const mag = 10 ** Math.floor(Math.log10(x)), r = x / mag; return NICE.find(s => s >= r - eps) * mag; };
  const fix = x => parseFloat(x.toPrecision(12));
  const startOf = w => fix(Math.floor(mn / w + eps) * w);
  let w, start, k;
  if (spec && spec.w > 0) {
    w = spec.w;
    if ((mx - startOf(w)) / w > MAX_WIDTH_BINS) w = ceil1((mx - mn) / MAX_WIDTH_BINS || 1);
    start = startOf(w);
    k = Math.floor((mx - start) / w + eps) + 1; // every bin half-open: a max on an edge opens a bin
  } else {
    const n = Math.max(2, Math.min(MAX_BINS, Math.round((spec && spec.n) || 4)));
    w = mx > mn ? ceil1((mx - mn) / n) : 1;
    if (intData) w = Math.max(1, Math.ceil(w));
    start = startOf(w);
    while (start + n * w < mx - eps) { w = fix(ceil1(w * (1 + 1e-6))); start = startOf(w); }
    k = Math.max(1, Math.ceil((mx - start) / w - eps));
  }
  w = fix(w);
  const f = x => String(fix(x));
  const whole = intData && Number.isInteger(w) && Number.isInteger(start);
  const labels = Array.from({ length: k }, (_, j) => {
    const a = fix(start + j * w), b = fix(start + (j + 1) * w), last = j === k - 1;
    if (whole) { const hi = last && mx >= b - eps ? b : b - 1; return hi === a ? String(a) : a + (a < 0 || hi < 0 ? " to " : "–") + hi; }
    return f(a) + (last && mx >= b - eps ? " to " : " to <") + f(b);
  });
  const index = v => Math.min(k - 1, Math.max(0, Math.floor((v - start) / w + eps)));
  return { start, w, k, labels, index };
}
