import { useState, useRef, useEffect } from "react";
import { iSm, btnPlus, ctrlLbl } from "../lib/styles";

function Sel({ label, value, onChange, options, labels }) {
  return (
    <label style={ctrlLbl}>{label}:
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{ ...iSm, marginLeft:3, cursor:"pointer" }}>
        {options.map((o, i) => <option key={o} value={o}>{labels ? labels[i] : o}</option>)}
      </select>
    </label>
  );
}

function InlineEdit({ value, onChange, style = {} }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value);
  const ref = useRef();
  useEffect(() => setVal(value), [value]);
  useEffect(() => { if (editing) ref.current && ref.current.focus(); }, [editing]);
  if (editing) return (
    <input ref={ref} value={val}
      onChange={e => setVal(e.target.value)}
      onBlur={() => { setEditing(false); onChange(val); }}
      onKeyDown={e => { if (e.key === "Enter" || e.key === "Escape") { setEditing(false); onChange(val); } }}
      style={{ border:"1px solid #6366f1", borderRadius:3, padding:"1px 4px", fontSize:"inherit", outline:"none", width:"100%", background:"#fff", ...style }} />
  );
  return (
    <span onClick={() => setEditing(true)}
      style={{ cursor:"text", borderBottom:"1px dashed #ccc", minWidth:20, display:"inline-block", ...style }}>
      {value || <span style={{ color:"#bbb" }}>…</span>}
    </span>
  );
}

function ReplacementToggle({ device, onChange }) {
  return (
    <label style={{ fontSize:11, color:"#555", display:"flex", alignItems:"center", gap:5, marginTop:6, cursor:"pointer" }}>
      <input type="checkbox" checked={device.withReplacement !== false}
        onChange={e => onChange({ ...device, withReplacement: e.target.checked })} />
      Sample with replacement
    </label>
  );
}

function PasteButton({ onApply }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  if (!open) return (
    <button onClick={() => setOpen(true)}
      style={{ ...btnPlus, color:"#4338ca", borderColor:"#a5b4fc", background:"#eef2ff" }}>
      📋 paste
    </button>
  );
  return (
    <div style={{ marginTop:4, padding:7, background:"#f8f9fa", borderRadius:7, border:"1px solid #e2e8f0" }}>
      <textarea value={text} onChange={e => setText(e.target.value)}
        placeholder="Red, Blue, Red, Green…"
        style={{ width:"100%", height:44, fontSize:11, border:"1px solid #ddd", borderRadius:5, padding:4, resize:"none", boxSizing:"border-box" }} />
      <div style={{ display:"flex", gap:5, marginTop:3 }}>
        <button onClick={() => { onApply(text.split(/[\n,\t]+/).map(s => s.trim()).filter(Boolean)); setOpen(false); setText(""); }}
          style={{ ...btnPlus, background:"#2c3e50", color:"#fff", borderColor:"#2c3e50" }}>Apply</button>
        <button onClick={() => setOpen(false)} style={btnPlus}>Cancel</button>
      </div>
    </div>
  );
}

function RangeInput({ onApply, onClose }) {
  const [val, setVal] = useState("");
  const apply = () => {
    const t = val.trim();
    const m = t.match(/^(.+?)\s+to\s+(.+)$/i);
    let items = [];
    if (m) {
      const a = m[1].trim(), b = m[2].trim();
      const an = parseFloat(a), bn = parseFloat(b);
      if (!isNaN(an) && !isNaN(bn)) {
        const step = an <= bn ? 1 : -1;
        for (let v = an; step > 0 ? v <= bn : v >= bn; v += step)
          items.push(String(Math.round(v * 1e6) / 1e6));
      } else if (a.length === 1 && b.length === 1) {
        const ac = a.charCodeAt(0), bc = b.charCodeAt(0), step = ac <= bc ? 1 : -1;
        for (let c = ac; step > 0 ? c <= bc : c >= bc; c += step)
          items.push(String.fromCharCode(c));
      }
    } else {
      items = t.split(/[\n,\t]+/).map(s => s.trim()).filter(Boolean);
    }
    onApply(items);
  };
  return (
    <div style={{ marginTop:6, padding:8, background:"#f5f3ff", borderRadius:8, border:"1px solid #c4b5fd" }}>
      <div style={{ fontSize:11, color:"#7c3aed", marginBottom:4 }}>
        <code>a to f</code> or <code>1 to 10</code> or comma-separated
      </div>
      <input value={val} onChange={e => setVal(e.target.value)} placeholder="e.g. 1 to 6"
        style={{ ...iSm, width:"100%", marginBottom:5 }}
        onKeyDown={e => e.key === "Enter" && apply()} autoFocus />
      <div style={{ display:"flex", gap:5 }}>
        <button onClick={apply} style={{ ...btnPlus, background:"#7c3aed", color:"#fff", borderColor:"#7c3aed" }}>Add</button>
        <button onClick={onClose} style={btnPlus}>Cancel</button>
      </div>
    </div>
  );
}

function ChkLabel({ checked, onChange, label }) {
  return (
    <label style={{ display:"flex", alignItems:"center", gap:4, cursor:"pointer", color:"#555" }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function CopyColumnButton({ header, rows }) {
  const [copied, setCopied] = useState(false);
  const vals = rows.map(r => r[header]).filter(v => v !== undefined && v !== "");
  const doCopy = () => {
    const text = vals.join(", ");
    const fallback = () => {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (e) {}
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(fallback);
    } else { fallback(); }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <button onClick={doCopy}
      style={{ ...btnPlus, color: copied ? "#fff" : "#4338ca",
        borderColor: copied ? "#10b981" : "#a5b4fc",
        background: copied ? "#10b981" : "#eef2ff",
        transition:"all 0.15s" }}>
      {copied ? "✓ Copied " + vals.length + " values" : "📋 " + header}
    </button>
  );
}

export { Sel, InlineEdit, ReplacementToggle, PasteButton, RangeInput, ChkLabel, CopyColumnButton };
