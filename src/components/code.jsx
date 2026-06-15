import { useState, useRef, useEffect } from "react";
import { CODE_SECTIONS, sectionColor, SHAPE_PATH } from "../lib/styles";

// Parallel R/Python code panels (Task E). Each panel is placed beside the tool it mirrors
// (Sampler ★ / Sample Results ● / Collect table ▲ / Collect plot ■) and stacks below on
// narrow screens. The page-header `CodeControls` toggle off/R/Python drives them. Colors and
// symbols match the program's logo; color-blind mode (`cbMode`) remaps only the ambiguous
// hues (red→black, green→gray) — see CODE_SECTIONS in styles.js. No `<foreignObject>`/`xmlns=`
// per constraint #3: every glyph is a plain SVG `<path>`.

const MONO = "'IBM Plex Mono','SFMono-Regular',Consolas,monospace";
const SECT = Object.fromEntries(CODE_SECTIONS.map(s => [s.id, s]));

// A section's shape as a solid-filled SVG glyph.
function Glyph({ symbol, color, size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display:"block" }}>
      <path d={SHAPE_PATH[symbol]} fill={color} />
    </svg>
  );
}

function CopyButton({ text }) {
  const [done, setDone] = useState(false);
  const copy = () => {
    const announce = () => { setDone(true); setTimeout(() => setDone(false), 1800); };
    // Synchronous fallback for when the async Clipboard API is unavailable or rejects (e.g.
    // an insecure context or a missing user-gesture) — keeps copy + the confirmation working.
    const fallback = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.focus(); ta.select();
        document.execCommand("copy"); document.body.removeChild(ta);
        announce();
      } catch { /* give up silently */ }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(announce).catch(fallback);
    else fallback();
  };
  return (
    <span style={{ display:"inline-flex", alignItems:"center", gap:6 }}>
      {/* Confirmation to the left of the button. `role="status"` makes it a polite live
          region so screen readers announce the copy; the surface pill keeps it legible over
          the header's colored gradient. */}
      <span role="status" aria-live="polite" style={{
        fontSize:11, fontWeight:700, whiteSpace:"nowrap", color:"var(--green-ink)",
        background: done ? "var(--surface)" : "transparent",
        border: done ? "1px solid var(--border-2)" : "1px solid transparent",
        borderRadius:5, padding: done ? "2px 7px" : 0,
        boxShadow: done ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
        opacity: done ? 1 : 0, transition:"opacity 0.15s" }}>
        {done ? "✓ Copied to clipboard" : ""}
      </span>
      {/* Button label stays stable ("Copy"); the role="status" pill above is the single
          confirmation (announced once to screen readers, no accessible-name churn). */}
      <button onClick={copy} title="Copy this code"
        style={{ background:"var(--surface)", border:"1px solid rgba(0,0,0,0.12)", color:"var(--text-2)",
          borderRadius:5, fontSize:11, fontWeight:600, padding:"2px 8px", cursor:"pointer", whiteSpace:"nowrap",
          boxShadow:"0 1px 2px rgba(0,0,0,0.08)" }}>
        ⧉ Copy
      </button>
    </span>
  );
}

// ── Code-box change cue ────────────────────────────────────────────────────────
// When a parameter changes the generated code, briefly highlight just the part that changed.
// `generateCode` lines carry no stable id, so we diff old vs new line text on each regenerate.

// The changed substring of `b` (new) relative to `o` (old): strip the common prefix + suffix,
// the middle is what changed. `null` if identical; `"whole"` when the change is a pure
// deletion within the line or a wholesale rewrite (highlight the entire line then).
function substrRange(o, b) {
  if (o === b) return null;
  const max = Math.min(o.length, b.length);
  let p = 0; while (p < max && o[p] === b[p]) p++;
  let s = 0; while (s < max - p && o[o.length - 1 - s] === b[b.length - 1 - s]) s++;
  const start = p, end = b.length - s;
  return start < end ? { start, end } : "whole";
}

// LCS-align the two line arrays, then map each new line that is modified/added to its highlight
// range. Returns a Map<newIndex, {start,end}|"whole">, or null to signal "don't flash" (no
// change, or a structural/language change so big that lighting it up would be noise).
function diffLines(oldLines, newLines) {
  const a = oldLines.map(l => l.text), b = newLines.map(l => l.text);
  const n = a.length, m = b.length;
  if (!m) return null;
  // LCS length table (suffix form) so we can walk forward and classify each line.
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const dels = [], adds = [];          // old-only indices, new-only indices (both in order)
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) dels.push(i++);
    else adds.push(j++);
  }
  while (i < n) dels.push(i++);
  while (j < m) adds.push(j++);
  // Structural / language switch (e.g. R↔Python, isSimple flip): most lines differ → suppress.
  if (!adds.length || adds.length > m * 0.5) return null;
  // Pair each added line with a deleted line in document order → an in-place edit (one del +
  // one add) becomes a substring diff; leftover adds with no del are brand-new → whole line.
  const map = new Map();
  adds.forEach((nj, k) => map.set(nj, k < dels.length ? substrRange(a[dels[k]], b[nj]) : "whole"));
  return map;
}

// Render one code line, wrapping the changed substring (if any) in a flashing span. The span
// is keyed by `v` (a version counter) so the CSS animation replays when the same line changes
// again before the previous flash has faded.
function CodeLine({ text, range, v }) {
  const flash = inner => <span key={v} className="code-flash">{inner}</span>;
  const body = !range ? (text || " ")
    : range === "whole" ? flash(text || " ")
    : <>{text.slice(0, range.start)}{flash(text.slice(range.start, range.end))}{text.slice(range.end)}</>;
  return <pre style={{ margin:0, padding:"0 10px", whiteSpace:"pre", minHeight:18 }}>{body}</pre>;
}

// One section panel: a header banner that fades from white (left, where the title sits) into
// the section color (right), with the section's shape as a large white watermark on the
// colored end — then the code, one element per line so the change cue can highlight a span.
export function CodeBox({ sectionId, lines, cbMode }) {
  const section = SECT[sectionId];
  const color = sectionColor(section, cbMode);
  const text = lines.map(l => l.text).join("\n");
  // Diff against the previously-rendered lines to flash what changed. `prev` survives across
  // regenerations because CodeBeside keeps this panel mounted (it only unmounts when code is
  // toggled off entirely), so a first mount (prev null) correctly shows no flash.
  const prev = useRef(null);
  const scrollRef = useRef(null);
  const [flash, setFlash] = useState({ map: null, v: 0 });
  useEffect(() => {
    const old = prev.current;
    prev.current = lines;
    if (!old) return;
    const map = diffLines(old, lines);
    if (!map || !map.size) return;
    setFlash(f => ({ map, v: f.v + 1 }));
    const t = setTimeout(() => setFlash(f => ({ map: null, v: f.v })), 1500);
    return () => clearTimeout(t);
  }, [text]);
  // When the change is off-screen to the right (the code box scrolls horizontally), reveal it —
  // but scroll ONLY this box, never the page (no scrollIntoView, which would bubble to the
  // window). Runs after the flash spans render (keyed on flash.v).
  useEffect(() => {
    if (!flash.map || !flash.map.size) return;
    const c = scrollRef.current; if (!c) return;
    const span = c.querySelector(".code-flash"); if (!span) return;
    const cRect = c.getBoundingClientRect(), sRect = span.getBoundingClientRect();
    const relLeft = sRect.left - cRect.left + c.scrollLeft, relRight = relLeft + sRect.width, pad = 24;
    if (relLeft < c.scrollLeft + pad) c.scrollTo({ left: Math.max(0, relLeft - pad), behavior: "smooth" });
    else if (relRight > c.scrollLeft + c.clientWidth - pad) c.scrollTo({ left: relRight - c.clientWidth + pad, behavior: "smooth" });
  }, [flash.v]);
  return (
    <div style={{ border:"1px solid var(--border)", borderRadius:10, overflow:"hidden", background:"var(--surface)", display:"flex", flexDirection:"column" }}>
      <div style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 10px",
        background:`linear-gradient(90deg, var(--surface) 0%, var(--surface) 42%, ${color} 100%)` }}>
        <span style={{ fontSize:13, fontWeight:700, color:"var(--text)" }}>{section.title}</span>
        {/* Symbol pinned to the right (colored) corner; the Copy button sits to its left so the
            "Copied" confirmation expands into the title's flexible space and the symbol stays put. */}
        <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:10 }}>
          <CopyButton text={text} />
          <Glyph symbol={section.symbol} color="#fff" size={26} />
        </div>
      </div>
      <div ref={scrollRef} style={{ padding:"8px 0", fontFamily:MONO, fontSize:11.5, lineHeight:1.5,
        color:"var(--text)", background:"var(--surface-2)", overflowX:"auto", borderTop:"1px solid var(--border)" }}>
        {lines.map((l, i) => <CodeLine key={i} text={l.text} range={flash.map ? flash.map.get(i) : null} v={flash.v} />)}
      </div>
    </div>
  );
}

// The integrated program: one runnable script with the section symbol in the gutter where a
// line number would go, color-coded by origin. Consecutive same-section lines read as a block,
// so the compact loop shows ★ (red) draw + ● (orange) statistic lines nested inside the ▲
// (green) for-loop. Blank lines get no glyph.
export function CodeIntegrated({ lines, cbMode, dark }) {
  const text = lines.map(l => l.text).join("\n");
  return (
    <div style={{ border:"1px solid var(--border)", borderRadius:10, overflow:"hidden", background:"var(--surface)" }}>
      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"7px 10px", background:"var(--surface-2)", borderBottom:"1px solid var(--border)", flexWrap:"wrap" }}>
        <span style={{ fontSize:13, fontWeight:700, color:"var(--text)" }}>Integrated code</span>
        <div style={{ display:"flex", gap:10, marginLeft:4, flexWrap:"wrap" }}>
          {CODE_SECTIONS.map(s => (
            <span key={s.id} style={{ display:"flex", alignItems:"center", gap:3, fontSize:10.5, color:"var(--text-3)" }}>
              <Glyph symbol={s.symbol} color={sectionColor(s, cbMode, dark)} size={11} /> {s.title}
            </span>
          ))}
        </div>
        <div style={{ marginLeft:"auto" }}><CopyButton text={text} /></div>
      </div>
      <div style={{ fontFamily:MONO, fontSize:11.5, lineHeight:1.55, background:"var(--surface-2)", overflowX:"auto" }}>
        {lines.map((l, i) => {
          const sec = SECT[l.section] || CODE_SECTIONS[0];
          const blank = !l.text.trim();
          // Color-blind: the sampler star and for-loop triangle both lift to light hues in dark
          // mode and, with no text label in the gutter, become hard to tell apart. Give the star
          // a high-contrast black-on-white cell so its shape reads unambiguously; every other
          // section keeps its tinted cell. (The header key keeps the lifted-light star — its
          // "Sampler" label disambiguates it there.)
          const starCB = cbMode && sec.symbol === "star";
          const color = starCB ? "#000" : sectionColor(sec, cbMode, dark);
          const cellBg = blank ? "transparent" : (starCB ? "#fff" : color + "1f");
          return (
            <div key={i} style={{ display:"flex", alignItems:"stretch", minHeight:19 }}>
              <div style={{ width:22, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center",
                background: cellBg, borderRight:"1px solid var(--border)" }}>
                {blank ? null : <Glyph symbol={sec.symbol} color={color} size={10} />}
              </div>
              <pre style={{ margin:0, padding:"0 10px", color:"var(--text)", whiteSpace:"pre" }}>{l.text || " "}</pre>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Lay a tool's content beside its code panel; wraps to stacked (code directly below) on
// narrow screens via flex-wrap. When `lines` is absent (code off) the tool spans full width
// with no layout change at all.
export function CodeBeside({ children, sectionId, lines, cbMode }) {
  // Always render the same wrapper so toggling code on/off never changes the element type at
  // this tree position. Returning children bare when off but wrapped when on would make React
  // unmount/remount the tool — and its Plot would lose all internal state (selected vars,
  // overlays, divider, ruler). With a stable wrapper the tool stays mounted; only the CodeBox
  // slot beside it appears/disappears. When off, the tool column flexes to full width, so the
  // layout matches the old bare-children version.
  // flex-basis sums to ~580px (+gap), so the two columns sit side by side on a tablet/laptop
  // and wrap (code directly below) only on a genuinely narrow ~<620px viewport. The tool gets
  // the larger grow share so devices/plots keep room; the code box can scroll horizontally.
  return (
    <div style={{ display:"flex", gap:14, flexWrap:"wrap", alignItems:"flex-start" }}>
      <div style={{ flex: lines ? "2 1 300px" : "1 1 100%", minWidth:0 }}>{children}</div>
      {lines && (
        <div style={{ flex:"1 1 280px", minWidth:0 }}>
          <CodeBox sectionId={sectionId} lines={lines} cbMode={cbMode} />
        </div>
      )}
    </div>
  );
}

// Page-header control: the off/R/Python toggle + (when on) the color-blind palette switch.
export function CodeControls({ codeLang, cbMode, onSetLang, onToggleCb }) {
  const on = codeLang === "r" || codeLang === "python";
  const langBtn = (val, label) => (
    <button key={val} onClick={() => onSetLang(val)}
      style={{ padding:"4px 12px", border:"1px solid " + (codeLang === val ? "#6366f1" : "var(--border-2)"),
        background: codeLang === val ? "#6366f1" : "var(--surface)", color: codeLang === val ? "#fff" : "var(--text-2)",
        fontSize:12, fontWeight:600, cursor:"pointer",
        borderRadius: val === "off" ? "7px 0 0 7px" : val === "python" ? "0 7px 7px 0" : 0,
        marginLeft: val === "off" ? 0 : -1 }}>
      {label}
    </button>
  );
  // The color-blind checkbox sits to the LEFT of the toggle, so the toggle (which is the
  // rightmost item and the group is right-anchored in the header) stays fixed in place as the
  // checkbox shows/hides. The logo up top now signals the active color palette.
  return (
    <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap", justifyContent:"flex-end" }}>
      {on && (
        <button onClick={onToggleCb} title="Toggle the color-blind palette"
          aria-pressed={cbMode}
          style={{ display:"inline-flex", alignItems:"center", padding:"4px 10px", fontSize:12, fontWeight:600,
            background: cbMode ? "#6366f1" : "var(--surface)", color: cbMode ? "#fff" : "var(--text-2)",
            border:"1px solid " + (cbMode ? "#6366f1" : "var(--border-2)"), borderRadius:7, cursor:"pointer" }}>
          Color-blind
        </button>
      )}
      <span style={{ fontSize:12, fontWeight:700, color:"var(--text-3)" }}>{"</> "}Code</span>
      <div style={{ display:"flex" }}>
        {langBtn("off", "Off")}{langBtn("r", "R")}{langBtn("python", "Python")}
      </div>
    </div>
  );
}
