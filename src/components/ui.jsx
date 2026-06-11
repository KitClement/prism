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

// Fill a device from an uploaded CSV column. Replaces the old free-text paste: a styled
// select listing the dataset's headers. Picking a column hands its raw values to `onFill`
// along with the column name + dataset name, so the device can stamp a `source` link the
// codegen reads (read.csv / pd.read_csv). Disabled with a hint when no dataset is loaded.
function FillFromData({ dataset, onFill }) {
  const headers = (dataset && dataset.headers) || [];
  if (!headers.length) return (
    <button disabled title="Upload a CSV in Data & Exploratory Analysis first"
      style={{ ...btnPlus, color:"#bbb", borderColor:"#e5e5e5", background:"#fafafa", cursor:"not-allowed" }}>
      Fill from data
    </button>
  );
  return (
    <select value="" title="Fill this device from a CSV column"
      onChange={e => {
        const h = e.target.value; if (!h) return;
        const vals = dataset.rows.map(r => r[h]).filter(v => v !== undefined && v !== "");
        onFill(vals, h, dataset.name);
        e.target.value = "";
      }}
      style={{ ...btnPlus, color:"#4338ca", borderColor:"#a5b4fc", background:"#eef2ff", cursor:"pointer" }}>
      <option value="">Fill from data…</option>
      {headers.map(h => <option key={h} value={h}>{h}</option>)}
    </select>
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

// A number input that keeps a local text buffer while focused, so the last digit CAN be
// deleted (the box goes empty) without snapping back. An empty/invalid box is remembered —
// `onChange` only fires for a parseable number — and on blur the box reverts to the live
// `value`. External changes (e.g. a drag moving a divider cut) sync in only when not editing.
// `round` (digits) controls display rounding; min/max/step/style pass straight through.
function NumInput({ value, onChange, round, style, ...rest }) {
  const fmt = v => (v == null || v === "" || isNaN(v) ? "" : String(round != null ? parseFloat(Number(v).toFixed(round)) : v));
  const [text, setText] = useState(() => fmt(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setText(fmt(value)); }, [value, editing]);
  const handle = e => {
    const t = e.target.value;
    setText(t);                       // allow empty / a partial number while typing
    if (t.trim() === "") return;      // remember the prior value — don't propagate the blank
    const n = parseFloat(t);
    if (!isNaN(n)) onChange(n);
  };
  return (
    <input type="number" value={text} onChange={handle} style={style}
      onFocus={() => setEditing(true)}
      onBlur={() => { setEditing(false); setText(fmt(value)); }} {...rest} />
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

export { Sel, InlineEdit, ReplacementToggle, FillFromData, RangeInput, ChkLabel, NumInput };
