import { useState, useRef } from "react";
import { CODE_SECTIONS, sectionColor, SHAPE_PATH } from "../lib/styles";
import { useContainerWidth } from "../lib/hooks";
import { generateCode } from "../lib/codegen";

// Parallel R/Python code panels (Task E). Four runnable, symbol/color-coded sections
// (Sampler ★ / Single sample ● / For-loop ▲ / Inference ■) plus an integrated program
// whose gutter color-codes each line by its origin section. Colors/symbols match the
// program's logo; color-blind mode (`cbMode`) remaps only the ambiguous hues
// (red→black, green→gray) — see CODE_SECTIONS in styles.js. No `<foreignObject>`/`xmlns=`
// per constraint #3: every glyph is a plain SVG `<path>`.

const MONO = "'IBM Plex Mono','SFMono-Regular',Consolas,monospace";
const SECT = Object.fromEntries(CODE_SECTIONS.map(s => [s.id, s]));

// A section's shape as a solid-filled SVG glyph (used in the integrated gutter and,
// in white, cut into a CodeBox header).
function Glyph({ symbol, color, size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display:"block" }}>
      <path d={SHAPE_PATH[symbol]} fill={color} />
    </svg>
  );
}

// One section card: a header banner gradient in the section color with the section's
// shape cut out in white, then the code in a monospace block.
function CodeBox({ section, lines, cbMode }) {
  const color = sectionColor(section, cbMode);
  const text = lines.map(l => l.text).join("\n");
  const gid = "cbgrad-" + section.id + (cbMode ? "-cb" : "");
  return (
    <div style={{ border:"1px solid #e7e7ee", borderRadius:10, overflow:"hidden", background:"#fff", display:"flex", flexDirection:"column" }}>
      <div style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 10px", color:"#fff", position:"relative" }}>
        {/* Gradient banner with the shape in white */}
        <svg width={26} height={26} viewBox="0 0 24 24" style={{ flexShrink:0 }}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={color} />
              <stop offset="100%" stopColor={mix(color, "#000", 0.4)} />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width="24" height="24" rx="5" fill={`url(#${gid})`} />
          <path d={SHAPE_PATH[section.symbol]} fill="#fff" transform="translate(3 3) scale(0.75)" />
        </svg>
        <span style={{ fontSize:12.5, fontWeight:700, color:"#2c3e50" }}>{section.title}</span>
        <div style={{ marginLeft:"auto" }}><CopyButtonDark text={text} /></div>
      </div>
      <pre style={{ margin:0, padding:"8px 10px", fontFamily:MONO, fontSize:11.5, lineHeight:1.5,
        color:"#24292e", background:"#fbfbfd", overflowX:"auto", borderTop:"1px solid #f0f0f4" }}>{text}</pre>
    </div>
  );
}

// Dark-on-light copy button for the section header (the banner sits on white, not the color).
function CopyButtonDark({ text }) {
  const [done, setDone] = useState(false);
  const copy = () => {
    const announce = () => { setDone(true); setTimeout(() => setDone(false), 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(announce).catch(() => {});
    else announce();
  };
  return (
    <button onClick={copy} title="Copy this code"
      style={{ background:"#f4f5f7", border:"1px solid #ddd", color:"#555",
        borderRadius:5, fontSize:11, fontWeight:600, padding:"2px 8px", cursor:"pointer" }}>
      {done ? "✓ Copied" : "⧉ Copy"}
    </button>
  );
}

// The integrated program: each line carries its origin section's symbol in the gutter.
function IntegratedPanel({ lines, cbMode }) {
  const text = lines.map(l => l.text).join("\n");
  return (
    <div style={{ border:"1px solid #e7e7ee", borderRadius:10, overflow:"hidden", background:"#fff" }}>
      <div style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 10px", borderBottom:"1px solid #f0f0f4" }}>
        <span style={{ fontSize:12.5, fontWeight:700, color:"#2c3e50" }}>Integrated program</span>
        <span style={{ fontSize:11, color:"#aaa" }}>— the four sections as one runnable script</span>
        <div style={{ marginLeft:"auto" }}><CopyButtonDark text={text} /></div>
      </div>
      <div style={{ fontFamily:MONO, fontSize:11.5, lineHeight:1.6, background:"#fbfbfd", overflowX:"auto", padding:"8px 0" }}>
        {lines.map((l, i) => {
          const sec = SECT[l.section] || SECT.sampler;
          const color = sectionColor(sec, cbMode);
          return (
            <div key={i} style={{ display:"flex", alignItems:"stretch", minHeight:18 }}>
              <span style={{ width:22, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center",
                borderLeft:`3px solid ${color}`, marginRight:4 }}>
                {l.text.trim() ? <Glyph symbol={sec.symbol} color={color} size={11} /> : null}
              </span>
              <span style={{ whiteSpace:"pre", color:"#24292e", paddingRight:12 }}>{l.text || " "}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Top-level code feature: language + color-blind toggles, then (when on) the four boxes
// in a responsive grid and the integrated panel below. Off by default → no layout cost.
export function CodePanels({ codeLang, cbMode, config, onSetLang, onToggleCb }) {
  const ref = useRef(null);
  const width = useContainerWidth(ref, 320, 1400);
  const twoCol = width >= 760;
  const on = codeLang === "r" || codeLang === "python";
  const code = on ? generateCode(config, codeLang) : null;

  const langBtn = (val, label) => (
    <button onClick={() => onSetLang(val)}
      style={{ padding:"4px 12px", border:"1px solid " + (codeLang === val ? "#6366f1" : "#ddd"),
        background: codeLang === val ? "#6366f1" : "#fff", color: codeLang === val ? "#fff" : "#666",
        fontSize:12, fontWeight:600, cursor:"pointer",
        borderRadius: val === "off" ? "7px 0 0 7px" : val === "python" ? "0 7px 7px 0" : 0,
        marginLeft: val === "off" ? 0 : -1 }}>
      {label}
    </button>
  );

  return (
    <div ref={ref}>
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom: on ? 12 : 0, flexWrap:"wrap" }}>
        <span style={{ fontSize:14, fontWeight:700, color:"#2c3e50" }}>{"</> "}Code</span>
        <div style={{ display:"flex" }}>
          {langBtn("off", "Off")}
          {langBtn("r", "R")}
          {langBtn("python", "Python")}
        </div>
        {on && (
          <>
            <label style={{ fontSize:12, color:"#555", display:"flex", alignItems:"center", gap:5, cursor:"pointer" }}>
              <input type="checkbox" checked={cbMode} onChange={onToggleCb} />
              Color-blind palette
            </label>
            <Legend cbMode={cbMode} />
          </>
        )}
      </div>

      {on && (
        <>
          <div style={{ display:"grid", gridTemplateColumns: twoCol ? "1fr 1fr" : "1fr", gap:12, marginBottom:12 }}>
            <CodeBox section={SECT.sampler} lines={code.sampler} cbMode={cbMode} />
            <CodeBox section={SECT.single} lines={code.single} cbMode={cbMode} />
            <CodeBox section={SECT.collect} lines={code.collect} cbMode={cbMode} />
            <CodeBox section={SECT.inference} lines={code.inference} cbMode={cbMode} />
          </div>
          <IntegratedPanel lines={code.integrated} cbMode={cbMode} />
          <div style={{ fontSize:10.5, color:"#bbb", marginTop:8 }}>
            Runnable base-{codeLang === "r" ? "R" : "Python"} mirroring the sampler. A without-replacement device is noted but
            sampled with replacement; copy the integrated program into a REPL to reproduce the sampling distribution.
          </div>
        </>
      )}
    </div>
  );
}

// Compact symbol legend so a reader can map each shape/color to its section.
function Legend({ cbMode }) {
  return (
    <div style={{ display:"flex", gap:10, alignItems:"center", flexWrap:"wrap", marginLeft:"auto" }}>
      {CODE_SECTIONS.map(s => (
        <span key={s.id} style={{ display:"inline-flex", alignItems:"center", gap:4, fontSize:11, color:"#888" }}>
          <Glyph symbol={s.symbol} color={sectionColor(s, cbMode)} size={11} />{s.title}
        </span>
      ))}
    </div>
  );
}

// Blend two hex colors (0 = a, 1 = b) for the header gradient's darker stop.
function mix(a, b, t) {
  const pa = hex(a), pb = hex(b);
  const c = i => Math.round(pa[i] + (pb[i] - pa[i]) * t);
  return "#" + [c(0), c(1), c(2)].map(v => v.toString(16).padStart(2, "0")).join("");
}
function hex(h) {
  const s = h.replace("#", "");
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
