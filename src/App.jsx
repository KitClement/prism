import { useState, useRef, useEffect, useCallback, useMemo } from "react";

// ─── Constants & helpers ──────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const COLORS = ["#e74c3c","#3498db","#2ecc71","#f39c12","#9b59b6","#1abc9c","#e67e22","#e91e63","#00bcd4","#607d8b","#8bc34a","#ff5722"];

// Shared styles — defined before any component that uses them
const iSm = { padding:"3px 6px", border:"1px solid #ddd", borderRadius:5, fontSize:12, outline:"none", background:"#fafafa" };
const btnX = { background:"none", border:"none", color:"#ccc", cursor:"pointer", fontSize:15, padding:"0 2px", lineHeight:1 };
const btnPlus = { padding:"3px 9px", background:"#f7f8fa", border:"1.5px dashed #ddd", borderRadius:5, fontSize:11, cursor:"pointer", color:"#666" };
const btnArr = { background:"none", border:"1px solid #eee", borderRadius:4, fontSize:11, cursor:"pointer", color:"#999", padding:"1px 4px" };
const btnNav = { padding:"3px 8px", background:"#f4f5f7", border:"1px solid #ddd", borderRadius:5, fontSize:11, cursor:"pointer", color:"#555" };
const ctrlLbl = { fontSize:12, color:"#555", display:"flex", alignItems:"center" };

// ─── Small shared components ──────────────────────────────────────────────────
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

// ─── Sampling helpers ─────────────────────────────────────────────────────────
function sampleSpinner(slices) {
  const total = slices.reduce((s, sl) => s + sl.pct, 0) || 100;
  let r = Math.random() * total;
  for (const sl of slices) { r -= sl.pct; if (r <= 0) return sl.label; }
  return slices.at(-1).label;
}

// ─── Shared single-draw logic (used by both the animation loop and the
//     collect loop, so sampling behavior stays identical in both) ──────────────
// `state` carries per-repetition mutable tracking:
//   state.liveCounts[devId] = number[]  (remaining count per stacks item)
//   state.drawnBalls[devId] = Set       (drawn mixer ball indices)
// Initialize it for a fresh repetition with makeDrawState(pipeline).
function makeDrawState(pipeline) {
  const liveCounts = {}, drawnBalls = {};
  pipeline.forEach(dev => {
    if (dev.type === "stacks") liveCounts[dev.id] = dev.items.map(it => it.count);
    if (dev.type === "mixer") drawnBalls[dev.id] = new Set();
  });
  return { liveCounts, drawnBalls };
}

// Draw a single value from a stacks device. Returns { label, itemIdx } or null
// if the device is empty. Mutates state.liveCounts when without replacement.
function drawStacks(dev, state) {
  const counts = state.liveCounts[dev.id];
  const pool = dev.items.flatMap((it, i) => Array(Math.max(0, counts[i])).fill(i));
  if (!pool.length) return null;
  const itemIdx = pool[Math.floor(Math.random() * pool.length)];
  if (!dev.withReplacement) counts[itemIdx] = Math.max(0, counts[itemIdx] - 1);
  return { label: dev.items[itemIdx].label, itemIdx };
}

// Draw a single value from a mixer device. Returns { label, ballIdx } or null.
// Mutates state.drawnBalls when without replacement.
function drawMixer(dev, state) {
  const drawn = state.drawnBalls[dev.id];
  const avail = dev.balls.map((b, i) => i).filter(i => dev.withReplacement || !drawn.has(i));
  if (!avail.length) return null;
  const ballIdx = avail[Math.floor(Math.random() * avail.length)];
  if (!dev.withReplacement) drawn.add(ballIdx);
  return { label: dev.balls[ballIdx].label, ballIdx };
}

// ─── Device factories ─────────────────────────────────────────────────────────
const mkSpinner = n => ({
  id:uid(), type:"spinner", varName:`spin${n}`, withReplacement:true,
  slices:[
    { id:uid(), label:"A", pct:33.3, color:"#e74c3c" },
    { id:uid(), label:"B", pct:33.3, color:"#3498db" },
    { id:uid(), label:"C", pct:33.4, color:"#2ecc71" },
  ]
});
const mkStacks = n => ({
  id:uid(), type:"stacks", varName:`stk${n}`, withReplacement:true,
  items:[
    { id:uid(), label:"a", count:5, color:"#e74c3c" },
    { id:uid(), label:"b", count:5, color:"#3498db" },
  ]
});
const mkMixer = n => ({
  id:uid(), type:"mixer", varName:`mix${n}`, withReplacement:true,
  balls:[
    { id:uid(), label:"a", color:"#e74c3c" },
    { id:uid(), label:"a", color:"#e74c3c" },
    { id:uid(), label:"b", color:"#3498db" },
    { id:uid(), label:"b", color:"#3498db" },
    { id:uid(), label:"b", color:"#3498db" },
  ]
});

// ══════════════════════════════════════════════════════════════════════════════
// SPINNER COMPONENT
// ══════════════════════════════════════════════════════════════════════════════
function SpinnerDevice({ device, onChange, animState, onSpinReady }) {
  const total = device.slices.reduce((s, sl) => s + sl.pct, 0) || 100;

  // Arrow angle driven by animState
  const angleRef = useRef(-90);
  const [displayAngle, setDisplayAngle] = useState(-90);
  const animRef = useRef(null);

  // spinDone: true once arrow has stopped — controls result highlight
  const [spinDone, setSpinDone] = useState(false);
  // Use a draw counter (not result string) so same-section consecutive draws re-trigger
  const prevDrawId = useRef(null);

  useEffect(() => {
    const drawId = animState && animState.drawId;
    const result = animState && animState.result;
    if (!drawId || !result) return;
    if (!animState.animating) {
      // Instant mode — show result immediately, no spin
      prevDrawId.current = drawId;
      setSpinDone(true);
      return;
    }
    if (drawId === prevDrawId.current) return; // already handled
    prevDrawId.current = drawId;
    setSpinDone(false); // hide highlight until arrow stops

    // Find the target slice angle range
    let cum = -90, sliceStart = -90, sliceEnd = -90;
    for (const sl of device.slices) {
      const sweep = (sl.pct / total) * 360;
      if (sl.label === result) { sliceStart = cum; sliceEnd = cum + sweep; break; }
      cum += sweep;
    }
    const sweep = sliceEnd - sliceStart;
    const margin = sweep * 0.10;
    // Random landing angle within the slice
    const target = sliceStart + margin + Math.random() * Math.max(0, sweep - margin * 2);

    // Normalise current angle and target to [0,360)
    const curNorm = ((angleRef.current % 360) + 360) % 360;
    const tgtNorm = ((target % 360) + 360) % 360;
    // Always spin CW; ensure at least minSpins full rotations
    const delta = (tgtNorm - curNorm + 360) % 360;
    // speed: 0=slow, 1=fast, 2=instant (but instant handled above)
    const minSpins = animState.speed === 0 ? 3 : 1.5;
    const totalDeg = minSpins * 360 + delta;
    const duration = animState.speed === 0 ? 1600 : 650;

    const startTime = performance.now();
    const startAngle = angleRef.current;

    if (animRef.current) cancelAnimationFrame(animRef.current);
    const frame = now => {
      const t = Math.min((now - startTime) / duration, 1);
      const ease = 1 - Math.pow(1 - t, 4);
      const next = startAngle + totalDeg * ease;
      angleRef.current = next;
      setDisplayAngle(next);
      if (t < 1) {
        animRef.current = requestAnimationFrame(frame);
      } else {
        setSpinDone(true); // arrow stopped — now show highlight + signal loop
        animState.onSpinDone && animState.onSpinDone();
        onSpinReady && onSpinReady();
      }
    };
    animRef.current = requestAnimationFrame(frame);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [animState && animState.drawId]);

  const rad = a => a * Math.PI / 180;
  let cumAngle = -90;

  return (
    <div>
      <svg viewBox="-1.15 -1.15 2.3 2.3" style={{ width:"100%", maxWidth:160, display:"block", margin:"0 auto" }}>
        {device.slices.map((sl, i) => {
          const sweep = (sl.pct / total) * 360;
          const x1 = Math.cos(rad(cumAngle)), y1 = Math.sin(rad(cumAngle));
          const x2 = Math.cos(rad(cumAngle + sweep)), y2 = Math.sin(rad(cumAngle + sweep));
          const large = sweep > 180 ? 1 : 0;
          const d = `M 0 0 L ${x1} ${y1} A 1 1 0 ${large} 1 ${x2} ${y2} Z`;
          const mid = cumAngle + sweep / 2;
          const tx = Math.cos(rad(mid)) * 0.63, ty = Math.sin(rad(mid)) * 0.63;
          const isResult = spinDone && animState && animState.result === sl.label;
          const hasResult = spinDone && !!(animState && animState.result);
          cumAngle += sweep;
          return (
            <g key={sl.id}>
              <path d={d} fill={sl.color} stroke="#fff" strokeWidth="0.04"
                opacity={hasResult && !isResult ? 0.45 : 1} />
              {(sl.pct / total) > 0.07 && (
                <text x={tx} y={ty} textAnchor="middle" dominantBaseline="middle"
                  fontSize="0.18" fontWeight="bold" fill="#fff"
                  style={{ pointerEvents:"none" }}>
                  {sl.label}
                </text>
              )}
            </g>
          );
        })}
        <g transform={"rotate(" + (displayAngle + 90) + ")"}>
          <polygon points="0,-0.87 -0.055,-0.12 0.055,-0.12" fill="#1a1a2e" opacity="0.85" />
        </g>
        <circle cx="0" cy="0" r="0.08" fill="#fff" stroke="#aaa" strokeWidth="0.03" />
      </svg>
      <div style={{ display:"flex", flexDirection:"column", gap:3, marginTop:6 }}>
        {device.slices.map((sl, i) => (
          <div key={sl.id} style={{ display:"flex", alignItems:"center", gap:3 }}>
            <input type="color" value={sl.color}
              onChange={e => { const s = [...device.slices]; s[i] = { ...s[i], color:e.target.value }; onChange({ ...device, slices:s }); }}
              style={{ width:20, height:20, border:"none", padding:0, cursor:"pointer", borderRadius:3, flexShrink:0 }} />
            <div style={{ flex:1, fontSize:12 }}>
              <InlineEdit value={sl.label}
                onChange={v => { const s = [...device.slices]; s[i] = { ...s[i], label:v }; onChange({ ...device, slices:s }); }} />
            </div>
            <input type="number" value={Math.round(sl.pct * 10) / 10} min={0.1} max={100} step={1}
              onChange={e => { const s = [...device.slices]; s[i] = { ...s[i], pct:parseFloat(e.target.value) || 1 }; onChange({ ...device, slices:s }); }}
              style={{ ...iSm, width:46 }} />
            <span style={{ fontSize:10, color:"#bbb" }}>%</span>
            <button onClick={() => onChange({ ...device, slices:device.slices.filter((_, j) => j !== i) })} style={btnX}>×</button>
          </div>
        ))}
        <div style={{ fontSize:10, color:Math.abs(total - 100) > 0.5 ? "#e74c3c" : "#bbb" }}>
          Total: {Math.round(total * 10) / 10}%
        </div>
        <button onClick={() => onChange({ ...device, slices:[...device.slices, { id:uid(), label:`S${device.slices.length + 1}`, pct:10, color:COLORS[device.slices.length % COLORS.length] }] })}
          style={{ ...btnPlus, marginTop:2 }}>+ slice</button>
      </div>
      <div style={{ fontSize:11, color:"#bbb", display:"flex", alignItems:"center", gap:5, marginTop:6 }}>
      <input type="checkbox" checked={true} disabled={true} readOnly />
      <span>Always with replacement</span>
    </div>
  </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// STACKS COMPONENT
// ══════════════════════════════════════════════════════════════════════════════
function StacksDevice({ device, onChange, animState }) {
  const BAR_MAX_H = 130, MAX_CT = 200;
  const dragIdx = useRef(null), dragY0 = useRef(0), dragCount0 = useRef(0);

  // Live counts: from animState when animating, else from device
  const displayCounts = (animState && animState.liveCounts) || device.items.map(it => it.count);
  const highlightIdx = animState && animState.highlightIdx;
  const shuffling = animState && animState.shuffling;
  const merged = animState && animState.merged;
  const mergedDeck = (animState && animState.mergedDeck) || null;
  const highlightTop = animState && animState.highlightTop;

  const startDrag = (e, i) => {
    e.preventDefault();
    dragIdx.current = i; dragY0.current = e.clientY; dragCount0.current = device.items[i].count;
    const move = ev => {
      const delta = Math.round((dragY0.current - ev.clientY) / 7);
      const items = [...device.items];
      items[i] = { ...items[i], count:clamp(dragCount0.current + delta, 0, MAX_CT) };
      onChange({ ...device, items });
    };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const total = displayCounts.reduce((s, c) => s + c, 0);

  const maxCount = Math.max(...device.items.map((_, i) => displayCounts[i] || 0), 1);
  // Switch to continuous bar if any stack has > 30 items; otherwise discrete segments
  const useDiscrete = maxCount <= 30;
  const SEG_H = useDiscrete ? Math.max(5, Math.min(18, Math.floor(BAR_MAX_H / maxCount))) : 0;
  const contH = (ct) => Math.max(0, (ct / Math.max(maxCount, 1)) * BAR_MAX_H);

  // ── Animated merge layer geometry ──
  // During the shuffle the cards/segments transition between their "home"
  // (per-category column) position and a single combined deck.
  const animActive = merged || highlightTop || (mergedDeck && mergedDeck.length > 0);

  const totalUnits = displayCounts.reduce((a, c) => a + c, 0);
  // Use individual unit-cards when the total is modest; otherwise use a
  // proportional "stripe" merge (each category contributes a colored band).
  const cardMode = totalUnits <= 80;

  const LAYER_W = 230;
  const nCols = Math.max(device.items.length, 1);
  const colW = LAYER_W / nCols;
  const cardW = Math.max(10, Math.min(colW - 6, 48));
  const mergedX = (LAYER_W - cardW) / 2;

  // ---- CARD MODE geometry: one flying card per unit ----
  const homeUnitH = Math.max(3, Math.min(16, Math.floor(BAR_MAX_H / Math.max(maxCount, 1))));
  const homeCards = [];
  if (cardMode) {
    device.items.forEach((it, i) => {
      const ct = displayCounts[i] !== undefined ? displayCounts[i] : it.count;
      for (let si = 0; si < ct; si++) {
        homeCards.push({ key: i + "-" + si, itemIdx: i, color: it.color,
          hx: i * colW + (colW - cardW) / 2, hy: BAR_MAX_H - (si + 1) * homeUnitH });
      }
    });
  }
  const mergedUnitH = mergedDeck && mergedDeck.length
    ? Math.max(2, Math.min(14, Math.floor(BAR_MAX_H / mergedDeck.length))) : homeUnitH;
  const mergedSlotsByItem = {};
  if (mergedDeck && cardMode) {
    mergedDeck.forEach((itemIdx, di) => {
      if (!mergedSlotsByItem[itemIdx]) mergedSlotsByItem[itemIdx] = [];
      mergedSlotsByItem[itemIdx].push({ di, my: BAR_MAX_H - (di + 1) * mergedUnitH, isTop: di === mergedDeck.length - 1 });
    });
  }
  const consume = {};
  const cards = homeCards.map(c => {
    let merge = null;
    if (mergedDeck) {
      const q = mergedSlotsByItem[c.itemIdx] || [];
      const idx = (consume[c.itemIdx] = (consume[c.itemIdx] || 0));
      merge = q[idx] || null;
      consume[c.itemIdx] = idx + 1;
    }
    return { ...c, merge };
  });

  // ---- STRIPE MODE geometry: every unit is a thin stripe, no gaps ----
  // Home: stripes are grouped in their category column (stacked bottom-up).
  // Merged: stripes interleave in shuffled mergedDeck order in one column, so
  // colors are mixed throughout the deck (not big same-color blocks).
  let stripeData = null;
  if (!cardMode && mergedDeck && mergedDeck.length) {
    const mergedUnitHS = BAR_MAX_H / mergedDeck.length;
    // Home stripe height per category (fit tallest stack)
    const homeUnitHS = BAR_MAX_H / Math.max(maxCount, 1);
    // Assign each unit a home position (per-category) and a merged slot.
    // Walk mergedDeck; for each item index track how many of that item we've
    // placed so we can compute its home stacking index.
    const homeIdxByItem = {};
    const stripes = mergedDeck.map((itemIdx, di) => {
      const si = (homeIdxByItem[itemIdx] = (homeIdxByItem[itemIdx] || 0));
      homeIdxByItem[itemIdx] = si + 1;
      return {
        itemIdx,
        color: device.items[itemIdx] ? device.items[itemIdx].color : "#999",
        // home: in its category column, stacked bottom-up
        hx: itemIdx * colW + (colW - cardW) / 2,
        hy: BAR_MAX_H - (si + 1) * homeUnitHS,
        hh: homeUnitHS,
        // merged: single column, position by deck order (bottom→top)
        my: BAR_MAX_H - (di + 1) * mergedUnitHS,
        mh: mergedUnitHS,
        isTop: di === mergedDeck.length - 1,
        di,
      };
    });
    stripeData = { stripes, mergedUnitHS };
  }

  const useCardLayer = animActive && cardMode && homeCards.length > 0;
  const useStripeLayer = animActive && !cardMode && stripeData;

  return (
    <div>
      {useCardLayer ? (
        // ── Absolutely-positioned card layer: cards fly home ↔ merged deck ──
        <div style={{ position:"relative", width:LAYER_W, height: BAR_MAX_H + 20, margin:"0 auto" }}>
          <div style={{ position:"absolute", top:-2, left:0, right:0, textAlign:"center",
            fontSize:10, color:"#555", fontWeight:700 }}>
            {highlightTop ? "top card" : "shuffling…"}
          </div>
          {cards.map(c => {
            const toMerged = merged && c.merge;
            const x = toMerged ? mergedX : c.hx;
            const y = (toMerged ? c.merge.my : c.hy) + 14; // +14 for header space
            const isTopCard = highlightTop && c.merge && c.merge.isTop;
            const h = toMerged ? mergedUnitH : homeUnitH;
            return (
              <div key={c.key} style={{
                position:"absolute", left:0, top:0,
                width: cardW, height: h - 1,
                background: isTopCard ? "#fff" : c.color,
                border:"1px solid rgba(255,255,255,0.4)",
                borderRadius: isTopCard ? "3px" : "2px",
                boxShadow: isTopCard ? "0 0 0 2px " + c.color + ", 0 -2px 8px rgba(0,0,0,0.25)" : "0 1px 2px rgba(0,0,0,0.12)",
                transform: "translate(" + x + "px," + y + "px)",
                transition: "transform 0.5s cubic-bezier(0.4,0,0.2,1), height 0.3s ease, background 0.2s",
                animation: isTopCard ? "tkFlash 0.3s ease-in-out infinite alternate" : "none",
                zIndex: c.merge ? c.merge.di + 1 : 1,
                boxSizing:"border-box",
              }} />
            );
          })}
        </div>
      ) : useStripeLayer ? (
        // ── Stripe merge: every unit is a thin stripe; bars split and re-merge
        //    into one interleaved (shuffled-order) combined deck ──
        <div style={{ position:"relative", width:LAYER_W, height: BAR_MAX_H + 20, margin:"0 auto" }}>
          <div style={{ position:"absolute", top:-2, left:0, right:0, textAlign:"center",
            fontSize:10, color:"#555", fontWeight:700 }}>
            {highlightTop ? "top card" : "shuffling…"}
          </div>
          {stripeData.stripes.map((s, i) => {
            const x = merged ? mergedX : s.hx;
            const y = (merged ? s.my : s.hy) + 14;
            const h = merged ? s.mh : s.hh;
            const isTopStripe = merged && highlightTop && s.isTop;
            return (
              <div key={i} style={{
                position:"absolute", left:0, top:0,
                width: cardW, height: Math.max(1.5, h),
                background: isTopStripe ? "#fff" : s.color,
                // hairline divider between stripes without white gaps
                borderTop:"0.5px solid rgba(0,0,0,0.12)",
                borderRadius: (merged ? s.isTop : false) ? "3px 3px 0 0" : 0,
                boxShadow: isTopStripe ? "0 0 0 2px " + s.color + ", 0 -2px 8px rgba(0,0,0,0.25)" : "none",
                transform: "translate(" + x + "px," + y + "px)",
                transition: "transform 0.5s cubic-bezier(0.4,0,0.2,1), height 0.4s ease, background 0.2s",
                animation: isTopStripe ? "tkFlash 0.3s ease-in-out infinite alternate" : "none",
                zIndex: merged ? s.di + 1 : 1,
                boxSizing:"border-box",
              }} />
            );
          })}
          <div style={{ position:"absolute", bottom:-2, left:0, right:0, textAlign:"center", fontSize:9, color:"#aaa" }}>
            combined deck · {totalUnits} cards
          </div>
        </div>
      ) : (
      <div style={{ display:"flex", gap:4, alignItems:"flex-end", justifyContent:"center", padding:"0 4px", minHeight: BAR_MAX_H + 20 }}>
        {device.items.map((it, i) => {
          const ct = displayCounts[i] !== undefined ? displayCounts[i] : it.count;
          const isHL = highlightIdx === i;
          return (
            <div key={it.id} style={{ display:"flex", flexDirection:"column", alignItems:"center", flex:1, minWidth:28 }}>
              <span style={{ fontSize:10, color:"#555", fontWeight:700 }}>{ct}</span>
              {useDiscrete ? (
                <div onMouseDown={e => startDrag(e, i)}
                  style={{ width:"100%", display:"flex", flexDirection:"column-reverse", cursor:"ns-resize", gap:1 }}>
                  {Array.from({ length: ct }, (_, si) => (
                    <div key={si} style={{
                      width:"100%", height:SEG_H,
                      background: it.color,
                      border: "1px solid rgba(255,255,255,0.35)",
                      borderRadius: si === ct - 1 ? "3px 3px 0 0" : "1px",
                      boxSizing:"border-box",
                      flexShrink:0,
                    }} />
                  ))}
                </div>
              ) : (
                <div onMouseDown={e => startDrag(e, i)}
                  style={{ width:"100%", height: contH(ct), background: it.color,
                    borderRadius:"4px 4px 0 0", cursor:"ns-resize", position:"relative",
                    transition:"height 0.12s ease", overflow:"hidden" }}>
                  {isHL && (
                    <div style={{ position:"absolute", inset:0,
                      background:"rgba(255,255,255,0.4)",
                      animation:"tkFlash 0.3s ease-in-out infinite alternate" }} />
                  )}
                </div>
              )}
              <div style={{ fontSize:8, color:it.color, fontWeight:700, marginTop:2,
                overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:"100%", textAlign:"center" }}>
                <InlineEdit value={it.label}
                  onChange={v => { const items = [...device.items]; items[i] = { ...items[i], label:v }; onChange({ ...device, items }); }}
                  style={{ fontSize:9 }} />
              </div>
            </div>
          );
        })}
      </div>
      )}
      <div style={{ fontSize:10, color:"#bbb", textAlign:"center", marginBottom:6 }}>↕ drag · total: {total}</div>
      <div style={{ display:"flex", flexDirection:"column", gap:3, maxHeight:110, overflowY:"auto" }}>
        {device.items.map((it, i) => (
          <div key={it.id} style={{ display:"flex", alignItems:"center", gap:3 }}>
            <input type="color" value={it.color}
              onChange={e => { const items = [...device.items]; items[i] = { ...items[i], color:e.target.value }; onChange({ ...device, items }); }}
              style={{ width:20, height:20, border:"none", padding:0, cursor:"pointer", borderRadius:3, flexShrink:0 }} />
            <div style={{ flex:1, fontSize:12 }}>
              <InlineEdit value={it.label}
                onChange={v => { const items = [...device.items]; items[i] = { ...items[i], label:v }; onChange({ ...device, items }); }} />
            </div>
            <input type="number" value={it.count} min={0} max={MAX_CT}
              onChange={e => { const items = [...device.items]; items[i] = { ...items[i], count:parseInt(e.target.value) || 0 }; onChange({ ...device, items }); }}
              style={{ ...iSm, width:42 }} />
            <button onClick={() => onChange({ ...device, items:device.items.filter((_, j) => j !== i) })} style={btnX}>×</button>
          </div>
        ))}
      </div>
      <div style={{ display:"flex", gap:5, marginTop:6, flexWrap:"wrap" }}>
        <button onClick={() => onChange({ ...device, items:[...device.items, { id:uid(), label:`C${device.items.length + 1}`, count:3, color:COLORS[device.items.length % COLORS.length] }] })}
          style={btnPlus}>+ category</button>
        <PasteButton onApply={vals => {
          const counts = {}, order = [], cm = {};
          vals.forEach(v => { if (!counts[v]) { counts[v] = 0; order.push(v); cm[v] = COLORS[order.length % COLORS.length]; } counts[v]++; });
          onChange({ ...device, items:order.map(label => ({ id:uid(), label, count:counts[label], color:cm[label] })) });
        }} />
      </div>
      <ReplacementToggle device={device} onChange={onChange} />
      <style>{`@keyframes tkFlash{from{opacity:0.2}to{opacity:0.85}}`}</style>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MIXER COMPONENT
// ══════════════════════════════════════════════════════════════════════════════
function MixerDevice({ device, onChange, animState }) {
  const BOWL_W = 190, BOWL_H = 108;
  const posRef = useRef([]);
  const frameRef = useRef(null);
  const [positions, setPositions] = useState([]);
  const isBouncingRef = useRef(false);
  const animStateRef = useRef(animState);
  animStateRef.current = animState;
  const [rangeOpen, setRangeOpen] = useState(false);

  // Ball radius shrinks so that ALL balls fit inside the bowl area.
  // Estimate: total ball area should be <= ~55% of bowl area (packing factor).
  const computeBallR = (n) => {
    if (n <= 0) return 12;
    const area = BOWL_W * BOWL_H;
    const perBall = (area * 0.45) / n;          // available area per ball (packing factor)
    const rFromArea = Math.sqrt(perBall / Math.PI);
    return Math.max(3, Math.min(12, Math.floor(rFromArea)));
  };
  const ballR = computeBallR(device.balls.length);

  // Compute organized grid positions (default state) — packs all n balls
  const getGridPositions = (n, r) => {
    const gap = r < 6 ? 1 : 2;
    const cols = Math.max(1, Math.floor((BOWL_W - 2) / (r * 2 + gap)));
    return Array.from({ length: n }, (_, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const y = BOWL_H - r - 2 - row * (r * 2 + gap);
      return {
        x: r + 2 + col * (r * 2 + gap) + (row % 2 === 1 ? r / 2 : 0),
        y: Math.max(r + 2, y),  // clamp so rows never start above the bowl
        vx: 0, vy: 0,
      };
    });
  };

  // Init positions when ball count changes
  useEffect(() => {
    const r = computeBallR(device.balls.length);
    posRef.current = getGridPositions(device.balls.length, r).map(p => ({ ...p, vx:0, vy:0 }));
    setPositions([...posRef.current]);
  }, [device.balls.length]);

  const NOTCH_X = BOWL_W / 2, NOTCH_Y = ballR + 4; // target for surfaced ball

  const tick = useCallback(() => {
    const as = animStateRef.current;
    const surfaceIdx = as && as.surfaceIdx != null ? as.surfaceIdx : -1;
    const removedSet = (as && as.removedSet) || new Set();
    posRef.current = posRef.current.map((b, i) => {
      if (removedSet.has(i)) return b;
      let { x, y, vx, vy } = b;
      if (i === surfaceIdx) {
        // Pull toward notch at top-center
        vx += (NOTCH_X - x) * 0.18;
        vy += (NOTCH_Y - y) * 0.18;
        vx *= 0.75; vy *= 0.75;
      } else if (surfaceIdx >= 0) {
        // Others: add gravity to settle toward bottom
        vy += 0.6;
        vx *= 0.88;
        vx += (Math.random() - 0.5) * 0.4;
      } else {
        // Bouncing freely
        vx += (Math.random() - 0.5) * 1.5;
        vy += (Math.random() - 0.5) * 1.5;
      }
      vx = clamp(vx, -5, 5); vy = clamp(vy, -5, 5);
      x += vx; y += vy;
      if (x - ballR < 3) { x = ballR + 3; vx = Math.abs(vx) * 0.75; }
      if (x + ballR > BOWL_W - 3) { x = BOWL_W - ballR - 3; vx = -Math.abs(vx) * 0.75; }
      if (y - ballR < 3) { y = ballR + 3; vy = Math.abs(vy) * 0.75; }
      if (y + ballR > BOWL_H - 3) { y = BOWL_H - ballR - 3; vy = -Math.abs(vy) * 0.75; }
      return { ...b, x, y, vx, vy };
    });
    setPositions([...posRef.current]);
    frameRef.current = requestAnimationFrame(tick);
  }, [ballR, NOTCH_X, NOTCH_Y]);

  // Start/stop bouncing based on animState; reset to grid when done
  useEffect(() => {
    const shouldBounce = animState && animState.bouncing;
    const hasSurface = animState && animState.surfaceIdx != null;
    const active = shouldBounce || hasSurface;
    if (active && !isBouncingRef.current) {
      isBouncingRef.current = true;
      frameRef.current = requestAnimationFrame(tick);
    } else if (!active && isBouncingRef.current) {
      isBouncingRef.current = false;
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      // Reset to organized grid after animation ends
      const r = computeBallR(device.balls.length);
      const removed = (animState && animState.removedSet) || new Set();
      const grid = getGridPositions(device.balls.length, r);
      posRef.current = posRef.current.map((b, i) => removed.has(i) ? b : { ...b, ...grid[i], vx:0, vy:0 });
      setPositions([...posRef.current]);
    }
  }, [animState && animState.bouncing, animState && animState.surfaceIdx]);

  useEffect(() => () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); }, []);

  const removedSet = (animState && animState.removedSet) || new Set();
  const surfaceIdx = animState && animState.surfaceIdx;

  // Group balls by label for editor
  const grouped = [];
  const seen = {};
  device.balls.forEach((b, i) => {
    if (!seen[b.label]) { seen[b.label] = { label:b.label, color:b.color, count:0 }; grouped.push(seen[b.label]); }
    seen[b.label].count++;
  });

  return (
    <div>
      <div style={{ position:"relative", width:BOWL_W, height:BOWL_H, margin:"0 auto 4px",
        background:"linear-gradient(180deg,#eef2ff 0%,#e0e7ff 100%)",
        borderRadius:6,
        border:"2.5px solid #a5b4fc", overflow:"hidden" }}>
        {/* Notch slot at top-center — visible when animating */}
        {(animState && (animState.bouncing || animState.surfaceIdx != null)) && (
          <div style={{
            position:"absolute", left:BOWL_W/2 - ballR - 4, top:0,
            width:ballR * 2 + 8, height:ballR * 2 + 6,
            background:"rgba(255,255,255,0.25)",
            border:"2px dashed rgba(255,255,255,0.7)",
            borderRadius:"0 0 8px 8px", borderTop:"none",
            zIndex:5, pointerEvents:"none",
          }} />
        )}
        {device.balls.map((ball, i) => {
          if (removedSet.has(i)) return null;
          const pos = positions[i] || { x:BOWL_W / 2, y:BOWL_H / 2 };
          const isSurfaced = surfaceIdx === i;
          return (
            <div key={ball.id} style={{
              position:"absolute",
              left:pos.x - ballR, top:pos.y - ballR,
              width:ballR * 2, height:ballR * 2,
              borderRadius:"50%", background:ball.color,
              display:"flex", alignItems:"center", justifyContent:"center",
              fontSize:ballR > 8 ? 9 : 6, fontWeight:700, color:"#fff",
              boxShadow:isSurfaced
                ? "0 0 0 3px #fff, 0 0 0 6px " + ball.color + ", 0 4px 16px rgba(0,0,0,0.3)"
                : "0 1px 3px rgba(0,0,0,0.2)",
              transform:isSurfaced ? "scale(1.5)" : "scale(1)",
              transition:"transform 0.12s, box-shadow 0.12s",
              zIndex:isSurfaced ? 15 : 1,
              pointerEvents:"none",
            }}>
              {ballR >= 8 ? ball.label : ""}
            </div>
          );
        })}
      </div>
      <div style={{ fontSize:10, color:"#bbb", textAlign:"center", marginBottom:4 }}>
        {device.balls.length} ball{device.balls.length !== 1 ? "s" : ""}
      </div>

      <div style={{ display:"flex", flexDirection:"column", gap:3, maxHeight:120, overflowY:"auto" }}>
        {grouped.map(group => (
          <div key={group.label} style={{ display:"flex", alignItems:"center", gap:3 }}>
            <input type="color" value={group.color}
              onChange={e => { const balls = device.balls.map(b => b.label === group.label ? { ...b, color:e.target.value } : b); onChange({ ...device, balls }); }}
              style={{ width:20, height:20, border:"none", padding:0, cursor:"pointer", borderRadius:3, flexShrink:0 }} />
            <div style={{ flex:1, fontSize:12 }}>
              <InlineEdit value={group.label}
                onChange={newL => { const balls = device.balls.map(b => b.label === group.label ? { ...b, label:newL } : b); onChange({ ...device, balls }); }} />
            </div>
            <span style={{ fontSize:10, color:"#888" }}>×{group.count}</span>
            <button onClick={() => { const idx = [...device.balls.map((b, i) => b.label === group.label ? i : -1)].filter(i => i >= 0).at(-1); onChange({ ...device, balls:device.balls.filter((_, i) => i !== idx) }); }}
              style={{ ...btnArr, padding:"0 5px", fontSize:13 }}>−</button>
            <button onClick={() => onChange({ ...device, balls:[...device.balls, { id:uid(), label:group.label, color:group.color }] })}
              style={{ ...btnArr, padding:"0 5px", fontSize:13 }}>+</button>
            <button onClick={() => onChange({ ...device, balls:device.balls.filter(b => b.label !== group.label) })} style={btnX}>×</button>
          </div>
        ))}
      </div>
      <div style={{ display:"flex", gap:5, marginTop:6, flexWrap:"wrap" }}>
        <button onClick={() => { const color = COLORS[grouped.length % COLORS.length]; onChange({ ...device, balls:[...device.balls, { id:uid(), label:`New${grouped.length + 1}`, color }] }); }}
          style={btnPlus}>+ ball type</button>
        <button onClick={() => setRangeOpen(r => !r)}
          style={{ ...btnPlus, color:"#7c3aed", borderColor:"#c4b5fd", background:"#f5f3ff" }}>… range</button>
        <PasteButton onApply={vals => {
          const cm = {}; [...new Set(vals)].forEach((l, i) => { cm[l] = COLORS[i % COLORS.length]; });
          onChange({ ...device, balls:[...device.balls, ...vals.map(label => ({ id:uid(), label, color:cm[label] }))] });
        }} />
      </div>
      {rangeOpen && (
        <RangeInput
          onApply={items => { const cm = {}; [...new Set(items)].forEach((l, i) => { cm[l] = COLORS[i % COLORS.length]; }); onChange({ ...device, balls:[...device.balls, ...items.map(label => ({ id:uid(), label, color:cm[label] }))] }); setRangeOpen(false); }}
          onClose={() => setRangeOpen(false)} />
      )}
      <ReplacementToggle device={device} onChange={onChange} />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// DEVICE CARD
// ══════════════════════════════════════════════════════════════════════════════
const DTYPE = { spinner:{ icon:"🎰", label:"Spinner" }, stacks:{ icon:"📊", label:"Stacks" }, mixer:{ icon:"🎱", label:"Mixer" } };

function DeviceCard({ device, index, total, onChange, onRemove, onMove, animState, locked }) {
  const { icon, label } = DTYPE[device.type] || { icon:"?", label:"?" };

  // For spinners, the badge only shows after the arrow finishes spinning.
  // Reset readiness on each new draw; if not animating (instant mode), it's ready now.
  const [spinnerReady, setSpinnerReady] = useState(false);
  const drawId = animState && animState.drawId;
  const isAnimating = animState && animState.animating;
  useEffect(() => {
    // New draw started: hide until spin completes (unless instant mode)
    setSpinnerReady(!isAnimating);
  }, [drawId]);

  const rawResult = animState && animState.result;
  // Spinner result is gated on spinnerReady; other devices show immediately
  const result = device.type === "spinner"
    ? (spinnerReady ? rawResult : null)
    : rawResult;

  return (
    <div style={{ background:"#fff", borderRadius:12,
      boxShadow:"0 2px 10px rgba(0,0,0,0.06)",
      border:result ? "2px solid #6366f1" : "1.5px solid #e8e8e8",
      padding:12, display:"flex", flexDirection:"column", gap:7,
      flex:"1 1 180px", minWidth:170, maxWidth:240,
      transition:"border-color 0.2s",
      position:"relative" }}>
      {/* Lock overlay when sampling — transparent, just blocks interaction */}
      {locked && (
        <div style={{ position:"absolute", inset:0, borderRadius:12, zIndex:10,
          background:"transparent", cursor:"not-allowed" }} />
      )}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <span style={{ fontWeight:700, fontSize:13, color:"#2c3e50" }}>{icon} {label}</span>
        <div style={{ display:"flex", gap:2 }}>
          <button disabled={index === 0 || locked} onClick={() => onMove(index, -1)} style={btnArr}>←</button>
          <button disabled={index === total - 1 || locked} onClick={() => onMove(index, 1)} style={btnArr}>→</button>
          <button disabled={locked} onClick={onRemove} style={{ ...btnArr, color:"#e74c3c" }}>✕</button>
        </div>
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:4 }}>
        <span style={{ fontSize:10, color:"#bbb" }}>var:</span>
        <input value={device.varName} disabled={locked}
          onChange={e => onChange({ ...device, varName:e.target.value.replace(/\s/g, "_") })}
          style={{ ...iSm, flex:1, fontFamily:"monospace", fontSize:11 }} />
      </div>
      {/* Result badge */}
      <div style={{ minHeight:26, display:"flex", alignItems:"center", justifyContent:"center" }}>
        {result ? (
          <div style={{ background:"#6366f1", color:"#fff", borderRadius:20,
            padding:"3px 16px", fontSize:14, fontWeight:700,
            boxShadow:"0 2px 8px rgba(99,102,241,0.35)" }}>
            {result}
          </div>
        ) : (
          <div style={{ height:24, width:64, borderRadius:20,
            border:"1.5px dashed #e0e0e0", background:"#fafafa" }} />
        )}
      </div>
      {device.type === "spinner" && (
        <SpinnerDevice device={device} onChange={locked ? () => {} : onChange}
          animState={animState} onSpinReady={() => setSpinnerReady(true)} />
      )}
      {device.type === "stacks" && <StacksDevice device={device} onChange={locked ? () => {} : onChange} animState={animState} />}
      {device.type === "mixer"  && <MixerDevice  device={device} onChange={locked ? () => {} : onChange} animState={animState} />}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ANIMATION LOOP
// Drives animState for each device sequentially, then commits a row to the table
// ══════════════════════════════════════════════════════════════════════════════
async function runAnimatedSample({ pipeline, sampleSize, speed, setAnimStates, onRow, onDone, cancelRef }) {
  // speed: 0=slow, 1=fast, 2=instant
  const delay = speed === 0 ? 1800 : speed === 1 ? 500 : 0;

  // Per-device without-replacement tracking (same shape as collect loop)
  const drawState = makeDrawState(pipeline);
  const liveCounts = drawState.liveCounts;
  const drawnSets = drawState.drawnBalls;

  const set = (devId, patch) => setAnimStates(prev => ({ ...prev, [devId]: { ...prev[devId], ...patch, speed } }));
  const clearAll = () => setAnimStates(prev => {
    const next = { ...prev };
    Object.keys(next).forEach(k => { next[k] = { ...next[k], result:null, bouncing:false, surfaceIdx:null, highlightIdx:null, animating:false }; });
    return next;
  });

  for (let s = 0; s < sampleSize; s++) {
    if (cancelRef.current) break;
    const row = { _sample: s + 1 };

    for (const dev of pipeline) {
      if (cancelRef.current) break;
      let result = "";

      if (dev.type === "spinner") {
        result = sampleSpinner(dev.slices);
        if (delay > 0) {
          // Wait for the spinner animation to fully complete before continuing.
          // The spin itself takes ~1600ms (slow) or ~650ms (fast); safety timeout
          // must be LONGER than that so it never cuts the spin short.
          const spinMs = speed === 0 ? 1600 : 650;
          await new Promise(resolve => {
            let done = false;
            const finish = () => { if (!done) { done = true; resolve(); } };
            set(dev.id, { result, animating:true, drawId:uid(), onSpinDone:finish });
            setTimeout(finish, spinMs + 600); // generous safety margin
          });
          // Keep the result visible (animating now false, but result + drawId persist)
          set(dev.id, { animating:false, onSpinDone:null });
          // Hold the finished result on screen briefly before the next device/draw
          await sleep(delay * 0.3);
        } else {
          set(dev.id, { result, animating:false, drawId:uid(), onSpinDone:null });
        }

      } else if (dev.type === "stacks") {
        const counts = liveCounts[dev.id];
        // Pool maps each remaining unit to its item index; live counts already
        // reflect without-replacement removals, so just sample by current counts.
        const pool = dev.items.flatMap((it, i) => Array(Math.max(0, counts[i])).fill(i));
        if (!pool.length) { set(dev.id, { result:"—" }); continue; }
        const pickedIdx = pool[Math.floor(Math.random() * pool.length)];
        result = dev.items[pickedIdx].label;
        if (delay > 0) {
          // Build a merged deck: all remaining units in random order.
          // Place the picked item index on TOP (last element = top of deck).
          const rest = [...pool];
          const removeAt = rest.indexOf(pickedIdx);
          if (removeAt >= 0) rest.splice(removeAt, 1);
          for (let k = rest.length - 1; k > 0; k--) {
            const j = Math.floor(Math.random() * (k + 1));
            [rest[k], rest[j]] = [rest[j], rest[k]];
          }
          const mergedDeck = [...rest, pickedIdx]; // top of deck = picked

          // Phase 0: render cards in their home (category) positions first,
          // so the next state change animates the transition into the deck.
          set(dev.id, { merged:false, mergedDeck, shuffling:false, highlightTop:false, highlightIdx:null, highlightSeg:null, result:null, liveCounts:[...counts] });
          await sleep(60);
          // Phase 1: merge — cards fly from their stacks into one combined deck
          set(dev.id, { merged:true, mergedDeck, shuffling:false, highlightTop:false, result:null, liveCounts:[...counts] });
          await sleep(delay * 0.55);
          // Phase 2: highlight the TOP card of the merged deck
          set(dev.id, { merged:true, mergedDeck, shuffling:false, highlightTop:true, result:null, liveCounts:[...counts] });
          await sleep(delay * 0.3);
          // Phase 3: take the top card, return to separate stacks, show result
          if (!dev.withReplacement) counts[pickedIdx] = Math.max(0, counts[pickedIdx] - 1);
          set(dev.id, { merged:false, mergedDeck:null, shuffling:false, highlightTop:false, highlightIdx:null, highlightSeg:null, result, liveCounts:[...counts] });
          await sleep(delay * 0.2);
        } else {
          if (!dev.withReplacement) counts[pickedIdx] = Math.max(0, counts[pickedIdx] - 1);
          set(dev.id, { result, liveCounts:[...counts], highlightIdx:null, highlightSeg:null, shuffling:false, merged:false });
        }

      } else if (dev.type === "mixer") {
        const removed = drawnSets[dev.id];
        const avail = dev.balls.map((b, i) => i).filter(i => dev.withReplacement || !removed.has(i));
        if (!avail.length) { set(dev.id, { result:"—" }); continue; }
        const pickedIdx = avail[Math.floor(Math.random() * avail.length)];
        result = dev.balls[pickedIdx].label;
        if (delay > 0) {
          set(dev.id, { bouncing:true, surfaceIdx:null, result:null, removedSet:new Set(removed) });
          await sleep(delay * 0.55);
          set(dev.id, { bouncing:true, surfaceIdx:pickedIdx });
          await sleep(delay * 0.3);
          set(dev.id, { bouncing:false, surfaceIdx:null, result });
          if (!dev.withReplacement) removed.add(pickedIdx);
          set(dev.id, { removedSet:new Set(removed) });
          await sleep(delay * 0.15);
        } else {
          if (!dev.withReplacement) removed.add(pickedIdx);
          set(dev.id, { result, removedSet:new Set(removed), bouncing:false });
        }
      }
      row[dev.varName] = result;
    }

    onRow({ ...row });
    if (delay > 0) { await sleep(delay * 0.2); clearAll(); await sleep(60); }
  }

  // Reset live state
  pipeline.forEach(dev => {
    if (dev.type === "stacks") set(dev.id, { liveCounts:null, result:null, highlightIdx:null });
    if (dev.type === "mixer") set(dev.id, { removedSet:new Set(), result:null, bouncing:false });
  });
  clearAll();
  onDone();
}

// ══════════════════════════════════════════════════════════════════════════════
// DOT PLOT
// ══════════════════════════════════════════════════════════════════════════════
function DotPlot({ data, varNames }) {
  const [xVar, setXVar] = useState(varNames[0] || "");
  const [yVar, setYVar] = useState("none");
  const [colorVar, setColorVar] = useState("none");
  const [dotSize, setDotSize] = useState(5);
  useEffect(() => { if (varNames.length && !varNames.includes(xVar)) setXVar(varNames[0]); }, [varNames.join(",")]);

  if (!data.length) return <div style={{ color:"#bbb", padding:24, textAlign:"center" }}>No data yet.</div>;

  const colorKeys = colorVar !== "none" ? [...new Set(data.map(r => r[colorVar]))].sort() : [];
  const colorMap = {};
  colorKeys.forEach((k, i) => { colorMap[k] = COLORS[i % COLORS.length]; });

  const W = 500, H = 260, PL = 50, PR = 16, PT = 18, PB = 44, iW = W - PL - PR, iH = H - PT - PB, R = dotSize;

  const makeScale = (vn, size) => {
    const vals = data.map(r => r[vn]);
    const numeric = vals.slice(0, 20).every(v => !isNaN(Number(v)));
    if (numeric) {
      const nums = vals.map(Number), mn = Math.min(...nums), mx = Math.max(...nums);
      const range = mx - mn || 1, pad = range * 0.05, lo = mn - pad, hi = mx + pad;
      const nT = Math.min(7, Math.max(2, Math.ceil(range) + 1));
      const ticks = Array.from({ length:nT }, (_, i) => mn + (i / (nT - 1)) * range);
      return { numeric:true, scale:v => ((Number(v) - lo) / (hi - lo)) * size, ticks, fmt:v => parseFloat(v.toFixed(2)) };
    } else {
      const cats = [...new Set(vals)].sort(), step = size / cats.length;
      return { numeric:false, scale:v => cats.indexOf(v) * step + step / 2, ticks:cats, fmt:v => v };
    }
  };

  const xS = makeScale(xVar, iW);
  const yS = yVar !== "none" ? makeScale(yVar, iH) : null;

  // First pass: count how many dots fall in each x-stack column to find the tallest
  const colCounts = {};
  if (!yS) {
    data.forEach(row => {
      const xp = xS.scale(row[xVar]);
      const key = Math.round(xp / (R * 2 + 1));
      colCounts[key] = (colCounts[key] || 0) + 1;
    });
  }
  const tallest = Math.max(1, ...Object.values(colCounts));
  // Vertical spacing per dot: shrink so tallest stack fits within iH
  const fitSpacing = (iH - R) / tallest;
  const dotSpacing = Math.min(R * 2 + 1, fitSpacing);

  const stks = {};
  const dots = data.map(row => {
    const xp = xS.scale(row[xVar]);
    let yp;
    if (yS) { yp = iH - yS.scale(row[yVar]); }
    else {
      const key = Math.round(xp / (R * 2 + 1));
      stks[key] = (stks[key] || 0) + 1;
      yp = iH - (stks[key] - 1) * dotSpacing - R;
    }
    const color = colorVar !== "none" ? (colorMap[row[colorVar]] || "#888") : "#3b82f6";
    return { x:PL + xp, y:PT + yp, color };
  });
  const opacity = Math.min(0.9, Math.max(0.15, 80 / Math.sqrt(dots.length + 1)));

  return (
    <div>
      <div style={{ display:"flex", gap:8, marginBottom:8, flexWrap:"wrap", alignItems:"center" }}>
        <Sel label="X" value={xVar} onChange={setXVar} options={varNames} />
        <Sel label="Y" value={yVar} onChange={setYVar} options={["none", ...varNames.filter(v => v !== xVar)]} labels={["— stack dots —", ...varNames.filter(v => v !== xVar)]} />
        <Sel label="Color" value={colorVar} onChange={setColorVar} options={["none", ...varNames]} labels={["none", ...varNames]} />
        <label style={ctrlLbl}>dot size
          <input type="range" min={1} max={12} value={dotSize} onChange={e => setDotSize(+e.target.value)} style={{ width:55, marginLeft:4 }} />
        </label>
      </div>
      <svg width={W} height={H} style={{ display:"block", overflow:"visible", maxWidth:"100%" }}>
        {xS.ticks.map((t, i) => <line key={i} x1={PL + xS.scale(t)} y1={PT} x2={PL + xS.scale(t)} y2={PT + iH} stroke="#f0f0f0" strokeWidth={1} />)}
        {yS && yS.ticks.map((t, i) => <line key={i} x1={PL} y1={PT + iH - yS.scale(t)} x2={PL + iW} y2={PT + iH - yS.scale(t)} stroke="#f0f0f0" strokeWidth={1} />)}
        <line x1={PL} y1={PT + iH} x2={PL + iW} y2={PT + iH} stroke="#ccc" strokeWidth={1.5} />
        <line x1={PL} y1={PT} x2={PL} y2={PT + iH} stroke="#ccc" strokeWidth={1.5} />
        {xS.ticks.map((t, i) => (
          <g key={i}>
            <line x1={PL + xS.scale(t)} y1={PT + iH} x2={PL + xS.scale(t)} y2={PT + iH + 4} stroke="#bbb" />
            <text x={PL + xS.scale(t)} y={PT + iH + 15} textAnchor="middle" fontSize={10} fill="#999">{xS.fmt(t)}</text>
          </g>
        ))}
        {yS && yS.ticks.map((t, i) => (
          <g key={i}>
            <line x1={PL - 4} y1={PT + iH - yS.scale(t)} x2={PL} y2={PT + iH - yS.scale(t)} stroke="#bbb" />
            <text x={PL - 7} y={PT + iH - yS.scale(t)} textAnchor="end" dominantBaseline="middle" fontSize={10} fill="#999">{yS.fmt(t)}</text>
          </g>
        ))}
        <text x={PL + iW / 2} y={H - 3} textAnchor="middle" fontSize={11} fill="#666" fontWeight={600}>{xVar}</text>
        {yS && <text x={12} y={PT + iH / 2} textAnchor="middle" fontSize={11} fill="#666" fontWeight={600} transform={"rotate(-90,12," + (PT + iH / 2) + ")"}>{yVar}</text>}
        {dots.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r={R} fill={d.color} fillOpacity={opacity} stroke="none" />)}
      </svg>
      {colorVar !== "none" && (
        <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginTop:2 }}>
          {colorKeys.map(k => (
            <div key={k} style={{ display:"flex", alignItems:"center", gap:3, fontSize:11 }}>
              <div style={{ width:9, height:9, borderRadius:"50%", background:colorMap[k] }} />
              <span style={{ color:"#666" }}>{colorVar}={k}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// STATISTICS ENGINE
// ══════════════════════════════════════════════════════════════════════════════
function computeStat(stat, rows) {
  let working = rows;
  if (stat.condVar && stat.condVal !== "") working = rows.filter(r => String(r[stat.condVar]) === String(stat.condVal));
  const vals = working.map(r => r[stat.variable]).filter(v => v !== undefined && v !== "");
  const nums = vals.map(Number).filter(v => !isNaN(v));
  const sorted = () => [...nums].sort((a, b) => a - b);
  switch (stat.fn) {
    case "count":      return vals.length;
    case "countVal":   return vals.filter(v => String(v) === String(stat.target)).length;
    case "proportion": return vals.length ? vals.filter(v => String(v) === String(stat.target)).length / vals.length : NaN;
    case "mean":       return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : NaN;
    case "median":     return nums.length ? quantile(sorted(), 0.5) : NaN;
    case "min":        return nums.length ? Math.min(...nums) : NaN;
    case "max":        return nums.length ? Math.max(...nums) : NaN;
    case "q1":         return nums.length ? quantile(sorted(), 0.25) : NaN;
    case "q3":         return nums.length ? quantile(sorted(), 0.75) : NaN;
    case "slope": case "intercept": {
      const pairs = working.map(r => ({ x:Number(r[stat.variable]), y:Number(r[stat.variable2]) })).filter(p => !isNaN(p.x) && !isNaN(p.y));
      const fit = lsFit(pairs);
      if (!fit) return NaN;
      return stat.fn === "slope" ? fit.slope : fit.intercept;
    }
    default: return NaN;
  }
}

function statLabel(s) {
  const c = s.condVar ? " | " + s.condVar + "=\"" + s.condVal + "\"" : "", v = s.variable || "?";
  const mp = { count:"count(" + v + c + ")", countVal:"count(" + v + "=\"" + s.target + "\"" + c + ")", proportion:"prop(" + v + "=\"" + s.target + "\"" + c + ")", mean:"mean(" + v + c + ")", median:"median(" + v + c + ")", min:"min(" + v + c + ")", max:"max(" + v + c + ")", q1:"Q1(" + v + c + ")", q3:"Q3(" + v + c + ")", slope:"slope(" + v + "~" + (s.variable2 || "?") + c + ")", intercept:"intercept(" + v + "~" + (s.variable2 || "?") + c + ")" };
  return mp[s.fn] || s.fn;
}

const FN_OPTS = [{ v:"mean", l:"Mean" }, { v:"median", l:"Median" }, { v:"proportion", l:"Proportion" }, { v:"countVal", l:"Count of value" }, { v:"count", l:"Count (n)" }, { v:"min", l:"Min" }, { v:"max", l:"Max" }, { v:"q1", l:"Q1" }, { v:"q3", l:"Q3" }, { v:"slope", l:"LS Slope" }, { v:"intercept", l:"LS Intercept" }];

function StatDefiner({ stat, varNames, sampleData, onChange, onRemove }) {
  const allVals = stat.variable && sampleData.length ? [...new Set(sampleData.map(r => r[stat.variable]))] : [];
  const condVals = stat.condVar && sampleData.length ? [...new Set(sampleData.map(r => r[stat.condVar]))] : [];
  const needsTarget = ["proportion", "countVal"].includes(stat.fn);
  const needsTwo = ["slope", "intercept"].includes(stat.fn);

  // Auto-fill a sensible default target so the stat is never silently misconfigured
  useEffect(() => {
    if (needsTarget && (!stat.target || stat.target === "") && allVals.length > 0) {
      onChange({ ...stat, target: String(allVals[0]) });
    }
  }, [stat.fn, stat.variable, allVals.length]);
  return (
    <div style={{ background:"#f8f9fa", borderRadius:9, padding:10, border:"1px solid #e2e8f0", position:"relative" }}>
      <button onClick={onRemove} style={{ ...btnX, position:"absolute", top:7, right:7, fontSize:14 }}>×</button>
      <div style={{ display:"flex", gap:6, flexWrap:"wrap", alignItems:"center", paddingRight:20 }}>
        <Sel label="Stat" value={stat.fn} onChange={v => onChange({ ...stat, fn:v })} options={FN_OPTS.map(o => o.v)} labels={FN_OPTS.map(o => o.l)} />
        <Sel label="Variable" value={stat.variable || ""} onChange={v => onChange({ ...stat, variable:v })} options={["", ...varNames]} labels={["—", ...varNames]} />
        {needsTwo && <Sel label="vs" value={stat.variable2 || ""} onChange={v => onChange({ ...stat, variable2:v })} options={["", ...varNames]} labels={["—", ...varNames]} />}
        {needsTarget && allVals.length > 0 && <Sel label="= value" value={stat.target || ""} onChange={v => onChange({ ...stat, target:v })} options={["", ...allVals]} labels={["—", ...allVals]} />}
        {needsTarget && !allVals.length && <label style={ctrlLbl}>= <input value={stat.target || ""} onChange={e => onChange({ ...stat, target:e.target.value })} style={{ ...iSm, width:50, marginLeft:3 }} /></label>}
        <Sel label="| filter" value={stat.condVar || "none"} onChange={v => onChange({ ...stat, condVar:v === "none" ? "" : v, condVal:"" })} options={["none", ...varNames]} labels={["(none)", ...varNames]} />
        {stat.condVar && <Sel label="=" value={stat.condVal || ""} onChange={v => onChange({ ...stat, condVal:v })} options={["", ...condVals]} labels={["—", ...condVals]} />}
      </div>
      <div style={{ marginTop:5, fontSize:11, color:"#6366f1", fontFamily:"monospace" }}>→ {statLabel(stat)}</div>
    </div>
  );
}

function StatDistPlot({ label, values, color }) {
  const valid = values.filter(v => !isNaN(v) && isFinite(v));
  if (!valid.length) return <div style={{ color:"#bbb", fontSize:12, padding:8 }}>No valid values.</div>;
  const mn = Math.min(...valid), mx = Math.max(...valid), range = mx - mn || 1;
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const W = 300, H = 180, PL = 44, PR = 10, PT = 16, PB = 32, iW = W - PL - PR, iH = H - PT - PB;
  const R = Math.max(2, Math.min(6, Math.floor(iW / (valid.length * 0.8 + 1))));
  const pad = range * 0.06, lo = mn - pad, hi = mx + pad;
  const xS = v => ((v - lo) / (hi - lo)) * iW;
  // Find tallest stack to scale vertical spacing so it fits
  const colCounts = {};
  valid.forEach(v => { const key = Math.round(xS(v) / (R * 2 + 0.5)); colCounts[key] = (colCounts[key] || 0) + 1; });
  const tallest = Math.max(1, ...Object.values(colCounts));
  const dotSpacing = Math.min(R * 2 + 0.5, (iH - R) / tallest);
  const stks = {};
  const dots = valid.map(v => { const xp = xS(v), key = Math.round(xp / (R * 2 + 0.5)); stks[key] = (stks[key] || 0) + 1; return { x:PL + xp, y:PT + iH - (stks[key] - 1) * dotSpacing - R }; });
  const nT = 5, ticks = Array.from({ length:nT }, (_, i) => mn + (i / (nT - 1)) * range);
  const opacity = Math.min(0.9, Math.max(0.2, 80 / Math.sqrt(valid.length + 1)));
  const meanX = PL + xS(mean);
  return (
    <div style={{ background:"#fff", borderRadius:10, border:"1px solid #e8e8e8", padding:10, boxShadow:"0 1px 6px rgba(0,0,0,0.04)", minWidth:220 }}>
      <div style={{ fontFamily:"monospace", fontSize:11, color:"#4338ca", marginBottom:3, fontWeight:700 }}>{label}</div>
      <svg width={W} height={H} style={{ display:"block", maxWidth:"100%", overflow:"visible" }}>
        {ticks.map((t, i) => <line key={i} x1={PL + xS(t)} y1={PT} x2={PL + xS(t)} y2={PT + iH} stroke="#f0f0f0" strokeWidth={1} />)}
        <line x1={PL} y1={PT + iH} x2={PL + iW} y2={PT + iH} stroke="#ccc" strokeWidth={1.5} />
        <line x1={PL} y1={PT} x2={PL} y2={PT + iH} stroke="#ccc" strokeWidth={1.5} />
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PL + xS(t)} y1={PT + iH} x2={PL + xS(t)} y2={PT + iH + 4} stroke="#bbb" />
            <text x={PL + xS(t)} y={PT + iH + 13} textAnchor="middle" fontSize={9} fill="#aaa">{parseFloat(t.toFixed(3))}</text>
          </g>
        ))}
        {dots.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r={R} fill={color} fillOpacity={opacity} stroke="none" />)}
        <line x1={meanX} y1={PT} x2={meanX} y2={PT + iH} stroke="#ef4444" strokeWidth={1.5} strokeDasharray="3,3" />
        <text x={meanX} y={PT - 4} textAnchor="middle" fontSize={9} fill="#ef4444">{"x\u0304=" + parseFloat(mean.toFixed(3))}</text>
      </svg>
      <div style={{ fontSize:10, color:"#aaa", display:"flex", gap:8, flexWrap:"wrap" }}>
        <span>n={valid.length}</span>
        <span>min={parseFloat(mn.toFixed(3))}</span>
        <span>max={parseFloat(mx.toFixed(3))}</span>
        <span style={{ color:"#ef4444" }}>mean={parseFloat(mean.toFixed(3))}</span>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// CSV PARSING + TYPE DETECTION + SUMMARY STATS
// ══════════════════════════════════════════════════════════════════════════════
function parseCSV(text) {
  // Simple CSV parser handling quoted fields and commas
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(l => l.length > 0);
  if (!lines.length) return { headers: [], rows: [] };
  const parseLine = line => {
    const out = []; let cur = ""; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ",") { out.push(cur); cur = ""; }
        else cur += c;
      }
    }
    out.push(cur);
    return out.map(s => s.trim());
  };
  const headers = parseLine(lines[0]).map(h => h || "col");
  const rows = lines.slice(1).map(line => {
    const cells = parseLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] !== undefined ? cells[i] : ""; });
    return row;
  });
  return { headers, rows };
}

// Decide if a column is numeric: >80% of non-empty values parse as numbers
function isNumericColumn(rows, col) {
  const vals = rows.map(r => r[col]).filter(v => v !== undefined && v !== "");
  if (!vals.length) return false;
  const numCount = vals.filter(v => !isNaN(Number(v)) && v !== "").length;
  return numCount / vals.length >= 0.8;
}

function quantile(sortedNums, q) {
  if (!sortedNums.length) return NaN;
  const pos = (sortedNums.length - 1) * q;
  const base = Math.floor(pos), rest = pos - base;
  if (sortedNums[base + 1] !== undefined)
    return sortedNums[base] + rest * (sortedNums[base + 1] - sortedNums[base]);
  return sortedNums[base];
}

function numericSummary(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  return {
    n, min: s[0], max: s[n - 1], mean, sd,
    q1: quantile(s, 0.25), median: quantile(s, 0.5), q3: quantile(s, 0.75),
  };
}

function lsFit(pairs) {
  if (pairs.length < 2) return null;
  const n = pairs.length;
  const sx = pairs.reduce((a, p) => a + p.x, 0), sy = pairs.reduce((a, p) => a + p.y, 0);
  const sxy = pairs.reduce((a, p) => a + p.x * p.y, 0), sxx = pairs.reduce((a, p) => a + p.x * p.x, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  // r-squared
  const my = sy / n;
  const ssTot = pairs.reduce((a, p) => a + (p.y - my) ** 2, 0);
  const ssRes = pairs.reduce((a, p) => a + (p.y - (slope * p.x + intercept)) ** 2, 0);
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { slope, intercept, r2 };
}

// ══════════════════════════════════════════════════════════════════════════════
// EDA PLOT — exploratory plot with toggleable statistics overlays
// ══════════════════════════════════════════════════════════════════════════════
function EDAPlot({ rows, headers }) {
  const [xVar, setXVar] = useState(headers[0] || "");
  const [yVar, setYVar] = useState("none");
  const [dotSize, setDotSize] = useState(5);

  // Stat toggles
  const [showBox, setShowBox] = useState(false);
  const [showMean, setShowMean] = useState(false);
  const [showSD, setShowSD] = useState(false);
  const [showLS, setShowLS] = useState(false);
  const [showCounts, setShowCounts] = useState(true);

  // Detect each column's type once per (rows, headers) instead of re-scanning
  // the data on every reference. numericByCol[col] = true/false.
  const numericByCol = useMemo(() => {
    const map = {};
    headers.forEach(h => { map[h] = isNumericColumn(rows, h); });
    return map;
  }, [rows, headers]);

  useEffect(() => { if (headers.length && !headers.includes(xVar)) setXVar(headers[0]); }, [headers.join(",")]);

  if (!rows.length) return <div style={{ color:"#bbb", padding:24, textAlign:"center" }}>No data loaded.</div>;
  if (!xVar) return null;

  const xNumeric = !!numericByCol[xVar];
  const yNumeric = yVar !== "none" && !!numericByCol[yVar];
  const bivariate = yVar !== "none";

  const W = 520, H = 300, PL = 56, PR = 20, PT = 20, PB = 70;
  const iW = W - PL - PR, iH = H - PT - PB;
  const R = dotSize;

  // ── Build scales ──
  const makeScale = (col, size, isNum) => {
    const vals = rows.map(r => r[col]).filter(v => v !== undefined && v !== "");
    if (isNum) {
      const nums = vals.map(Number).filter(v => !isNaN(v));
      const mn = Math.min(...nums), mx = Math.max(...nums);
      const range = mx - mn || 1, pad = range * 0.05, lo = mn - pad, hi = mx + pad;
      const nT = 6;
      const ticks = Array.from({ length: nT }, (_, i) => mn + (i / (nT - 1)) * range);
      return { numeric: true, lo, hi, scale: v => ((Number(v) - lo) / (hi - lo)) * size, ticks, fmt: v => parseFloat(v.toFixed(2)) };
    } else {
      const cats = [...new Set(vals)].sort();
      const step = size / cats.length;
      const idxOf = {}; cats.forEach((c, i) => { idxOf[c] = i; });
      return { numeric: false, cats, scale: v => (idxOf[v] || 0) * step + step / 2, ticks: cats, fmt: v => v };
    }
  };

  const xS = makeScale(xVar, iW, xNumeric);
  const yS = bivariate ? makeScale(yVar, iH, yNumeric) : null;

  // ── Compute dot positions ──
  const colCounts = {};
  if (!yS) {
    rows.forEach(r => {
      const v = r[xVar]; if (v === undefined || v === "") return;
      const key = Math.round(xS.scale(v) / (R * 2 + 1));
      colCounts[key] = (colCounts[key] || 0) + 1;
    });
  }
  const tallest = Math.max(1, ...Object.values(colCounts));
  const dotSpacing = Math.min(R * 2 + 1, (iH - R) / tallest);

  const stks = {};
  const dots = rows.map(r => {
    const xv = r[xVar];
    if (xv === undefined || xv === "") return null;
    if (bivariate && (r[yVar] === undefined || r[yVar] === "")) return null;
    const xp = xS.scale(xv);
    let yp;
    if (yS) yp = iH - yS.scale(r[yVar]);
    else { const key = Math.round(xp / (R * 2 + 1)); stks[key] = (stks[key] || 0) + 1; yp = iH - (stks[key] - 1) * dotSpacing - R; }
    return { x: PL + xp, y: PT + yp };
  }).filter(Boolean);

  // ── Summary stats for side panel ──
  const xNums = rows.map(r => Number(r[xVar])).filter(v => !isNaN(v));
  const xSummary = xNumeric ? numericSummary(xNums) : null;

  // Categorical frequency (univariate or bivariate row-wise)
  let catTable = null;
  if (!xNumeric) {
    if (!bivariate) {
      const counts = {};
      rows.forEach(r => { const v = r[xVar]; if (v !== "") counts[v] = (counts[v] || 0) + 1; });
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      catTable = { type: "uni", counts, total };
    } else if (!yNumeric) {
      // Bivariate categorical is rendered as the grid plot itself; no side table needed
      catTable = null;
    }
  }

  // LS fit for bivariate numeric
  let ls = null;
  if (bivariate && xNumeric && yNumeric) {
    const pairs = rows.map(r => ({ x: Number(r[xVar]), y: Number(r[yVar]) })).filter(p => !isNaN(p.x) && !isNaN(p.y));
    ls = lsFit(pairs);
  }

  // ── Boxplot geometry (horizontal, below the dots) ──
  const boxY = PT + iH + 24;
  const sx = v => PL + xS.scale(v);

  return (
    <div style={{ display:"flex", gap:14, flexWrap:"wrap" }}>
      <div style={{ flex:"2 1 420px", minWidth:340 }}>
        {/* Controls */}
        <div style={{ display:"flex", gap:8, marginBottom:8, flexWrap:"wrap", alignItems:"center" }}>
          <Sel label="X" value={xVar} onChange={setXVar} options={headers} />
          <Sel label="Y" value={yVar} onChange={setYVar} options={["none", ...headers.filter(h => h !== xVar)]} labels={["— none —", ...headers.filter(h => h !== xVar)]} />
          <label style={ctrlLbl}>dot size
            <input type="range" min={1} max={12} value={dotSize} onChange={e => setDotSize(+e.target.value)} style={{ width:55, marginLeft:4 }} />
          </label>
        </div>

        {/* Stat toggles — only show what's reasonable for the data types */}
        <div style={{ display:"flex", gap:10, marginBottom:8, flexWrap:"wrap", fontSize:12 }}>
          {/* univariate numeric, OR categorical-by-numeric split → per-group box/mean/SD */}
          {((xNumeric && !bivariate) || (bivariate && (xNumeric !== yNumeric))) && (
            <>
              <ChkLabel checked={showBox} onChange={setShowBox} label="📦 Boxplot" />
              <ChkLabel checked={showMean} onChange={setShowMean} label="△ Mean" />
              <ChkLabel checked={showSD} onChange={setShowSD} label="↔ ±1 SD" />
            </>
          )}
          {bivariate && xNumeric && yNumeric && (
            <ChkLabel checked={showLS} onChange={setShowLS} label="📈 LS Line" />
          )}
          {!xNumeric && !bivariate && (
            <ChkLabel checked={showCounts} onChange={setShowCounts} label="# Counts & %" />
          )}
        </div>

        {/* Plot — rendering depends on variable types */}
        {(() => {
          // MODE 1: both categorical → grid of cells with stacked dots + count/%
          if (bivariate && !xNumeric && !yNumeric) {
            return <CatCatGrid rows={rows} xVar={xVar} yVar={yVar} R={R} />;
          }
          // MODE 2: one categorical + one numeric → split dot plots by category
          if (bivariate && (xNumeric !== yNumeric)) {
            const catVar = xNumeric ? yVar : xVar;
            const numVar = xNumeric ? xVar : yVar;
            return <SplitDotPlots rows={rows} catVar={catVar} numVar={numVar} R={R}
              showBox={showBox} showMean={showMean} showSD={showSD} />;
          }
          // MODE 3: scatter (both numeric) or univariate → existing SVG
          return (
            <svg width={W} height={H} style={{ display:"block", overflow:"visible", maxWidth:"100%" }}>
              {/* grid */}
              {xS.ticks.map((t, i) => <line key={"xg"+i} x1={sx(t)} y1={PT} x2={sx(t)} y2={PT + iH} stroke="#f5f5f5" strokeWidth={1} />)}
              {yS && yS.ticks.map((t, i) => <line key={"yg"+i} x1={PL} y1={PT + iH - yS.scale(t)} x2={PL + iW} y2={PT + iH - yS.scale(t)} stroke="#f5f5f5" strokeWidth={1} />)}
              {/* axes */}
              <line x1={PL} y1={PT + iH} x2={PL + iW} y2={PT + iH} stroke="#ccc" strokeWidth={1.5} />
              <line x1={PL} y1={PT} x2={PL} y2={PT + iH} stroke="#ccc" strokeWidth={1.5} />
              {/* x ticks */}
              {xS.ticks.map((t, i) => (
                <g key={"xt"+i}>
                  <line x1={sx(t)} y1={PT + iH} x2={sx(t)} y2={PT + iH + 4} stroke="#bbb" />
                  <text x={sx(t)} y={PT + iH + 16} textAnchor="middle" fontSize={10} fill="#999">{xS.fmt(t)}</text>
                </g>
              ))}
              {/* y ticks */}
              {yS && yS.ticks.map((t, i) => (
                <g key={"yt"+i}>
                  <line x1={PL - 4} y1={PT + iH - yS.scale(t)} x2={PL} y2={PT + iH - yS.scale(t)} stroke="#bbb" />
                  <text x={PL - 7} y={PT + iH - yS.scale(t)} textAnchor="end" dominantBaseline="middle" fontSize={10} fill="#999">{yS.fmt(t)}</text>
                </g>
              ))}
              {/* axis labels */}
              <text x={PL + iW / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="#666" fontWeight={600}>{xVar}</text>
              {yS && <text x={14} y={PT + iH / 2} textAnchor="middle" fontSize={11} fill="#666" fontWeight={600} transform={"rotate(-90,14," + (PT + iH / 2) + ")"}>{yVar}</text>}
              {/* dots */}
              {dots.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r={R} fill="#3b82f6" fillOpacity={Math.min(0.85, Math.max(0.2, 70 / Math.sqrt(dots.length + 1)))} />)}
              {/* LS line */}
              {showLS && ls && yS && (() => {
                const x1 = xS.lo, x2 = xS.hi;
                const y1 = ls.slope * x1 + ls.intercept, y2v = ls.slope * x2 + ls.intercept;
                return <line x1={sx(x1)} y1={PT + iH - yS.scale(y1)} x2={sx(x2)} y2={PT + iH - yS.scale(y2v)} stroke="#ef4444" strokeWidth={2} />;
              })()}
              {/* Boxplot (univariate numeric) */}
              {showBox && xSummary && !bivariate && (
                <g>
                  <line x1={sx(xSummary.min)} y1={boxY} x2={sx(xSummary.max)} y2={boxY} stroke="#475569" strokeWidth={1.5} />
                  <line x1={sx(xSummary.min)} y1={boxY - 6} x2={sx(xSummary.min)} y2={boxY + 6} stroke="#475569" strokeWidth={1.5} />
                  <line x1={sx(xSummary.max)} y1={boxY - 6} x2={sx(xSummary.max)} y2={boxY + 6} stroke="#475569" strokeWidth={1.5} />
                  <rect x={sx(xSummary.q1)} y={boxY - 12} width={Math.max(1, sx(xSummary.q3) - sx(xSummary.q1))} height={24} fill="rgba(99,102,241,0.18)" stroke="#6366f1" strokeWidth={1.5} />
                  <line x1={sx(xSummary.median)} y1={boxY - 12} x2={sx(xSummary.median)} y2={boxY + 12} stroke="#6366f1" strokeWidth={2.5} />
                </g>
              )}
              {/* Mean triangle */}
              {showMean && xSummary && !bivariate && (
                <g>
                  <polygon points={(sx(xSummary.mean)) + "," + (PT + iH + 6) + " " + (sx(xSummary.mean) - 6) + "," + (PT + iH + 18) + " " + (sx(xSummary.mean) + 6) + "," + (PT + iH + 18)} fill="#10b981" stroke="#059669" strokeWidth={1} />
                  <text x={sx(xSummary.mean)} y={PT + iH + 30} textAnchor="middle" fontSize={9} fill="#059669" fontWeight={700}>{parseFloat(xSummary.mean.toFixed(2))}</text>
                </g>
              )}
              {/* SD range */}
              {showSD && xSummary && !bivariate && (
                <g>
                  <line x1={sx(xSummary.mean - xSummary.sd)} y1={PT + iH + 44} x2={sx(xSummary.mean + xSummary.sd)} y2={PT + iH + 44} stroke="#f59e0b" strokeWidth={2} />
                  <line x1={sx(xSummary.mean - xSummary.sd)} y1={PT + iH + 40} x2={sx(xSummary.mean - xSummary.sd)} y2={PT + iH + 48} stroke="#f59e0b" strokeWidth={2} />
                  <line x1={sx(xSummary.mean + xSummary.sd)} y1={PT + iH + 40} x2={sx(xSummary.mean + xSummary.sd)} y2={PT + iH + 48} stroke="#f59e0b" strokeWidth={2} />
                  <text x={sx(xSummary.mean)} y={PT + iH + 58} textAnchor="middle" fontSize={9} fill="#d97706" fontWeight={700}>±1 SD = {parseFloat(xSummary.sd.toFixed(2))}</text>
                </g>
              )}
            </svg>
          );
        })()}
      </div>

      {/* Side panel: statistic values */}
      <div style={{ flex:"1 1 220px", minWidth:200 }}>
        <div style={{ fontSize:11, fontWeight:700, color:"#aaa", letterSpacing:1, textTransform:"uppercase", marginBottom:8 }}>Statistics</div>
        {xNumeric && xSummary && (
          <div style={{ background:"#f8f9fa", borderRadius:8, padding:10, border:"1px solid #eee", marginBottom:8 }}>
            <div style={{ fontWeight:700, fontSize:12, color:"#2c3e50", marginBottom:4, fontFamily:"monospace" }}>{xVar}</div>
            {[["n", xSummary.n], ["min", xSummary.min], ["Q1", xSummary.q1], ["median", xSummary.median], ["Q3", xSummary.q3], ["max", xSummary.max], ["mean", xSummary.mean], ["SD", xSummary.sd]].map(([k, v]) => (
              <div key={k} style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"#666", marginBottom:1 }}>
                <span>{k}</span><strong>{typeof v === "number" ? parseFloat(v.toFixed(3)) : v}</strong>
              </div>
            ))}
          </div>
        )}
        {ls && (
          <div style={{ background:"#fef2f2", borderRadius:8, padding:10, border:"1px solid #fecaca", marginBottom:8 }}>
            <div style={{ fontWeight:700, fontSize:12, color:"#b91c1c", marginBottom:4 }}>Least-Squares Line</div>
            <div style={{ fontSize:12, color:"#666", fontFamily:"monospace" }}>ŷ = {parseFloat(ls.slope.toFixed(3))}x + {parseFloat(ls.intercept.toFixed(3))}</div>
            <div style={{ fontSize:11, color:"#999", marginTop:2 }}>R² = {parseFloat(ls.r2.toFixed(3))}</div>
          </div>
        )}
        {catTable && catTable.type === "uni" && showCounts && (
          <div style={{ background:"#f8f9fa", borderRadius:8, padding:10, border:"1px solid #eee" }}>
            <div style={{ fontWeight:700, fontSize:12, color:"#2c3e50", marginBottom:4, fontFamily:"monospace" }}>{xVar}</div>
            {Object.entries(catTable.counts).sort((a, b) => b[1] - a[1]).map(([k, c]) => (
              <div key={k} style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"#666", marginBottom:1 }}>
                <span>{k}</span><strong>{c} <span style={{ color:"#bbb", fontWeight:400 }}>({(c / catTable.total * 100).toFixed(1)}%)</span></strong>
              </div>
            ))}
          </div>
        )}
        {catTable && catTable.type === "bi" && showCounts && (
          <div style={{ background:"#f8f9fa", borderRadius:8, padding:10, border:"1px solid #eee", overflowX:"auto" }}>
            <div style={{ fontWeight:700, fontSize:11, color:"#2c3e50", marginBottom:4 }}>Row-wise % ({xVar} → {yVar})</div>
            <table style={{ borderCollapse:"collapse", fontSize:10 }}>
              <thead>
                <tr><th style={{ padding:"2px 5px", textAlign:"left", color:"#888" }}></th>
                  {catTable.yCats.map(yc => <th key={yc} style={{ padding:"2px 5px", color:"#555" }}>{yc}</th>)}
                </tr>
              </thead>
              <tbody>
                {catTable.xCats.map(xc => {
                  const rowTotal = catTable.yCats.reduce((a, yc) => a + catTable.grid[xc][yc], 0);
                  return (
                    <tr key={xc}>
                      <td style={{ padding:"2px 5px", fontWeight:700, color:"#555" }}>{xc}</td>
                      {catTable.yCats.map(yc => (
                        <td key={yc} style={{ padding:"2px 5px", textAlign:"center", color:"#666" }}>
                          {rowTotal ? (catTable.grid[xc][yc] / rowTotal * 100).toFixed(0) + "%" : "—"}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{ fontSize:9, color:"#aaa", marginTop:3 }}>Each row sums to 100% (P({yVar} | {xVar}))</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// CAT × CAT GRID — TinkerPlots-style cells with stacked dots + count/% per cell
// Percentages are column-conditional (each column sums to 100%), matching the
// reference layout where the colored number = P(row | column).
// ══════════════════════════════════════════════════════════════════════════════
function CatCatGrid({ rows, xVar, yVar, R }) {
  const xCats = [...new Set(rows.map(r => r[xVar]).filter(v => v !== "" && v !== undefined))].sort();
  const yCats = [...new Set(rows.map(r => r[yVar]).filter(v => v !== "" && v !== undefined))].sort();

  // Color per Y-category (rows), like the reference image
  const yColor = {};
  yCats.forEach((yc, i) => { yColor[yc] = COLORS[i % COLORS.length]; });

  // Build counts grid[yc][xc]
  const grid = {};
  yCats.forEach(yc => { grid[yc] = {}; xCats.forEach(xc => grid[yc][xc] = 0); });
  rows.forEach(r => {
    const xc = r[xVar], yc = r[yVar];
    if (xc !== "" && yc !== "" && grid[yc] && grid[yc][xc] !== undefined) grid[yc][xc]++;
  });

  // Row totals for row-conditional % (each Y-category row sums to 100%),
  // matching the reference: percentage = P(X-category | Y-category)
  const rowTotals = {};
  yCats.forEach(yc => { rowTotals[yc] = xCats.reduce((a, xc) => a + grid[yc][xc], 0); });

  const LABEL_W = 110, CELL_MIN_W = 90, CELL_H = 62, HEADER_H = 26, AXIS_H = 24;
  const cellW = Math.max(CELL_MIN_W, Math.min(160, Math.floor(440 / Math.max(xCats.length, 1))));
  const dotR = Math.max(4, Math.min(R + 2, 8));

  return (
    <div style={{ overflowX:"auto" }}>
      <div style={{ display:"inline-block", minWidth:"100%" }}>
        {/* Rows */}
        {yCats.map(yc => (
          <div key={yc} style={{ display:"flex", alignItems:"stretch", borderBottom:"1px solid #eee" }}>
            {/* Row label */}
            <div style={{ width:LABEL_W, flexShrink:0, display:"flex", alignItems:"center",
              justifyContent:"flex-end", paddingRight:10, fontSize:12, color:"#444", fontWeight:600 }}>
              {yc}
            </div>
            {/* Cells */}
            {xCats.map(xc => {
              const c = grid[yc][xc];
              const rowTot = rowTotals[yc] || 0;
              const pct = rowTot ? Math.round(c / rowTot * 100) : 0;
              return (
                <div key={xc} style={{ width:cellW, flexShrink:0, height:CELL_H,
                  borderLeft:"1px solid #eee", padding:"4px 6px", boxSizing:"border-box",
                  display:"flex", flexDirection:"column" }}>
                  <div style={{ fontSize:12, fontWeight:600, color: c > 0 ? "#3730a3" : "#bbb" }}>
                    {c} ({pct}%)
                  </div>
                  {/* Stacked dots */}
                  <div style={{ display:"flex", flexWrap:"wrap", gap:2, alignContent:"flex-start", marginTop:3, flex:1, overflow:"hidden" }}>
                    {Array.from({ length: c }, (_, i) => (
                      <div key={i} style={{ width:dotR * 2, height:dotR * 2, borderRadius:"50%",
                        background:yColor[yc], flexShrink:0 }} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
        {/* X-axis category labels */}
        <div style={{ display:"flex" }}>
          <div style={{ width:LABEL_W, flexShrink:0 }} />
          {xCats.map(xc => (
            <div key={xc} style={{ width:cellW, flexShrink:0, textAlign:"center", paddingTop:5,
              fontSize:12, color:"#444", fontWeight:600 }}>{xc}</div>
          ))}
        </div>
        {/* Axis titles */}
        <div style={{ textAlign:"center", marginTop:4, fontSize:11, color:"#666", fontWeight:700,
          marginLeft:LABEL_W }}>{xVar}</div>
      </div>
      <div style={{ fontSize:10, color:"#aaa", marginTop:4, marginLeft:LABEL_W - 10 }}>
        Rows = {yVar} · percentages are row-conditional: P({xVar} | {yVar})
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SPLIT DOT PLOTS — one numeric axis, split into stacked rows by a categorical
// variable, for comparing distributions across groups. Optional box/mean/SD per group.
// ══════════════════════════════════════════════════════════════════════════════
function SplitDotPlots({ rows, catVar, numVar, R, showBox, showMean, showSD }) {
  const cats = [...new Set(rows.map(r => r[catVar]).filter(v => v !== "" && v !== undefined))].sort();

  // Shared numeric scale across all groups for fair comparison
  const allNums = rows.map(r => Number(r[numVar])).filter(v => !isNaN(v));
  if (!allNums.length) return <div style={{ color:"#bbb", padding:20 }}>No numeric data.</div>;
  const mn = Math.min(...allNums), mx = Math.max(...allNums);
  const range = mx - mn || 1, pad = range * 0.05, lo = mn - pad, hi = mx + pad;

  const W = 520, PL = 90, PR = 20, PT = 10, PB = 40;
  const iW = W - PL - PR;
  const GROUP_H = 78;
  const H = PT + cats.length * GROUP_H + PB;
  const sx = v => PL + ((v - lo) / (hi - lo)) * iW;
  const nT = 6;
  const ticks = Array.from({ length: nT }, (_, i) => mn + (i / (nT - 1)) * range);

  const dotR = Math.max(3, Math.min(R, 6));

  return (
    <svg width={W} height={H} style={{ display:"block", overflow:"visible", maxWidth:"100%" }}>
      {/* vertical gridlines */}
      {ticks.map((t, i) => <line key={"g"+i} x1={sx(t)} y1={PT} x2={sx(t)} y2={H - PB} stroke="#f5f5f5" strokeWidth={1} />)}

      {cats.map((cat, gi) => {
        const top = PT + gi * GROUP_H;
        const baseY = top + GROUP_H - 14; // dots stack upward from here
        const groupNums = rows.map(r => r[catVar] === cat ? Number(r[numVar]) : NaN).filter(v => !isNaN(v));
        const summary = numericSummary(groupNums);
        // Stack dots by x-bin
        const stacks = {};
        const groupDots = groupNums.map(v => {
          const x = sx(v);
          const key = Math.round(x / (dotR * 2 + 1));
          stacks[key] = (stacks[key] || 0) + 1;
          return { x, y: baseY - (stacks[key] - 1) * (dotR * 2 + 1) };
        });
        const color = COLORS[gi % COLORS.length];
        return (
          <g key={cat}>
            {/* group separator */}
            {gi > 0 && <line x1={PL} y1={top} x2={W - PR} y2={top} stroke="#f0f0f0" strokeWidth={1} />}
            {/* group label */}
            <text x={PL - 10} y={top + GROUP_H / 2} textAnchor="end" dominantBaseline="middle"
              fontSize={11} fill="#444" fontWeight={600}>{cat}</text>
            <text x={PL - 10} y={top + GROUP_H / 2 + 13} textAnchor="end" dominantBaseline="middle"
              fontSize={9} fill="#aaa">n={groupNums.length}</text>
            {/* baseline */}
            <line x1={PL} y1={baseY + dotR + 1} x2={W - PR} y2={baseY + dotR + 1} stroke="#e0e0e0" strokeWidth={1} />
            {/* dots */}
            {groupDots.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r={dotR} fill={color}
              fillOpacity={Math.min(0.85, Math.max(0.3, 60 / Math.sqrt(groupDots.length + 1)))} />)}
            {/* boxplot */}
            {showBox && summary && (() => {
              const by = baseY + dotR + 8;
              return (
                <g>
                  <line x1={sx(summary.min)} y1={by} x2={sx(summary.max)} y2={by} stroke="#475569" strokeWidth={1.2} />
                  <rect x={sx(summary.q1)} y={by - 5} width={Math.max(1, sx(summary.q3) - sx(summary.q1))} height={10} fill="rgba(99,102,241,0.15)" stroke={color} strokeWidth={1.2} />
                  <line x1={sx(summary.median)} y1={by - 5} x2={sx(summary.median)} y2={by + 5} stroke={color} strokeWidth={2} />
                </g>
              );
            })()}
            {/* mean triangle */}
            {showMean && summary && (
              <polygon points={sx(summary.mean) + "," + (baseY + dotR + 2) + " " + (sx(summary.mean) - 5) + "," + (baseY + dotR + 11) + " " + (sx(summary.mean) + 5) + "," + (baseY + dotR + 11)}
                fill="#10b981" stroke="#059669" strokeWidth={0.8} />
            )}
            {/* SD range */}
            {showSD && summary && (
              <line x1={sx(summary.mean - summary.sd)} y1={baseY + dotR + 14} x2={sx(summary.mean + summary.sd)} y2={baseY + dotR + 14} stroke="#f59e0b" strokeWidth={2} />
            )}
          </g>
        );
      })}

      {/* x axis */}
      <line x1={PL} y1={H - PB} x2={W - PR} y2={H - PB} stroke="#ccc" strokeWidth={1.5} />
      {ticks.map((t, i) => (
        <g key={"t"+i}>
          <line x1={sx(t)} y1={H - PB} x2={sx(t)} y2={H - PB + 4} stroke="#bbb" />
          <text x={sx(t)} y={H - PB + 16} textAnchor="middle" fontSize={10} fill="#999">{parseFloat(t.toFixed(2))}</text>
        </g>
      ))}
      <text x={PL + iW / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="#666" fontWeight={600}>{numVar} (by {catVar})</text>
    </svg>
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

// ══════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ══════════════════════════════════════════════════════════════════════════════
export default function App() {
  // CSV / EDA dataset
  const [dataset, setDataset] = useState(null); // { headers, rows, name }
  const [edaOpen, setEdaOpen] = useState(true);

  const [pipeline, setPipeline] = useState([mkStacks(1)]);
  const [sampleSize, setSampleSize] = useState(10);
  const [animSpeed, setAnimSpeed] = useState(0); // default: slow
  const [sampleData, setSampleData] = useState([]);
  const [sampling, setSampling] = useState(false);
  const [animStates, setAnimStates] = useState({});
  const cancelRef = useRef(false);

  // Per-type counter for default device names (spin1, mix2, …). Kept in a ref
  // so it persists across renders but resets cleanly if the app remounts.
  const devCounts = useRef({});

  const [stats, setStats] = useState([{ id:uid(), fn:"proportion", variable:"", target:"", condVar:"", condVal:"", variable2:"" }]);
  const [repetitions, setRepetitions] = useState(500);
  const [collecting, setCollecting] = useState(false);
  const [collectProgress, setCollectProgress] = useState(0);
  const [distributions, setDistributions] = useState({});
  const collectCancelRef = useRef(false);
  const STAT_COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899"];

  const varNames = pipeline.map(d => d.varName);

  const addDevice = type => {
    devCounts.current[type] = (devCounts.current[type] || 0) + 1;
    const m = { spinner:mkSpinner, stacks:mkStacks, mixer:mkMixer };
    setPipeline(p => [...p, m[type](devCounts.current[type])]);
  };

  const handleCSVFile = file => {
    const reader = new FileReader();
    reader.onload = e => {
      const parsed = parseCSV(String(e.target.result));
      if (parsed.headers.length) setDataset({ ...parsed, name: file.name });
    };
    reader.readAsText(file);
  };

  const updDevice = (i, d) => setPipeline(p => { const a = [...p]; a[i] = d; return a; });
  const remDevice = i => setPipeline(p => p.filter((_, j) => j !== i));
  const movDevice = (i, dir) => setPipeline(p => { const a = [...p], j = i + dir; if (j < 0 || j >= a.length) return a; [a[i], a[j]] = [a[j], a[i]]; return a; });

  const doSample = useCallback(async () => {
    if (sampling) { cancelRef.current = true; return; }
    cancelRef.current = false;
    setSampling(true);
    setSampleData([]);
    const rows = [];
    await runAnimatedSample({
      pipeline, sampleSize, speed:animSpeed,
      setAnimStates,
      onRow: row => { rows.push(row); setSampleData([...rows]); },
      onDone: () => setSampling(false),
      cancelRef,
    });
  }, [pipeline, sampleSize, animSpeed, sampling]);

  const addStat = () => setStats(s => [...s, { id:uid(), fn:"mean", variable:varNames[0] || "", target:"", condVar:"", condVal:"", variable2:"" }]);
  const updStat = (i, s) => setStats(ss => { const a = [...ss]; a[i] = s; return a; });
  const remStat = i => setStats(ss => ss.filter((_, j) => j !== i));

  const doCollect = async () => {
    if (collecting) { collectCancelRef.current = true; return; }
    collectCancelRef.current = false;
    setCollecting(true); setCollectProgress(0);
    const validStats = stats.filter(s => s.variable);
    const accum = {};
    validStats.forEach(s => { accum[s.id] = []; });
    let rep = 0;
    const CHUNK = 200;
    const step = () => {
      let n = 0;
      while (n < CHUNK && rep < repetitions && !collectCancelRef.current) {
        // Per-repetition state: live counts for stacks, drawn-index sets for mixer
        const drawState = makeDrawState(pipeline);
        const rows = [];
        for (let s = 0; s < sampleSize; s++) {
          const row = { _sample:s + 1 };
          pipeline.forEach(dev => {
            if (dev.type === "spinner") {
              row[dev.varName] = sampleSpinner(dev.slices);
            } else if (dev.type === "stacks") {
              const drawn = drawStacks(dev, drawState);
              row[dev.varName] = drawn ? drawn.label : "";
            } else if (dev.type === "mixer") {
              const drawn = drawMixer(dev, drawState);
              row[dev.varName] = drawn ? drawn.label : "";
            }
          });
          rows.push(row);
        }
        validStats.forEach(s => { accum[s.id].push(computeStat(s, rows)); });
        rep++; n++;
      }
      setCollectProgress(Math.round(rep / repetitions * 100));
      if (rep < repetitions && !collectCancelRef.current) requestAnimationFrame(step);
      else { setDistributions({ ...accum }); setCollecting(false); }
    };
    requestAnimationFrame(step);
  };

  const exportCSV = (data, name) => {
    const cols = Object.keys(data[0] || {});
    const csv = [cols.join(","), ...data.map(r => cols.map(c => r[c]).join(","))].join("\n");
    const a = document.createElement("a");
    a.href = "data:text/csv," + encodeURIComponent(csv);
    a.download = name; a.click();
  };

  const SPEED_LABELS = ["🐢 Slow", "🐇 Fast", "⚡ Instant"];

  return (
    <div style={{ fontFamily:"'IBM Plex Sans',system-ui,sans-serif", background:"#f1f2f5", minHeight:"100vh", padding:14, boxSizing:"border-box" }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:14, flexWrap:"wrap" }}>
        <div>
          <h1 style={{ margin:0, fontSize:20, fontWeight:800, color:"#1a1a2e" }}>🎲 TinkerSim</h1>
          <p style={{ margin:0, fontSize:11, color:"#999" }}>Probability sampler & simulation</p>
        </div>
        <div style={{ marginLeft:"auto", display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:1 }}>
            <span style={{ fontSize:10, color:"#888" }}>{SPEED_LABELS[animSpeed]}</span>
            <input type="range" min={0} max={2} step={1} value={animSpeed} onChange={e => setAnimSpeed(+e.target.value)} style={{ width:80, accentColor:"#6366f1" }} />
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:9, color:"#bbb", width:80 }}>
              <span>slow</span><span>fast</span><span>instant</span>
            </div>
          </div>
          <label style={ctrlLbl}>n =
            <input type="number" value={sampleSize} min={1} max={10000}
              onChange={e => setSampleSize(Math.max(1, parseInt(e.target.value) || 1))}
              style={{ ...iSm, width:60, marginLeft:4 }} />
          </label>
          <button onClick={doSample} style={{ padding:"8px 18px", background:sampling ? "#ef4444" : "#6366f1", color:"#fff", border:"none", borderRadius:8, fontWeight:700, fontSize:13, cursor:"pointer", minWidth:120 }}>
            {sampling ? "⏹ Stop" : "▶ Draw Sample"}
          </button>
          {sampleData.length > 0 && !sampling && (
            <button onClick={() => exportCSV(sampleData, "sample.csv")} style={{ ...btnNav, fontSize:12 }}>⬇ CSV</button>
          )}
        </div>
      </div>

      {/* ── CSV / EDA STAGE ── */}
      <div style={{ background:"#fff", borderRadius:14, padding:14, marginBottom:14, boxShadow:"0 1px 6px rgba(0,0,0,0.04)", border:"1px solid #eee" }}>
        <div style={{ display:"flex", gap:10, alignItems:"center", flexWrap:"wrap", marginBottom: edaOpen ? 12 : 0 }}>
          <button onClick={() => setEdaOpen(o => !o)}
            style={{ background:"none", border:"none", cursor:"pointer", fontSize:13, fontWeight:700, color:"#2c3e50", display:"flex", alignItems:"center", gap:6 }}>
            <span style={{ transform: edaOpen ? "rotate(90deg)" : "none", transition:"transform 0.15s", display:"inline-block" }}>▶</span>
            📂 Data &amp; Exploratory Analysis
          </button>
          {dataset && <span style={{ fontSize:11, color:"#aaa" }}>{dataset.name} · {dataset.rows.length} rows · {dataset.headers.length} cols</span>}
          <label style={{ marginLeft:"auto", ...btnNav, fontSize:12, cursor:"pointer", display:"inline-flex", alignItems:"center", gap:5 }}>
            ⬆ Upload CSV
            <input type="file" accept=".csv,text/csv" style={{ display:"none" }}
              onChange={e => { const f = e.target.files && e.target.files[0]; if (f) handleCSVFile(f); }} />
          </label>
          {dataset && <button onClick={() => setDataset(null)} style={{ ...btnNav, fontSize:12 }}>✕ Clear</button>}
        </div>

        {edaOpen && (
          dataset ? (
            <div>
              <EDAPlot rows={dataset.rows} headers={dataset.headers} />
              <div style={{ marginTop:12, paddingTop:10, borderTop:"1px solid #f0f0f0" }}>
                <div style={{ fontSize:11, fontWeight:700, color:"#aaa", letterSpacing:1, textTransform:"uppercase", marginBottom:6 }}>
                  Copy a column
                </div>
                <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                  {dataset.headers.map(h => (
                    <CopyColumnButton key={h} header={h} rows={dataset.rows} />
                  ))}
                </div>
                <div style={{ fontSize:10, color:"#bbb", marginTop:4 }}>
                  Copies every value in the column. Build a Mixer in the sampler below, then use its <strong>📋 paste</strong> button to load the data.
                </div>
              </div>
            </div>
          ) : (
            <div style={{ color:"#bbb", textAlign:"center", padding:24, fontSize:13 }}>
              Upload a CSV to explore your data, compute statistics, and feed columns into the sampler.
            </div>
          )
        )}
      </div>

      {/* Pipeline */}
      <div style={{ background:"#fff", borderRadius:14, padding:14, marginBottom:14, boxShadow:"0 1px 6px rgba(0,0,0,0.04)", border:"1px solid #eee" }}>
        <div style={{ display:"flex", gap:8, marginBottom:10, alignItems:"center", flexWrap:"wrap" }}>
          <span style={{ fontSize:11, fontWeight:700, color:"#bbb", letterSpacing:1, textTransform:"uppercase" }}>Sampler Pipeline</span>
          {[["stacks", "📊 Stacks"], ["mixer", "🎱 Mixer"], ["spinner", "🎰 Spinner"]].map(([t, l]) => (
            <button key={t} onClick={() => addDevice(t)} disabled={sampling}
              style={{ padding:"4px 10px", background:"#f7f8fa", border:"1.5px dashed #ddd", borderRadius:7, fontSize:12, cursor:sampling?"not-allowed":"pointer", color:sampling?"#bbb":"#555", opacity:sampling?0.5:1 }}>+ {l}</button>
          ))}
          {sampling && <span style={{ fontSize:12, color:"#6366f1", fontWeight:600 }}>drawing {sampleData.length}/{sampleSize}…</span>}
        </div>
        <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"flex-start" }}>
          {pipeline.map((dev, i) => (
            <div key={dev.id} style={{ display:"contents" }}>
              <DeviceCard device={dev} index={i} total={pipeline.length}
                onChange={d => updDevice(i, d)} onRemove={() => remDevice(i)} onMove={movDevice}
                animState={animStates[dev.id] || null} locked={sampling} />
              {i < pipeline.length - 1 && <div style={{ alignSelf:"center", color:"#ccc", fontSize:20, flexShrink:0 }}>→</div>}
            </div>
          ))}
        </div>
      </div>

      {/* Sample Results */}
      <div style={{ background:"#fff", borderRadius:14, padding:14, marginBottom:14, boxShadow:"0 1px 6px rgba(0,0,0,0.04)", border:"1px solid #eee", opacity:sampleData.length ? 1 : 0.4, transition:"opacity 0.3s" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12, flexWrap:"wrap" }}>
          <span style={{ fontSize:14, fontWeight:700, color:"#2c3e50" }}>Sample Results</span>
          {sampleData.length > 0 && <span style={{ fontSize:11, color:"#aaa" }}>n = {sampleData.length}</span>}
        </div>
        {sampleData.length > 0 ? (
          <div style={{ display:"flex", gap:12, flexWrap:"wrap" }}>
            <div style={{ flex:"2 1 340px", minWidth:260 }}>
              <DotPlot data={sampleData} varNames={varNames} />
            </div>
            <div style={{ flex:"1 1 200px", minWidth:180, maxHeight:270, overflowY:"auto" }}>
              <table style={{ borderCollapse:"collapse", width:"100%", fontSize:12 }}>
                <thead>
                  <tr style={{ background:"#f7f7fa" }}>
                    {["_sample", ...varNames].map(c => <th key={c} style={{ padding:"5px 8px", textAlign:"left", fontWeight:600, color:"#555", borderBottom:"2px solid #eee", whiteSpace:"nowrap" }}>{c}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {sampleData.slice(-60).reverse().map((row, i) => (
                    <tr key={i} style={{ background:i === 0 ? "#f0f4ff" : i % 2 ? "#fafafa" : "#fff" }}>
                      {["_sample", ...varNames].map(c => <td key={c} style={{ padding:"3px 8px", borderBottom:"1px solid #f0f0f0", color:c === "_sample" ? "#bbb" : "#2c3e50" }}>{row[c]}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div style={{ color:"#bbb", textAlign:"center", padding:24 }}>Press "Draw Sample" to begin</div>
        )}
      </div>

      {/* Collect Statistics */}
      <div style={{ background:"#fff", borderRadius:14, padding:14, boxShadow:"0 1px 6px rgba(0,0,0,0.04)", border:"1px solid #eee", opacity:sampleData.length ? 1 : 0.35, pointerEvents:sampleData.length ? "auto" : "none", transition:"opacity 0.3s" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12, flexWrap:"wrap" }}>
          <span style={{ fontSize:14, fontWeight:700, color:"#2c3e50" }}>📈 Collect Statistics</span>
          <div style={{ marginLeft:"auto", display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
            <label style={ctrlLbl}>Repetitions:
              <input type="number" value={repetitions} min={1} max={10000}
                onChange={e => setRepetitions(Math.max(1, parseInt(e.target.value) || 1))}
                style={{ ...iSm, width:70, marginLeft:4 }} />
            </label>
            <button onClick={doCollect} disabled={!stats.some(s => s.variable)}
              style={{ padding:"7px 16px", background:collecting ? "#ef4444" : "#10b981", color:"#fff", border:"none", borderRadius:8, fontWeight:700, fontSize:13, cursor:"pointer", minWidth:100 }}>
              {collecting ? "⏹ " + collectProgress + "%" : "▶ Collect"}
            </button>
            {Object.keys(distributions).length > 0 && !collecting && (
              <button onClick={() => {
                const vs = stats.filter(s => s.variable && distributions[s.id]);
                const rows = Array.from({ length:repetitions }, (_, i) => { const r = { _rep:i + 1 }; vs.forEach(s => { r[statLabel(s)] = distributions[s.id] && distributions[s.id][i] !== undefined ? distributions[s.id][i] : ""; }); return r; });
                exportCSV(rows, "distributions.csv");
              }} style={{ ...btnNav, fontSize:12 }}>⬇ CSV</button>
            )}
          </div>
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:6, marginBottom:12 }}>
          {stats.map((s, i) => (
            <StatDefiner key={s.id} stat={s} varNames={varNames} sampleData={sampleData}
              onChange={ns => updStat(i, ns)} onRemove={() => remStat(i)} />
          ))}
          <button onClick={addStat} style={{ ...btnPlus, alignSelf:"flex-start", marginTop:2 }}>+ add statistic</button>
        </div>
        {Object.keys(distributions).length > 0 && (
          <div>
            <div style={{ fontSize:11, fontWeight:700, color:"#aaa", letterSpacing:1, textTransform:"uppercase", marginBottom:10 }}>
              Sampling Distributions — {repetitions} reps × n={sampleSize}
            </div>
            <div style={{ display:"flex", gap:12, flexWrap:"wrap" }}>
              {stats.filter(s => s.variable && distributions[s.id]).map((s, i) => (
                <StatDistPlot key={s.id} label={statLabel(s)} values={distributions[s.id]} color={STAT_COLORS[i % STAT_COLORS.length]} />
              ))}
            </div>
          </div>
        )}
        {!Object.keys(distributions).length && sampleData.length > 0 && (
          <div style={{ color:"#bbb", textAlign:"center", padding:16, fontSize:13 }}>Define a statistic above, then click Collect.</div>
        )}
      </div>
    </div>
  );
}
