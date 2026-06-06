import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { iSm, btnX, btnPlus, btnArr } from "../lib/styles";
import { COLORS, clamp, uid, nextItemLabel } from "../lib/util";
import { InlineEdit, PasteButton, ReplacementToggle, RangeInput } from "./ui";

// ── Spinner slice math: every helper returns a fresh slices array that sums to 100 ──
// Floor so a slice never fully vanishes (small enough that manual entry stays flexible;
// borders this thin are hard to grab by drag, but the number box can still set them).
const MIN_PCT = 0.1;

// Set slice `i` to `newPct`, absorbing the delta from the OTHER slices so Σ stays 100.
// Others are visited in adjacency order — below first, then nearest-above — so editing a
// value pulls only from the sections beneath it, cascading upward only when those can't
// supply enough. e.g. [33.3,33.3,33.4] set #0→40 ⇒ [40,26.6,33.4].
function redistribute(slices, i, newPct) {
  const n = slices.length;
  if (n <= 1) return slices.map(s => ({ ...s, pct: 100 }));
  newPct = clamp(newPct, MIN_PCT, 100 - MIN_PCT * (n - 1));
  const out = slices.map(s => ({ ...s }));
  let delta = newPct - slices[i].pct;           // >0 take from others; <0 give back
  out[i].pct = newPct;
  const order = [];                              // below first, then nearest-above:
  for (let j = i + 1; j < n; j++) order.push(j);  // i+1…n-1
  for (let j = i - 1; j >= 0; j--) order.push(j); // i-1…0
  if (delta > 0) {                               // pull `delta` from others, down to MIN
    for (const j of order) {
      if (delta <= 1e-9) break;
      const give = Math.min(delta, out[j].pct - MIN_PCT);
      out[j].pct -= give; delta -= give;
    }
  } else if (delta < 0) {                         // hand `-delta` back, nearest first
    out[order[0]].pct += -delta;
  }
  return out;
}

// Append a slice at an equal share (100/(n+1)); scale existing down to fill the rest.
function addSlice(slices) {
  const n = slices.length;
  const fresh = 100 / (n + 1);
  const sum = slices.reduce((s, sl) => s + sl.pct, 0) || 1;
  const factor = (100 - fresh) / sum;
  const out = slices.map(s => ({ ...s, pct: s.pct * factor }));
  out.push({ id: uid(), label: nextItemLabel(slices.map(s => s.label)), pct: fresh, color: COLORS[n % COLORS.length] });
  return out;
}

// Drop slice `i`; scale the remainder back up to sum 100. Never removes the last slice.
function removeSlice(slices, i) {
  if (slices.length <= 1) return slices;
  const rest = slices.filter((_, j) => j !== i);
  const sum = rest.reduce((s, sl) => s + sl.pct, 0) || 1;
  const factor = 100 / sum;
  return rest.map(s => ({ ...s, pct: s.pct * factor }));
}

// Reset every slice to an equal share.
function equalize(slices) {
  const eq = 100 / slices.length;
  return slices.map(s => ({ ...s, pct: eq }));
}

// Percentage entry that commits on blur/Enter (not per keystroke) so the redistribution
// — and the invalidation guard it can trigger — runs once, not on every digit typed.
function PctInput({ pct, onCommit }) {
  const [val, setVal] = useState("");
  const [editing, setEditing] = useState(false);
  const rounded = Math.round(pct * 10) / 10;
  const commit = () => {
    setEditing(false);
    const p = parseFloat(val);
    if (!isNaN(p)) onCommit(p);
  };
  return (
    <input type="number" value={editing ? val : rounded} min={MIN_PCT} max={100} step={1}
      onFocus={() => { setEditing(true); setVal(String(rounded)); }}
      onChange={e => setVal(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === "Enter") { commit(); e.target.blur(); }
        else if (e.key === "Escape") { setEditing(false); e.target.blur(); }
      }}
      style={{ ...iSm, width:46 }} />
  );
}

function SpinnerDevice({ device, onChange, animState, onSpinReady }) {
  const total = device.slices.reduce((s, sl) => s + sl.pct, 0) || 100;
  const svgRef = useRef(null);
  // Local preview of slices mid-drag. We do NOT call onChange on every mousemove: each
  // onChange runs updDevice's invalidation guard, which can pop a window.confirm — firing
  // one dialog per pixel of drag. Instead preview locally and commit one onChange on
  // mouseup (mirrors the StacksDevice fix). On cancel, no setPipeline runs so device.slices
  // is unchanged and the re-render snaps the border back.
  const [dragPreview, setDragPreview] = useState(null); // slices[] | null

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

  // Slices to render: the live drag preview while dragging, else the committed device.
  const displaySlices = dragPreview || device.slices;
  const dispTotal = displaySlices.reduce((s, sl) => s + sl.pct, 0) || 100;
  // Cumulative percentage before slice j (its start position, 0–100).
  const cumBefore = j => displaySlices.slice(0, j).reduce((s, sl) => s + sl.pct, 0);

  // Drag the interior boundary at the start of slice k (between slice k-1 and slice k),
  // trading percentage between just those two so the total is conserved.
  const startBorderDrag = (e, k) => {
    e.preventDefault();
    const base = device.slices.map(s => ({ ...s }));
    const cumLo = base.slice(0, k - 1).reduce((s, sl) => s + sl.pct, 0); // start of slice k-1
    const span = base[k - 1].pct + base[k].pct;                          // combined budget
    let committed = null;
    const move = ev => {
      const rect = svgRef.current.getBoundingClientRect();
      // client → SVG user space (viewBox -1.15 … +1.15 on each axis).
      const ux = ((ev.clientX - rect.left) / rect.width) * 2.3 - 1.15;
      const uy = ((ev.clientY - rect.top) / rect.height) * 2.3 - 1.15;
      const angle = Math.atan2(uy, ux) * 180 / Math.PI;     // drawing angle (y-down)
      const offset = (((angle + 90) % 360) + 360) % 360;     // degrees CW from the top
      const pctPos = offset / 360 * 100;
      const newCum = clamp(pctPos, cumLo + MIN_PCT, cumLo + span - MIN_PCT);
      const next = base.map(s => ({ ...s }));
      next[k - 1].pct = newCum - cumLo;
      next[k].pct = cumLo + span - newCum;
      committed = next;
      setDragPreview(next);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setDragPreview(null);
      // Commit once, only if a drag actually moved the border.
      if (committed) onChange({ ...device, slices: committed });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  let cumAngle = -90;

  return (
    <div>
      <svg ref={svgRef} viewBox="-1.15 -1.15 2.3 2.3" style={{ width:"100%", maxWidth:160, display:"block", margin:"0 auto" }}>
        {displaySlices.map((sl, i) => {
          const sweep = (sl.pct / dispTotal) * 360;
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
              {(sl.pct / dispTotal) > 0.07 && (
                <text x={tx} y={ty} textAnchor="middle" dominantBaseline="middle"
                  fontSize="0.18" fontWeight="bold" fill="#fff"
                  style={{ pointerEvents:"none" }}>
                  {sl.label}
                </text>
              )}
            </g>
          );
        })}
        {/* Draggable interior boundaries (slice 0 stays anchored at the top). Wide
            transparent hit lines over the white slice borders. */}
        {displaySlices.map((sl, k) => {
          if (k === 0) return null;
          const ang = -90 + (cumBefore(k) / dispTotal) * 360;
          const rx = Math.cos(rad(ang)), ry = Math.sin(rad(ang));
          return (
            <line key={"h" + sl.id} x1="0" y1="0" x2={rx} y2={ry}
              stroke="transparent" strokeWidth="0.14"
              style={{ cursor:"col-resize" }}
              onMouseDown={e => startBorderDrag(e, k)} />
          );
        })}
        <g transform={"rotate(" + (displayAngle + 90) + ")"} style={{ pointerEvents:"none" }}>
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
            <PctInput pct={sl.pct}
              onCommit={p => onChange({ ...device, slices: redistribute(device.slices, i, p) })} />
            <span style={{ fontSize:10, color:"#bbb" }}>%</span>
            <button disabled={device.slices.length <= 1}
              onClick={() => onChange({ ...device, slices: removeSlice(device.slices, i) })} style={btnX}>×</button>
          </div>
        ))}
        <div style={{ display:"flex", gap:4, marginTop:2 }}>
          <button onClick={() => onChange({ ...device, slices: addSlice(device.slices) })}
            style={{ ...btnPlus, flex:1 }}>+ slice</button>
          <button onClick={() => onChange({ ...device, slices: equalize(device.slices) })}
            style={{ ...btnPlus, flex:1 }}>Equalize</button>
        </div>
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
  const dragY0 = useRef(0), dragCount0 = useRef(0);
  // Local preview of the bar being dragged. We do NOT call onChange on every
  // mousemove: each onChange runs updDevice's invalidation guard, which can pop a
  // window.confirm — firing one dialog per pixel of drag (and never settling, since
  // the collected-rows state clears asynchronously). Instead preview locally and
  // commit a single onChange on mouseup.
  const [dragPreview, setDragPreview] = useState(null); // { i, count } | null

  // Live counts: from animState when animating, else the drag preview, else device
  const displayCounts = (animState && animState.liveCounts) ||
    device.items.map((it, idx) => (dragPreview && dragPreview.i === idx ? dragPreview.count : it.count));
  const highlightIdx = animState && animState.highlightIdx;
  const shuffling = animState && animState.shuffling;
  const merged = animState && animState.merged;
  const mergedDeck = (animState && animState.mergedDeck) || null;
  const highlightTop = animState && animState.highlightTop;

  const startDrag = (e, i) => {
    e.preventDefault();
    dragY0.current = e.clientY; dragCount0.current = device.items[i].count;
    let lastCount = dragCount0.current;
    const move = ev => {
      const delta = Math.round((dragY0.current - ev.clientY) / 7);
      lastCount = clamp(dragCount0.current + delta, 0, MAX_CT);
      setDragPreview({ i, count:lastCount });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setDragPreview(null);
      // Commit once, and only if the count actually changed (a bare click shouldn't
      // trip the invalidation guard).
      if (lastCount !== dragCount0.current) {
        const items = [...device.items];
        items[i] = { ...items[i], count:lastCount };
        onChange({ ...device, items });
      }
    };
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
        <button onClick={() => onChange({ ...device, items:[...device.items, { id:uid(), label:nextItemLabel(device.items.map(it => it.label)), count:3, color:COLORS[device.items.length % COLORS.length] }] })}
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
        <button onClick={() => {
            // Continue the existing label pattern; nextItemLabel skips labels that already
            // exist, so removing a middle type then adding one makes a NEW type instead of
            // merging into an existing one.
            const label = nextItemLabel(grouped.map(g => g.label));
            const color = COLORS[grouped.length % COLORS.length];
            onChange({ ...device, balls:[...device.balls, { id:uid(), label, color }] });
          }}
          style={btnPlus}>+ ball type</button>
        <button onClick={() => setRangeOpen(r => !r)}
          style={{ ...btnPlus, color:"#7c3aed", borderColor:"#c4b5fd", background:"#f5f3ff" }}>… range</button>
        <PasteButton onApply={vals => {
          const cm = {}; [...new Set(vals)].forEach((l, i) => { cm[l] = COLORS[i % COLORS.length]; });
          onChange({ ...device, balls:vals.map(label => ({ id:uid(), label, color:cm[label] })) });
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

function DeviceCard({ device, index, total, onChange, onRemove, onMove, animState, locked, nameError }) {
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
          title={nameError ? "Device names must be unique and non-blank" : undefined}
          onChange={e => onChange({ ...device, varName:e.target.value.replace(/\s/g, "_") })}
          style={{ ...iSm, flex:1, fontFamily:"monospace", fontSize:11,
            borderColor: nameError ? "#ef4444" : undefined,
            boxShadow: nameError ? "0 0 0 1px #ef4444" : undefined }} />
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

export { SpinnerDevice, StacksDevice, MixerDevice, DeviceCard };
