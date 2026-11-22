// Formula editor (EDA table + Sample Results). Each formula is a name + typed text; the
// engine (lib/formula.js) decides its shape: a per-case formula becomes a read-only
// column in the table, a summary-only formula shows ONCE here as a single value (not a
// column of identical numbers, as TinkerPlots does).
//
// Columns can be typed by name (spaces are fine — "Hand span") or by the letter on their
// chip (A, B, …). Letters are a typing shortcut only: on commit they're rewritten into
// names, so a saved formula never depends on column order. The ƒx menu inserts columns,
// functions and operators at the caret.
import { useState, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import { btnX, btnPlus, iSm } from "../lib/styles";
import { uid } from "../lib/util";
import { aliasFor } from "../lib/expr";
import { renameInFormula, expandAliases, refText, fmtFormulaVal } from "../lib/formula";

// Menu entries: [label, open, close, description, usage, example]. A function inserts
// `open` + `close` with the caret between them (or wraps the selected text); an operator
// inserts `open` alone. Hovering (or focusing) an entry shows its help in the menu's help line.
const FN_GROUPS = [
  { title: "Summaries · one value", items: [
    ["mean", "mean(", ")", "The average of a column.", "mean(column)", "mean(x)"],
    ["median", "median(", ")", "The middle value of a column (half the values are below it).", "median(column)", "median(x)"],
    ["sd", "sd(", ")", "The sample standard deviation: a typical distance of the values from their mean.", "sd(column)", "sd(x)"],
    ["sum", "sum(", ")", "Adds up a column. Summing a test counts the cases where it's true.", "sum(column)", "sum(x)  ·  sum(Result = \"Correct\")"],
    ["count", "count(", ")", "How many non-blank values a column has.", "count(column)", "count(x)"],
    ["min", "min(", ")", "The smallest value in a column. With two values, the smaller one for each case.", "min(column)  ·  min(a, b)", "min(x)"],
    ["max", "max(", ")", "The largest value in a column. With two values, the larger one for each case.", "max(column)  ·  max(a, b)", "max(x)"],
    ["q1", "q1(", ")", "The lower quartile: 25% of the values are below it.", "q1(column)", "q1(x)"],
    ["q3", "q3(", ")", "The upper quartile: 75% of the values are below it.", "q3(column)", "q3(x)"],
  ] },
  { title: "Math · per case", items: [
    ["abs", "abs(", ")", "The absolute value: drops a minus sign (the distance from 0).", "abs(value)", "abs(x - mean(x))"],
    ["sqrt", "sqrt(", ")", "The square root.", "sqrt(value)", "sqrt(sum(sq) / (count(x) - 1))"],
    ["round", "round(", ", 2)", "Rounds to a number of decimal places (0 if left out).", "round(value, places)", "round(x, 2)"],
    ["log", "log(", ")", "The natural logarithm (base e).", "log(value)", "log(x)"],
    ["exp", "exp(", ")", "e raised to a power (undoes log).", "exp(value)", "exp(x)"],
  ] },
  { title: "Logic & text", items: [
    ["if", "if(", ", \"yes\", \"no\")", "Picks one of two values for each case, depending on a test.", "if(test, value if true, value if false)", "if(Height > 66, \"Tall\", \"Not tall\")"],
    ["join", "join(", ", )", "Joins values into text, separated by commas.", "join(a, b, …)", "join(Coin1, Coin2) → \"H,T\""],
    ["and", " and ", "", "True when both tests are true.", "test and test", "x > 3 and x < 6"],
    ["or", " or ", "", "True when either test is true.", "test or test", "x = 1 or x = 6"],
    ["not", "not(", ")", "True when the test is false.", "not(test)", "not(x = 6)"],
  ] },
  { title: "Operators", items: [
    ["+", " + ", "", "Add.", "a + b", "x + 1"],
    ["−", " - ", "", "Subtract.", "a - b", "x - mean(x)"],
    ["×", " * ", "", "Multiply (type *).", "a * b", "x * 2"],
    ["÷", " / ", "", "Divide (type /).", "a / b", "x / count(x)"],
    ["^", "^", "", "Raise to a power.", "a ^ b", "(x - mean(x))^2"],
    ["(", "(", "", "Group part of a formula so it's worked out first.", "( … )", "(x - mean(x))^2"],
    [")", ")", "", "Close a group.", "( … )", "(x - mean(x))^2"],
    ["=", " = ", "", "Test: equal to.", "a = b", "Teacher = Guess"],
    ["≠", " != ", "", "Test: not equal to (type !=).", "a != b", "Coin1 != Coin2"],
    ["<", " < ", "", "Test: less than.", "a < b", "x < 3"],
    ["≤", " <= ", "", "Test: less than or equal to (type <=).", "a <= b", "x <= 3"],
    [">", " > ", "", "Test: greater than.", "a > b", "x > 3"],
    ["≥", " >= ", "", "Test: greater than or equal to (type >=).", "a >= b", "x >= 3"],
    ["&", " & ", "", "Joins text with nothing between.", "a & b", "Coin1 & Coin2 → \"HT\""],
    ["\"text\"", "\"", "\"", "Use quotations to distinguish the names of categorical outcomes in your table from the names of columns. No need to use this for numeric outcomes.", "\"text\"", "class = \"Sophomore\""],
  ] },
];

// A text field that edits a local draft and commits on blur / Enter (so a half-typed
// formula doesn't flash errors or rename references on every keystroke). Escape reverts.
// `selRef` (optional) records the last caret/selection so the ƒx menu can insert there.
function DraftInput({ value, onCommit, inputRef, selRef, ...rest }) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  // Layout effect: the menu re-focuses the field right after an insert, so the draft must
  // already hold the new value by then.
  useLayoutEffect(() => { if (!focused.current) setDraft(value); }, [value]);
  const commit = () => { if (draft !== value) onCommit(draft); };
  const noteSel = e => { if (selRef) selRef.current = { s: e.currentTarget.selectionStart, e: e.currentTarget.selectionEnd }; };
  return (
    <input {...rest} ref={inputRef} value={draft}
      onChange={e => { setDraft(e.target.value); noteSel(e); }}
      onSelect={noteSel}
      onFocus={() => { focused.current = true; }}
      onBlur={() => { focused.current = false; commit(); }}
      onKeyDown={e => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { setDraft(value); e.currentTarget.blur(); }
      }} />
  );
}

const chipStyle = { ...btnPlus, display:"inline-flex", gap:5, alignItems:"center", color:"var(--accent-ink)",
  borderColor:"#a5b4fc", background:"var(--xsel-cell)" };
const fnStyle = { ...btnPlus, fontFamily:"ui-monospace, Consolas, monospace", color:"var(--text-2)", minWidth:26 };

// The derived-statistic builder (Collect table) combines one number per sample, so it gets
// only the per-row math its engine (`lib/expr.js`) evaluates — no summaries.
const DERIVED_FN_GROUPS = [
  { title: "Math", items: [
    ["abs", "abs(", ")", "The absolute value: drops a minus sign (the distance from 0).", "abs(value)", "abs(A - B)"],
    ["sqrt", "sqrt(", ")", "The square root.", "sqrt(value)", "sqrt(A)"],
    ["round", "round(", ", 2)", "Rounds to a number of decimal places (0 if left out).", "round(value, places)", "round(A, 2)"],
    ["log", "log(", ")", "The natural logarithm (base e).", "log(value)", "log(A / B)"],
    ["exp", "exp(", ")", "e raised to a power (undoes log).", "exp(value)", "exp(A)"],
  ] },
  { title: "Operators", items: [
    ["+", " + ", "", "Add.", "a + b", "A + B"],
    ["−", " - ", "", "Subtract.", "a - b", "A - B"],
    ["×", " * ", "", "Multiply (type *).", "a * b", "2 * A"],
    ["÷", " / ", "", "Divide (type /).", "a / b", "A / B"],
    ["^", "^", "", "Raise to a power.", "a ^ b", "(A - B)^2"],
    ["(", "(", "", "Group part of a formula so it's worked out first.", "( … )", "(A - B)^2"],
    [")", ")", "", "Close a group.", "( … )", "(A - B)^2"],
  ] },
];

// Chips: [{ name, letter?, insert?, desc? }] — `insert` defaults to the column's name, `desc`
// to the formula editor's "type the name or its letter" help. `groups` picks the functions.
function FormulaMenu({ chips, onInsert, groups = FN_GROUPS, chipsTitle = "Columns · type the name or its letter" }) {
  // The entry under the mouse (or keyboard focus); its help shows in the line at the bottom.
  const [hint, setHint] = useState(null);
  const hov = h => ({ onMouseEnter: () => setHint(h), onFocus: () => setHint(h) });
  return (
    <div style={{ flexBasis:"100%", border:"1px solid var(--border)", borderRadius:8, padding:"8px 10px", margin:"2px 0 4px",
      background:"var(--surface-2, transparent)", display:"grid", gap:8 }}>
      <div>
        <div style={menuHead}>{chipsTitle}</div>
        <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
          {chips.length ? chips.map(c => (
            <button key={c.key || c.name} onClick={() => onInsert(c.insert != null ? c.insert : refText(c.name), "")}
              {...hov({ usage: c.letter && c.insert === c.letter ? c.letter : c.name,
                desc: c.desc || `Inserts the column ${c.name}.${c.letter ? ` You can also type its letter, ${c.letter}; it's saved as the name.` : ""}` })}
              aria-label={`Insert column ${c.name}`} style={chipStyle}>
              {c.letter && <strong>{c.letter}</strong>}
              <span style={{ fontFamily:"ui-monospace, Consolas, monospace", fontSize:12, maxWidth:160, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.name}</span>
            </button>
          )) : <span style={{ fontSize:12, color:"var(--text-faint)" }}>No columns yet</span>}
        </div>
      </div>
      {groups.map(g => (
        <div key={g.title}>
          <div style={menuHead}>{g.title}</div>
          <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
            {g.items.map(([label, open, close, desc, usage, example]) => (
              <button key={label} onClick={() => onInsert(open, close)} {...hov({ usage, desc, example })}
                aria-label={`${label}: ${desc}`}
                style={{ ...fnStyle, ...(hint && hint.usage === usage && hint.desc === desc ? { border:"1.5px solid var(--accent-ink)", color:"var(--accent-ink)" } : null) }}>{label}</button>
            ))}
          </div>
        </div>
      ))}
      <div aria-live="polite" style={{ borderTop:"1px solid var(--border)", paddingTop:6, fontSize:12, lineHeight:1.5, minHeight:36, color:"var(--text-2)" }}>
        {hint ? (
          <>
            <code style={{ fontWeight:700, color:"var(--accent-ink)" }}>{hint.usage}</code>
            <span style={{ marginLeft:8 }}>{hint.desc}</span>
            {hint.example && <div style={{ color:"var(--text-3)" }}>Example: <code>{hint.example}</code></div>}
          </>
        ) : (
          <span style={{ color:"var(--text-faint)" }}>Point at a column or function to see what it does. Click one to insert it.</span>
        )}
      </div>
    </div>
  );
}
const menuHead = { fontSize:11, fontWeight:700, color:"var(--text-3)", letterSpacing:0.5, textTransform:"uppercase", marginBottom:4 };

function FormulaRow({ f, result, chips, onSetText, onRename, onRemove, autoFocus, onTrack, tracked }) {
  const textRef = useRef(null);
  const selRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(!!autoFocus);
  useEffect(() => { if (autoFocus && textRef.current) textRef.current.focus(); }, [autoFocus]);
  const kind = result ? result.kind : "error";
  // Insert at the last caret (wrapping a selection), commit, then put the caret back inside.
  const insert = (open, close) => {
    const el = textRef.current;
    const cur = el ? el.value : f.text;
    const sel = selRef.current && selRef.current.s != null ? selRef.current : { s: cur.length, e: cur.length };
    const s = Math.min(sel.s, cur.length), e = Math.min(Math.max(sel.e, s), cur.length);
    const mid = cur.slice(s, e);
    const next = cur.slice(0, s) + open + mid + close + cur.slice(e);
    const caret = s + open.length + mid.length + (mid ? close.length : 0);
    selRef.current = { s: caret, e: caret };
    onSetText(next);
    requestAnimationFrame(() => {
      const el2 = textRef.current;
      if (!el2) return;
      el2.focus();
      const p = Math.min(caret, el2.value.length);
      try { el2.setSelectionRange(p, p); } catch { /* not focusable here */ }
    });
  };
  const first = chips[0];
  return (
    <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap", padding:"5px 0", borderBottom:"1px solid var(--border)" }}>
      <DraftInput value={f.name} onCommit={onRename} aria-label="Formula name"
        style={{ ...iSm, width:90, fontWeight:700 }} />
      <span style={{ color:"var(--text-3)", fontSize:13 }}>=</span>
      <DraftInput value={f.text} onCommit={onSetText} inputRef={textRef} selRef={selRef} aria-label={`Formula for ${f.name || "new formula"}`}
        placeholder={first ? `e.g. ${refText(first.name)} - mean(${first.letter || refText(first.name)})` : "e.g. x - mean(x)"}
        spellCheck={false}
        style={{ ...iSm, flex:"1 1 180px", minWidth:140, fontFamily:"ui-monospace, Consolas, monospace" }} />
      <button onClick={() => setMenuOpen(o => !o)} aria-expanded={menuOpen} aria-label="Columns and functions menu"
        title="Insert a column, function or operator"
        style={{ ...btnPlus, fontStyle:"italic", fontWeight:700, color:"var(--accent-ink)", background: menuOpen ? "var(--xsel-cell)" : undefined }}>ƒx</button>
      <span style={{ flex:"0 0 auto", minWidth:110, fontSize:12 }} aria-live="polite">
        {!f.text.trim() ? <span style={{ color:"var(--text-faint)" }}>type a formula</span>
          : kind === "summary" ? (
            <span title="Every column is inside a summary (mean, sd, …), so this is one value">
              {onTrack ? (
                <button onClick={() => onTrack(result)} aria-pressed={!!tracked}
                  title={tracked ? "Tracked in Collect Statistics — click to stop tracking" : "Click to track this value in Collect Statistics"}
                  style={{ fontSize:15, fontWeight:700, color:"var(--accent-ink)", background: tracked ? "var(--xsel-cell)" : "transparent", border:"1px " + (tracked ? "solid" : "dashed") + " var(--accent-ink)", borderRadius:6, padding:"0 6px", cursor:"pointer" }}>
                  {result.value === null ? "—" : fmtFormulaVal(result.value)}
                </button>
              ) : (
                <span style={{ fontSize:15, fontWeight:700, color:"var(--accent-ink)" }}>{result.value === null ? "—" : fmtFormulaVal(result.value)}</span>
              )}
              <span style={{ color:"var(--text-faint)", marginLeft:5 }}>{tracked ? "summary · tracked" : "summary"}</span>
            </span>
          ) : kind === "column" ? (
            <span style={{ color:"var(--green-ink)" }} title="Varies case by case, so it's a new column in the table">→ new column</span>
          ) : (
            <span role="alert" style={{ color:"var(--red-ink, #b91c1c)" }}>{result ? result.error : "…"}</span>
          )}
      </span>
      <button title="Delete formula" aria-label={`Delete formula ${f.name}`} onClick={onRemove} style={{ ...btnX }}>×</button>
      {menuOpen && <FormulaMenu chips={chips} onInsert={insert} />}
    </div>
  );
}

// `formulas` [{id,name,text}] · `results` from applyFormulas (same order) · `colNames` the
// data columns a formula may use · `onChange(nextFormulas)` · optional `onTrack(result)` /
// `isTracked(result)` make a summary value click-to-track (Sample Results only).
function FormulaPanel({ formulas, results, colNames, onChange, title = "Formulas", onTrack, isTracked }) {
  const [justAdded, setJustAdded] = useState(null);
  const byId = Object.fromEntries((results || []).map(r => [r.id, r]));
  const names = formulas.map(f => f.name);
  const allNames = [...colNames, ...names.filter(Boolean)];
  // Letters for every column and formula, in order, skipping any letter that is itself a
  // column/formula name (case-insensitively) so a typed letter is never ambiguous.
  const letters = useMemo(() => {
    const taken = new Set(allNames.map(n => n.toLowerCase()));
    const out = []; let k = 0;
    allNames.forEach(n => {
      let L = aliasFor(k++);
      while (taken.has(L.toLowerCase())) L = aliasFor(k++);
      out.push({ name: n, letter: L });
    });
    return out;
  }, [allNames.join("\u0000")]);
  const letterToName = useMemo(() => Object.fromEntries(letters.map(c => [c.letter, c.name])), [letters]);

  const add = () => {
    let i = formulas.length + 1, name = `formula${i}`;
    while (names.includes(name) || colNames.includes(name)) name = `formula${++i}`;
    const f = { id: uid(), name, text: "" };
    setJustAdded(f.id);
    onChange([...formulas, f]);
  };
  const setText = (id, text) => {
    const t = expandAliases(text, letterToName, allNames);
    onChange(formulas.map(f => f.id === id ? { ...f, text: t } : f));
  };
  // Renaming a formula rewrites the other formulas that use it.
  const rename = (id, raw) => {
    const newName = raw.trim();
    const old = formulas.find(f => f.id === id);
    if (!old || newName === old.name) return;
    onChange(formulas.map(f => f.id === id ? { ...f, name: newName }
      : (old.name && newName ? { ...f, text: renameInFormula(f.text, old.name, newName, allNames) } : f)));
  };
  const remove = id => onChange(formulas.filter(f => f.id !== id));

  return (
    <div style={{ marginTop:10 }}>
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:2 }}>
        <div style={{ fontSize:12, fontWeight:700, color:"var(--text-3)", letterSpacing:1, textTransform:"uppercase" }}>{title}</div>
        <button onClick={add} style={{ ...btnPlus, color:"var(--accent-ink)" }}>＋ formula</button>
      </div>
      {formulas.length === 0 ? (
        <div style={{ fontSize:12, color:"var(--text-faint)" }}>
          Add a formula to compute a new column (like <code>x - mean(x)</code>) or a single summary value (like <code>sd(x)</code>).
        </div>
      ) : (
        formulas.map(f => (
          <FormulaRow key={f.id} f={f} result={byId[f.id]} chips={letters.filter(c => c.name !== f.name)}
            autoFocus={justAdded === f.id}
            onTrack={onTrack} tracked={!!(isTracked && byId[f.id] && isTracked(byId[f.id]))}
            onSetText={t => setText(f.id, t)} onRename={n => rename(f.id, n)} onRemove={() => remove(f.id)} />
        ))
      )}
    </div>
  );
}

export { FormulaPanel, FormulaMenu, DERIVED_FN_GROUPS };
