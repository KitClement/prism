// Derived-statistic expression engine (Phase 5). A hand-rolled recursive-descent
// evaluator over a *token array* (no string lexing — the click-to-insert UI builds
// tokens directly). Dependency-light and pure.
//
// Token shapes:
//   { k:"num", v:Number }      numeric constant
//   { k:"col", id:String }     reference to a collected-statistic column
//   { k:"op",  v:"+|-|*|/|^" } binary operator (also unary "-")
//   { k:"fn",  v:"sqrt|abs|round|log|exp" }  function (followed by a parenthesised group)
//   { k:"lp" } / { k:"rp" }    parentheses
//   { k:"comma" }              argument separator (only round(x, places) takes two)
//
// Grammar (precedence low→high):
//   expr   := term (('+'|'-') term)*
//   term   := factor (('*'|'/') factor)*
//   factor := '-' factor | power
//   power  := atom ('^' factor)?            // right-associative
//   atom   := num | col | fn '(' expr (',' expr)? ')' | '(' expr ')'
//
// Numeric only, and per collected row: every function works on one value (no mean/sd —
// those would summarize the column; the Collect plot shows them). round/log/exp follow
// lib/formula.js exactly (round halves up, 0 places by default; log is natural).
//
// A missing operand (column absent in a row → undefined/NaN) propagates NaN through
// the arithmetic, so a partial sample yields NaN rather than a silently-coerced 0.

import { statLabel } from "./stats";

// Parse + evaluate a token array. `valueOf(id)` resolves a column reference to a
// Number (or NaN/undefined if missing). Returns { value, ok } where `ok` is the
// *structural* validity (balanced, no missing operands) independent of the values.
function parse(tokens, valueOf) {
  let i = 0, ok = true;
  const peek = () => tokens[i];
  const isOp = v => { const t = peek(); return t && t.k === "op" && (v ? v.includes(t.v) : true); };

  function parseExpr() {
    let v = parseTerm();
    while (isOp("+-")) { const op = tokens[i++].v; const r = parseTerm(); v = op === "+" ? v + r : v - r; }
    return v;
  }
  function parseTerm() {
    let v = parseFactor();
    while (isOp("*/")) { const op = tokens[i++].v; const r = parseFactor(); v = op === "*" ? v * r : v / r; }
    return v;
  }
  function parseFactor() {
    if (isOp("-")) { i++; return -parseFactor(); }
    return parsePower();
  }
  function parsePower() {
    const base = parseAtom();
    if (isOp("^")) { i++; const exp = parseFactor(); return Math.pow(base, exp); }
    return base;
  }
  function parseAtom() {
    const t = peek();
    if (!t || t.k === "op" || t.k === "rp" || t.k === "comma") { ok = false; return NaN; }
    if (t.k === "num") { i++; return t.v; }
    if (t.k === "col") { i++; const r = valueOf(t.id); return r === undefined || r === "" ? NaN : Number(r); }
    if (t.k === "fn") {
      i++;
      if (!peek() || peek().k !== "lp") { ok = false; return NaN; }
      i++; const args = [parseExpr()];
      while (peek() && peek().k === "comma") { i++; args.push(parseExpr()); }
      if (peek() && peek().k === "rp") i++; else ok = false;
      if (args.length > (FN_MAX_ARGS[t.v] || 1)) ok = false;
      return applyFn(t.v, args);
    }
    if (t.k === "lp") {
      i++; const v = parseExpr();
      if (peek() && peek().k === "rp") i++; else ok = false;
      return v;
    }
    ok = false; return NaN;
  }

  const value = parseExpr();
  if (i !== tokens.length) ok = false; // trailing tokens (e.g. "A B") are invalid
  return { value, ok };
}

const FN_MAX_ARGS = { round: 2 };
const EXPR_FNS = ["sqrt", "abs", "round", "log", "exp"];
const FN_ALIAS = { ln: "log" };
function applyFn(f, [x, d]) {
  if (f === "sqrt") return Math.sqrt(x);
  if (f === "abs") return Math.abs(x);
  if (f === "log") return Math.log(x);
  if (f === "exp") return Math.exp(x);
  if (f === "round") {
    const p = Math.pow(10, Math.round(d === undefined ? 0 : d));
    return Math.round(x * p) / p;
  }
  return NaN;
}

// Lex a *typed* expression string into the same token array the click-to-insert path
// produces. Column references are typed as short uppercase aliases (A, B, …, AA, …);
// `aliasToId` maps an alias to its stat id. Unicode operators (− × ÷) are normalised.
// Returns { tokens, ok }; `ok` is false on any unrecognised symbol or alias (parse()
// then reports structural validity separately).
function lexExpr(text, aliasToId) {
  const s = (text || "").replace(/[−–—]/g, "-").replace(/×/g, "*").replace(/÷/g, "/");
  const tokens = [];
  let i = 0, ok = true;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      const v = parseFloat(s.slice(i, j));
      if (isNaN(v)) ok = false; else tokens.push({ k:"num", v });
      i = j; continue;
    }
    if ("+-*/^".includes(c)) { tokens.push({ k:"op", v:c }); i++; continue; }
    if (c === "(") { tokens.push({ k:"lp" }); i++; continue; }
    if (c === ")") { tokens.push({ k:"rp" }); i++; continue; }
    if (c === ",") { tokens.push({ k:"comma" }); i++; continue; }
    if (/[A-Za-z]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9]/.test(s[j])) j++;
      const word = s.slice(i, j), lw = word.toLowerCase();
      const fn = FN_ALIAS[lw] || lw;
      if (EXPR_FNS.includes(fn)) tokens.push({ k:"fn", v:fn });
      else if (aliasToId[word.toUpperCase()]) tokens.push({ k:"col", id:aliasToId[word.toUpperCase()] });
      else ok = false;
      i = j; continue;
    }
    ok = false; i++; // unrecognised character
  }
  return { tokens, ok };
}

// Spreadsheet-style alias for the column at index i: A…Z, then AA, AB, … Uppercase
// letters only, so a typed expression can always reference any column.
function aliasFor(i) {
  let s = "", n = i + 1;
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

// Evaluate a token array against a row's column values. Returns a Number (NaN if any
// operand is missing or the expression is structurally incomplete).
function evalExpr(tokens, valueOf) {
  if (!tokens || !tokens.length) return NaN;
  const { value, ok } = parse(tokens, valueOf);
  return ok ? value : NaN;
}

// Structural validity for the builder's "Add" gate: non-empty, balanced, every
// operator/function has its operands.
function validateExpr(tokens) {
  if (!tokens || !tokens.length) return false;
  return parse(tokens, () => 1).ok;
}

const OP_SYM = { "+": " + ", "-": " − ", "*": " × ", "/": " ÷ ", "^": "^" };

// Render a token array to a human-readable string. `labelOf(id)` names a column
// reference (its statLabel, or a short alias in the builder).
function renderExpr(tokens, labelOf) {
  return (tokens || []).map(t => {
    if (t.k === "num") return String(t.v);
    if (t.k === "col") return labelOf(t.id);
    if (t.k === "op") return OP_SYM[t.v] || t.v;
    if (t.k === "fn") return t.v;
    if (t.k === "lp") return "(";
    if (t.k === "rp") return ")";
    if (t.k === "comma") return ", ";
    return "";
  }).join("");
}

// The formula label for a column: plain stats use statLabel; a derived column renders
// its expression with each referenced column resolved (recursively). This ignores any
// custom name, so it can serve as the always-available tooltip / fallback.
function exprLabel(s, byId, nameOf) {
  if (!s || s.kind !== "derived") return statLabel(s, nameOf);
  return renderExpr(s.tokens, id => { const o = byId[id]; return o ? colLabel(o, byId, nameOf) : "?"; });
}

// Display label for any tracked column: a user-given custom `name` (on any column kind,
// derived or plain) wins; otherwise a derived column renders its formula and a plain stat
// uses statLabel. `nameOf` resolves device ids to display names (threaded to statLabel).
function colLabel(s, byId, nameOf) {
  if (s && s.name && s.name.trim()) return s.name.trim();
  return exprLabel(s, byId, nameOf);
}

// Compute one accumulator row for a sample: every plain stat via computeStat, then
// every derived column over those values (two passes so a derived can read a stat).
// `computeStat` is injected to avoid a circular import.
function computeStatRow(specs, sampleRows, computeStat) {
  const row = {};
  specs.forEach(s => { if (s.kind !== "derived") row[s.id] = computeStat(s, sampleRows); });
  specs.forEach(s => { if (s.kind === "derived") row[s.id] = evalExpr(s.tokens, id => row[id]); });
  return row;
}

export { evalExpr, validateExpr, renderExpr, colLabel, exprLabel, computeStatRow, lexExpr, aliasFor, OP_SYM };
