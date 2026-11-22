// Statistics engine: quantiles, numeric summaries, least-squares fit, and the
// computeStat/statLabel spec consumed by Collect Statistics.

function quantile(sortedNums, q) {
  if (!sortedNums.length) return NaN;
  const pos = (sortedNums.length - 1) * q;
  const base = Math.floor(pos), rest = pos - base;
  if (sortedNums[base + 1] !== undefined)
    return sortedNums[base] + rest * (sortedNums[base + 1] - sortedNums[base]);
  return sortedNums[base];
}

function numericSummary(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? s.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : NaN;
  const sd = Math.sqrt(variance);
  const q1 = quantile(s, 0.25), median = quantile(s, 0.5), q3 = quantile(s, 0.75);
  // Tukey whiskers: extend to the most extreme datum within 1.5·IQR of the box.
  const iqr = q3 - q1, lf = q1 - 1.5 * iqr, uf = q3 + 1.5 * iqr;
  let whiskerLo = s[0], whiskerHi = s[n - 1];
  for (let i = 0; i < n; i++) { if (s[i] >= lf) { whiskerLo = s[i]; break; } }
  for (let i = n - 1; i >= 0; i--) { if (s[i] <= uf) { whiskerHi = s[i]; break; } }
  // With interpolated quartiles on tiny samples a quartile can fall outside the
  // nearest in-fence datum; never let a whisker retract inside the box.
  whiskerLo = Math.min(whiskerLo, q1);
  whiskerHi = Math.max(whiskerHi, q3);
  return { n, min: s[0], max: s[n - 1], mean, sd, q1, median, q3, whiskerLo, whiskerHi };
}

// Gaussian kernel-density estimate sampled across [lo, hi]. Bandwidth by Silverman's
// rule of thumb (h = 0.9·min(SD, IQR/1.34)·n^(-1/5)). Returns `steps` points
// { x, y } with y the raw density (the caller scales height into the plot), or null
// for degenerate input (fewer than 2 points, or zero spread → nothing to smooth).
function kdeCurve(values, lo, hi, steps = 120) {
  const nums = (values || []).map(Number).filter(v => !isNaN(v));
  const n = nums.length;
  if (n < 2 || !(hi > lo)) return null;
  const summ = numericSummary(nums);
  const iqr = summ.q3 - summ.q1;
  const spread = Math.min(summ.sd || Infinity, iqr > 0 ? iqr / 1.34 : Infinity);
  const h = 0.9 * (isFinite(spread) ? spread : (summ.sd || 0)) * Math.pow(n, -1 / 5);
  if (!(h > 0)) return null; // all values identical → no curve
  const inv = 1 / (h * Math.sqrt(2 * Math.PI));
  const curve = [];
  for (let i = 0; i < steps; i++) {
    const x = lo + ((hi - lo) * i) / (steps - 1);
    let sum = 0;
    for (let j = 0; j < n; j++) {
      const z = (x - nums[j]) / h;
      sum += Math.exp(-0.5 * z * z);
    }
    curve.push({ x, y: (sum * inv) / n });
  }
  return curve;
}

function lsFit(pairs) {
  if (pairs.length < 2) return null;
  const n = pairs.length;
  const sx = pairs.reduce((a, p) => a + p.x, 0), sy = pairs.reduce((a, p) => a + p.y, 0);
  const sxy = pairs.reduce((a, p) => a + p.x * p.y, 0), sxx = pairs.reduce((a, p) => a + p.x * p.x, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  // r-squared
  const my = sy / n;
  const ssTot = pairs.reduce((a, p) => a + (p.y - my) ** 2, 0);
  const ssRes = pairs.reduce((a, p) => a + (p.y - (slope * p.x + intercept)) ** 2, 0);
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  // correlation r: the square root of R², signed like the slope
  const r = Math.sign(slope) * Math.sqrt(Math.max(0, r2));
  return { slope, intercept, r2, r };
}

// Least-absolute-deviations line: minimizes Σ|y − (m·x + b)|. Exact.
// Some optimal line always passes through two data points (a "vertex"), and the best line
// through a fixed point i has slope = the weighted median of the slopes (y_j − y_i)/(x_j − x_i),
// weights |x_j − x_i| (`bestThrough`, O(n log n)). So, like the simplex method R's
// quantreg::rq / L1pack::lad use, the fit walks vertex to vertex: from the current line, try
// rotating it about each data point on it; move while that strictly lowers the sum, and stop
// when no rotation does. The objective is convex, so that vertex is a global minimum.
// **Ties** (LAD is not always unique): the optimal lines form a convex set whose corners are
// two-point lines. The fit explores all of them (rotations that keep the minimum, capped at 200)
// and returns their **average**. That average is optimal too (convexity) and doesn't depend on
// row order, like the midpoint median of an even sample. R's simplex instead returns whichever
// corner its pivoting reaches, and only warns "solution may be nonunique".
// Returns { slope, intercept, sae, unique } or null (fewer than 2 distinct x values).
function ladFit(pairs) {
  const n = pairs.length;
  if (n < 2) return null;
  const X = Float64Array.from(pairs, p => p.x), Y = Float64Array.from(pairs, p => p.y);
  let yAbs = 0;
  for (let j = 0; j < n; j++) yAbs += Math.abs(Y[j]);
  const sae = L => { let a = 0; for (let j = 0; j < n; j++) a += Math.abs(Y[j] - (L.m * X[j] + L.b)); return a; };
  const lineAt = (i, m) => ({ m, b: Y[i] - m * X[i] });
  const yScale = yAbs / n + 1;
  // The data points on line L, one per distinct x (points on a line sharing an x coincide, so
  // they give the same rotation; with discrete data hundreds can sit on the line).
  const onLine = L => {
    const out = [], seen = new Set();
    for (let j = 0; j < n; j++)
      if (!seen.has(X[j]) && Math.abs(Y[j] - (L.m * X[j] + L.b)) <= 1e-9 * yScale) { seen.add(X[j]); out.push(j); }
    return out;
  };
  const S = new Float64Array(n), Wt = new Float64Array(n), idx = new Uint32Array(n);
  // The optimal slopes [lo, hi] for lines through point i (lo === hi unless tied), or null.
  const bestThrough = i => {
    let c = 0, W = 0;
    for (let j = 0; j < n; j++) {
      const dx = X[j] - X[i];
      if (dx === 0) continue;
      S[c] = (Y[j] - Y[i]) / dx; Wt[c] = Math.abs(dx); idx[c] = c; W += Wt[c]; c++;
    }
    if (!c) return null;
    const ord = idx.subarray(0, c).sort((a, q) => S[a] - S[q]);
    let cum = 0;
    for (let k = 0; k < c; k++) {
      cum += Wt[ord[k]];
      if (cum >= W / 2 - 1e-12 * W) {
        const lo = S[ord[k]];
        // Cumulative weight exactly half: every slope up to the next one ties.
        const hi = Math.abs(cum - W / 2) <= 1e-12 * W && k + 1 < c ? S[ord[k + 1]] : lo;
        return { lo, hi };
      }
    }
    return null;
  };
  // Start from the point with the median x (usually few steps from the optimum).
  const byX = Array.from({ length: n }, (_, j) => j).sort((a, q) => X[a] - X[q]);
  const i0 = byX[n >> 1], r0 = bestThrough(i0);
  if (!r0) return null;
  let cur = lineAt(i0, r0.lo), cv = sae(cur);
  const tol = () => 1e-9 * (cv + yAbs + 1);
  for (let it = 0; it < 4 * n + 10; it++) {
    let moved = false;
    for (const k of onLine(cur)) {
      const r = bestThrough(k);
      if (!r) continue;
      const L = lineAt(k, r.lo), v = sae(L);
      if (v < cv - tol()) { cur = L; cv = v; moved = true; break; }
    }
    if (!moved) break;
  }
  // Every optimal corner, reached by the rotations that keep the minimum.
  const same = (a, c) => Math.abs(a.m - c.m) <= 1e-9 * (Math.abs(a.m) + 1) && Math.abs(a.b - c.b) <= 1e-9 * (Math.abs(a.b) + 1);
  const opt = [cur], queue = [cur];
  while (queue.length && opt.length < 200) {
    const L = queue.pop();
    for (const k of onLine(L)) {
      const r = bestThrough(k);
      if (!r || sae(lineAt(k, r.lo)) > cv + tol()) continue;
      for (const m of r.hi === r.lo ? [r.lo] : [r.lo, r.hi]) {
        const L2 = lineAt(k, m);
        if (!opt.some(o => same(o, L2))) { opt.push(L2); queue.push(L2); }
      }
    }
  }
  const slope = opt.reduce((a, o) => a + o.m, 0) / opt.length;
  const intercept = opt.reduce((a, o) => a + o.b, 0) / opt.length;
  return { slope, intercept, sae: sae({ m: slope, b: intercept }), unique: opt.length === 1 };
}

// ══════════════════════════════════════════════════════════════════════════════
// STATISTICS ENGINE
// ══════════════════════════════════════════════════════════════════════════════
function computeStat(stat, rows) {
  let working = rows;
  if (stat.condVar && stat.condVal !== "") working = rows.filter(r => String(r[stat.condVar]) === String(stat.condVal));
  const vals = working.map(r => r[stat.variable]).filter(v => v !== undefined && v !== "");
  const nums = vals.map(Number).filter(v => !isNaN(v));
  const sorted = () => [...nums].sort((a, b) => a - b);
  switch (stat.fn) {
    case "count":      return vals.length;
    case "countVal":   return vals.filter(v => String(v) === String(stat.target)).length;
    case "proportion": return vals.length ? vals.filter(v => String(v) === String(stat.target)).length / vals.length : NaN;
    case "mean":       return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : NaN;
    case "sd": {       // sample SD, matching numericSummary (variance over n-1)
      if (nums.length < 2) return NaN;
      const m = nums.reduce((a, b) => a + b, 0) / nums.length;
      return Math.sqrt(nums.reduce((a, b) => a + (b - m) ** 2, 0) / (nums.length - 1));
    }
    case "median":     return nums.length ? quantile(sorted(), 0.5) : NaN;
    case "min":        return nums.length ? Math.min(...nums) : NaN;
    case "max":        return nums.length ? Math.max(...nums) : NaN;
    case "q1":         return nums.length ? quantile(sorted(), 0.25) : NaN;
    case "q3":         return nums.length ? quantile(sorted(), 0.75) : NaN;
    case "slope": case "intercept": {
      const pairs = working.map(r => ({ x:Number(r[stat.variable]), y:Number(r[stat.variable2]) })).filter(p => !isNaN(p.x) && !isNaN(p.y));
      const fit = lsFit(pairs);
      if (!fit) return NaN;
      return stat.fn === "slope" ? fit.slope : fit.intercept;
    }
    case "countBetween": case "propBetween": {
      // Values within a numeric region [lo, hi] with per-side open/closed bounds
      // (a null bound is unbounded). Authored by the divider tool from a cut value.
      const inR = x => (stat.lo == null || (stat.loOpen ? x > stat.lo : x >= stat.lo)) &&
                       (stat.hi == null || (stat.hiOpen ? x < stat.hi : x <= stat.hi));
      const cnt = nums.filter(inR).length;
      return stat.fn === "countBetween" ? cnt : (nums.length ? cnt / nums.length : NaN);
    }
    // A tracked summary formula (lib/formula.js withFormulas carries its value on every row).
    case "formula": {
      const v = rows.length ? rows[0][stat.variable] : undefined;
      return v === undefined || v === "" || isNaN(Number(v)) ? NaN : Number(v);
    }
    default: return NaN;
  }
}

// Human-readable description of a numeric region, e.g. "score < 5", "5 ≤ score ≤ 10".
function regionDesc(s, v) {
  const r = n => parseFloat(Number(n).toFixed(4));
  if (s.lo == null) return v + " " + (s.hiOpen ? "<" : "≤") + " " + r(s.hi);
  if (s.hi == null) return v + " " + (s.loOpen ? ">" : "≥") + " " + r(s.lo);
  return r(s.lo) + " " + (s.loOpen ? "<" : "≤") + " " + v + " " + (s.hiOpen ? "<" : "≤") + " " + r(s.hi);
}

// Stable IDENTITY key for a stat spec, serialized over its structural fields (which
// hold device ids once the pipeline is id-keyed). Used for all dedup / toggle /
// membership / data-mkey comparisons so identity never rides on the display label —
// which changes on a rename and would collide when two devices momentarily share a
// name. `statLabel` stays purely for display.
function statKey(s) {
  if (!s) return "";
  if (s.kind === "derived") return "derived:" + s.id;
  return JSON.stringify([
    s.fn, s.variable || "", s.variable2 || "", s.condVar || "",
    s.condVal == null ? "" : s.condVal, s.target == null ? "" : s.target,
    s.lo == null ? null : s.lo, s.hi == null ? null : s.hi, !!s.loOpen, !!s.hiOpen,
  ]);
}

// Display label for a stat spec. `nameOf(id)` resolves a device id to its display
// varName; it defaults to identity so callers without a pipeline map (and the EDA
// plot, which passes real header strings) render unchanged.
function statLabel(s, nameOf) {
  const nm = nameOf || (v => v);
  const c = s.condVar ? " | " + nm(s.condVar) + "=\"" + s.condVal + "\"" : "", v = s.variable ? nm(s.variable) : "?";
  if (s.fn === "countBetween" || s.fn === "propBetween")
    return (s.fn === "countBetween" ? "count(" : "prop(") + regionDesc(s, v) + c + ")";
  if (s.fn === "formula") return v;
  const v2 = s.variable2 ? nm(s.variable2) : "?";
  const mp = { count:"count(" + v + c + ")", countVal:"count(" + v + "=\"" + s.target + "\"" + c + ")", proportion:"prop(" + v + "=\"" + s.target + "\"" + c + ")", mean:"mean(" + v + c + ")", sd:"SD(" + v + c + ")", median:"median(" + v + c + ")", min:"min(" + v + c + ")", max:"max(" + v + c + ")", q1:"Q1(" + v + c + ")", q3:"Q3(" + v + c + ")", slope:"slope(" + v + "~" + v2 + c + ")", intercept:"intercept(" + v + "~" + v2 + c + ")" };
  return mp[s.fn] || s.fn;
}

const FN_OPTS = [{ v:"mean", l:"Mean" }, { v:"sd", l:"SD" }, { v:"median", l:"Median" }, { v:"proportion", l:"Proportion" }, { v:"countVal", l:"Count of value" }, { v:"count", l:"Count (n)" }, { v:"min", l:"Min" }, { v:"max", l:"Max" }, { v:"q1", l:"Q1" }, { v:"q3", l:"Q3" }, { v:"slope", l:"LS Slope" }, { v:"intercept", l:"LS Intercept" }];

// Stat functions that are only meaningful on a numeric variable (so they must be
// dropped if their variable becomes categorical). count / countVal / proportion tally a
// value and work on any kind, so they are excluded.
const NUMERIC_FNS = new Set(["mean", "sd", "median", "min", "max", "q1", "q3", "slope", "intercept", "countBetween", "propBetween"]);

export { quantile, numericSummary, kdeCurve, lsFit, ladFit, computeStat, statLabel, statKey, FN_OPTS, NUMERIC_FNS };
