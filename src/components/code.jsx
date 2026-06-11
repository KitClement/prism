import { useState } from "react";
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
    const announce = () => { setDone(true); setTimeout(() => setDone(false), 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(announce).catch(() => {});
    else announce();
  };
  return (
    <button onClick={copy} title="Copy this code"
      style={{ background:"#fff", border:"1px solid rgba(0,0,0,0.12)", color:"#444",
        borderRadius:5, fontSize:11, fontWeight:600, padding:"2px 8px", cursor:"pointer", whiteSpace:"nowrap",
        boxShadow:"0 1px 2px rgba(0,0,0,0.08)" }}>
      {done ? "✓ Copied" : "⧉ Copy"}
    </button>
  );
}

// One section panel: a header banner that fades from white (left, where the title sits) into
// the section color (right), with the section's shape as a large white watermark on the
// colored end — then the code in a monospace block.
export function CodeBox({ sectionId, lines, cbMode }) {
  const section = SECT[sectionId];
  const color = sectionColor(section, cbMode);
  const text = lines.map(l => l.text).join("\n");
  return (
    <div style={{ border:"1px solid #e7e7ee", borderRadius:10, overflow:"hidden", background:"#fff", display:"flex", flexDirection:"column" }}>
      <div style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 10px",
        background:`linear-gradient(90deg, #fff 0%, #fff 42%, ${color} 100%)` }}>
        <span style={{ fontSize:13, fontWeight:700, color:"#2c3e50" }}>{section.title}</span>
        <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:10 }}>
          <Glyph symbol={section.symbol} color="#fff" size={26} />
          <CopyButton text={text} />
        </div>
      </div>
      <pre style={{ margin:0, padding:"8px 10px", fontFamily:MONO, fontSize:11.5, lineHeight:1.5,
        color:"#24292e", background:"#fbfbfd", overflowX:"auto", borderTop:"1px solid #f0f0f4" }}>{text}</pre>
    </div>
  );
}

// The integrated program: one runnable script with the section symbol in the gutter where a
// line number would go, color-coded by origin. Consecutive same-section lines read as a block,
// so the compact loop shows ★ (red) draw + ● (orange) statistic lines nested inside the ▲
// (green) for-loop. Blank lines get no glyph.
export function CodeIntegrated({ lines, cbMode }) {
  const text = lines.map(l => l.text).join("\n");
  return (
    <div style={{ border:"1px solid #e7e7ee", borderRadius:10, overflow:"hidden", background:"#fff" }}>
      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"7px 10px", background:"#f7f7fb", borderBottom:"1px solid #eee", flexWrap:"wrap" }}>
        <span style={{ fontSize:13, fontWeight:700, color:"#2c3e50" }}>Integrated code</span>
        <div style={{ display:"flex", gap:10, marginLeft:4, flexWrap:"wrap" }}>
          {CODE_SECTIONS.map(s => (
            <span key={s.id} style={{ display:"flex", alignItems:"center", gap:3, fontSize:10.5, color:"#777" }}>
              <Glyph symbol={s.symbol} color={sectionColor(s, cbMode)} size={11} /> {s.title}
            </span>
          ))}
        </div>
        <div style={{ marginLeft:"auto" }}><CopyButton text={text} /></div>
      </div>
      <div style={{ fontFamily:MONO, fontSize:11.5, lineHeight:1.55, background:"#fbfbfd", overflowX:"auto" }}>
        {lines.map((l, i) => {
          const sec = SECT[l.section] || CODE_SECTIONS[0];
          const color = sectionColor(sec, cbMode);
          const blank = !l.text.trim();
          return (
            <div key={i} style={{ display:"flex", alignItems:"stretch", minHeight:19 }}>
              <div style={{ width:22, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center",
                background: blank ? "transparent" : color + "1f", borderRight:"1px solid #eef0f4" }}>
                {blank ? null : <Glyph symbol={sec.symbol} color={color} size={10} />}
              </div>
              <pre style={{ margin:0, padding:"0 10px", color:"#24292e", whiteSpace:"pre" }}>{l.text || " "}</pre>
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
  if (!lines) return children;
  // flex-basis sums to ~580px (+gap), so the two columns sit side by side on a tablet/laptop
  // and wrap (code directly below) only on a genuinely narrow ~<620px viewport. The tool gets
  // the larger grow share so devices/plots keep room; the code box can scroll horizontally.
  return (
    <div style={{ display:"flex", gap:14, flexWrap:"wrap", alignItems:"flex-start" }}>
      <div style={{ flex:"2 1 300px", minWidth:0 }}>{children}</div>
      <div style={{ flex:"1 1 280px", minWidth:0 }}>
        <CodeBox sectionId={sectionId} lines={lines} cbMode={cbMode} />
      </div>
    </div>
  );
}

// Page-header control: the off/R/Python toggle + (when on) the color-blind palette switch.
export function CodeControls({ codeLang, cbMode, onSetLang, onToggleCb }) {
  const on = codeLang === "r" || codeLang === "python";
  const langBtn = (val, label) => (
    <button key={val} onClick={() => onSetLang(val)}
      style={{ padding:"4px 12px", border:"1px solid " + (codeLang === val ? "#6366f1" : "#ddd"),
        background: codeLang === val ? "#6366f1" : "#fff", color: codeLang === val ? "#fff" : "#666",
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
        <label style={{ fontSize:11.5, color:"#666", display:"flex", alignItems:"center", gap:5, cursor:"pointer" }}>
          <input type="checkbox" checked={cbMode} onChange={onToggleCb} />
          Color-blind
        </label>
      )}
      <span style={{ fontSize:12, fontWeight:700, color:"#888" }}>{"</> "}Code</span>
      <div style={{ display:"flex" }}>
        {langBtn("off", "Off")}{langBtn("r", "R")}{langBtn("python", "Python")}
      </div>
    </div>
  );
}
