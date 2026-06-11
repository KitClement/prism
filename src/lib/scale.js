// Shared plotting primitives — a 1-D value→pixel scale and bottom-anchored
// dot-stacking. Extracted from EDAPlot/DotPlot/StatDistPlot so every plot shares
// one implementation (scales + dot-stacking were the duplicated bits).
import { minutesToTime } from "./util";

// A "nice" tick step from the 1/2/5×10^k family, sized so the data span yields about
// `count` intervals. `integral` forces an integer step ≥ 1 (whole-number data should
// never show fractional ticks like 0.5). Returns the step plus the decimal places its
// labels need (0 for an integer step).
function niceStep(span, count, integral) {
  const raw = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  if (integral) step = Math.max(1, Math.round(step));
  const decimals = Number.isInteger(step) ? 0 : Math.max(0, -Math.floor(Math.log10(step)));
  return { step, decimals };
}

// Tick values aligned to a nice step across [mn, mx] (endpoints not forced).
function niceTicks(mn, mx, count, integral) {
  if (!(mx > mn)) return { ticks: [mn], decimals: integral ? 0 : 2 };
  const { step, decimals } = niceStep(mx - mn, count, integral);
  const start = Math.ceil(mn / step) * step;
  const n = Math.floor((mx - start) / step + 1e-9);
  const ticks = Array.from({ length: n + 1 }, (_, i) => start + i * step);
  return { ticks, decimals };
}

// Build a scale mapping data values to pixel offsets in [0, size].
//   opts.numeric   — treat values as numeric (else categorical band scale)
//   opts.time      — format numeric ticks as clock times (minutes → "h:mm")
//   opts.toNumber  — value→number coercion (Number, or toNum for time-aware)
//   opts.pad       — fraction of the data range added as padding each side
//   opts.tickCount — number of ticks, or a fn(range) → count
//   opts.precision — decimal places for numeric tick labels
// Numeric → { numeric:true, lo, hi, min, max, scale, ticks, fmt }
// Categorical → { numeric:false, cats, scale, ticks, fmt }
export function makeScale(values, size, opts = {}) {
  const { numeric = false, time = false, toNumber = Number, pad = 0.05, tickCount = 6, precision = 2 } = opts;
  const clean = values.filter(v => v !== undefined && v !== "");
  if (numeric) {
    const nums = clean.map(toNumber).filter(v => !isNaN(v));
    const mn = Math.min(...nums), mx = Math.max(...nums);
    const range = mx - mn || 1, p = range * pad, lo = mn - p, hi = mx + p;
    const nT = typeof tickCount === "function" ? tickCount(range) : tickCount;
    // Time keeps its old interpolated ticks (clock formatting). Otherwise use nice
    // 1/2/5×10^k steps so whole-number data gets whole-number ticks (no stray decimals),
    // forcing an integer step when every value is an integer.
    let ticks, fmt;
    if (time) {
      ticks = Array.from({ length: nT }, (_, i) => mn + (i / (nT - 1)) * range);
      fmt = v => minutesToTime(v);
    } else {
      const allInt = nums.every(Number.isInteger);
      const nice = niceTicks(mn, mx, nT, allInt);
      ticks = nice.ticks;
      fmt = nice.decimals === 0 ? (v => Math.round(v)) : (v => parseFloat(v.toFixed(precision)));
    }
    return { numeric: true, lo, hi, min: mn, max: mx, scale: v => ((toNumber(v) - lo) / (hi - lo)) * size, ticks, fmt };
  }
  const cats = [...new Set(clean)].sort();
  const step = size / cats.length;
  const idxOf = {}; cats.forEach((c, i) => { idxOf[c] = i; });
  return { numeric: false, cats, scale: v => (idxOf[v] || 0) * step + step / 2, ticks: cats, fmt: v => v };
}

// Bottom-anchored dot-stacking. Given each datum's x-pixel offset, bin dots into
// columns and return their y-offsets (from the plot top). Vertical spacing shrinks
// so the tallest column always fits within height h (never overflows).
//   R   — dot radius (px)
//   h   — available plot height (px)
//   gap — minimum space between stacked dots (px)
// Output is index-aligned with `xs`.
export function stackDots(xs, R, h, gap = 1) {
  const bin = x => Math.round(x / (R * 2 + gap));
  const counts = {};
  xs.forEach(x => { const k = bin(x); counts[k] = (counts[k] || 0) + 1; });
  const tallest = Math.max(1, ...Object.values(counts));
  const dotSpacing = Math.min(R * 2 + gap, (h - R) / tallest);
  const stks = {};
  return xs.map(x => { const k = bin(x); stks[k] = (stks[k] || 0) + 1; return h - (stks[k] - 1) * dotSpacing - R; });
}
