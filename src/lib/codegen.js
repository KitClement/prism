// Parallel R / Python code generation (Task E). Pure functions that turn the LIVE
// sampler config into runnable base-language code mirroring the simulation, so students
// can learn to write it themselves. Every generator reads the *same* specs the UI uses
// (stage outcomes, the `computeStat` fn semantics, the run-until rule) so the code and
// the tool never diverge.
//
// Each generator returns an array of LINES — `{ text, section }` — where `section` is one
// of "sampler" | "single" | "collect" | "inference". The four per-section panels render
// just the text; the integrated panel concatenates them and uses `section` to color-code
// each line's origin in its symbol gutter.
//
// Scope notes (v1): sampling is row-by-row WITH replacement (the default and the common
// teaching case); a without-replacement device is flagged with a comment rather than
// reproduced exactly. Derived columns aren't emitted — the headline statistic is the first
// plain tracked stat (or a sensible default when none are tracked).

import { stageVarKind, stageOutcomes } from "./sampling";

// ─── Literals & identifiers ───────────────────────────────────────────────────
// A label is emitted as a numeric literal only when it parses as a finite number — so a
// numeric variable's draws are numbers (mean/SD work) while "a"/"8:30"/etc. stay quoted.
const isNumLit = v => { const s = String(v).trim(); return s !== "" && !isNaN(Number(s)); };
const lit = v => (isNumLit(v) ? String(Number(v)) : JSON.stringify(String(v)));
// JSON.stringify gives a safely-escaped double-quoted string, valid in both R and Python.
const key = name => JSON.stringify(name);
// Sanitize a varName into a valid R/Python identifier; dedupe across the pipeline so two
// names that collapse to the same identifier ("a b" / "a-b") still get distinct symbols.
function safeName(raw) {
  let s = String(raw || "").replace(/[^A-Za-z0-9_]/g, "_");
  if (!s) s = "v";
  if (/^[0-9]/.test(s)) s = "v" + s;
  return s;
}
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

// ─── One device → a single-draw expression ────────────────────────────────────
const vec = (labels, lang) => (lang === "r" ? "c(" : "[") + labels.map(lit).join(", ") + (lang === "r" ? ")" : "]");
function weighted(labels, w, lang) {
  const allEq = w.every(x => x === w[0]);
  if (lang === "r") return allEq ? `sample(${vec(labels, "r")}, 1)` : `sample(${vec(labels, "r")}, 1, prob = c(${w.join(", ")}))`;
  return allEq ? `random.choices(${vec(labels, "py")})[0]` : `random.choices(${vec(labels, "py")}, weights = [${w.join(", ")}])[0]`;
}
// The single-draw RHS for one device. A length-1 outcome space is emitted as the literal
// itself (deterministic) — this also sidesteps R's `sample(c(5), 1)` "sample from 1:5" trap.
function deviceDraw(dev, lang) {
  let labels, w;
  if (dev.type === "spinner") { labels = dev.slices.map(s => s.label); w = dev.slices.map(s => s.pct); }
  else if (dev.type === "stacks") { labels = dev.items.map(it => it.label); w = dev.items.map(it => it.count); }
  else if (dev.type === "mixer") { labels = dev.balls.map(b => b.label); w = dev.balls.map(() => 1); } // duplicates ⇒ uniform
  else return lang === "r" ? "NA" : "None";
  if (!labels.length) return lang === "r" ? "NA" : "None";
  if (labels.length === 1) return lit(labels[0]);
  return weighted(labels, w, lang);
}

// ─── One stage → an assignment block (handles forks) ──────────────────────────
// Mirrors `selectBranch`: conditional branches in array order, then the default (`else`).
function stageBlock(stage, names, lang) {
  const name = names[stage.id];
  const conds = stage.branches.filter(b => b.condVar !== null);
  const def = stage.branches.find(b => b.condVar === null) || stage.branches[0];
  if (!conds.length) {
    return [lang === "r" ? `  ${name} <- ${deviceDraw(def.device, lang)}` : `    ${name} = ${deviceDraw(def.device, lang)}`];
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

// ─── Run-until stop predicate (mirrors `stopReached`) ─────────────────────────
function stopPredicate(rule, names, dfExpr, lang) {
  const col = names[rule.stageId];
  const n = rule.n || 1;
  if (lang === "r") {
    const c = `${dfExpr}$${col}`;
    if (rule.kind === "outcome") return `any(${c} == ${lit(rule.value)})`;
    if (rule.kind === "count") return `sum(${c} == ${lit(rule.value)}) >= ${n}`;
    return `length(unique(${c})) >= ${n}`;
  }
  const c = `r[${key(col)}]`;
  if (rule.kind === "outcome") return `any(${c} == ${lit(rule.value)} for r in ${dfExpr})`;
  if (rule.kind === "count") return `sum(1 for r in ${dfExpr} if ${c} == ${lit(rule.value)}) >= ${n}`;
  return `len(set(${c} for r in ${dfExpr})) >= ${n}`;
}

// ─── Section 1: the sampler (★) ───────────────────────────────────────────────
function genSampler(cfg, names, lang) {
  const { pipeline, sampleSize, runMode, stopRule } = cfg;
  const L = [], push = t => L.push({ text: t, section: "sampler" });
  const until = runMode === "until" && stopRule && stopRule.stageId;
  const withoutRepl = pipeline.some(st => st.branches.some(b => b.device.withReplacement === false));

  if (lang === "r") {
    push("# ── Sampler: draw one row through the pipeline ──");
    if (withoutRepl) push("# (a device draws without replacement in the tool; this code samples with replacement)");
    push("draw_one <- function() {");
    pipeline.forEach(st => stageBlock(st, names, "r").forEach(push));
    push("  data.frame(" + pipeline.map(st => `${names[st.id]} = ${names[st.id]}`).join(", ") + ", stringsAsFactors = FALSE)");
    push("}");
    push("");
    if (until) {
      push("# Draw rows until the stop rule holds (n varies), capped at max_draws");
      push("draw_sample <- function(max_draws) {");
      push("  rows <- list()");
      push("  repeat {");
      push("    rows[[length(rows) + 1]] <- draw_one()");
      push("    df <- do.call(rbind, rows)");
      push(`    if (${stopPredicate(stopRule, names, "df", "r")}) break`);
      push("    if (length(rows) >= max_draws) break");
      push("  }");
      push("  do.call(rbind, rows)");
      push("}");
    } else {
      push("# A sample = n rows drawn through the pipeline");
      push("draw_sample <- function(n) {");
      push("  do.call(rbind, lapply(seq_len(n), function(i) draw_one()))");
      push("}");
    }
    return L;
  }

  // Python
  push("import random");
  push("");
  push("# Draw one row through the pipeline");
  if (withoutRepl) push("# (a device draws without replacement in the tool; this code samples with replacement)");
  push("def draw_one():");
  pipeline.forEach(st => stageBlock(st, names, "py").forEach(push));
  push("    return {" + pipeline.map(st => `${key(names[st.id])}: ${names[st.id]}`).join(", ") + "}");
  push("");
  if (until) {
    push("# Draw rows until the stop rule holds (n varies), capped at max_draws")
    push("def draw_sample(max_draws):");
    push("    rows = []");
    push("    while True:");
    push("        rows.append(draw_one())");
    push(`        if ${stopPredicate(stopRule, names, "rows", "py")}: break`);
    push("        if len(rows) >= max_draws: break");
    push("    return rows");
  } else {
    push("# A sample = n rows drawn through the pipeline");
    push("def draw_sample(n):");
    push("    return [draw_one() for _ in range(n)]");
  }
  return L;
}

// ─── Region predicate for countBetween/propBetween (mirrors computeStat's inR) ─
function regionExpr(xExpr, s, lang) {
  const num = v => String(parseFloat(Number(v).toFixed(4)));
  const parts = [];
  if (s.lo != null) parts.push(`${xExpr} ${s.loOpen ? ">" : ">="} ${num(s.lo)}`);
  if (s.hi != null) parts.push(`${xExpr} ${s.hiOpen ? "<" : "<="} ${num(s.hi)}`);
  if (!parts.length) return lang === "r" ? "TRUE" : "True";
  const join = lang === "r" ? " & " : " and ";
  return parts.length > 1 ? parts.map(p => `(${p})`).join(join) : parts[0];
}

// Choose the headline statistic: the first plain (non-derived) tracked stat, else a
// sensible default — mean of the first numeric stage, or the proportion of the first
// outcome of the first stage. Returns a computeStat-shaped spec.
function headlineStat(cfg) {
  const plain = (cfg.trackedStats || []).find(s => s && s.kind !== "derived" && s.fn);
  if (plain) return plain;
  const numStage = cfg.pipeline.find(st => stageVarKind(st).numeric);
  if (numStage) return { fn: "mean", variable: numStage.id };
  const st = cfg.pipeline[0];
  return st ? { fn: "proportion", variable: st.id, target: stageOutcomes(st)[0] || "" } : { fn: "count", variable: "" };
}

// ─── Section 2: a single sample → one statistic (●) ───────────────────────────
function genSingle(cfg, names, lang) {
  const L = [], push = t => L.push({ text: t, section: "single" });
  const s = headlineStat(cfg);
  const v = names[s.variable], v2 = names[s.variable2], cond = names[s.condVar];
  const until = cfg.runMode === "until" && cfg.stopRule && cfg.stopRule.stageId;
  const capName = until ? "max_draws" : "n";

  if (lang === "r") {
    push(`${capName} <- ${cfg.sampleSize}` + (until ? "   # safety cap (max draws per sample)" : "   # sample size"));
    push("");
    push("# Compute the tracked statistic on one sample (a data frame of draws)");
    push("compute_stat <- function(df) {");
    push(s.condVar ? `  sub <- df[df$${cond} == ${lit(s.condVal)}, , drop = FALSE]` : "  sub <- df");
    push("  " + rStatExpr(s, v, v2));
    push("}");
    push("");
    push(`one_sample <- draw_sample(${capName})`);
    push("stat_value <- compute_stat(one_sample)");
    return L;
  }

  // Python
  push("import math");
  push("import statistics");
  push("");
  push("def _quantile(xs, q):              # type-7 linear interpolation (matches the tool)");
  push("    s = sorted(xs)");
  push("    if not s: return float('nan')");
  push("    pos = (len(s) - 1) * q");
  push("    lo = int(math.floor(pos)); frac = pos - lo");
  push("    return s[lo] + frac * (s[lo + 1] - s[lo]) if lo + 1 < len(s) else s[lo]");
  push("");
  push("def _ls_fit(pairs):                # least-squares slope & intercept of y ~ x");
  push("    n = len(pairs)");
  push("    sx = sum(p[0] for p in pairs); sy = sum(p[1] for p in pairs)");
  push("    sxx = sum(p[0] ** 2 for p in pairs); sxy = sum(p[0] * p[1] for p in pairs)");
  push("    denom = n * sxx - sx * sx");
  push("    slope = (n * sxy - sx * sy) / denom");
  push("    return slope, (sy - slope * sx) / n");
  push("");
  push(`${capName} = ${cfg.sampleSize}` + (until ? "   # safety cap (max draws per sample)" : "   # sample size"));
  push("");
  push("# Compute the tracked statistic on one sample (a list of row dicts)");
  push("def compute_stat(df):");
  push(s.condVar ? `    sub = [r for r in df if r[${key(cond)}] == ${lit(s.condVal)}]` : "    sub = df");
  pyStatExpr(s, v, v2).forEach(push);
  push("");
  push(`one_sample = draw_sample(${capName})`);
  push("stat_value = compute_stat(one_sample)");
  return L;
}

// R: the trailing expression of compute_stat (the function's return value).
function rStatExpr(s, v, v2) {
  const x = `sub$${v}`;
  switch (s.fn) {
    case "count": return "nrow(sub)";
    case "countVal": return `sum(${x} == ${lit(s.target)})`;
    case "proportion": return `mean(${x} == ${lit(s.target)})`;
    case "mean": return `mean(${x})`;
    case "sd": return `sqrt(mean((${x} - mean(${x}))^2))`;
    case "median": return `median(${x})`;
    case "min": return `min(${x})`;
    case "max": return `max(${x})`;
    case "q1": return `as.numeric(quantile(${x}, 0.25, type = 7))`;
    case "q3": return `as.numeric(quantile(${x}, 0.75, type = 7))`;
    case "slope": return `unname(coef(lm(${v2} ~ ${v}, data = sub))[2])`;
    case "intercept": return `unname(coef(lm(${v2} ~ ${v}, data = sub))[1])`;
    case "countBetween": return `sum(${regionExpr(x, s, "r")})`;
    case "propBetween": return `mean(${regionExpr(x, s, "r")})`;
    default: return "NA";
  }
}
// Python: the body lines of compute_stat after `sub` is defined.
function pyStatExpr(s, v, v2) {
  const xs = `[r[${key(v)}] for r in sub]`;
  const ret = e => [`    return ${e}`];
  switch (s.fn) {
    case "count": return ret("len(sub)");
    case "countVal": return ret(`sum(1 for r in sub if r[${key(v)}] == ${lit(s.target)})`);
    case "proportion": return ret(`(sum(1 for r in sub if r[${key(v)}] == ${lit(s.target)}) / len(sub)) if sub else float('nan')`);
    case "mean": return [`    xs = ${xs}`, "    return statistics.mean(xs) if xs else float('nan')"];
    case "sd": return [`    xs = ${xs}`, "    return statistics.pstdev(xs) if xs else float('nan')"];
    case "median": return [`    xs = ${xs}`, "    return statistics.median(xs) if xs else float('nan')"];
    case "min": return [`    xs = ${xs}`, "    return min(xs) if xs else float('nan')"];
    case "max": return [`    xs = ${xs}`, "    return max(xs) if xs else float('nan')"];
    case "q1": return [`    xs = ${xs}`, "    return _quantile(xs, 0.25)"];
    case "q3": return [`    xs = ${xs}`, "    return _quantile(xs, 0.75)"];
    case "slope": return [`    pairs = [(r[${key(v)}], r[${key(v2)}]) for r in sub]`, "    return _ls_fit(pairs)[0] if len(pairs) >= 2 else float('nan')"];
    case "intercept": return [`    pairs = [(r[${key(v)}], r[${key(v2)}]) for r in sub]`, "    return _ls_fit(pairs)[1] if len(pairs) >= 2 else float('nan')"];
    case "countBetween": return [`    xs = ${xs}`, `    return sum(1 for v in xs if ${regionExpr("v", s, "py")})`];
    case "propBetween": return [`    xs = ${xs}`, `    return (sum(1 for v in xs if ${regionExpr("v", s, "py")}) / len(xs)) if xs else float('nan')`];
    default: return ret("float('nan')");
  }
}

// ─── Section 3: the for-loop that builds the sampling distribution (▲) ─────────
function genCollect(cfg, names, lang) {
  const L = [], push = t => L.push({ text: t, section: "collect" });
  const until = cfg.runMode === "until" && cfg.stopRule && cfg.stopRule.stageId;
  const capName = until ? "max_draws" : "n";
  if (lang === "r") {
    push("# Repeat the single-sample statistic to build its sampling distribution");
    push("N <- 1000   # number of samples to collect");
    push(`dist <- replicate(N, compute_stat(draw_sample(${capName})))`);
    push("hist(dist)");
    return L;
  }
  push("# Repeat the single-sample statistic to build its sampling distribution");
  push("N = 1000   # number of samples to collect");
  push(`dist = [compute_stat(draw_sample(${capName})) for _ in range(N)]`);
  return L;
}

// ─── Section 4: inference off the sampling distribution (■) ────────────────────
function genInference(cfg, names, lang) {
  const L = [], push = t => L.push({ text: t, section: "inference" });
  if (lang === "r") {
    push("# Inference from the sampling distribution");
    push("observed <- 0   # <- replace with your observed statistic");
    push("ci <- quantile(dist, c(0.025, 0.975))            # 95% percentile interval");
    push("p_value <- mean(dist >= observed)                # one-sided (upper-tail)");
    push("print(ci); print(p_value)");
    return L;
  }
  push("# Inference from the sampling distribution");
  push("observed = 0   # <- replace with your observed statistic");
  push("ci = (_quantile(dist, 0.025), _quantile(dist, 0.975))   # 95% percentile interval");
  push("p_value = sum(1 for d in dist if d >= observed) / len(dist)   # one-sided (upper-tail)");
  push("print(ci, p_value)");
  return L;
}

// ─── Top-level: all four sections + the integrated program ────────────────────
export function generateCode(cfg, lang) {
  const language = lang === "python" ? "py" : "r";
  const names = buildNames(cfg.pipeline || []);
  const sampler = genSampler(cfg, names, language);
  const single = genSingle(cfg, names, language);
  const collect = genCollect(cfg, names, language);
  const inference = genInference(cfg, names, language);
  // Integrated = the four sections stitched into one runnable program; blank separators
  // are tagged with the upcoming section so the gutter symbol leads each block.
  const integrated = [];
  [sampler, single, collect, inference].forEach((sec, i) => {
    if (i > 0) integrated.push({ text: "", section: sec[0] ? sec[0].section : "sampler" });
    sec.forEach(ln => integrated.push(ln));
  });
  return { sampler, single, collect, inference, integrated };
}
