// Formula engine for data columns (EDA table + Sample Results). Pure, no React, no imports.
//
// A formula is typed text over column NAMES, e.g.
//   HandSpan - mean(HandSpan)        abs(Deviation)^2
//   if(Teacher = Guess, "Correct", "Incorrect")      join(Team1, Team2)
// Names that aren't plain identifiers are written in brackets: [Hand span].
//
// Deliberately NOT TinkerPlots' behaviour, where `stdDev(HandSpan)` (here `sd`) fills every row with
// the same number. Each formula is classified by the SHAPE of its result:
//   • per-case ("column")  — it references a column outside any aggregate, so it varies by
//     case. It becomes a new (read-only) column. Aggregates may appear inside it as a scalar.
//   • summary ("summary")  — every column reference sits inside an aggregate (or there are
//     none), so it is ONE number. It shows once, in a summary strip, not as a column.
// A formula may reference other formulas by name: a column formula per row, a summary as
// its scalar. They are evaluated in dependency order; a cycle is reported as an error.
//
// AST (also what codegen translates — keep it plain JSON):
//   { t:"num", v } | { t:"str", v } | { t:"ref", name }
//   { t:"bin", op, a, b }   op ∈ + - * / ^ & = != < <= > >= and or
//   { t:"neg", a } | { t:"not", a } | { t:"call", fn, args:[…] }

// ─── Function table ────────────────────────────────────────────────────────────
// Aggregates take ONE argument evaluated over every case. min/max with 2+ args are the
// row-wise (scalar) versions instead.
const AGG_FNS = ["mean", "median", "sd", "sum", "count", "min", "max", "q1", "q3"];
const ROW_FNS = ["abs", "sqrt", "round", "log", "exp", "if", "join", "concat"];
const FN_ALIASES = { stddev: "sd", stdev: "sd", std: "sd", avg: "mean", average: "mean", ln: "log" };
const FN_ARITY = { abs:[1,1], sqrt:[1,1], round:[1,2], log:[1,1], exp:[1,1], if:[3,3], join:[1,99], concat:[1,99] };
const KEYWORDS = ["and", "or", "not"];

function canonFn(name) {
  const lw = name.toLowerCase();
  if (FN_ALIASES[lw]) return FN_ALIASES[lw];
  const all = [...AGG_FNS, ...ROW_FNS];
  return all.find(f => f.toLowerCase() === lw) || null;
}
// A call is an aggregate when its function is one AND it has a single argument
// (min(a, b) is the row-wise minimum).
const isAggCall = n => n.t === "call" && AGG_FNS.includes(n.fn) && n.args.length === 1;

// ─── Lexer ─────────────────────────────────────────────────────────────────────
// Tokens carry [start,end) so a column rename can rewrite references in place.
// `names` are the known column/formula names: one that isn't a plain identifier (it has a
// space, like "Hand span") is matched as a whole, longest first, so it needs no [brackets].
const isPlainId = n => /^[A-Za-z_][A-Za-z0-9_.]*$/.test(n);
function lex(text, names = []) {
  const multi = [...new Set(names)].filter(n => n && !isPlainId(n) && /^[A-Za-z_]/.test(n))
    .sort((a, b) => b.length - a.length);
  const s = String(text || "").replace(/[−–—]/g, "-").replace(/×/g, "*").replace(/÷/g, "/")
    .replace(/≤/g, "<=").replace(/≥/g, ">=").replace(/≠/g, "!=").replace(/[“”]/g, '"');
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i], start = i;
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      if (j < s.length && /[eE]/.test(s[j]) && /[-+0-9]/.test(s[j + 1] || "")) { j += 2; while (j < s.length && /[0-9]/.test(s[j])) j++; }
      const v = Number(s.slice(i, j));
      if (isNaN(v)) return { error: `"${s.slice(i, j)}" isn't a number` };
      out.push({ k:"num", v, start, end:j }); i = j; continue;
    }
    if (c === '"' || c === "'") {
      const j = s.indexOf(c, i + 1);
      if (j < 0) return { error: "A quoted text value is missing its closing quote" };
      out.push({ k:"str", v:s.slice(i + 1, j), start, end:j + 1 }); i = j + 1; continue;
    }
    if (c === "[" || c === "`") {
      const close = c === "[" ? "]" : "`";
      const j = s.indexOf(close, i + 1);
      if (j < 0) return { error: `A column name starting with ${c} is missing its closing ${close}` };
      out.push({ k:"id", v:s.slice(i + 1, j).trim(), quoted:true, start, end:j + 1 }); i = j + 1; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const hit = multi.find(n => s.slice(i, i + n.length).toLowerCase() === n.toLowerCase() && !/[A-Za-z0-9_.]/.test(s[i + n.length] || ""));
      if (hit) { out.push({ k:"id", v:hit, quoted:true, start, end:i + hit.length }); i += hit.length; continue; }
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9_.]/.test(s[j])) j++;
      const w = s.slice(i, j);
      if (KEYWORDS.includes(w.toLowerCase())) out.push({ k:"op", v:w.toLowerCase(), start, end:j });
      else out.push({ k:"id", v:w, start, end:j });
      i = j; continue;
    }
    const two = s.slice(i, i + 2);
    if (["<=", ">=", "!=", "<>", "==", "&&", "||"].includes(two)) {
      const v = { "<>":"!=", "==":"=", "&&":"and", "||":"or" }[two] || two;
      out.push({ k:"op", v, start, end:i + 2 }); i += 2; continue;
    }
    if ("+-*/^&=<>".includes(c)) { out.push({ k:"op", v:c, start, end:i + 1 }); i++; continue; }
    if (c === "!") { out.push({ k:"op", v:"not", start, end:i + 1 }); i++; continue; }
    if (c === "(") { out.push({ k:"lp", start, end:i + 1 }); i++; continue; }
    if (c === ")") { out.push({ k:"rp", start, end:i + 1 }); i++; continue; }
    if (c === ",") { out.push({ k:"comma", start, end:i + 1 }); i++; continue; }
    return { error: `Unexpected "${c}"` };
  }
  return { tokens: out };
}

// ─── Parser (recursive descent) ────────────────────────────────────────────────
// Precedence low→high: or, and, not, comparison, & (join text), + -, * /, unary -, ^.
function parseFormula(text, names = []) {
  const lx = lex(text, names);
  if (lx.error) return { error: lx.error };
  const toks = lx.tokens;
  if (!toks.length) return { error: "Type a formula" };
  let i = 0;
  const peek = () => toks[i];
  const isOp = (...vs) => { const t = peek(); return t && t.k === "op" && vs.includes(t.v); };
  const fail = msg => { throw new Error(msg); };

  const pOr = () => { let a = pAnd(); while (isOp("or")) { i++; a = { t:"bin", op:"or", a, b:pAnd() }; } return a; };
  const pAnd = () => { let a = pNot(); while (isOp("and")) { i++; a = { t:"bin", op:"and", a, b:pNot() }; } return a; };
  const pNot = () => { if (isOp("not")) { i++; return { t:"not", a:pNot() }; } return pCmp(); };
  const pCmp = () => {
    const a = pCat();
    if (isOp("=", "!=", "<", "<=", ">", ">=")) { const op = toks[i++].v; return { t:"bin", op, a, b:pCat() }; }
    return a;
  };
  const pCat = () => { let a = pAdd(); while (isOp("&")) { i++; a = { t:"bin", op:"&", a, b:pAdd() }; } return a; };
  const pAdd = () => { let a = pMul(); while (isOp("+", "-")) { const op = toks[i++].v; a = { t:"bin", op, a, b:pMul() }; } return a; };
  const pMul = () => { let a = pUnary(); while (isOp("*", "/")) { const op = toks[i++].v; a = { t:"bin", op, a, b:pUnary() }; } return a; };
  const pUnary = () => { if (isOp("-")) { i++; return { t:"neg", a:pUnary() }; } if (isOp("+")) { i++; return pUnary(); } return pPow(); };
  const pPow = () => { const a = pAtom(); if (isOp("^")) { i++; return { t:"bin", op:"^", a, b:pUnary() }; } return a; };
  const pAtom = () => {
    const t = peek();
    if (!t) fail("The formula ends too soon");
    if (t.k === "num") { i++; return { t:"num", v:t.v }; }
    if (t.k === "str") { i++; return { t:"str", v:t.v }; }
    if (t.k === "lp") {
      i++; const e = pOr();
      if (!peek() || peek().k !== "rp") fail("A ( is missing its closing )");
      i++; return e;
    }
    if (t.k === "id") {
      i++;
      const next = peek();
      if (!t.quoted && next && next.k === "lp") {
        const fn = canonFn(t.v);
        if (!fn) fail(`"${t.v}" isn't a function`);
        i++;
        const args = [];
        if (peek() && peek().k === "rp") i++;
        else {
          for (;;) {
            args.push(pOr());
            const p = peek();
            if (p && p.k === "comma") { i++; continue; }
            if (p && p.k === "rp") { i++; break; }
            fail(`${fn}( is missing its closing )`);
          }
        }
        if (AGG_FNS.includes(fn)) {
          if (!args.length) fail(`${fn}() needs a column`);
          if (args.length > 1 && fn !== "min" && fn !== "max") fail(`${fn}() takes one column`);
        } else {
          const [lo, hi] = FN_ARITY[fn];
          if (args.length < lo || args.length > hi)
            fail(lo === hi ? `${fn}() takes ${lo} value${lo > 1 ? "s" : ""}` : `${fn}() takes ${lo}–${hi} values`);
        }
        return { t:"call", fn, args };
      }
      return { t:"ref", name:t.v };
    }
    if (t.k === "rp") fail("There's an extra )");
    if (t.k === "comma") fail("Unexpected comma");
    fail(`"${t.v}" is missing a value`);
  };

  try {
    const ast = pOr();
    if (i < toks.length) {
      const t = toks[i], prev = toks[i - 1];
      // Two names in a row is almost always a name with a space that isn't a column.
      if (t.k === "id" && prev && prev.k === "id")
        return { error: `No column named "${String(text).slice(prev.start, t.end)}"` };
      return { error: t.k === "rp" ? "There's an extra )" : "Something is missing between two values (an operator?)" };
    }
    return { ast };
  } catch (e) {
    return { error: e.message };
  }
}

// ─── Analysis helpers ──────────────────────────────────────────────────────────
// Every name referenced anywhere in the AST.
function refsOf(ast, out = new Set()) {
  if (!ast) return out;
  if (ast.t === "ref") out.add(ast.name);
  if (ast.a) refsOf(ast.a, out);
  if (ast.b) refsOf(ast.b, out);
  if (ast.args) ast.args.forEach(a => refsOf(a, out));
  return out;
}
// Names referenced OUTSIDE any aggregate (these are the ones that make a formula vary by case).
function freeRefs(ast, out = new Set()) {
  if (!ast) return out;
  if (ast.t === "ref") out.add(ast.name);
  if (isAggCall(ast)) return out;
  if (ast.a) freeRefs(ast.a, out);
  if (ast.b) freeRefs(ast.b, out);
  if (ast.args) ast.args.forEach(a => freeRefs(a, out));
  return out;
}

// ─── Values ────────────────────────────────────────────────────────────────────
// Cell values are numbers, strings, booleans, or null (blank / not computable).
const isBlank = v => v === null || v === undefined || v === "" || (typeof v === "number" && !isFinite(v));
function asNum(v) {
  if (isBlank(v)) return NaN;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = Number(v);
  return isNaN(n) ? NaN : n;
}
const numOrNull = n => (typeof n === "number" && isFinite(n)) ? n : null;
// Trim float noise (HandSpan − mean → 1.2000000000000028) without losing real precision.
const tidy = n => n === null ? null : (Object.is(n, -0) ? 0 : Number(n.toPrecision(12)));

function quantile7(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q, base = Math.floor(pos), rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
}
// Aggregate over a column of per-case values. Blank cells are skipped (like R na.rm).
function aggregate(fn, vals) {
  if (fn === "count") return vals.filter(v => !isBlank(v)).length;
  const nums = vals.map(asNum).filter(n => !isNaN(n));
  if (!nums.length) return null;
  const n = nums.length;
  const sum = nums.reduce((a, b) => a + b, 0);
  switch (fn) {
    case "sum": return sum;
    case "mean": return sum / n;
    case "sd": {
      if (n < 2) return null;
      const m = sum / n;
      return Math.sqrt(nums.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
    }
    case "min": return Math.min(...nums);
    case "max": return Math.max(...nums);
    default: {
      const s = [...nums].sort((a, b) => a - b);
      return quantile7(s, fn === "median" ? 0.5 : fn === "q1" ? 0.25 : 0.75);
    }
  }
}

function equalVals(x, y) {
  const nx = asNum(x), ny = asNum(y);
  if (!isNaN(nx) && !isNaN(ny) && typeof x !== "boolean" && typeof y !== "boolean") return nx === ny;
  return String(x) === String(y);
}
const asText = v => isBlank(v) ? "" : (typeof v === "number" ? String(tidy(v)) : String(v));
const truthy = v => typeof v === "boolean" ? v : (!isBlank(v) && asNum(v) !== 0 && v !== "false");

// Evaluate `ast` for one case. `ctx` = { rows, cell(row, name), scalar(name), aggCache }.
// `row` is null when evaluating a summary (then a free column reference is an error that
// classification has already ruled out).
function evalNode(ast, row, ctx) {
  switch (ast.t) {
    case "num": return ast.v;
    case "str": return ast.v;
    case "ref": {
      if (ctx.isScalar(ast.name)) return ctx.scalar(ast.name);
      return row ? ctx.cell(row, ast.name) : null;
    }
    case "neg": { const n = asNum(evalNode(ast.a, row, ctx)); return isNaN(n) ? null : -n; }
    case "not": { const v = evalNode(ast.a, row, ctx); return isBlank(v) ? null : !truthy(v); }
    case "bin": {
      const a = evalNode(ast.a, row, ctx), b = evalNode(ast.b, row, ctx);
      const op = ast.op;
      if (op === "&") return asText(a) + asText(b);
      if (op === "and" || op === "or") {
        if (isBlank(a) || isBlank(b)) return null;
        return op === "and" ? truthy(a) && truthy(b) : truthy(a) || truthy(b);
      }
      if (op === "=" || op === "!=") {
        if (isBlank(a) || isBlank(b)) return null;
        const eq = equalVals(a, b);
        return op === "=" ? eq : !eq;
      }
      if (op === "<" || op === "<=" || op === ">" || op === ">=") {
        if (isBlank(a) || isBlank(b)) return null;
        const na = asNum(a), nb = asNum(b);
        const [x, y] = (!isNaN(na) && !isNaN(nb)) ? [na, nb] : [String(a), String(b)];
        return op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : x >= y;
      }
      const na = asNum(a), nb = asNum(b);
      if (isNaN(na) || isNaN(nb)) return null;
      const r = op === "+" ? na + nb : op === "-" ? na - nb : op === "*" ? na * nb : op === "/" ? na / nb : Math.pow(na, nb);
      return numOrNull(r);
    }
    case "call": {
      if (isAggCall(ast)) {
        // Constant for the whole column — compute once per evaluation pass.
        if (!ctx.aggCache.has(ast)) {
          const arg = ast.args[0];
          ctx.aggCache.set(ast, aggregate(ast.fn, ctx.rows.map(r => evalNode(arg, r, ctx))));
        }
        return ctx.aggCache.get(ast);
      }
      const vals = ast.args.map(a => evalNode(a, row, ctx));
      const f = ast.fn;
      if (f === "if") {
        const c = vals[0];
        if (isBlank(c)) return null;
        return truthy(c) ? vals[1] : vals[2];
      }
      if (f === "join" || f === "concat") {
        if (vals.every(isBlank)) return null;
        return vals.map(asText).join(f === "join" ? "," : "");
      }
      if (f === "min" || f === "max") {
        const ns = vals.map(asNum);
        if (ns.some(isNaN)) return null;
        return f === "min" ? Math.min(...ns) : Math.max(...ns);
      }
      const n = asNum(vals[0]);
      if (isNaN(n)) return null;
      if (f === "abs") return Math.abs(n);
      if (f === "sqrt") return numOrNull(Math.sqrt(n));
      if (f === "log") return numOrNull(Math.log(n));
      if (f === "exp") return numOrNull(Math.exp(n));
      if (f === "round") {
        const d = vals.length > 1 ? asNum(vals[1]) : 0;
        if (isNaN(d)) return null;
        const p = Math.pow(10, Math.round(d));
        return Math.round(n * p) / p;
      }
      return null;
    }
    default: return null;
  }
}

// Normalise a computed cell for storage in a row. Stored as TEXT, exactly like a CSV or
// sampler cell, so every plot/table path treats it the same way: numbers tidied, booleans
// as "true"/"false", blank → "".
function storeVal(v) {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") { const n = tidy(numOrNull(v)); return n === null ? "" : String(n); }
  if (isBlank(v)) return "";
  return String(v);
}

// ─── The driver ────────────────────────────────────────────────────────────────
// Apply `formulas` ([{ id, name, text }]) to `rows`.
//   cols      : [{ key, name }] — the data columns a formula may reference (name → row key)
//   keyOf(f)  : the row key a COLUMN formula writes to (EDA: its name; Sample Results: its id)
// Returns
//   rows      : new row objects carrying every column formula's value
//   results   : one per formula, in the input order:
//               { id, name, text, kind:"column"|"summary"|"error", error, value, key, ast,
//                 numeric (column: every non-blank value is a number) }
function applyFormulas(rows, cols, formulas, keyOf = f => f.name) {
  const colByName = new Map(cols.map(c => [c.name, c.key]));
  const lowerCol = new Map();
  cols.forEach(c => { const lw = c.name.toLowerCase(); lowerCol.set(lw, lowerCol.has(lw) ? null : c.key); });

  const allNames = [...cols.map(c => c.name), ...formulas.map(f => (f.name || "").trim())];
  const parsed = formulas.map(f => {
    const name = (f.name || "").trim();
    const r = { id:f.id, name, text:f.text || "", kind:"error", error:null, value:null, key:keyOf(f), ast:null, numeric:false };
    if (!name) { r.error = "Give this formula a name"; return r; }
    if (colByName.has(name)) { r.error = `"${name}" is already a column name`; return r; }
    const p = parseFormula(f.text, allNames);
    if (p.error) { r.error = p.error; return r; }
    r.ast = p.ast;
    return r;
  });
  // Duplicate formula names: only the first keeps the name.
  const byName = new Map();
  parsed.forEach(r => {
    if (r.error || !r.name) return;
    if (byName.has(r.name)) r.error = `Another formula is already named "${r.name}"`;
    else byName.set(r.name, r);
  });

  // Resolve a referenced name: a data column key, another formula, or unknown.
  const resolve = name => {
    if (colByName.has(name)) return { kind:"col", key:colByName.get(name) };
    if (byName.has(name)) return { kind:"formula", f:byName.get(name) };
    const k = lowerCol.get(name.toLowerCase());
    if (k) return { kind:"col", key:k };
    for (const [n, f] of byName) if (n.toLowerCase() === name.toLowerCase()) return { kind:"formula", f };
    return null;
  };

  // Topological evaluation: repeatedly evaluate any formula whose formula-dependencies are done.
  const pending = parsed.filter(r => !r.error);
  pending.forEach(r => {
    const unknown = [...refsOf(r.ast)].find(n => !resolve(n));
    if (unknown !== undefined) r.error = `No column named "${unknown}"`;
    else if ([...refsOf(r.ast)].some(n => { const x = resolve(n); return x.kind === "formula" && x.f === r; }))
      r.error = "A formula can't use itself";
  });

  const done = new Set();
  const outRows = rows.map(r => ({ ...r }));
  const ctxFor = () => ({
    rows: outRows,
    aggCache: new Map(),
    isScalar: name => { const x = resolve(name); return !!(x && x.kind === "formula" && x.f.kind === "summary"); },
    scalar: name => resolve(name).f.value,
    cell: (row, name) => {
      const x = resolve(name);
      if (!x) return null;
      if (x.kind === "col") { const v = row[x.key]; return v === undefined ? null : v; }
      const v = row[x.f.key];
      return v === undefined ? null : v;
    },
  });

  let progress = true;
  while (progress) {
    progress = false;
    for (const r of pending) {
      if (r.error || done.has(r)) continue;
      const deps = [...refsOf(r.ast)].map(resolve).filter(x => x.kind === "formula").map(x => x.f);
      if (deps.some(d => d.error)) { r.error = `It uses "${deps.find(d => d.error).name}", which has a problem`; done.add(r); progress = true; continue; }
      if (!deps.every(d => done.has(d))) continue;
      // Shape: varies by case iff a free reference is a data column or a column formula.
      const rowLevel = [...freeRefs(r.ast)].some(n => { const x = resolve(n); return x.kind === "col" || x.f.kind === "column"; });
      const ctx = ctxFor();
      if (rowLevel) {
        r.kind = "column";
        let allNum = true, any = false;
        outRows.forEach(row => {
          const raw = evalNode(r.ast, row, ctx);
          const v = storeVal(raw);
          row[r.key] = v;
          if (v !== "") { any = true; if (typeof raw !== "number") allNum = false; }
        });
        r.numeric = any && allNum;
      } else {
        r.kind = "summary";
        const v = evalNode(r.ast, null, ctx);
        r.value = typeof v === "number" ? tidy(numOrNull(v)) : (isBlank(v) ? null : v);
      }
      done.add(r);
      progress = true;
    }
  }
  // Anything left undone sits in a cycle.
  pending.forEach(r => { if (!r.error && !done.has(r)) r.error = "These formulas use each other in a loop"; });
  return { rows: outRows, results: parsed };
}

// Sample Results: formulas over sampler columns, keyed by formula id (FORMULA_KEY) so a
// rename never orphans a tracked stat. Each SUMMARY's value is also carried on every row under
// its key, so a tracked summary is an ordinary stat spec { fn:"formula", variable:key } that
// computeStat reads off the first row — every stat path (per-run, batch, seeding) then handles
// it with no special case.
const FORMULA_KEY = f => "ƒ:" + f.id;
function withFormulas(rows, cols, formulas) {
  if (!formulas || !formulas.length) return { rows, results: [] };
  const out = applyFormulas(rows, cols, formulas, FORMULA_KEY);
  const sums = out.results.filter(r => r.kind === "summary");
  if (sums.length) out.rows.forEach(row => sums.forEach(r => { row[r.key] = storeVal(r.value); }));
  return out;
}

// ─── Editing helpers ───────────────────────────────────────────────────────────
// How a name is written in a formula: bare when it's a plain identifier or plain words
// separated by single spaces ("Hand span" — the lexer matches known names whole), else
// [bracketed] (symbols, or a word that's and/or/not).
function refText(name) {
  const words = String(name).split(" ");
  const plain = words.every(w => isPlainId(w) && !KEYWORDS.includes(w.toLowerCase()));
  return plain ? name : `[${name}]`;
}
// Replace typed column letters (A, B, … from the editor's chips) with the names they stand
// for, so a saved formula always reads in names and never depends on column order. A letter
// that is itself a known name is left alone (the chip legend never offers one).
function expandAliases(text, aliasToName, names = []) {
  const lx = lex(text, names);
  if (lx.error) return text;
  let out = "", last = 0;
  lx.tokens.forEach((t, idx) => {
    const next = lx.tokens[idx + 1];
    if (t.k === "id" && !t.quoted && !(next && next.k === "lp") && aliasToName[t.v] !== undefined) {
      out += text.slice(last, t.start) + refText(aliasToName[t.v]);
      last = t.end;
    }
  });
  return out + text.slice(last);
}
// Rewrite references to `oldName` as `newName` (a column or formula was renamed). Only
// reference tokens change — a function called mean() survives a column renamed "mean".
function renameInFormula(text, oldName, newName, names = []) {
  const lx = lex(text, [...names, oldName]);
  if (lx.error) return text;
  let out = "", last = 0;
  lx.tokens.forEach((t, idx) => {
    const next = lx.tokens[idx + 1];
    const isCall = t.k === "id" && !t.quoted && next && next.k === "lp";
    if (t.k === "id" && !isCall && t.v === oldName) {
      out += text.slice(last, t.start) + refText(newName);
      last = t.end;
    }
  });
  return out + text.slice(last);
}

// Format a computed number for display (table cell / summary strip).
function fmtFormulaVal(v) {
  if (typeof v !== "number") return v === null || v === undefined ? "" : String(v);
  if (Number.isInteger(v)) return String(v);
  const a = Math.abs(v);
  return String(Number(v.toFixed(a >= 100 ? 2 : a >= 1 ? 3 : 4)));
}

export { parseFormula, applyFormulas, withFormulas, FORMULA_KEY, renameInFormula, expandAliases, refText, fmtFormulaVal, refsOf, freeRefs, isAggCall, AGG_FNS };
