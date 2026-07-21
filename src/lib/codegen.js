// Parallel R / Python code generation (Task E). Pure functions that turn the LIVE
// sampler config into runnable code mirroring the simulation, so students can learn to
// write it themselves. Every generator reads the *same* specs the UI uses (stage outcomes,
// the `computeStat` fn semantics, the run-until rule) so the code and the tool never diverge.
//
// Each generator returns an array of LINES — `{ text, section }` — where `section` is one of
// "sampler" | "single" | "collect" | "inference". The four panels render the text beside the
// tool they mirror; the lines read top-to-bottom as one program (imports appear once, in the
// Sampler section).
//
// TWO shapes of output, picked by `isSimple`:
//   • COMPACT (the common teaching case): no fork, fixed n, and every enabled statistic reads a
//     single column. Each device is drawn as ONE vector (`sample(c(...), n)` / `df[...].sample(n)`)
//     and each statistic is inlined — no helper functions, even with several devices.
//   • SPLIT (forks, run-until, or multi-column stats like slope / group means): keeps the
//     per-row `draw_one` / `draw_sample` decomposition those genuinely require (per-row drawing
//     keeps columns row-aligned for regression / cross-column subsetting), then computes each
//     statistic inline and collects with a plain for-loop, mirroring the compact path.
//
// The Sample-Results ("single") and Collect ("collect") sections mirror the TABLE state:
// one entry per *enabled* tracked statistic (nothing until the student enables one), and the
// collect loop's N is the number of samples collected so far (`collectedCount`). Python uses
// pandas/numpy (statsmodels for regression); R is base R. Scope: WITH replacement (a
// without-replacement device is flagged in a comment); sample SD; type-7 quantiles. Derived
// columns aren't emitted.

// ─── Literals & identifiers ───────────────────────────────────────────────────
// A label is emitted as a numeric literal only when it parses as a finite number — so a
// numeric variable's draws are numbers (mean/SD work) while "a"/"8:30"/etc. stay quoted.
const isNumLit = v => { const s = String(v).trim(); return s !== "" && !isNaN(Number(s)); };
const lit = v => (isNumLit(v) ? String(Number(v)) : JSON.stringify(String(v)));
// JSON.stringify gives a safely-escaped double-quoted string, valid in both R and Python.
const key = name => JSON.stringify(name);
const vec = (labels, lang) => (lang === "r" ? "c(" : "[") + labels.map(lit).join(", ") + (lang === "r" ? ")" : "]");
// Sanitize a name into a valid R/Python identifier.
function safeName(raw) {
  let s = String(raw || "").replace(/[^A-Za-z0-9_]/g, "_");
  if (!s) s = "v";
  if (/^[0-9]/.test(s)) s = "v" + s;
  return s;
}
// Stage varNames → identifiers, deduped so two names that collapse to the same identifier
// ("a b" / "a-b") still get distinct symbols.
function buildNames(pipeline) {
  const map = {}, used = new Set();
  pipeline.forEach(st => {
    const base = safeName(st.varName);
    let n = base, k = 2;
    while (used.has(n)) n = base + "_" + k++;
    used.add(n); map[st.id] = n;
  });
  return map;
}

// ─── A device → its outcome space (labels + weights) ──────────────────────────
// Spinner weights = slice pct; stacks weights = item counts; mixer = distinct labels weighted
// by ball multiplicity. `uniform` lets us drop the weights argument when every weight is equal.
function outcomeSpec(dev) {
  const labels = [], weights = [];
  if (dev.type === "spinner") dev.slices.forEach(s => { labels.push(s.label); weights.push(s.pct); });
  else if (dev.type === "stacks") dev.items.forEach(it => { labels.push(it.label); weights.push(it.count); });
  else if (dev.type === "mixer") {
    const at = {};
    dev.balls.forEach(b => {
      if (!(b.label in at)) { at[b.label] = labels.length; labels.push(b.label); weights.push(0); }
      weights[at[b.label]]++;
    });
  }
  const uniform = weights.every(w => w === weights[0]);
  const replace = dev.type === "spinner" ? true : dev.withReplacement !== false;
  return { labels, weights, uniform, replace };
}
// A stage with a single (default) branch — the device it always draws from.
const defDevice = st => (st.branches.find(b => b.condVar === null) || st.branches[0]).device;
// A "pool" device draws from a finite, integer-count population (stacks = item counts, mixer =
// ball multiplicities). It's reproduced as the EXPANDED pool (each label repeated by its count),
// so with-/without-replacement is just the `replace` flag — no weights. A spinner is NOT a pool:
// its weights are fractional pct, applied at draw time, and it's always with replacement.
const isPool = dev => dev && (dev.type === "stacks" || dev.type === "mixer");

// ─── CSV-sourced devices (Fill-from-data) ─────────────────────────────────────
// A device filled from an uploaded CSV column carries `source = { dataset, var }`. Codegen
// then reads the file (read.csv / pd.read_csv) and samples that column instead of inlining a
// literal vector. Only Fill-from-data sets `source`; any manual edit clears it (see devices.jsx).
const devSource = dev => (dev && dev.source && dev.source.var) ? dev.source : null;
// Reference to a sourced column on a read-in data frame `frame`. Python reads the population into
// `df` in both paths (the drawn sample is `sample`); R reads into `df` (compact) / `pop` (split,
// where its drawn sample is `df`).
function srcCol(src, frame, lang) {
  if (lang === "r") return /^[A-Za-z.][A-Za-z0-9._]*$/.test(src.var) ? `${frame}$${src.var}` : `${frame}[[${JSON.stringify(src.var)}]]`;
  return `${frame}[${JSON.stringify(src.var)}]`;
}
// True when any device in the pipeline is CSV-sourced (⇒ emit one read line).
const anySource = cfg => cfg.pipeline.some(st => st.branches.some(b => devSource(b.device)));
// The CSV filename to read (single dataset in app state ⇒ one frame). First sourced device wins.
function csvFile(cfg) {
  for (const st of cfg.pipeline) for (const b of st.branches) {
    const s = devSource(b.device); if (s) return s.dataset || "data.csv";
  }
  return "data.csv";
}

// ─── Statistic selection & identity ───────────────────────────────────────────
// The enabled, code-emittable statistics: plain (non-derived) tracked stats. Derived columns
// aren't emitted (scope); an empty list means "nothing enabled yet".
const plainStats = cfg => (cfg.trackedStats || []).filter(s => s && s.kind !== "derived" && s.fn);
// A readable, valid identifier for one statistic (its column in the collect table). A group stat
// (condVar) appends its group value, so two group means read `mean_value_A` / `mean_value_B`.
function statId(s, names) {
  const v = names[s.variable] || "x", t = s.target != null ? "_" + safeName(s.target) : "";
  const g = s.condVar != null ? "_" + safeName(s.condVal) : "";
  const base = (() => {
    switch (s.fn) {
      case "mean": return `mean_${v}`;
      case "median": return `median_${v}`;
      case "sd": return `sd_${v}`;
      case "min": return `min_${v}`;
      case "max": return `max_${v}`;
      case "q1": return `q1_${v}`;
      case "q3": return `q3_${v}`;
      case "count": return `n_${v}`;
      case "countVal": return `count_${v}${t}`;
      case "proportion": return `prop_${v}${t}`;
      case "countBetween": return `count_${v}`;
      case "propBetween": return `prop_${v}`;
      case "slope": return `slope_${names[s.variable2] || "y"}_${v}`;
      case "intercept": return `intercept_${names[s.variable2] || "y"}_${v}`;
      default: return `stat_${v}`;
    }
  })();
  return base + g;
}
// Pair each stat with a unique identifier (suffix collisions).
function withIds(stats, names) {
  const used = new Set(), out = [];
  stats.forEach(s => {
    let base = statId(s, names), id = base, k = 2;
    while (used.has(id)) id = base + "_" + k++;
    used.add(id); out.push({ s, id });
  });
  return out;
}
// The collect loop's N = samples collected so far (falls back to a teaching default of 1000
// before any have been collected).
const collectN = cfg => (cfg.collectedCount > 0 ? cfg.collectedCount : 1000);
const collectNote = cfg => (cfg.collectedCount > 0 ? "   # samples collected so far" : "   # number of samples to collect");

// The Collect-plot divider (lifted from the UI), resolved against the tracked stats so the
// inference section can mirror the real cutoff + framing. Returns either `{ id, ... }` (the
// divider sits on an enabled plain stat — `id` is its generated result-vector name) or
// `{ derived, ... }` (it sits on a derived column — `derived` is the tracked spec, emitted from
// its operands at inference time), or null (no divider / unresolvable column / off).
const numLit = v => String(parseFloat(Number(v).toFixed(4)));
const pctLabel = f => `${parseFloat((f * 100).toFixed(2))}%`;
// A tracked column's display name → a valid R/Python identifier (non-word chars → "_",
// leading digit prefixed). Falls back to "derived" when there's no usable name.
const safeVarName = s => { const v = String(s || "").trim().replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "_$1"); return v || "derived"; };
function dividerInfo(cfg, stats) {
  const d = cfg.divider;
  if (!d || !d.cuts || !d.cuts.length || d.statId == null) return null;
  const cuts = d.cuts.map(Number).filter(v => !isNaN(v));
  if (!cuts.length) return null;
  const frame = { cuts, range: d.range && cuts.length >= 2,
    dir: d.dir === "left" || d.dir === "right" ? d.dir : "none",
    by: d.by === "pct" ? "pct" : "value", pct: typeof d.pct === "number" ? d.pct : 0.05,
    band: d.band === "tails" ? "tails" : "middle" };
  const match = stats.find(({ s }) => s.id === d.statId);
  if (match) return { ...frame, id: match.id };
  // A derived column is plotted: emit it from its operands (which must be enabled plain stats).
  const der = (cfg.trackedStats || []).find(s => s && s.kind === "derived" && s.id === d.statId);
  if (der) return { ...frame, derived: der };
  return null;
}
// The inference line(s) a divider implies over a vector/Series expression `vec`, by mode:
//   range + middle + value → band proportion P(lo ≤ x ≤ hi)
//   range + middle + pct   → CI: the middle-m percentile interval `quantile(c((1-m)/2, 1-(1-m)/2))`.
//                   A plain percentile interval for the set %, NOT the conservative band the
//                   tool draws — the student-facing code stays simple (won't match the visual
//                   band exactly on discrete data, which is fine).
//   range + tails  + value → combined two-sided tail proportion P(x < lo) + P(x > hi) (a two-sided p-value)
//   range + tails  + pct   → two-sided critical values `quantile(c(m/2, 1-m/2))` (m = combined tail mass)
//   tail  + value → one-sided p-value P(x ≥ v) / P(x < v)
//   tail  + pct   → critical value: the (1-m) percentile (right) / m percentile (left)
//   two-sided     → both proportions P(x ≥ v) / P(x < v)
// Quantiles are type-7 percentile-based (R/numpy/pandas default), matching stats.js `quantile`.
function dividerExprs(vec, div, lang) {
  const R = lang === "r";
  const ge = v => (R ? `mean(${vec} >= ${v})` : `(${vec} >= ${v}).mean()`);
  const lt = v => (R ? `mean(${vec} < ${v})` : `(${vec} < ${v}).mean()`);
  const le = v => (R ? `mean(${vec} <= ${v})` : `(${vec} <= ${v}).mean()`); // left tail is inclusive
  const band = (a, b) => (R ? `mean(${vec} >= ${a} & ${vec} <= ${b})` : `((${vec} >= ${a}) & (${vec} <= ${b})).mean()`);
  const outside = (a, b) => (R ? `mean(${vec} < ${a} | ${vec} > ${b})` : `((${vec} < ${a}) | (${vec} > ${b})).mean()`);
  const quant = a => (R ? `quantile(${vec}, ${a})` : `np.quantile(${vec}, ${a})`);

  if (div.range) {
    const a = numLit(Math.min(div.cuts[0], div.cuts[1])), b = numLit(Math.max(div.cuts[0], div.cuts[1]));
    if (div.band === "tails") {
      if (div.by === "pct") {
        // Two-sided critical values: the cutoffs enclosing the central 1-m band (m = combined tail mass).
        const lo = numLit(div.pct / 2), hi = numLit(1 - div.pct / 2);
        const args = R ? `c(${lo}, ${hi})` : `[${lo}, ${hi}]`;
        return [`${quant(args)}   # two-sided critical values (~${pctLabel(div.pct)} in tails)`];
      }
      return [`${outside(a, b)}   # two-sided p-value P(stat < ${a} or stat > ${b})`];
    }
    if (div.by === "pct") {
      // CI: the middle-m percentile interval for the set % (a plain percentile interval — not
      // the tool's conservative band; simple and student-readable).
      const a2 = numLit((1 - div.pct) / 2), b2 = numLit(1 - (1 - div.pct) / 2);
      const args = R ? `c(${a2}, ${b2})` : `[${a2}, ${b2}]`;
      return [`${quant(args)}   # middle ${pctLabel(div.pct)} (percentile interval)`];
    }
    return [`${band(a, b)}   # P(${a} <= stat <= ${b})`];
  }
  if (div.dir === "left" || div.dir === "right") {
    if (div.by === "pct") {
      // Critical value: the percentile cutting off the focused tail (right → upper, left → lower).
      const q = numLit(div.dir === "right" ? 1 - div.pct : div.pct);
      return [`${quant(q)}   # critical value (~${pctLabel(div.pct)} ${div.dir} tail)`];
    }
    const v = numLit(div.cuts[0]);
    return div.dir === "right" ? [`${ge(v)}   # p-value (upper tail)`] : [`${le(v)}   # p-value (lower tail)`];
  }
  const v = numLit(div.cuts[0]);
  return [`${ge(v)}   # P(stat >= ${v})`, `${lt(v)}   # P(stat < ${v})`];
}
// Translate a derived column's token array (lib/expr.js) into a code expression over the collected
// vectors. `refOf(id)` resolves a referenced stat-id to its emitted vector reference, or null if it
// can't be emitted (e.g. a derived-of-derived operand) — in which case the whole thing returns null.
function derivedExprCode(tokens, refOf, lang) {
  const out = [];
  for (const t of tokens || []) {
    if (t.k === "num") out.push(String(t.v));
    else if (t.k === "col") { const r = refOf(t.id); if (r == null) return null; out.push(r); }
    else if (t.k === "op") out.push(t.v === "^" ? (lang === "r" ? " ^ " : " ** ") : ` ${t.v} `);
    else if (t.k === "fn") out.push(lang === "r" ? t.v : "np." + t.v);   // sqrt | abs
    else if (t.k === "lp") out.push("(");
    else if (t.k === "rp") out.push(")");
  }
  return out.join("").trim();
}
// The inference body lines for a divider: optional setup (py list→array conversions, or a derived-
// column definition built from its operands) then `dividerExprs` over the target vector. `vecRef(e)`
// gives an emitted stat's collected-vector reference in this path (R: bare name compact / dist$x
// split; Python: samp_dist['x']); `emittedOf(id)` maps a tracked stat-id to its emitted name (or null);
// `arrayize(e)` (py compact only) turns a collected list into a numpy array. Returns string[] of
// lines, or null when the divider sits on something we can't emit (derived with a missing operand).
// Resolve a divider/overlay spec ({ id } | { derived }) to its target vector reference plus any
// setup lines: py list→array conversions, and — for a derived column — its definition built from
// the operand vectors. Returns { setup, target } or null when an operand can't be emitted.
function resolveTarget(spec, lang, emittedOf, vecRef, arrayize) {
  const setup = [], done = new Set();
  const azOnce = e => { if (!arrayize || done.has(e)) return; done.add(e); setup.push(...arrayize(e)); };
  if (spec.derived) {
    const colIds = (spec.derived.tokens || []).filter(t => t.k === "col").map(t => t.id);
    for (const id of colIds) if (emittedOf(id) == null) return null;
    colIds.forEach(id => azOnce(emittedOf(id)));
    const expr = derivedExprCode(spec.derived.tokens, id => { const e = emittedOf(id); return e == null ? null : vecRef(e); }, lang);
    if (expr == null) return null;
    const vn = safeVarName(spec.derived.name);   // the column's name → a valid identifier (else "derived")
    setup.push((lang === "r" ? vn + " <- " : vn + " = ") + expr + "   # the plotted derived column");
    return { setup, target: vn };
  }
  azOnce(spec.id);
  return { setup, target: vecRef(spec.id) };
}
function dividerBody(div, lang, emittedOf, vecRef, arrayize) {
  const r = resolveTarget(div, lang, emittedOf, vecRef, arrayize);
  if (!r) return null;
  return [...r.setup, ...dividerExprs(r.target, div, lang)];
}
// The plot-overlay summaries (boxplot / mean / ±1 SD on the Collect plot) the host reports via
// `cfg.overlays` ({ statId, mean, sd, box } | null), resolved to the matched enabled stat. Skipped
// on a derived / un-enabled column (not emitted, like the divider). Independent of the divider.
function overlayInfo(cfg, stats) {
  const o = cfg.overlays;
  if (!o || o.statId == null || !(o.mean || o.sd || o.box)) return null;
  const flags = { mean: !!o.mean, sd: !!o.sd, box: !!o.box };
  const match = stats.find(({ s }) => s.id === o.statId);
  if (match) return { ...flags, id: match.id };
  // A derived column is plotted (e.g. a difference of means): summarize it from its operands,
  // exactly as the divider does (which must be enabled plain stats).
  const der = (cfg.trackedStats || []).find(s => s && s.kind === "derived" && s.id === o.statId);
  if (der) return { ...flags, derived: der };
  return null;
}
// Overlay lines over the target stat's collected vector. fivenum (R) / .describe() (py) give the
// five-number summary; SD is the sample SD (matches the tool and the `sd` statistic). A plain stat's
// bare list is accepted by np.mean / pd.Series directly; a derived column is built from its
// operands first via `resolveTarget` (which arrayizes them in the py compact path so arithmetic works).
function overlayBody(ov, lang, emittedOf, vecRef, arrayize) {
  const r = resolveTarget(ov, lang, emittedOf, vecRef, arrayize);
  if (!r) return null;
  const v = r.target, R = lang === "r", out = [];
  if (ov.mean) out.push((R ? `mean(${v})` : `np.mean(${v})`) + "   # center of the sampling distribution");
  if (ov.sd)   out.push((R ? `sd(${v})` : `pd.Series(${v}).std()`) + "   # spread (sample SD)");
  if (ov.box)  out.push((R ? `fivenum(${v})` : `pd.Series(${v}).describe().loc[['min', '25%', '50%', '75%', 'max']]`) + "   # five-number summary");
  return out.length ? [...r.setup, ...out] : null;
}
// Assemble the whole inference section over the collected vectors: the divider's inference (if its
// tool is on) plus the plot-overlay summaries (if any are on) — both can appear. `vecRef(name)`
// resolves an emitted stat's collected vector in this path; `arrayize` (py compact) converts a list
// to a numpy array for the divider's vectorized comparisons. Empty when nothing is enabled/emittable.
function inferenceBody(cfg, stats, lang, vecRef, arrayize) {
  const emittedById = {}; stats.forEach(({ s, id }) => emittedById[s.id] = id);
  const emittedOf = id => (emittedById[id] != null ? emittedById[id] : null);
  const out = [];
  const div = dividerInfo(cfg, stats);
  if (div) {
    const body = dividerBody(div, lang, emittedOf, vecRef, arrayize);
    if (body) { out.push("# Inference from the sampling distribution (divider)"); body.forEach(t => out.push(t)); }
  }
  const ov = overlayInfo(cfg, stats);
  if (ov) {
    // A plain stat's vector is summarized directly (no array conversion); a derived column needs
    // its operands arrayized (py compact) to do arithmetic, like the divider.
    const body = overlayBody(ov, lang, emittedOf, vecRef, ov.derived ? arrayize : null);
    if (body) { out.push("# Summary of the sampling distribution (plot overlays)"); body.forEach(t => out.push(t)); }
  }
  return out;
}
const NO_INFERENCE = "# Turn on the Divider tool or a plot overlay (mean / SD / boxplot) on the Collect plot to generate inference code";

// ─── Region predicate for countBetween / propBetween (mirrors computeStat's inR) ─
// Elementwise on a vector/Series in both languages, so `&` (not R's `&&` / Python's `and`).
function regionExpr(xExpr, s, lang) {
  const num = v => String(parseFloat(Number(v).toFixed(4)));
  const parts = [];
  if (s.lo != null) parts.push(`${xExpr} ${s.loOpen ? ">" : ">="} ${num(s.lo)}`);
  if (s.hi != null) parts.push(`${xExpr} ${s.hiOpen ? "<" : "<="} ${num(s.hi)}`);
  if (!parts.length) return lang === "r" ? "TRUE" : "True";
  return parts.length > 1 ? parts.map(p => `(${p})`).join(" & ") : parts[0];
}

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  COMPACT PATH — no fork, fixed n, single-column stats: one vector per device    ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

// The Python population-definition line for one device (compact path), or null when the device is
// CSV-sourced (the draw reads `df` directly). Mirrors the read_csv path's one-column DataFrame:
// a pool device (stacks/mixer) becomes the EXPANDED population (each label repeated by its count,
// via np.repeat) so the draw is just .sample(replace=…) with no weights; a spinner keeps distinct
// labels (its fractional pct weights are applied at draw time). Shared by genCompact + genIntegrated.
function popDefPy(col, dev) {
  if (devSource(dev)) return null;
  const { labels, weights } = outcomeSpec(dev);
  if (!labels.length) return `pop_${col} = pd.DataFrame({${key(col)}: []})`;
  const allOnes = weights.every(w => w === 1);
  const colVals = (isPool(dev) && !allOnes) ? `np.repeat(${vec(labels, "py")}, [${weights.join(", ")}])` : vec(labels, "py");
  return `pop_${col} = pd.DataFrame({${key(col)}: ${colVals}})`;
}
// The whole-sample draw expression for one device (compact path).
function drawVec(col, dev, lang) {
  const src = devSource(dev);
  if (src) { const rep = dev.withReplacement !== false; return lang === "r"
    ? `${col} <- sample(${srcCol(src, "df", "r")}, n${rep ? ", replace = TRUE" : ""})`
    : `${col} = ${srcCol(src, "df", "py")}.sample(n, replace=${rep ? "True" : "False"})`; }
  const { labels, weights, uniform, replace } = outcomeSpec(dev);
  const pool = isPool(dev), allOnes = weights.every(w => w === 1);
  if (!labels.length) return lang === "r" ? `${col} <- NA` : `${col} = pop_${col}[${key(col)}].sample(n, replace=True)`;
  if (lang === "r") {
    if (labels.length === 1) return `${col} <- rep(${lit(labels[0])}, n)`;   // avoids R's sample(c(5),n) 1:5 trap, valid WR & WoR
    if (pool) {
      // Expanded finite pool: with-/without-replacement is only the `replace` flag (no prob).
      const popExpr = allOnes ? vec(labels, "r") : `rep(${vec(labels, "r")}, c(${weights.join(", ")}))`;
      return `${col} <- sample(${popExpr}, n${replace ? ", replace = TRUE" : ""})`;
    }
    const prob = uniform ? "" : `, prob = c(${weights.join(", ")})`;   // spinner: weighted, always WR
    return `${col} <- sample(${vec(labels, "r")}, n, replace = TRUE${prob})`;
  }
  if (pool) return `${col} = pop_${col}[${key(col)}].sample(n, replace=${replace ? "True" : "False"})`;
  const w = uniform ? "" : `, weights=[${weights.join(", ")}]`;   // spinner: weighted, always WR
  return `${col} = pop_${col}[${key(col)}].sample(n, replace=True${w})`;
}
// Python compact: each device is drawn as its own vector (one line per device, via `drawVec`),
// then those vectors are assembled into one per-sample DataFrame `sample` so every statistic is
// computed with familiar pandas/df syntax (reusing the split path's `pyStatAssign`). `.values`
// strips each draw's random index so the columns align by position (without it a multi-column
// DataFrame misaligns into NaN). `statDfLinePy` builds the post-loop sampling-distribution
// `samp_dist` from the collected stat lists. Shared by genCompact + genIntegrated.
function sampleFrameLinePy(cfg, names) {
  const cells = cfg.pipeline.map(st => `${key(names[st.id])}: ${names[st.id]}.values`);
  return `sample = pd.DataFrame({${cells.join(", ")}})`;
}
const statDfLinePy = stats => `samp_dist = pd.DataFrame({${stats.map(({ id }) => `${key(id)}: ${id}`).join(", ")}})`;
// The column expression an R compact statistic reads: the device's bare length-n vector, subset
// to a group when the stat is conditional (`condVar`). (Python compact reads off the `sample`
// frame via `pyStatAssign`, so this is R-only now.)
function compactCol(s, names) {
  const v = names[s.variable];
  return s.condVar ? `${v}[${names[s.condVar]} == ${lit(s.condVal)}]` : v;
}
// True when any compact statistic needs statsmodels (Python regression import).
const compactNeedsSm = stats => stats.some(({ s }) => s.fn === "slope" || s.fn === "intercept");
// True when the Python compact path needs the per-sample `sample` DataFrame: only regression
// (smf.ols wants a frame). Plain + group stats compute off the bare device Series, mirroring R.
const compactNeedsFrame = compactNeedsSm;
// True when the Python compact path references numpy — only `np.repeat` in popDefPy (a pool
// device with unequal counts). Without it the bare-Series stats are pure pandas, so the
// `import numpy as np` line would be dead; gate it on this.
const compactNeedsNp = cfg => (cfg.pipeline || []).some(st => {
  const d = defDevice(st); return isPool(d) && !outcomeSpec(d).weights.every(w => w === 1);
});
// One R compact statistic as a value expression. Regression (slope/intercept) fits `lm(y ~ x)`
// directly on the drawn vectors (no data frame needed); everything else is `vStat` over one
// (optionally group-subset) vector. (Python compact uses the `sample`-frame path; see genCompact.)
function compactStatExpr(s, names) {
  if (s.fn === "slope" || s.fn === "intercept") {
    const v = names[s.variable], v2 = names[s.variable2];
    return `unname(coef(lm(${v2} ~ ${v}))[${s.fn === "slope" ? 2 : 1}])`;
  }
  return vStat(s, compactCol(s, names), "r");
}
// Python compact, mirroring `compactStatExpr`: assignment line(s) for one statistic off the bare
// device Series. Plain → `vStat(series)`; group (condVar) → a positional boolean mask
// (`series[(group == val).values]`) so the cross-device subset aligns by position without a frame
// (the numpy bool array indexes positionally, sidestepping each `.sample()`'s mismatched index);
// regression → `smf.ols` over the `sample` frame (built only when regression is present). `target`
// wraps the value into its assignment (`id = …` single / `id.append(…)` collect loop).
function compactStatLinesPy(s, id, names, target) {
  if (s.fn === "slope" || s.fn === "intercept")
    return [target(pyStatExpr(s, names[s.variable], names[s.variable2], "sample"))];
  const v = names[s.variable];
  const col = s.condVar ? `${v}[(${names[s.condVar]} == ${lit(s.condVal)}).values]` : v;
  return [target(vStat(s, col, "py"))];
}
// The inline statistic expression over the drawn column `v` (an R vector / a pandas Series).
function vStat(s, v, lang) {
  if (lang === "r") {
    switch (s.fn) {
      case "mean": return `mean(${v})`;
      case "median": return `median(${v})`;
      case "sd": return `sd(${v})`;
      case "min": return `min(${v})`;
      case "max": return `max(${v})`;
      case "q1": return `as.numeric(quantile(${v}, 0.25, type = 7))`;
      case "q3": return `as.numeric(quantile(${v}, 0.75, type = 7))`;
      case "count": return `length(${v})`;
      case "countVal": return `sum(${v} == ${lit(s.target)})`;
      case "proportion": return `mean(${v} == ${lit(s.target)})`;
      case "countBetween": return `sum(${regionExpr(v, s, "r")})`;
      case "propBetween": return `mean(${regionExpr(v, s, "r")})`;
      default: return "NA";
    }
  }
  switch (s.fn) {
    case "mean": return `${v}.mean()`;
    case "median": return `${v}.median()`;
    case "sd": return `${v}.std()`;
    case "min": return `${v}.min()`;
    case "max": return `${v}.max()`;
    case "q1": return `${v}.quantile(0.25)`;
    case "q3": return `${v}.quantile(0.75)`;
    case "count": return `len(${v})`;
    case "countVal": return `(${v} == ${lit(s.target)}).sum()`;
    case "proportion": return `(${v} == ${lit(s.target)}).mean()`;
    case "countBetween": return `(${regionExpr(v, s, "py")}).sum()`;
    case "propBetween": return `(${regionExpr(v, s, "py")}).mean()`;
    default: return "float('nan')";
  }
}

function genCompact(cfg, names, lang) {
  const stats = withIds(plainStats(cfg), names);
  const mk = section => { const a = []; a.push = t => Array.prototype.push.call(a, { text: t, section }); return a; };
  const first = stats[0];

  if (lang === "r") {
    const sampler = mk("sampler");
    sampler.push("# Sampler — draw one sample of n from each device");
    if (anySource(cfg)) sampler.push(`df <- read.csv(${JSON.stringify(csvFile(cfg))})`);
    sampler.push(`n <- ${cfg.sampleSize}`);
    cfg.pipeline.forEach(st => sampler.push(drawVec(names[st.id], defDevice(st), "r")));

    const single = mk("single");
    if (!stats.length) single.push("# Enable a statistic (click a value on the plot) to compute it here");
    else { single.push("# One value per enabled statistic (this sample)"); stats.forEach(({ s, id }) => single.push(`${id} <- ${compactStatExpr(s, names)}`)); }

    const collect = mk("collect");
    if (!stats.length) collect.push("# Enable a statistic to collect its sampling distribution");
    else {
      collect.push(`N <- ${collectN(cfg)}${collectNote(cfg)}`);
      stats.forEach(({ id }) => collect.push(`${id} <- numeric(N)`));
      collect.push("for (i in 1:N) {");
      cfg.pipeline.forEach(st => collect.push("  " + drawVec(names[st.id], defDevice(st), "r")));
      stats.forEach(({ s, id }) => collect.push(`  ${id}[i] <- ${compactStatExpr(s, names)}`));
      collect.push("}");
    }

    const inference = mk("inference");
    compactInfLines(cfg, stats, "r").forEach(([t]) => inference.push(t));
    return { sampler, single, collect, inference };
  }

  // Python (pandas / numpy) — each device is drawn as its own vector, then assembled into the
  // per-sample DataFrame `sample`; every statistic is computed off `sample` with df syntax.
  const needsFrame = compactNeedsFrame(stats);
  const sampler = mk("sampler");
  sampler.push("import pandas as pd");
  if (compactNeedsNp(cfg)) sampler.push("import numpy as np");
  if (compactNeedsSm(stats)) sampler.push("import statsmodels.formula.api as smf");
  sampler.push("");
  sampler.push("# Sampler — draw one sample of n (one vector per device)");
  if (anySource(cfg)) sampler.push(`df = pd.read_csv(${JSON.stringify(csvFile(cfg))})`);
  sampler.push(`n = ${cfg.sampleSize}`);
  cfg.pipeline.forEach(st => { const pd = popDefPy(names[st.id], defDevice(st)); if (pd) sampler.push(pd); });
  cfg.pipeline.forEach(st => sampler.push(drawVec(names[st.id], defDevice(st), "py")));
  if (needsFrame) sampler.push(sampleFrameLinePy(cfg, names));

  const single = mk("single");
  if (!stats.length) single.push("# Enable a statistic (click a value on the plot) to compute it here");
  else { single.push("# One value per enabled statistic (this sample)"); stats.forEach(({ s, id }) => compactStatLinesPy(s, id, names, e => `${id} = ${e}`).forEach(t => single.push(t))); }

  const collect = mk("collect");
  if (!stats.length) collect.push("# Enable a statistic to collect its sampling distribution");
  else {
    collect.push(`N = ${collectN(cfg)}${collectNote(cfg)}`);
    stats.forEach(({ id }) => collect.push(`${id} = []`));
    collect.push("for i in range(N):");
    cfg.pipeline.forEach(st => collect.push("    " + drawVec(names[st.id], defDevice(st), "py")));
    if (needsFrame) collect.push("    " + sampleFrameLinePy(cfg, names));
    stats.forEach(({ s, id }) => compactStatLinesPy(s, id, names, e => `${id}.append(${e})`).forEach(t => collect.push("    " + t)));
    collect.push(statDfLinePy(stats));
  }

  const inference = mk("inference");
  compactInfLines(cfg, stats, "py").forEach(([t]) => inference.push(t));
  return { sampler, single, collect, inference };
}

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  SPLIT PATH — forks, run-until, or multi-column stats need per-row drawing      ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

// Without-replacement pool devices in the split path. Per the tool, each branch device keeps its
// own pool (per-branch pools never bleed), so each WoR stacks/mixer branch gets a uniquely-named
// pool, reset per sample and drawn with removal. Returns [{ devId, name, labels, weights, source }]
// keyed by a safe, readable pool name derived from the owning stage's identifier. A CSV-sourced WoR
// device carries its `source` so the pool template reads the data column (not a literal vector);
// spinner/WR devices are excluded (spinner is always WR, WR draws are i.i.d.).
function worPools(pipeline, names) {
  const out = [], used = new Set();
  (pipeline || []).forEach(st => {
    (st.branches || []).forEach((b, bi) => {
      const dev = b.device;
      if (!isPool(dev) || dev.withReplacement !== false) return;
      const src = devSource(dev);
      const { labels, weights } = outcomeSpec(dev);
      if (!src && !labels.length) return;
      let base = `pool_${names[st.id]}` + (st.branches.length > 1 ? `_${bi + 1}` : ""), nm = base, k = 2;
      while (used.has(nm)) nm = base + "_" + k++;
      used.add(nm);
      out.push({ devId: dev.id, name: nm, labels, weights, source: src });
    });
  });
  return out;
}
// One device → a single-draw expression (per row). Length-1 outcome → the literal itself
// (deterministic, and sidesteps R's `sample(c(5), 1)` "sample from 1:5" trap). A WoR pool device
// (`pools[dev.id]` set) draws-with-removal from its per-sample pool; everything else is i.i.d.
function weighted(labels, w, lang) {
  const allEq = w.every(x => x === w[0]);
  if (lang === "r") return allEq ? `sample(${vec(labels, "r")}, 1)` : `sample(${vec(labels, "r")}, 1, prob = c(${w.join(", ")}))`;
  return allEq ? `random.choices(${vec(labels, "py")})[0]` : `random.choices(${vec(labels, "py")}, weights = [${w.join(", ")}])[0]`;
}
function deviceDraw(dev, lang, pools) {
  // A WoR device (pool set) draws-with-removal first — including a CSV-sourced WoR device, whose
  // pool template is the data column. Check this before the sourced branch (which is WR per row).
  const poolName = pools && pools[dev.id];
  if (poolName) {
    // Draw one unit from the finite pool and remove it (without replacement, within this sample).
    // An exhausted pool yields "" — matching the tool, where an empty without-replacement device
    // returns an empty string (drawStacks/drawMixer → null) rather than erroring.
    if (lang === "r") return `if (length(${poolName}) > 0) { i <- sample(length(${poolName}), 1); v <- ${poolName}[i]; ${poolName} <<- ${poolName}[-i]; v } else ""`;
    const pk = `pools[${key(poolName)}]`;
    return `(${pk}.pop(random.randrange(len(${pk}))) if ${pk} else "")`;
  }
  const src = devSource(dev);
  if (src) return lang === "r" ? `sample(${srcCol(src, "pop", "r")}, 1)` : `${srcCol(src, "df", "py")}.sample(1).iloc[0]`;
  const { labels, weights } = outcomeSpec(dev);
  if (!labels.length) return lang === "r" ? "NA" : "None";
  if (labels.length === 1) return lit(labels[0]);
  return weighted(labels, weights, lang);
}
// One stage → an assignment block, mirroring `selectBranch` (conditional branches in order,
// then the default `else`).
function stageBlock(stage, names, lang, pools) {
  const name = names[stage.id];
  const conds = stage.branches.filter(b => b.condVar !== null);
  const def = stage.branches.find(b => b.condVar === null) || stage.branches[0];
  if (!conds.length) {
    return [lang === "r" ? `  ${name} <- ${deviceDraw(def.device, "r", pools)}` : `    ${name} = ${deviceDraw(def.device, "py", pools)}`];
  }
  if (lang === "r") {
    const out = [];
    conds.forEach((b, i) => {
      const head = i === 0 ? "if" : "} else if";
      out.push(`  ${i === 0 ? name + " <- " : ""}${head} (${names[b.condVar]} == ${lit(b.condVal)}) {`);
      out.push(`    ${deviceDraw(b.device, "r", pools)}`);
    });
    out.push(`  } else {`);
    out.push(`    ${deviceDraw(def.device, "r", pools)}  # otherwise`);
    out.push(`  }`);
    return out;
  }
  const out = [];
  conds.forEach((b, i) => {
    out.push(`    ${i === 0 ? "if" : "elif"} ${names[b.condVar]} == ${lit(b.condVal)}:`);
    out.push(`        ${name} = ${deviceDraw(b.device, "py", pools)}`);
  });
  out.push(`    else:`);
  out.push(`        ${name} = ${deviceDraw(def.device, "py", pools)}  # otherwise`);
  return out;
}
// Run-until stop predicate (mirrors `stopReached`).
function stopPredicate(rule, names, src, lang) {
  const col = names[rule.stageId], n = rule.n || 1;
  if (lang === "r") {
    const c = `${src}$${col}`;
    if (rule.kind === "outcome") return `any(${c} == ${lit(rule.value)})`;
    if (rule.kind === "count") return `sum(${c} == ${lit(rule.value)}) >= ${n}`;
    return `length(unique(${c})) >= ${n}`;
  }
  const c = `r[${key(col)}]`;
  if (rule.kind === "outcome") return `any(${c} == ${lit(rule.value)} for r in ${src})`;
  if (rule.kind === "count") return `sum(1 for r in ${src} if ${c} == ${lit(rule.value)}) >= ${n}`;
  return `len(set(${c} for r in ${src})) >= ${n}`;
}

// One statistic as a single expression over a data-frame expression `D` (the sample, or a
// row-subset of it). Mirrors `computeStat`/`rStatExpr`.
function rStatExpr(s, v, v2, D) {
  const x = `${D}$${v}`;
  switch (s.fn) {
    case "count": return `nrow(${D})`;
    case "countVal": return `sum(${x} == ${lit(s.target)})`;
    case "proportion": return `mean(${x} == ${lit(s.target)})`;
    case "mean": return `mean(${x})`;
    case "sd": return `sd(${x})`;
    case "median": return `median(${x})`;
    case "min": return `min(${x})`;
    case "max": return `max(${x})`;
    case "q1": return `as.numeric(quantile(${x}, 0.25, type = 7))`;
    case "q3": return `as.numeric(quantile(${x}, 0.75, type = 7))`;
    case "slope": return `unname(coef(lm(${v2} ~ ${v}, data = ${D}))[2])`;
    case "intercept": return `unname(coef(lm(${v2} ~ ${v}, data = ${D}))[1])`;
    case "countBetween": return `sum(${regionExpr(x, s, "r")})`;
    case "propBetween": return `mean(${regionExpr(x, s, "r")})`;
    default: return "NA";
  }
}
function pyStatExpr(s, v, v2, D) {
  const c = `${D}[${key(v)}]`;
  switch (s.fn) {
    case "count": return `len(${D})`;
    case "countVal": return `(${c} == ${lit(s.target)}).sum()`;
    case "proportion": return `(${c} == ${lit(s.target)}).mean()`;
    case "mean": return `${c}.mean()`;
    case "sd": return `${c}.std()`;
    case "median": return `${c}.median()`;
    case "min": return `${c}.min()`;
    case "max": return `${c}.max()`;
    case "q1": return `${c}.quantile(0.25)`;
    case "q3": return `${c}.quantile(0.75)`;
    case "slope": return `smf.ols(${key(`${v2} ~ ${v}`)}, data=${D}).fit().params[${key(v)}]`;
    case "intercept": return `smf.ols(${key(`${v2} ~ ${v}`)}, data=${D}).fit().params["Intercept"]`;
    case "countBetween": return `(${regionExpr(c, s, "py")}).sum()`;
    case "propBetween": return `(${regionExpr(c, s, "py")}).mean()`;
    default: return "float('nan')";
  }
}
// One stat as a value expression over R data-frame `D` — group stats subset it in a block.
function rStatValue(s, names, D = "df") {
  const v = names[s.variable], v2 = names[s.variable2];
  if (s.condVar) return `{ sub <- ${D}[${D}$${names[s.condVar]} == ${lit(s.condVal)}, , drop = FALSE]; ${rStatExpr(s, v, v2, "sub")} }`;
  return rStatExpr(s, v, v2, D);
}
// Per-stat assignment line(s) over Python data-frame `D`, at indent `ind`. `target(expr)` wraps
// the computed value into its assignment (`id = …` for the single sample, `id.append(…)` inside
// the collect loop). A group (condVar) stat slices `sub` first, mirroring computeStat.
function pyStatAssign(s, id, names, D, ind, target) {
  const v = names[s.variable], v2 = names[s.variable2];
  if (s.condVar) return [`${ind}sub = ${D}[${D}[${key(names[s.condVar])}] == ${lit(s.condVal)}]`,
    `${ind}${target(pyStatExpr(s, v, v2, "sub"))}`];
  return [`${ind}${target(pyStatExpr(s, v, v2, D))}`];
}

function genSplit(cfg, names, lang) {
  const { pipeline, sampleSize, runMode, stopRule } = cfg;
  const until = runMode === "until" && stopRule && stopRule.stageId;
  const cap = until ? "max_draws" : "n";
  // Per-branch without-replacement pools (stacks/mixer drawn WoR). The pool map keys deviceDraw's
  // draw-with-removal expression; templates are reset per sample.
  const pools = worPools(pipeline, names), hasPools = pools.length > 0;
  const poolMap = {}; pools.forEach(p => poolMap[p.devId] = p.name);
  // Pool template: a CSV-sourced WoR device draws from its data column (`pop$var`); a literal one
  // from its expanded counts. Every WoR device is now pool-backed, so there's no with-replacement
  // caveat anymore (sourced WoR used to be flagged-but-approximated).
  const tmplR = p => `${p.name}_template <- ` + (p.source ? srcCol(p.source, "pop", "r") : (p.weights.every(w => w === 1) ? vec(p.labels, "r") : `rep(${vec(p.labels, "r")}, c(${p.weights.join(", ")}))`));
  const tmplPy = p => `${p.name}_template = list(` + (p.source ? srcCol(p.source, "df", "py") : (p.weights.every(w => w === 1) ? vec(p.labels, "py") : `np.repeat(${vec(p.labels, "py")}, [${p.weights.join(", ")}])`)) + ")";
  const poolInitPy = `pools = {${pools.map(p => `${key(p.name)}: list(${p.name}_template)`).join(", ")}}`;
  const stats = withIds(plainStats(cfg), names);
  const needsSm = stats.some(({ s }) => s.fn === "slope" || s.fn === "intercept");
  const first = stats[0];
  // `push(text)` tags the line with the array's own section; `push(text, sec)` overrides it — so a
  // draw / statistic line inside the For-loop can carry its true section (★ sampler / ● single) for
  // the integrated gutter, even though it lives in the green ▲ collect array.
  const mk = section => { const a = []; a.push = (t, sec) => Array.prototype.push.call(a, { text: t, section: sec || section }); return a; };

  if (lang === "r") {
    const sampler = mk("sampler");
    sampler.push("# Sampler — draw one row through the pipeline");
    if (anySource(cfg)) sampler.push(`pop <- read.csv(${JSON.stringify(csvFile(cfg))})`);
    if (hasPools) {
      sampler.push("# Without-replacement pools — reset per sample, then drawn with removal");
      if (until) sampler.push("# (a pool can empty before the stop rule holds; the safety cap bounds the draws)");
      pools.forEach(p => sampler.push(tmplR(p)));
    }
    sampler.push("draw_one <- function() {");
    pipeline.forEach(st => stageBlock(st, names, "r", poolMap).forEach(t => sampler.push(t)));
    sampler.push("  data.frame(" + pipeline.map(st => `${names[st.id]} = ${names[st.id]}`).join(", ") + ", stringsAsFactors = FALSE)");
    sampler.push("}");
    sampler.push("");
    if (until) {
      sampler.push("# Draw rows until the stop rule holds (n varies), capped at max_draws");
      sampler.push("draw_sample <- function(max_draws) {");
      pools.forEach(p => sampler.push(`  ${p.name} <<- ${p.name}_template`));
      sampler.push("  rows <- list()");
      sampler.push("  repeat {");
      sampler.push("    rows[[length(rows) + 1]] <- draw_one()");
      sampler.push("    df <- do.call(rbind, rows)");
      sampler.push(`    if (${stopPredicate(stopRule, names, "df", "r")}) break`);
      sampler.push("    if (length(rows) >= max_draws) break");
      sampler.push("  }");
      sampler.push("  do.call(rbind, rows)");
      sampler.push("}");
    } else {
      sampler.push("# A sample = n rows drawn through the pipeline");
      if (hasPools) {
        sampler.push("draw_sample <- function(n) {");
        pools.forEach(p => sampler.push(`  ${p.name} <<- ${p.name}_template`));
        sampler.push("  do.call(rbind, lapply(seq_len(n), function(i) draw_one()))");
        sampler.push("}");
      } else {
        sampler.push("draw_sample <- function(n) do.call(rbind, lapply(seq_len(n), function(i) draw_one()))");
      }
    }
    sampler.push("");
    sampler.push(`${cap} <- ${sampleSize}` + (until ? "   # safety cap (max draws)" : "   # sample size"));

    const single = mk("single");
    if (!stats.length) single.push("# Enable a statistic (click a value on the plot) to compute it here");
    else {
      single.push("# Draw one sample, then one value per enabled statistic");
      single.push(`df <- draw_sample(${cap})`);
      stats.forEach(({ s, id }) => single.push(`${id} <- ${rStatValue(s, names)}`));
    }

    const collect = mk("collect");
    if (!stats.length) collect.push("# Enable a statistic to collect its sampling distribution");
    else {
      collect.push(`N <- ${collectN(cfg)}${collectNote(cfg)}`);
      stats.forEach(({ id }) => collect.push(`${id} <- numeric(N)`));
      collect.push("for (i in 1:N) {");
      collect.push(`  df <- draw_sample(${cap})`, "sampler");
      stats.forEach(({ s, id }) => collect.push(`  ${id}[i] <- ${rStatValue(s, names)}`, "single"));
      collect.push("}");
      collect.push(`dist <- data.frame(${stats.map(({ id }) => id).join(", ")})`);
    }

    const inference = mk("inference");
    if (!first) inference.push("# Enable a statistic, then collect samples, to do inference");
    else {
      const lines = inferenceBody(cfg, stats, "r", e => `dist$${e}`, null);
      if (lines.length) lines.forEach(t => inference.push(t));
      else inference.push(NO_INFERENCE);
    }
    return { sampler, single, collect, inference };
  }

  // Python (pandas / numpy / statsmodels)
  const sampler = mk("sampler");
  sampler.push("import random");
  sampler.push("import pandas as pd");
  sampler.push("import numpy as np");
  if (needsSm) sampler.push("import statsmodels.formula.api as smf");
  sampler.push("");
  sampler.push("# Sampler — draw one row through the pipeline");
  if (anySource(cfg)) sampler.push(`df = pd.read_csv(${JSON.stringify(csvFile(cfg))})`);
  if (hasPools) {
    sampler.push("# Without-replacement pools — reset per sample, then drawn with removal");
    if (until) sampler.push("# (a pool can empty before the stop rule holds; the safety cap bounds the draws)");
    pools.forEach(p => sampler.push(tmplPy(p)));
    sampler.push("");
  }
  sampler.push(hasPools ? "def draw_one(pools):" : "def draw_one():");
  pipeline.forEach(st => stageBlock(st, names, "py", poolMap).forEach(t => sampler.push(t)));
  sampler.push("    return {" + pipeline.map(st => `${key(names[st.id])}: ${names[st.id]}`).join(", ") + "}");
  sampler.push("");
  const drawCall = hasPools ? "draw_one(pools)" : "draw_one()";
  if (until) {
    sampler.push("# Draw rows until the stop rule holds (n varies), capped at max_draws");
    sampler.push("def draw_sample(max_draws):");
    if (hasPools) sampler.push("    " + poolInitPy);
    sampler.push("    rows = []");
    sampler.push("    while True:");
    sampler.push(`        rows.append(${drawCall})`);
    sampler.push(`        if ${stopPredicate(stopRule, names, "rows", "py")}: break`);
    sampler.push("        if len(rows) >= max_draws: break");
    sampler.push("    return pd.DataFrame(rows)");
  } else {
    sampler.push("# A sample = n rows drawn through the pipeline");
    sampler.push("def draw_sample(n):");
    if (hasPools) sampler.push("    " + poolInitPy);
    sampler.push(`    return pd.DataFrame([${drawCall} for _ in range(n)])`);
  }
  sampler.push("");
  sampler.push(`${cap} = ${sampleSize}` + (until ? "   # safety cap (max draws)" : "   # sample size"));

  const single = mk("single");
  if (!stats.length) single.push("# Enable a statistic (click a value on the plot) to compute it here");
  else {
    single.push("# Draw one sample, then one value per enabled statistic");
    single.push(`sample = draw_sample(${cap})`);
    stats.forEach(({ s, id }) => pyStatAssign(s, id, names, "sample", "", e => `${id} = ${e}`).forEach(t => single.push(t)));
  }

  const collect = mk("collect");
  if (!stats.length) collect.push("# Enable a statistic to collect its sampling distribution");
  else {
    collect.push(`N = ${collectN(cfg)}${collectNote(cfg)}`);
    stats.forEach(({ id }) => collect.push(`${id} = []`));
    collect.push("for i in range(N):");
    collect.push(`    sample = draw_sample(${cap})`, "sampler");
    stats.forEach(({ s, id }) => pyStatAssign(s, id, names, "sample", "    ", e => `${id}.append(${e})`).forEach(t => collect.push(t, "single")));
    collect.push(`samp_dist = pd.DataFrame({${stats.map(({ id }) => `${key(id)}: ${id}`).join(", ")}})`);
  }

  const inference = mk("inference");
  if (!first) inference.push("# Enable a statistic, then collect samples, to do inference");
  else {
    const lines = inferenceBody(cfg, stats, "py", e => `samp_dist[${key(e)}]`, null);
    if (lines.length) lines.forEach(t => inference.push(t));
    else inference.push(NO_INFERENCE);
  }
  return { sampler, single, collect, inference };
}

// ─── Top-level ────────────────────────────────────────────────────────────────
// COMPACT when: no fork, fixed n, and every enabled statistic reads a single column.
function isSimple(cfg) {
  const p = cfg.pipeline || [];
  if (cfg.runMode === "until") return false;
  const forked = st => st.branches.length > 1 || st.branches.some(b => b.condVar !== null);
  if (p.some(forked)) return false;
  // Every tracked statistic the compact path can now compute: plain, group (condVar subset), and
  // regression (slope/intercept via lm on vectors / statsmodels over `df`). So the only remaining
  // split triggers are a fork or a run-until rule (both handled above).
  return true;
}

// The inference lines for the compact path over the collected statistics, as [text, section]
// pairs (shared by the distributed panel and the integrated view so they can't diverge). Python
// reads the post-loop sampling-distribution DataFrame `samp_dist` (a column per stat, already a
// Series, so no array conversion); R reads the bare collected vectors (`mean_x`, …).
function compactInfLines(cfg, stats, lang) {
  if (!stats[0]) return [["# Enable a statistic, then collect samples, to do inference", "inference"]];
  const vecRef = lang === "py" ? e => `samp_dist[${key(e)}]` : e => e;
  const lines = inferenceBody(cfg, stats, lang, vecRef, null);
  if (!lines.length) return [[NO_INFERENCE, "inference"]];
  return lines.map(t => [t, "inference"]);
}

// One runnable program with per-line `section` tags driving the color-coded gutter. In the
// compact case the loop body's draws (★ red) and statistics (● orange) sit INSIDE the green
// (▲) for-loop; the split case lays the function defs / loop / inference out in order.
function genIntegrated(cfg, names, lang) {
  const stats = withIds(plainStats(cfg), names);
  const L = [], push = (text, section) => L.push({ text, section });
  if (isSimple(cfg)) {
    const ind = lang === "r" ? "  " : "    ";
    const needsFrame = compactNeedsFrame(stats);
    if (lang === "py") { push("import pandas as pd", "sampler"); if (compactNeedsNp(cfg)) push("import numpy as np", "sampler"); if (compactNeedsSm(stats)) push("import statsmodels.formula.api as smf", "sampler"); push("", "sampler"); }
    push("# Set up the sampler", "sampler");
    if (anySource(cfg)) push(lang === "r" ? `df <- read.csv(${JSON.stringify(csvFile(cfg))})` : `df = pd.read_csv(${JSON.stringify(csvFile(cfg))})`, "sampler");
    push(lang === "r" ? `n <- ${cfg.sampleSize}` : `n = ${cfg.sampleSize}`, "sampler");
    if (lang === "py") cfg.pipeline.forEach(st => { const pd = popDefPy(names[st.id], defDevice(st)); if (pd) push(pd, "sampler"); });
    if (!stats.length) { push("# Enable a statistic (click a value on the plot) to collect a distribution", "collect"); return L; }
    push(lang === "r" ? `N <- ${collectN(cfg)}${collectNote(cfg)}` : `N = ${collectN(cfg)}${collectNote(cfg)}`, "collect");
    stats.forEach(({ id }) => push(lang === "r" ? `${id} <- numeric(N)` : `${id} = []`, "collect"));
    push(lang === "r" ? "for (i in 1:N) {" : "for i in range(N):", "collect");
    cfg.pipeline.forEach(st => push(ind + drawVec(names[st.id], defDevice(st), lang), "sampler"));
    if (lang === "py" && needsFrame) push(ind + sampleFrameLinePy(cfg, names), "sampler");
    stats.forEach(({ s, id }) => {
      if (lang === "r") push(ind + `${id}[i] <- ${compactStatExpr(s, names)}`, "single");
      else compactStatLinesPy(s, id, names, e => `${id}.append(${e})`).forEach(t => push(ind + t, "single"));
    });
    if (lang === "r") push("}", "collect");
    else push(statDfLinePy(stats), "collect");
    push("", "inference");
    compactInfLines(cfg, stats, lang).forEach(([t, sec]) => push(t, sec));
    return L;
  }
  // Split: the sampler defs, the inline collect for-loop, and the inference already carry the
  // right section tags; stitch them in order. The standalone single-sample demo is omitted —
  // the collect loop already draws and computes every sample (mirroring the compact case).
  const secs = genSplit(cfg, names, lang);
  ["sampler", "collect", "inference"].forEach((k, i) => {
    if (i > 0) push("", secs[k][0] ? secs[k][0].section : k);
    secs[k].forEach(ln => push(ln.text, ln.section));
  });
  return L;
}

// When the sampler is concealed (hidden + not revealed), strip the device internals from the
// integrated program: collapse each run of sampler-tagged lines into one placeholder comment,
// keeping the For-loop / Statistics / Inference structure (and its indentation) intact.
function hideSampler(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].section !== "sampler") { out.push(lines[i]); continue; }
    const indent = (lines[i].text.match(/^\s*/) || [""])[0];
    out.push({ text: `${indent}# (sampler hidden)`, section: "sampler" });
    while (i + 1 < lines.length && lines[i + 1].section === "sampler") i++;
  }
  return out;
}

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  ROW-RESAMPLING (CASE) PATH — bootstrap: resample whole rows of a data frame    ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// A row-sample mixer carries `device.rowSample = { headers, rows, dataset }` (see lib/sampling).
// One stage produces MANY columns (one per CSV variable), so the code reads the dataset into a
// frame and resamples its rows — `df[sample(nrow(df), n), ]` (R) / `df.sample(n)` (Python) —
// rather than drawing per device. Statistics read the drawn frame `samp` by CSV-header column.

// The row-sample stage's columns: { headers, map (colId → header), withReplacement, file }.
function rowSampleCols(cfg) {
  const st = (cfg.pipeline || []).find(s => {
    const def = (s.branches || []).find(b => b.condVar === null) || (s.branches || [])[0];
    return def && def.device && def.device.rowSample;
  });
  if (!st) return null;
  const def = st.branches.find(b => b.condVar === null) || st.branches[0];
  const dev = def.device, rsd = dev.rowSample;
  const map = {};
  rsd.headers.forEach((h, ci) => { map[st.id + "::" + ci] = h; });
  return { headers: rsd.headers, map, withReplacement: dev.withReplacement !== false, file: rsd.dataset || "data.csv" };
}
const isRowSample = cfg => !!rowSampleCols(cfg);
// A drawn-frame column reference: R `samp$h` / `samp[["h"]]` (non-syntactic), Python `samp["h"]`.
function rsColRef(colId, rsc, lang) {
  const h = rsc.map[colId];
  if (h == null) return lang === "r" ? "NA" : "float('nan')";
  if (lang === "r") return /^[A-Za-z.][A-Za-z0-9._]*$/.test(h) ? `samp$${h}` : `samp[[${JSON.stringify(h)}]]`;
  return `samp[${JSON.stringify(h)}]`;
}
// One statistic as a value expression over the drawn frame `samp`. Regression fits over the two
// header columns with the SAME idiom as every other regression case — R `lm()` on the column refs,
// Python `smf.ols`. Because a row-sample's columns are raw CSV headers (unlike the sanitized
// identifier names elsewhere), a header that isn't a valid identifier is wrapped in patsy's `Q('…')`
// so the formula parses; the slope's `params` key is then the exact x-term string (e.g. `Q('h')`).
function rsStatExpr(s, rsc, lang) {
  if (s.fn === "slope" || s.fn === "intercept") {
    if (lang === "r") {
      const xref = rsColRef(s.variable, rsc, "r"), yref = rsColRef(s.variable2, rsc, "r");
      return `unname(coef(lm(${yref} ~ ${xref}))[${s.fn === "slope" ? 2 : 1}])`;
    }
    const term = h => /^[A-Za-z_][A-Za-z0-9_]*$/.test(h) ? h : `Q('${String(h).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}')`;
    const tx = term(rsc.map[s.variable]), ty = term(rsc.map[s.variable2]);
    const paramKey = s.fn === "slope" ? tx : "Intercept";
    return `smf.ols(${JSON.stringify(`${ty} ~ ${tx}`)}, data=samp).fit().params[${JSON.stringify(paramKey)}]`;
  }
  const v = rsColRef(s.variable, rsc, lang);
  if (s.condVar) {
    const cond = rsColRef(s.condVar, rsc, lang);
    return lang === "r" ? vStat(s, `${v}[${cond} == ${lit(s.condVal)}]`, "r") : vStat(s, `${v}[(${cond} == ${lit(s.condVal)})]`, "py");
  }
  return vStat(s, v, lang);
}
// The resample line (single sample). Faithfully reflects the device's replacement flag — a
// row-sample is trivially expressible either way (unlike pool devices, no with-replacement caveat).
function rsDrawLine(rsc, lang) {
  const wr = rsc.withReplacement;
  return lang === "r"
    ? `samp <- df[sample(nrow(df), n, replace = ${wr ? "TRUE" : "FALSE"}), ]`
    : `samp = df.sample(n, replace=${wr ? "True" : "False"}, ignore_index=True)`;
}
function genRowSample(cfg, lang) {
  const rsc = rowSampleCols(cfg);
  // Result-vector identifiers (statId) use safe header identifiers; column refs use the raw header.
  const names = {}; Object.keys(rsc.map).forEach(colId => { names[colId] = safeName(rsc.map[colId]); });
  const stats = withIds(plainStats(cfg), names);
  const mk = section => { const a = []; a.push = t => Array.prototype.push.call(a, { text: t, section }); return a; };
  const R = lang === "r", ind = R ? "  " : "    ";
  const drawLine = rsDrawLine(rsc, lang);
  const inf = compactInfLines(cfg, stats, lang);
  const needsSm = !R && stats.some(({ s }) => s.fn === "slope" || s.fn === "intercept");
  const needsNp = !R && inf.some(([t]) => t.includes("np."));

  const sampler = mk("sampler");
  if (!R) { sampler.push("import pandas as pd"); if (needsNp) sampler.push("import numpy as np"); if (needsSm) sampler.push("import statsmodels.formula.api as smf"); sampler.push(""); }
  sampler.push("# Sampler — resample whole rows (cases) from the dataset");
  sampler.push(R ? `df <- read.csv(${JSON.stringify(rsc.file)})` : `df = pd.read_csv(${JSON.stringify(rsc.file)})`);
  sampler.push(R ? `n <- ${cfg.sampleSize}` : `n = ${cfg.sampleSize}`);
  sampler.push(drawLine);

  const single = mk("single");
  if (!stats.length) single.push("# Enable a statistic (click a value on the plot) to compute it here");
  else { single.push("# One value per enabled statistic (this sample)"); stats.forEach(({ s, id }) => single.push(R ? `${id} <- ${rsStatExpr(s, rsc, "r")}` : `${id} = ${rsStatExpr(s, rsc, "py")}`)); }

  const collect = mk("collect");
  if (!stats.length) collect.push("# Enable a statistic to collect its sampling distribution");
  else {
    collect.push(R ? `N <- ${collectN(cfg)}${collectNote(cfg)}` : `N = ${collectN(cfg)}${collectNote(cfg)}`);
    stats.forEach(({ id }) => collect.push(R ? `${id} <- numeric(N)` : `${id} = []`));
    collect.push(R ? "for (i in 1:N) {" : "for i in range(N):");
    collect.push(ind + drawLine);
    stats.forEach(({ s, id }) => collect.push(ind + (R ? `${id}[i] <- ${rsStatExpr(s, rsc, "r")}` : `${id}.append(${rsStatExpr(s, rsc, "py")})`)));
    if (R) collect.push("}"); else collect.push(statDfLinePy(stats));
  }

  const inference = mk("inference");
  inf.forEach(([t]) => inference.push(t));
  return { sampler, single, collect, inference };
}
// The row-sample one-script view (mirrors genIntegrated's compact branch): the resample draw (★)
// and statistics (●) nest inside the green (▲) for-loop, then inference (■).
function genRowSampleIntegrated(cfg, lang) {
  const rsc = rowSampleCols(cfg);
  const names = {}; Object.keys(rsc.map).forEach(colId => { names[colId] = safeName(rsc.map[colId]); });
  const stats = withIds(plainStats(cfg), names);
  const R = lang === "r", ind = R ? "  " : "    ";
  const drawLine = rsDrawLine(rsc, lang);
  const inf = compactInfLines(cfg, stats, lang);
  const needsSm = !R && stats.some(({ s }) => s.fn === "slope" || s.fn === "intercept");
  const needsNp = !R && inf.some(([t]) => t.includes("np."));
  const L = [], push = (text, section) => L.push({ text, section });
  if (!R) { push("import pandas as pd", "sampler"); if (needsNp) push("import numpy as np", "sampler"); if (needsSm) push("import statsmodels.formula.api as smf", "sampler"); push("", "sampler"); }
  push("# Set up the sampler — resample whole rows (cases)", "sampler");
  push(R ? `df <- read.csv(${JSON.stringify(rsc.file)})` : `df = pd.read_csv(${JSON.stringify(rsc.file)})`, "sampler");
  push(R ? `n <- ${cfg.sampleSize}` : `n = ${cfg.sampleSize}`, "sampler");
  if (!stats.length) { push("# Enable a statistic (click a value on the plot) to collect a distribution", "collect"); return L; }
  push(R ? `N <- ${collectN(cfg)}${collectNote(cfg)}` : `N = ${collectN(cfg)}${collectNote(cfg)}`, "collect");
  stats.forEach(({ id }) => push(R ? `${id} <- numeric(N)` : `${id} = []`, "collect"));
  push(R ? "for (i in 1:N) {" : "for i in range(N):", "collect");
  push(ind + drawLine, "sampler");
  stats.forEach(({ s, id }) => push(ind + (R ? `${id}[i] <- ${rsStatExpr(s, rsc, "r")}` : `${id}.append(${rsStatExpr(s, rsc, "py")})`), "single"));
  if (R) push("}", "collect"); else push(statDfLinePy(stats), "collect");
  push("", "inference");
  inf.forEach(([t, sec]) => push(t, sec));
  return L;
}

export function generateCode(cfg, lang) {
  const language = lang === "python" ? "py" : "r";
  if (isRowSample(cfg)) {
    const secs = genRowSample(cfg, language);
    const integrated = cfg.hidden ? hideSampler(genRowSampleIntegrated(cfg, language)) : genRowSampleIntegrated(cfg, language);
    return { ...secs, integrated };
  }
  const names = buildNames(cfg.pipeline || []);
  const { sampler, single, collect, inference } =
    isSimple(cfg) ? genCompact(cfg, names, language) : genSplit(cfg, names, language);
  const integrated = cfg.hidden ? hideSampler(genIntegrated(cfg, names, language)) : genIntegrated(cfg, names, language);
  return { sampler, single, collect, inference, integrated };
}
