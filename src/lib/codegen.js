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
//     single column. Each device is drawn as ONE vector (`sample(c(...), n)` / `pop.sample(n)`)
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
// without-replacement device is flagged in a comment); population SD; type-7 quantiles. Derived
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

// ─── CSV-sourced devices (Fill-from-data) ─────────────────────────────────────
// A device filled from an uploaded CSV column carries `source = { dataset, var }`. Codegen
// then reads the file (read.csv / pd.read_csv) and samples that column instead of inlining a
// literal vector. Only Fill-from-data sets `source`; any manual edit clears it (see devices.jsx).
const devSource = dev => (dev && dev.source && dev.source.var) ? dev.source : null;
// Reference to a sourced column on a read-in data frame `frame`. (The compact path reads into
// `df`; the split path reads into `pop`, since `df` there is the drawn sample.)
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
// A statistic reads a single column (no cross-column alignment) — eligible for the compact path.
const singleColumn = s => !s.condVar && !s.variable2 && s.fn !== "slope" && s.fn !== "intercept";
// A readable, valid identifier for one statistic (its column in the collect table).
function statId(s, names) {
  const v = names[s.variable] || "x", t = s.target != null ? "_" + safeName(s.target) : "";
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

// The Collect-plot divider (lifted from the UI), resolved against the *enabled* stats so the
// inference section can mirror the real cutoff + framing. Returns `{ id, cuts, range, dir, by,
// pct }` keyed by the generated result-vector name, or null (no divider / derived column / off).
const numLit = v => String(parseFloat(Number(v).toFixed(4)));
const pctLabel = f => `${parseFloat((f * 100).toFixed(2))}%`;
function dividerInfo(cfg, stats) {
  const d = cfg.divider;
  if (!d || !d.cuts || !d.cuts.length || d.statId == null) return null;
  const match = stats.find(({ s }) => s.id === d.statId);
  if (!match) return null;
  const cuts = d.cuts.map(Number).filter(v => !isNaN(v));
  if (!cuts.length) return null;
  return { id: match.id, cuts, range: d.range && cuts.length >= 2,
    dir: d.dir === "left" || d.dir === "right" ? d.dir : "none",
    by: d.by === "pct" ? "pct" : "value", pct: typeof d.pct === "number" ? d.pct : 0.05 };
}
// The inference line(s) a divider implies over a vector/Series expression `vec`, by mode:
//   range + value → band proportion P(lo ≤ x ≤ hi)
//   range + pct   → CI: the middle-m percentile interval `quantile(c((1-m)/2, 1-(1-m)/2))`.
//                   A plain percentile interval for the set %, NOT the conservative band the
//                   tool draws — the student-facing code stays simple (won't match the visual
//                   band exactly on discrete data, which is fine).
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
  const quant = a => (R ? `quantile(${vec}, ${a})` : `np.quantile(${vec}, ${a})`);

  if (div.range) {
    if (div.by === "pct") {
      // CI: the middle-m percentile interval for the set % (a plain percentile interval — not
      // the tool's conservative band; simple and student-readable).
      const a = numLit((1 - div.pct) / 2), b = numLit(1 - (1 - div.pct) / 2);
      const args = R ? `c(${a}, ${b})` : `[${a}, ${b}]`;
      return [`${quant(args)}   # middle ${pctLabel(div.pct)} (percentile interval)`];
    }
    const a = numLit(Math.min(div.cuts[0], div.cuts[1])), b = numLit(Math.max(div.cuts[0], div.cuts[1]));
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

// The whole-sample draw expression for one device.
function drawVec(col, dev, lang) {
  const src = devSource(dev);
  if (src) return lang === "r"
    ? `${col} <- sample(${srcCol(src, "df", "r")}, n, replace = TRUE)`
    : `${col} = ${srcCol(src, "df", "py")}.sample(n, replace=True)`;
  const { labels, weights, uniform } = outcomeSpec(dev);
  if (!labels.length) return lang === "r" ? `${col} <- NA` : `${col} = pop_${col}.sample(n, replace=True)`;
  if (lang === "r") {
    if (labels.length === 1) return `${col} <- rep(${lit(labels[0])}, n)`;   // avoids R's sample(c(5),n) 1:5 trap
    const prob = uniform ? "" : `, prob = c(${weights.join(", ")})`;
    return `${col} <- sample(${vec(labels, "r")}, n, replace = TRUE${prob})`;
  }
  const w = uniform ? "" : `, weights=[${weights.join(", ")}]`;
  return `${col} = pop_${col}.sample(n, replace=True${w})`;
}
// The inline statistic expression over the drawn column `v` (an R vector / a pandas Series).
function vStat(s, v, lang) {
  if (lang === "r") {
    switch (s.fn) {
      case "mean": return `mean(${v})`;
      case "median": return `median(${v})`;
      case "sd": return `sqrt(mean((${v} - mean(${v}))^2))`;
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
    case "sd": return `${v}.std(ddof=0)`;
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
  const wor = cfg.pipeline.some(st => outcomeSpec(defDevice(st)).replace === false);
  const mk = section => { const a = []; a.push = t => Array.prototype.push.call(a, { text: t, section }); return a; };
  const first = stats[0];

  if (lang === "r") {
    const sampler = mk("sampler");
    sampler.push("# Sampler — draw one sample of n from each device");
    if (wor) sampler.push("# (a device draws without replacement; this code samples with replacement)");
    if (anySource(cfg)) sampler.push(`df <- read.csv(${JSON.stringify(csvFile(cfg))})`);
    sampler.push(`n <- ${cfg.sampleSize}`);
    cfg.pipeline.forEach(st => sampler.push(drawVec(names[st.id], defDevice(st), "r")));

    const single = mk("single");
    if (!stats.length) single.push("# Enable a statistic (click a value on the plot) to compute it here");
    else { single.push("# One value per enabled statistic (this sample)"); stats.forEach(({ s, id }) => single.push(`${id} <- ${vStat(s, names[s.variable], "r")}`)); }

    const collect = mk("collect");
    if (!stats.length) collect.push("# Enable a statistic to collect its sampling distribution");
    else {
      collect.push(`N <- ${collectN(cfg)}${collectNote(cfg)}`);
      stats.forEach(({ id }) => collect.push(`${id} <- numeric(N)`));
      collect.push("for (i in 1:N) {");
      cfg.pipeline.forEach(st => collect.push("  " + drawVec(names[st.id], defDevice(st), "r")));
      stats.forEach(({ s, id }) => collect.push(`  ${id}[i] <- ${vStat(s, names[s.variable], "r")}`));
      collect.push("}");
    }

    const inference = mk("inference");
    compactInfLines(cfg, stats, "r").forEach(([t]) => inference.push(t));
    return { sampler, single, collect, inference };
  }

  // Python (pandas / numpy)
  const sampler = mk("sampler");
  sampler.push("import pandas as pd");
  sampler.push("import numpy as np");
  sampler.push("");
  sampler.push("# Sampler — draw one sample of n from each device");
  if (wor) sampler.push("# (a device draws without replacement; this code samples with replacement)");
  if (anySource(cfg)) sampler.push(`df = pd.read_csv(${JSON.stringify(csvFile(cfg))})`);
  sampler.push(`n = ${cfg.sampleSize}`);
  cfg.pipeline.forEach(st => {
    const col = names[st.id], dev = defDevice(st);
    if (!devSource(dev)) sampler.push(`pop_${col} = pd.Series(${vec(outcomeSpec(dev).labels, "py")})`);
    sampler.push(drawVec(col, dev, "py"));
  });

  const single = mk("single");
  if (!stats.length) single.push("# Enable a statistic (click a value on the plot) to compute it here");
  else { single.push("# One value per enabled statistic (this sample)"); stats.forEach(({ s, id }) => single.push(`${id} = ${vStat(s, names[s.variable], "py")}`)); }

  const collect = mk("collect");
  if (!stats.length) collect.push("# Enable a statistic to collect its sampling distribution");
  else {
    collect.push(`N = ${collectN(cfg)}${collectNote(cfg)}`);
    stats.forEach(({ id }) => collect.push(`${id} = []`));
    collect.push("for i in range(N):");
    cfg.pipeline.forEach(st => collect.push("    " + drawVec(names[st.id], defDevice(st), "py")));
    stats.forEach(({ s, id }) => collect.push(`    ${id}.append(${vStat(s, names[s.variable], "py")})`));
  }

  const inference = mk("inference");
  compactInfLines(cfg, stats, "py").forEach(([t]) => inference.push(t));
  return { sampler, single, collect, inference };
}

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  SPLIT PATH — forks, run-until, or multi-column stats need per-row drawing      ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

// One device → a single-draw expression (per row). Length-1 outcome → the literal itself
// (deterministic, and sidesteps R's `sample(c(5), 1)` "sample from 1:5" trap).
function weighted(labels, w, lang) {
  const allEq = w.every(x => x === w[0]);
  if (lang === "r") return allEq ? `sample(${vec(labels, "r")}, 1)` : `sample(${vec(labels, "r")}, 1, prob = c(${w.join(", ")}))`;
  return allEq ? `random.choices(${vec(labels, "py")})[0]` : `random.choices(${vec(labels, "py")}, weights = [${w.join(", ")}])[0]`;
}
function deviceDraw(dev, lang) {
  const src = devSource(dev);
  if (src) return lang === "r" ? `sample(${srcCol(src, "pop", "r")}, 1)` : `${srcCol(src, "pop", "py")}.sample(1).iloc[0]`;
  const { labels, weights } = outcomeSpec(dev);
  if (!labels.length) return lang === "r" ? "NA" : "None";
  if (labels.length === 1) return lit(labels[0]);
  return weighted(labels, weights, lang);
}
// One stage → an assignment block, mirroring `selectBranch` (conditional branches in order,
// then the default `else`).
function stageBlock(stage, names, lang) {
  const name = names[stage.id];
  const conds = stage.branches.filter(b => b.condVar !== null);
  const def = stage.branches.find(b => b.condVar === null) || stage.branches[0];
  if (!conds.length) {
    return [lang === "r" ? `  ${name} <- ${deviceDraw(def.device, "r")}` : `    ${name} = ${deviceDraw(def.device, "py")}`];
  }
  if (lang === "r") {
    const out = [];
    conds.forEach((b, i) => {
      const head = i === 0 ? "if" : "} else if";
      out.push(`  ${i === 0 ? name + " <- " : ""}${head} (${names[b.condVar]} == ${lit(b.condVal)}) {`);
      out.push(`    ${deviceDraw(b.device, "r")}`);
    });
    out.push(`  } else {`);
    out.push(`    ${deviceDraw(def.device, "r")}  # otherwise`);
    out.push(`  }`);
    return out;
  }
  const out = [];
  conds.forEach((b, i) => {
    out.push(`    ${i === 0 ? "if" : "elif"} ${names[b.condVar]} == ${lit(b.condVal)}:`);
    out.push(`        ${name} = ${deviceDraw(b.device, "py")}`);
  });
  out.push(`    else:`);
  out.push(`        ${name} = ${deviceDraw(def.device, "py")}  # otherwise`);
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
    case "sd": return `sqrt(mean((${x} - mean(${x}))^2))`;
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
    case "sd": return `${c}.std(ddof=0)`;
    case "median": return `${c}.median()`;
    case "min": return `${c}.min()`;
    case "max": return `${c}.max()`;
    case "q1": return `${c}.quantile(0.25)`;
    case "q3": return `${c}.quantile(0.75)`;
    case "slope": return `sm.OLS(${D}[${key(v2)}], sm.add_constant(${D}[${key(v)}])).fit().params.iloc[1]`;
    case "intercept": return `sm.OLS(${D}[${key(v2)}], sm.add_constant(${D}[${key(v)}])).fit().params.iloc[0]`;
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
  const wor = pipeline.some(st => st.branches.some(b => b.device.withReplacement === false));
  const stats = withIds(plainStats(cfg), names);
  const needsSm = stats.some(({ s }) => s.fn === "slope" || s.fn === "intercept");
  const first = stats[0];
  const mk = section => { const a = []; a.push = t => Array.prototype.push.call(a, { text: t, section }); return a; };

  if (lang === "r") {
    const sampler = mk("sampler");
    sampler.push("# Sampler — draw one row through the pipeline");
    if (wor) sampler.push("# (a device draws without replacement in the tool; this code samples with replacement)");
    if (anySource(cfg)) sampler.push(`pop <- read.csv(${JSON.stringify(csvFile(cfg))})`);
    sampler.push("draw_one <- function() {");
    pipeline.forEach(st => stageBlock(st, names, "r").forEach(t => sampler.push(t)));
    sampler.push("  data.frame(" + pipeline.map(st => `${names[st.id]} = ${names[st.id]}`).join(", ") + ", stringsAsFactors = FALSE)");
    sampler.push("}");
    sampler.push("");
    if (until) {
      sampler.push("# Draw rows until the stop rule holds (n varies), capped at max_draws");
      sampler.push("draw_sample <- function(max_draws) {");
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
      sampler.push("draw_sample <- function(n) do.call(rbind, lapply(seq_len(n), function(i) draw_one()))");
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
      collect.push(`  df <- draw_sample(${cap})`);
      stats.forEach(({ s, id }) => collect.push(`  ${id}[i] <- ${rStatValue(s, names)}`));
      collect.push("}");
      collect.push(`dist <- data.frame(${stats.map(({ id }) => id).join(", ")})`);
    }

    const inference = mk("inference");
    const divR = dividerInfo(cfg, stats);
    if (!first) inference.push("# Enable a statistic, then collect samples, to do inference");
    else if (divR) {
      inference.push("# Inference from the sampling distribution (divider)");
      dividerExprs(`dist$${divR.id}`, divR, "r").forEach(t => inference.push(t));
    } else {
      inference.push("# Inference from the sampling distribution");
      inference.push(`quantile(dist$${first.id}, c(0.025, 0.975))   # 95% percentile interval`);
      inference.push(`mean(dist$${first.id} >= 0)                   # tail proportion — set your cutoff`);
    }
    return { sampler, single, collect, inference };
  }

  // Python (pandas / numpy / statsmodels)
  const sampler = mk("sampler");
  sampler.push("import random");
  sampler.push("import pandas as pd");
  sampler.push("import numpy as np");
  if (needsSm) sampler.push("import statsmodels.api as sm");
  sampler.push("");
  sampler.push("# Sampler — draw one row through the pipeline");
  if (wor) sampler.push("# (a device draws without replacement in the tool; this code samples with replacement)");
  if (anySource(cfg)) sampler.push(`pop = pd.read_csv(${JSON.stringify(csvFile(cfg))})`);
  sampler.push("def draw_one():");
  pipeline.forEach(st => stageBlock(st, names, "py").forEach(t => sampler.push(t)));
  sampler.push("    return {" + pipeline.map(st => `${key(names[st.id])}: ${names[st.id]}`).join(", ") + "}");
  sampler.push("");
  if (until) {
    sampler.push("# Draw rows until the stop rule holds (n varies), capped at max_draws");
    sampler.push("def draw_sample(max_draws):");
    sampler.push("    rows = []");
    sampler.push("    while True:");
    sampler.push("        rows.append(draw_one())");
    sampler.push(`        if ${stopPredicate(stopRule, names, "rows", "py")}: break`);
    sampler.push("        if len(rows) >= max_draws: break");
    sampler.push("    return pd.DataFrame(rows)");
  } else {
    sampler.push("# A sample = n rows drawn through the pipeline");
    sampler.push("def draw_sample(n):");
    sampler.push("    return pd.DataFrame([draw_one() for _ in range(n)])");
  }
  sampler.push("");
  sampler.push(`${cap} = ${sampleSize}` + (until ? "   # safety cap (max draws)" : "   # sample size"));

  const single = mk("single");
  if (!stats.length) single.push("# Enable a statistic (click a value on the plot) to compute it here");
  else {
    single.push("# Draw one sample, then one value per enabled statistic");
    single.push(`df = draw_sample(${cap})`);
    stats.forEach(({ s, id }) => pyStatAssign(s, id, names, "df", "", e => `${id} = ${e}`).forEach(t => single.push(t)));
  }

  const collect = mk("collect");
  if (!stats.length) collect.push("# Enable a statistic to collect its sampling distribution");
  else {
    collect.push(`N = ${collectN(cfg)}${collectNote(cfg)}`);
    stats.forEach(({ id }) => collect.push(`${id} = []`));
    collect.push("for i in range(N):");
    collect.push(`    df = draw_sample(${cap})`);
    stats.forEach(({ s, id }) => pyStatAssign(s, id, names, "df", "    ", e => `${id}.append(${e})`).forEach(t => collect.push(t)));
    collect.push(`dist = pd.DataFrame({${stats.map(({ id }) => `${key(id)}: ${id}`).join(", ")}})`);
  }

  const inference = mk("inference");
  const divP = dividerInfo(cfg, stats);
  if (!first) inference.push("# Enable a statistic, then collect samples, to do inference");
  else if (divP) {
    inference.push("# Inference from the sampling distribution (divider)");
    dividerExprs(`dist[${key(divP.id)}]`, divP, "py").forEach(t => inference.push(t));
  } else {
    inference.push("# Inference from the sampling distribution");
    inference.push(`np.quantile(dist[${key(first.id)}], [0.025, 0.975])   # 95% percentile interval`);
    inference.push(`(dist[${key(first.id)}] >= 0).mean()                  # tail proportion — set your cutoff`);
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
  return plainStats(cfg).every(singleColumn);
}

// The inference lines for the compact path over the collected vectors, as [text, section]
// pairs (shared by the distributed panel and the integrated view so they can't diverge).
function compactInfLines(cfg, stats, lang) {
  const out = [], first = stats[0], div = dividerInfo(cfg, stats);
  if (!first) return [["# Enable a statistic, then collect samples, to do inference", "inference"]];
  out.push([`# Inference from the sampling distribution${div ? " (divider)" : ""}`, "inference"]);
  if (lang === "r") {
    if (div) dividerExprs(div.id, div, "r").forEach(t => out.push([t, "inference"]));
    else {
      out.push([`quantile(${first.id}, c(0.025, 0.975))   # 95% percentile interval`, "inference"]);
      out.push([`mean(${first.id} >= 0)                   # tail proportion — set your cutoff`, "inference"]);
    }
  } else {
    const v = div ? div.id : first.id;
    out.push([`${v} = np.array(${v})`, "inference"]);
    if (div) dividerExprs(div.id, div, "py").forEach(t => out.push([t, "inference"]));
    else {
      out.push([`np.quantile(${first.id}, [0.025, 0.975])   # 95% percentile interval`, "inference"]);
      out.push([`(${first.id} >= 0).mean()                  # tail proportion — set your cutoff`, "inference"]);
    }
  }
  return out;
}

// One runnable program with per-line `section` tags driving the color-coded gutter. In the
// compact case the loop body's draws (★ red) and statistics (● orange) sit INSIDE the green
// (▲) for-loop; the split case lays the function defs / loop / inference out in order.
function genIntegrated(cfg, names, lang) {
  const stats = withIds(plainStats(cfg), names);
  const L = [], push = (text, section) => L.push({ text, section });
  if (isSimple(cfg)) {
    const ind = lang === "r" ? "  " : "    ";
    const wor = cfg.pipeline.some(st => outcomeSpec(defDevice(st)).replace === false);
    if (lang === "py") { push("import pandas as pd", "sampler"); push("import numpy as np", "sampler"); push("", "sampler"); }
    push("# Set up the sampler", "sampler");
    if (wor) push("# (a device draws without replacement; this code samples with replacement)", "sampler");
    if (anySource(cfg)) push(lang === "r" ? `df <- read.csv(${JSON.stringify(csvFile(cfg))})` : `df = pd.read_csv(${JSON.stringify(csvFile(cfg))})`, "sampler");
    push(lang === "r" ? `n <- ${cfg.sampleSize}` : `n = ${cfg.sampleSize}`, "sampler");
    if (lang === "py") cfg.pipeline.forEach(st => { const dev = defDevice(st); if (!devSource(dev)) push(`pop_${names[st.id]} = pd.Series(${vec(outcomeSpec(dev).labels, "py")})`, "sampler"); });
    if (!stats.length) { push("# Enable a statistic (click a value on the plot) to collect a distribution", "collect"); return L; }
    push(lang === "r" ? `N <- ${collectN(cfg)}${collectNote(cfg)}` : `N = ${collectN(cfg)}${collectNote(cfg)}`, "collect");
    stats.forEach(({ id }) => push(lang === "r" ? `${id} <- numeric(N)` : `${id} = []`, "collect"));
    push(lang === "r" ? "for (i in 1:N) {" : "for i in range(N):", "collect");
    cfg.pipeline.forEach(st => push(ind + drawVec(names[st.id], defDevice(st), lang), "sampler"));
    stats.forEach(({ s, id }) => {
      const e = vStat(s, names[s.variable], lang);
      push(ind + (lang === "r" ? `${id}[i] <- ${e}` : `${id}.append(${e})`), "single");
    });
    if (lang === "r") push("}", "collect");
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

export function generateCode(cfg, lang) {
  const language = lang === "python" ? "py" : "r";
  const names = buildNames(cfg.pipeline || []);
  const { sampler, single, collect, inference } =
    isSimple(cfg) ? genCompact(cfg, names, language) : genSplit(cfg, names, language);
  const integrated = cfg.hidden ? hideSampler(genIntegrated(cfg, names, language)) : genIntegrated(cfg, names, language);
  return { sampler, single, collect, inference, integrated };
}
