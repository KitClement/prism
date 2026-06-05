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
  const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
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
  return { slope, intercept, r2 };
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
    case "sd": {       // population SD, matching numericSummary (variance over n)
      if (!nums.length) return NaN;
      const m = nums.reduce((a, b) => a + b, 0) / nums.length;
      return Math.sqrt(nums.reduce((a, b) => a + (b - m) ** 2, 0) / nums.length);
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

function statLabel(s) {
  const c = s.condVar ? " | " + s.condVar + "=\"" + s.condVal + "\"" : "", v = s.variable || "?";
  if (s.fn === "countBetween" || s.fn === "propBetween")
    return (s.fn === "countBetween" ? "count(" : "prop(") + regionDesc(s, v) + c + ")";
  const mp = { count:"count(" + v + c + ")", countVal:"count(" + v + "=\"" + s.target + "\"" + c + ")", proportion:"prop(" + v + "=\"" + s.target + "\"" + c + ")", mean:"mean(" + v + c + ")", sd:"SD(" + v + c + ")", median:"median(" + v + c + ")", min:"min(" + v + c + ")", max:"max(" + v + c + ")", q1:"Q1(" + v + c + ")", q3:"Q3(" + v + c + ")", slope:"slope(" + v + "~" + (s.variable2 || "?") + c + ")", intercept:"intercept(" + v + "~" + (s.variable2 || "?") + c + ")" };
  return mp[s.fn] || s.fn;
}

const FN_OPTS = [{ v:"mean", l:"Mean" }, { v:"sd", l:"SD" }, { v:"median", l:"Median" }, { v:"proportion", l:"Proportion" }, { v:"countVal", l:"Count of value" }, { v:"count", l:"Count (n)" }, { v:"min", l:"Min" }, { v:"max", l:"Max" }, { v:"q1", l:"Q1" }, { v:"q3", l:"Q3" }, { v:"slope", l:"LS Slope" }, { v:"intercept", l:"LS Intercept" }];

// Stat functions that are only meaningful on a numeric variable (so they must be
// dropped if their variable becomes categorical). count / countVal / proportion tally a
// value and work on any kind, so they are excluded.
const NUMERIC_FNS = new Set(["mean", "sd", "median", "min", "max", "q1", "q3", "slope", "intercept", "countBetween", "propBetween"]);

export { quantile, numericSummary, lsFit, computeStat, statLabel, FN_OPTS, NUMERIC_FNS };
