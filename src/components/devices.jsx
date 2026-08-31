import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { iSm, btnX, btnPlus, btnArr } from "../lib/styles";
import { COLORS, clamp, uid, nextItemLabel } from "../lib/util";
import { InlineEdit, FillFromData, ReplacementToggle, RangeInput, NumInput } from "./ui";
import { mkSpinner, mkStacks, mkMixer, convertDevice, stageOutcomes } from "../lib/sampling";

// ── Animation level-of-detail cap ──────────────────────────────────────────────
// Above this many objects, the animated devices render a bounded, proportional SUBSET
// (mixer balls / stacks stripes). This is VIEW-ONLY: the draw itself uses the full
// device (see sampling.js pickStacksIdx / the mixer `avail` filter), so probabilities
// are unchanged — every ball/card stays equally likely to be picked.
const ANIM_RENDER_CAP = 400;

// Largest ball radius in [2,12] at which `n` balls fit the bowl grid without overflowing
// (so nothing has to be clamped to the top edge). Shrinks as n grows, then floors at 2.
// Searches in 0.1 steps, NOT integers: a coarse search jumps from "just fits" to "way
// oversized" (e.g. 400 balls need 15 rows at r≈2.9 but fill only ~half the bowl at r=2),
// leaving the bowl half-empty. A tight fractional fit packs `n` balls up to the top.
function fitRadius(n, W, H) {
  if (n <= 0) return 12;
  for (let s = 120; s >= 20; s--) {
    const r = s / 10;
    const gap = r < 6 ? 1 : 2, pitch = r * 2 + gap;
    const cols = Math.max(1, Math.floor((W - 2) / pitch));
    const rows = Math.max(1, Math.floor((H - 2) / pitch));
    if (cols * rows >= n) return r;
  }
  return 2;
}

// Allocate at most `cap` representative slots across label groups, proportional to each
// group's count (largest-remainder rounding), preserving group order. A non-empty group
// never fully vanishes. Returns [{label,color}].
function representativeSlots(groups, cap) {
  const total = groups.reduce((s, g) => s + g.count, 0);
  if (total <= 0) return [];
  if (total <= cap) return groups.flatMap(g => Array.from({ length: g.count }, () => ({ label: g.label, color: g.color })));
  const exact = groups.map(g => (g.count / total) * cap);
  const alloc = exact.map(Math.floor);
  let used = alloc.reduce((a, b) => a + b, 0);
  const order = groups.map((g, i) => ({ i, frac: exact[i] - alloc[i] })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; used < cap && k < order.length; k++, used++) alloc[order[k].i]++;
  groups.forEach((g, i) => {                    // keep every non-empty outcome visible
    if (g.count > 0 && alloc[i] === 0) {
      let m = 0; for (let j = 1; j < alloc.length; j++) if (alloc[j] > alloc[m]) m = j;
      if (alloc[m] > 1) { alloc[m]--; alloc[i] = 1; }
    }
  });
  const out = [];
  groups.forEach((g, i) => { for (let j = 0; j < alloc[i]; j++) out.push({ label: g.label, color: g.color }); });
  return out;
}

// Systematically downsample a shuffled deck of item-indices to at most `cap` entries,
// preserving the interleaved order and ALWAYS keeping the last element (the picked top card).
function downsampleDeck(deck, cap) {
  if (deck.length <= cap) return deck;
  const step = deck.length / cap;
  const out = [];
  for (let k = 0; k < cap - 1; k++) out.push(deck[Math.floor(k * step)]);
  out.push(deck[deck.length - 1]);
  return out;
}

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
    // speed: 0=slow, 1=fast, 2=instant (but instant handled above). minSpins MUST be a whole
    // number: totalDeg = minSpins*360 + delta lands on the target only when minSpins*360 is a
    // multiple of 360. A fractional 1.5 added a stray 180° (arrow stopped on the opposite slice).
    const minSpins = animState.speed === 0 ? 3 : 2;
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
      <svg ref={svgRef} viewBox="-1.15 -1.15 2.3 2.3" role="img"
        aria-label={"Spinner: " + device.slices.map(s => (s.label || "slice") + " " + Math.round(s.pct) + "%").join(", ")}
        style={{ width:"100%", maxWidth:160, display:"block", margin:"0 auto" }}>
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
        <circle cx="0" cy="0" r="0.08" fill="#fff" stroke="var(--text-3)" strokeWidth="0.03" />
      </svg>
      <div style={{ display:"flex", flexDirection:"column", gap:3, marginTop:6 }}>
        {device.slices.map((sl, i) => (
          <div key={sl.id} style={{ display:"flex", alignItems:"center", gap:3 }}>
            <input type="color" value={sl.color} aria-label={"Color for " + (sl.label || "slice")}
              onChange={e => { const s = [...device.slices]; s[i] = { ...s[i], color:e.target.value }; onChange({ ...device, slices:s }); }}
              style={{ width:20, height:20, border:"none", padding:0, cursor:"pointer", borderRadius:3, flexShrink:0 }} />
            <div style={{ flex:1, fontSize:12 }}>
              <InlineEdit value={sl.label}
                onChange={v => { const s = [...device.slices]; s[i] = { ...s[i], label:v }; onChange({ ...device, slices:s }); }} />
            </div>
            <PctInput pct={sl.pct}
              onCommit={p => onChange({ ...device, slices: redistribute(device.slices, i, p) })} />
            <span style={{ fontSize:12, color:"var(--text-faint)" }}>%</span>
            <button disabled={device.slices.length <= 1} aria-label={"Remove outcome " + (sl.label || "slice")}
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
      <div style={{ fontSize:12, color:"var(--text-faint)", display:"flex", alignItems:"center", gap:5, marginTop:6 }}>
      <input type="checkbox" checked={true} disabled={true} readOnly />
      <span>Always with replacement</span>
    </div>
  </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// STACKS COMPONENT
// ══════════════════════════════════════════════════════════════════════════════
function StacksDevice({ device, onChange, animState, dataset }) {
  const BAR_MAX_H = 130, MAX_CT = 200;
  // Manual content edits break any CSV link: drop the `source` so codegen reverts to a
  // literal vector. Only Fill-from-data (below) sets `source`. Color and the replacement
  // toggle don't change the sampled values, so they keep the live `onChange`.
  const editClear = next => onChange({ ...next, source: undefined });
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
        editClear({ ...device, items });
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
    // Cap the rendered stripe count (perf) — a proportional systematic sample of the
    // shuffled deck, keeping the interleave and the picked top card.
    const deck = downsampleDeck(mergedDeck, ANIM_RENDER_CAP);
    const mergedUnitHS = BAR_MAX_H / deck.length;
    // Home stripe height from the SHOWN per-category counts (not the real maxCount) so the
    // bars fill BAR_MAX_H and stripes never collapse to sub-pixel; the downsample preserves
    // proportions, so relative bar heights still read correctly.
    const shownCount = {};
    deck.forEach(idx => { shownCount[idx] = (shownCount[idx] || 0) + 1; });
    const homeUnitHS = BAR_MAX_H / Math.max(1, ...Object.values(shownCount));
    // Assign each unit a home position (per-category) and a merged slot.
    // Walk the deck; for each item index track how many of that item we've
    // placed so we can compute its home stacking index.
    const homeIdxByItem = {};
    const stripes = deck.map((itemIdx, di) => {
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
        isTop: di === deck.length - 1,
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
            fontSize:12, color:"var(--text-2)", fontWeight:700 }}>
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
            fontSize:12, color:"var(--text-2)", fontWeight:700 }}>
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
          <div style={{ position:"absolute", bottom:-2, left:0, right:0, textAlign:"center", fontSize:12, color:"var(--text-3)" }}>
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
              <span style={{ fontSize:12, color:"var(--text-2)", fontWeight:700 }}>{ct}</span>
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
              <div style={{ fontSize:12, color:it.color, fontWeight:700, marginTop:2,
                overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:"100%", textAlign:"center" }}>
                <InlineEdit value={it.label}
                  onChange={v => { const items = [...device.items]; items[i] = { ...items[i], label:v }; editClear({ ...device, items }); }}
                  style={{ fontSize:12 }} />
              </div>
            </div>
          );
        })}
      </div>
      )}
      <div style={{ fontSize:12, color:"var(--text-faint)", textAlign:"center", marginBottom:6 }}>drag · total: {total}</div>
      <div style={{ display:"flex", flexDirection:"column", gap:3, maxHeight:110, overflowY:"auto" }}>
        {device.items.map((it, i) => (
          <div key={it.id} style={{ display:"flex", alignItems:"center", gap:3 }}>
            <input type="color" value={it.color} aria-label={"Color for " + (it.label || "category")}
              onChange={e => { const items = [...device.items]; items[i] = { ...items[i], color:e.target.value }; onChange({ ...device, items }); }}
              style={{ width:20, height:20, border:"none", padding:0, cursor:"pointer", borderRadius:3, flexShrink:0 }} />
            <div style={{ flex:1, fontSize:12 }}>
              <InlineEdit value={it.label}
                onChange={v => { const items = [...device.items]; items[i] = { ...items[i], label:v }; editClear({ ...device, items }); }} />
            </div>
            <NumInput value={it.count} min={0} max={MAX_CT} round={0}
              onChange={v => { const items = [...device.items]; items[i] = { ...items[i], count:Math.max(0, Math.round(v)) }; editClear({ ...device, items }); }}
              style={{ ...iSm, width:42 }} />
            <button onClick={() => editClear({ ...device, items:device.items.filter((_, j) => j !== i) })} style={btnX} aria-label={"Remove outcome " + (it.label || "category")}>×</button>
          </div>
        ))}
      </div>
      <div style={{ display:"flex", gap:5, marginTop:6, flexWrap:"wrap" }}>
        <button onClick={() => editClear({ ...device, items:[...device.items, { id:uid(), label:nextItemLabel(device.items.map(it => it.label)), count:3, color:COLORS[device.items.length % COLORS.length] }] })}
          style={btnPlus}>+ category</button>
        <FillFromData dataset={dataset} onFill={(vals, varName, dsName) => {
          const counts = {}, order = [], cm = {};
          vals.forEach(v => { if (!counts[v]) { counts[v] = 0; order.push(v); cm[v] = COLORS[order.length % COLORS.length]; } counts[v]++; });
          onChange({ ...device, items:order.map(label => ({ id:uid(), label, count:counts[label], color:cm[label] })), source:{ dataset:dsName, var:varName } });
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
// Turn a mixer into a ROW-RESAMPLING device: balls become observation numbers (1…N) and a
// snapshot of the dataset rides along, so a draw brings a whole case (every variable) into the
// sample. Defaults to with replacement (the bootstrap convention).
function buildRowSampleDevice(device, dataset) {
  const headers = dataset.headers.slice();
  const rows = dataset.rows.map(r => { const o = {}; headers.forEach(h => { o[h] = r[h]; }); return o; });
  const balls = rows.map((_, i) => ({ id: uid(), label: String(i + 1), color: "#6366f1" }));
  return { ...device, balls, withReplacement: true, source: undefined, rowSample: { headers, rows, dataset: dataset.name } };
}

function MixerDevice({ device, onChange, animState, dataset, casesEligible }) {
  const rs = device.rowSample || null; // row-resampling mode: a dataset snapshot rides along
  const BOWL_W = 190, BOWL_H = 108;
  // Manual content edits break any CSV link — drop `source` so codegen reverts to a literal
  // vector. Only Fill-from-data sets it. Color/replacement keep the live `onChange`.
  const editClear = next => onChange({ ...next, source: undefined });
  const posRef = useRef([]);
  const frameRef = useRef(null);
  const [positions, setPositions] = useState([]);
  const isBouncingRef = useRef(false);
  const animStateRef = useRef(animState);
  animStateRef.current = animState;
  const [rangeOpen, setRangeOpen] = useState(false);

  // Group balls by label (order + color) — reused by the editor list and the
  // representative renderer below.
  const ballGroups = useMemo(() => {
    const g = [], seen = {};
    device.balls.forEach(b => {
      if (!seen[b.label]) { seen[b.label] = { label:b.label, color:b.color, count:0 }; g.push(seen[b.label]); }
      seen[b.label].count++;
    });
    return g;
  }, [device.balls]);

  const totalBalls = device.balls.length;
  const capped = totalBalls > ANIM_RENDER_CAP;
  // `slots` are what we actually render. At/under the cap it's the real balls in device
  // order (so removedSet / surfaceIdx map 1:1). Above the cap it's a shuffled proportional
  // subset (shuffled so colors interleave in the grid instead of forming solid blocks).
  const slots = useMemo(() => {
    if (!capped) return device.balls.map(b => ({ label: b.label, color: b.color }));
    const s = representativeSlots(ballGroups, ANIM_RENDER_CAP);
    for (let k = s.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [s[k], s[j]] = [s[j], s[k]]; }
    return s;
  }, [device.balls, ballGroups, capped]);
  const nSlots = slots.length;

  // Ball radius shrinks so the RENDERED slots fit the bowl grid (no top-edge pile-up).
  const ballR = fitRadius(nSlots, BOWL_W, BOWL_H);

  // Compute organized grid positions (default state) — packs all n balls
  const getGridPositions = (n, r) => {
    const gap = r < 6 ? 1 : 2;
    const cols = Math.max(1, Math.floor((BOWL_W - 2) / (r * 2 + gap)));
    return Array.from({ length: n }, (_, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      const y = BOWL_H - r - 2 - row * (r * 2 + gap);
      return {
        x: r + 2 + col * (r * 2 + gap) + (row % 2 === 1 ? r / 2 : 0),
        y: Math.max(r + 2, y),  // safety clamp (with fitRadius, rows already fit)
        vx: 0, vy: 0,
      };
    });
  };

  // Init positions when the rendered slot count (or fit radius) changes
  useEffect(() => {
    posRef.current = getGridPositions(nSlots, ballR).map(p => ({ ...p, vx:0, vy:0 }));
    setPositions([...posRef.current]);
  }, [nSlots, ballR]);

  // Each ball's STATIC grid home. Rendered left/top is always this; every motion (churn,
  // rise to the notch, sink, return) is a transform OFFSET from it — so no phase switch ever
  // jumps the base position, and the end-of-draw return home is one smooth CSS transition
  // instead of a snap.
  const homePositions = useMemo(() => getGridPositions(nSlots, ballR), [nSlots, ballR]);

  const NOTCH_X = BOWL_W / 2, NOTCH_Y = ballR + 4; // target for surfaced ball

  const removedSet = (animState && animState.removedSet) || new Set();
  const surfaceIdx = animState && animState.surfaceIdx;

  // Which rendered slots are "removed" (without-replacement). Uncapped: slot i === ball i,
  // so hide exactly the removed indices. Capped: hide a proportional number of slots per
  // label (from the end) so the drawn color visibly shrinks — the real pool is unaffected.
  const hiddenSlots = useMemo(() => {
    if (!capped) return removedSet;
    if (!removedSet.size) return new Set();
    const remByLabel = {};
    removedSet.forEach(i => { const l = device.balls[i] && device.balls[i].label; if (l != null) remByLabel[l] = (remByLabel[l] || 0) + 1; });
    const grpCount = {}; ballGroups.forEach(g => { grpCount[g.label] = g.count; });
    const shownByLabel = {}; slots.forEach((s, i) => { (shownByLabel[s.label] = shownByLabel[s.label] || []).push(i); });
    const hide = new Set();
    Object.keys(remByLabel).forEach(l => {
      const arr = shownByLabel[l] || [];
      const nHide = Math.min(arr.length, Math.round(remByLabel[l] * arr.length / (grpCount[l] || 1)));
      for (let k = 0; k < nHide; k++) hide.add(arr[arr.length - 1 - k]);
    });
    return hide;
  }, [capped, removedSet, slots, ballGroups, device.balls]);

  // Which slot rises to the notch. Uncapped: the picked slot itself. Capped: a visible slot
  // whose label matches the pick (any of that color is interchangeable), else the first
  // visible slot — so a ball always rises (the true label is on the result badge anyway).
  const surfaceSlot = useMemo(() => {
    if (surfaceIdx == null) return -1;
    if (!capped) return surfaceIdx;
    const label = device.balls[surfaceIdx] && device.balls[surfaceIdx].label;
    let firstVisible = -1;
    for (let i = 0; i < slots.length; i++) {
      if (hiddenSlots.has(i)) continue;
      if (firstVisible < 0) firstVisible = i;
      if (slots[i].label === label) return i;
    }
    return firstVisible;
  }, [surfaceIdx, capped, slots, hiddenSlots, device.balls]);

  // Live ref so the rAF churn loop reads the current removed set without re-subscribing.
  const hiddenRef = useRef(hiddenSlots); hiddenRef.current = hiddenSlots;

  const tick = useCallback(() => {
    const as = animStateRef.current;
    const surfacing = !!(as && as.surfaceIdx != null);
    const hidden = hiddenRef.current;
    if (surfacing) {
      // PAUSE the loop during the reveal. The pick's rise to the notch and the rest's sink to
      // the floor are both CSS transform transitions now (see render), so there's nothing for
      // JS to move — and stopping the per-frame re-render of all 400 divs frees the main
      // thread so those compositor transitions play smoothly at large n. The start/stop
      // effect restarts the loop on the next draw's bounce.
      frameRef.current = null;
      return;
    }
    posRef.current = posRef.current.map((b, i) => {
      if (hidden.has(i)) return b;
      let { x, y, vx, vy } = b;
      // Bouncing/mixing: strong random turbulence keeps a full bowl churning (balls don't
      // collide, so they stream through each other and rebound off the walls below). No
      // gravity here — it would drain the packed bowl to the floor mid-mix.
      vx += (Math.random() - 0.5) * 2.6;
      vy += (Math.random() - 0.5) * 2.6;
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
      // Kick every ball with a random initial velocity so a packed, filled bowl BURSTS
      // into motion immediately (a shaken-cage look) instead of easing out of rest — the
      // old jitter-from-zero read as "barely moving" at large ball counts. The ±10 kick
      // is clamped to the ±5 cap on the first frame: an instant max-speed scatter.
      posRef.current = posRef.current.map(b => ({ ...b, vx:(Math.random() - 0.5) * 10, vy:(Math.random() - 0.5) * 10 }));
      frameRef.current = requestAnimationFrame(tick);
    } else if (!active && isBouncingRef.current) {
      isBouncingRef.current = false;
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      // Reset ALL balls to the organized grid after animation ends. Removed balls render
      // null while removedSet holds them (so snapping them home now is invisible), but this
      // guarantees they return to their home slot rather than staying frozen at the notch
      // once the end-of-run cleanup clears removedSet (otherwise they'd pile at top-center).
      const grid = getGridPositions(nSlots, ballR);
      posRef.current = grid.map(g => ({ ...g, vx:0, vy:0 }));
      setPositions([...posRef.current]);
    }
  }, [animState && animState.bouncing, animState && animState.surfaceIdx]);

  useEffect(() => () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); }, []);

  const grouped = ballGroups; // label groups (order + color), for the editor list

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
        {(() => {
          const surfacingNow = surfaceSlot >= 0;                 // a pick is being revealed
          const bouncingNow = !surfacingNow && animState && animState.bouncing;  // churn phase
          const FLOOR_Y = BOWL_H - ballR - 3;
          const surfMs = animState && animState.speed === 1 ? 150 : 500;
          return slots.map((slot, i) => {
          if (hiddenSlots.has(i)) return null;
          const home = homePositions[i] || { x:BOWL_W / 2, y:BOWL_H / 2 };
          const isSurfaced = surfaceSlot === i;
          // Base left/top is ALWAYS the grid home; the whole animation is one transform offset
          // from there, so no phase switch jumps the base and the return home is a smooth CSS
          // ease (not the old left/top snap). Pick → rise to the notch; the rest → sink toward
          // the floor (lottery separation); churn → the JS bounce offset; idle → 0 (home).
          let tx = 0, ty = 0, scale = 1;
          if (isSurfaced) {
            tx = NOTCH_X - home.x; ty = NOTCH_Y - home.y; scale = 1.5;
          } else if (surfacingNow) {
            // Fall from the ball's CURRENT churn spot with a SUBTLE lean in its last direction
            // of travel — enough that it doesn't stop dead and drop straight down, but small
            // enough that the fall stays predominantly vertical. A bigger sideways carry made
            // all 400 balls dart to the walls at once, a visual din that swamped the pick's
            // rise (so the selection read as an instant jump). `positions[i]` is frozen at the
            // instant surfacing began, so vx is the churn velocity at freeze; the drift is
            // capped so a fast-moving ball still only leans, never flings.
            const p = positions[i] || home;
            const drift = clamp((p.vx || 0) * 2.5, -8, 8);
            const targetX = clamp(p.x + drift, ballR + 3, BOWL_W - ballR - 3);
            tx = targetX - home.x;
            ty = (FLOOR_Y - home.y) * 0.9;   // sink ~90% to the floor
          } else if (bouncingNow) {
            const p = positions[i] || home;
            tx = p.x - home.x; ty = p.y - home.y;                // churn offset from home
          }
          // Per-phase transition. Churn: a short linear pass so rAF frames aren't lagged.
          // Surface: the pick eases out to the notch (overshoot); the rest ease in to the floor
          // (gravity-like) over the surface phase (~500ms slow / ~150ms fast) but STAGGERED —
          // each ball waits a small per-ball delay and falls over a slightly different duration,
          // so the collapse ripples in as a tumbling cascade instead of one flat wall dropping
          // at once (softens the "everything suddenly falls" onset, esp. at large n where the
          // packed bowl shows little pre-fall motion). Idle (draw ended): a gentle ease home.
          let transition;
          if (bouncingNow) {
            transition = "transform 0.06s linear";
          } else if (isSurfaced) {
            transition = `transform ${surfMs}ms cubic-bezier(0.22,1,0.36,1), box-shadow 0.2s`;
          } else if (surfacingNow) {
            const h = ((i * 2654435761) >>> 0) % 1000 / 1000;   // cheap stable per-ball hash → [0,1)
            const delay = Math.round(h * surfMs * 0.35);          // staggered onset
            const dur = Math.round(surfMs * (0.8 + h * 0.4));     // varied fall duration
            transition = `transform ${dur}ms cubic-bezier(0.55,0,0.85,0.35) ${delay}ms`;
          } else {
            transition = "transform 0.35s cubic-bezier(0.4,0,0.2,1), box-shadow 0.25s";
          }
          return (
            <div key={"s" + i} style={{
              position:"absolute",
              left:home.x - ballR, top:home.y - ballR,
              width:ballR * 2, height:ballR * 2,
              borderRadius:"50%", background:slot.color,
              display:"flex", alignItems:"center", justifyContent:"center",
              fontSize:ballR > 8 ? 9 : 6, fontWeight:700, color:"#fff",
              boxShadow:isSurfaced
                ? "0 0 0 3px #fff, 0 0 0 6px " + slot.color + ", 0 4px 16px rgba(0,0,0,0.3)"
                : "0 1px 3px rgba(0,0,0,0.2)",
              transform:`translate(${tx}px, ${ty}px) scale(${scale})`,
              transition,
              zIndex:isSurfaced ? 15 : 1,
              pointerEvents:"none",
            }}>
              {ballR >= 8 ? slot.label : ""}
            </div>
          );
          });
        })()}
      </div>
      <div style={{ fontSize:12, color:"var(--text-faint)", textAlign:"center", marginBottom:4 }}>
        {rs ? `${totalBalls} case${totalBalls !== 1 ? "s" : ""}` : `${totalBalls} ball${totalBalls !== 1 ? "s" : ""}`}
      </div>

      {rs ? (
        <div>
          <div style={{ fontSize:12, color:"var(--text-2)", marginBottom:6 }}>
            Resampling whole cases{rs.dataset ? " from " + rs.dataset : ""} — each draw brings one observation's value for every variable.
          </div>
          <div style={{ fontSize:12, color:"var(--text-faint)", marginBottom:4 }}>Variables ({rs.headers.length}):</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginBottom:8, maxHeight:84, overflowY:"auto" }}>
            {rs.headers.map(h => (
              <span key={h} style={{ fontSize:12, fontFamily:"monospace", padding:"1px 6px", borderRadius:10, background:"var(--xsel-cell)", color:"var(--accent-ink)", border:"1px solid #a5b4fc" }}>{h}</span>
            ))}
          </div>
          <button onClick={() => onChange({ ...device, rowSample: undefined, balls: mkMixer(1).balls })}
            style={{ ...btnPlus, color:"var(--red-ink)", borderColor:"#f5b7b1", background:"var(--surface-2)" }}>✕ Use as a normal mixer</button>
        </div>
      ) : (
      <>
      <div style={{ display:"flex", flexDirection:"column", gap:3, maxHeight:120, overflowY:"auto" }}>
        {grouped.map(group => (
          <div key={group.label} style={{ display:"flex", alignItems:"center", gap:3 }}>
            <input type="color" value={group.color} aria-label={"Color for " + (group.label || "ball")}
              onChange={e => { const balls = device.balls.map(b => b.label === group.label ? { ...b, color:e.target.value } : b); onChange({ ...device, balls }); }}
              style={{ width:20, height:20, border:"none", padding:0, cursor:"pointer", borderRadius:3, flexShrink:0 }} />
            <div style={{ flex:1, fontSize:12 }}>
              <InlineEdit value={group.label}
                onChange={newL => { const balls = device.balls.map(b => b.label === group.label ? { ...b, label:newL } : b); editClear({ ...device, balls }); }} />
            </div>
            <span style={{ fontSize:12, color:"var(--text-3)" }}>×{group.count}</span>
            <button aria-label={"Remove one " + (group.label || "ball")} onClick={() => { const idx = [...device.balls.map((b, i) => b.label === group.label ? i : -1)].filter(i => i >= 0).at(-1); editClear({ ...device, balls:device.balls.filter((_, i) => i !== idx) }); }}
              style={{ ...btnArr, padding:"0 5px", fontSize:13 }}>−</button>
            <button aria-label={"Add one " + (group.label || "ball")} onClick={() => editClear({ ...device, balls:[...device.balls, { id:uid(), label:group.label, color:group.color }] })}
              style={{ ...btnArr, padding:"0 5px", fontSize:13 }}>+</button>
            <button aria-label={"Remove outcome " + (group.label || "ball")} onClick={() => editClear({ ...device, balls:device.balls.filter(b => b.label !== group.label) })} style={btnX}>×</button>
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
            editClear({ ...device, balls:[...device.balls, { id:uid(), label, color }] });
          }}
          style={btnPlus}>+ ball type</button>
        <button onClick={() => setRangeOpen(r => !r)}
          style={{ ...btnPlus, color:"var(--purple-ink)", borderColor:"var(--purple-soft-bd)", background:"var(--purple-soft)" }}>… range</button>
        <FillFromData dataset={dataset} onFill={(vals, varName, dsName) => {
          const cm = {}; [...new Set(vals)].forEach((l, i) => { cm[l] = COLORS[i % COLORS.length]; });
          onChange({ ...device, balls:vals.map(label => ({ id:uid(), label, color:cm[label] })), source:{ dataset:dsName, var:varName } });
        }} onSelectCases={casesEligible && dataset ? () => onChange(buildRowSampleDevice(device, dataset)) : undefined} />
      </div>
      {rangeOpen && (
        <RangeInput
          onApply={items => { const cm = {}; [...new Set(items)].forEach((l, i) => { cm[l] = COLORS[i % COLORS.length]; }); editClear({ ...device, balls:items.map(label => ({ id:uid(), label, color:cm[label] })) }); setRangeOpen(false); }}
          onClose={() => setRangeOpen(false)} />
      )}
      </>
      )}
      <ReplacementToggle device={device} onChange={onChange} />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// DEVICE CARD
// ══════════════════════════════════════════════════════════════════════════════
const DTYPE = { spinner:{ label:"Spinner" }, stacks:{ label:"Stacks" }, mixer:{ label:"Mixer" } };

function DeviceCard({ device, index, total, onChange, onRemove, onMove, animState, locked, nameError }) {
  const { label } = DTYPE[device.type] || { label:"?" };

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
    <div style={{ background:"var(--surface)", borderRadius:12,
      boxShadow:"0 2px 10px var(--shadow-sm)",
      border:result ? "2px solid #6366f1" : "1.5px solid var(--border)",
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
        <span style={{ fontWeight:700, fontSize:13, color:"var(--text)" }}>{label}</span>
        <div style={{ display:"flex", gap:2 }}>
          <button disabled={index === 0 || locked} onClick={() => onMove(index, -1)} style={btnArr} aria-label={"Move " + label + " left"}>←</button>
          <button disabled={index === total - 1 || locked} onClick={() => onMove(index, 1)} style={btnArr} aria-label={"Move " + label + " right"}>→</button>
          <button disabled={locked} onClick={onRemove} style={{ ...btnArr, color:"var(--red-ink)" }} aria-label={"Remove " + label}>✕</button>
        </div>
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:4 }}>
        <span style={{ fontSize:12, color:"var(--text-faint)" }}>var:</span>
        <input value={device.varName} disabled={locked}
          title={nameError ? "Device names must be unique and non-blank" : undefined}
          onChange={e => onChange({ ...device, varName:e.target.value.replace(/\s/g, "_") })}
          style={{ ...iSm, flex:1, fontFamily:"monospace", fontSize:12,
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
            border:"1.5px dashed var(--border-2)", background:"var(--surface-2)" }} />
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
// STAGE CARD — one output column. Holds 1+ conditional branches, each a device whose
// outcomes can depend on an upstream stage's draw (fork). A single-branch stage renders
// like a plain device; a forked stage stacks its branch sub-cards with condition labels.
// ══════════════════════════════════════════════════════════════════════════════

// Deep-clone a device with FRESH ids (its own + every outcome's), so a cloned branch
// device gets a separate without-replacement pool and its own animState slot.
function cloneDeviceFresh(dev) {
  const c = JSON.parse(JSON.stringify(dev));
  c.id = uid();
  const coll = c.items || c.balls || c.slices;
  if (coll) coll.forEach(o => { o.id = uid(); });
  return c;
}
const mkDeviceOfType = type => ({ spinner:mkSpinner, stacks:mkStacks, mixer:mkMixer }[type] || mkStacks)(1);

// The body of one branch: result badge + the device editor, dimmable when not selected.
function BranchDeviceBody({ device, onChange, animState, locked, dataset, casesEligible }) {
  const [spinnerReady, setSpinnerReady] = useState(false);
  const drawId = animState && animState.drawId;
  const isAnimating = animState && animState.animating;
  useEffect(() => { setSpinnerReady(!isAnimating); }, [drawId]);
  const rawResult = animState && animState.result;
  const result = device.type === "spinner" ? (spinnerReady ? rawResult : null) : rawResult;
  const edit = locked ? () => {} : onChange;
  return (
    <div style={{ opacity: animState && animState.inactive ? 0.32 : 1, transition:"opacity 0.2s" }}>
      <div style={{ minHeight:26, display:"flex", alignItems:"center", justifyContent:"center" }}>
        {result ? (
          <div style={{ background:"#6366f1", color:"#fff", borderRadius:20, padding:"3px 16px", fontSize:14, fontWeight:700, boxShadow:"0 2px 8px rgba(99,102,241,0.35)" }}>{result}</div>
        ) : (
          <div style={{ height:24, width:64, borderRadius:20, border:"1.5px dashed var(--border-2)", background:"var(--surface-2)" }} />
        )}
      </div>
      {device.type === "spinner" && <SpinnerDevice device={device} onChange={edit} animState={animState} onSpinReady={() => setSpinnerReady(true)} />}
      {device.type === "stacks" && <StacksDevice device={device} onChange={edit} animState={animState} dataset={dataset} />}
      {device.type === "mixer" && <MixerDevice device={device} onChange={edit} animState={animState} dataset={dataset} casesEligible={casesEligible} />}
    </div>
  );
}

// Inline condition editor for one conditional branch: "if <upstream> = <value>".
function BranchConditionEditor({ branch, upstreamStages, nameOf, onChange, locked }) {
  const condStage = upstreamStages.find(s => s.id === branch.condVar) || upstreamStages[0];
  const opts = condStage ? stageOutcomes(condStage) : [];
  const selSty = { ...iSm, fontSize:12, padding:"2px 4px" };
  return (
    <div style={{ display:"flex", alignItems:"center", gap:4, fontSize:12, color:"var(--purple-ink)", flexWrap:"wrap" }}>
      <span style={{ fontWeight:700 }}>if</span>
      <select value={branch.condVar || (condStage && condStage.id) || ""} disabled={locked}
        onChange={e => { const sid = e.target.value; const st = upstreamStages.find(s => s.id === sid); const vs = st ? stageOutcomes(st) : []; onChange({ ...branch, condVar:sid, condVal: vs.includes(branch.condVal) ? branch.condVal : (vs[0] || "") }); }}
        style={selSty}>
        {upstreamStages.map(s => <option key={s.id} value={s.id}>{nameOf(s.id)}</option>)}
      </select>
      <span>=</span>
      <select value={branch.condVal != null ? branch.condVal : ""} disabled={locked}
        onChange={e => onChange({ ...branch, condVal:e.target.value })} style={selSty}>
        {opts.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

const DTYPE_OPTS = [["stacks","Stacks"], ["mixer","Mixer"], ["spinner","Spinner"]];

function StageCard({ stage, index, total, upstreamStages, nameOf, onChange, onRemove, onMove, animStates, locked, nameError, dataset, casesEligible }) {
  const branches = stage.branches;
  const forked = branches.length > 1;
  const canFork = upstreamStages.length > 0; // need an upstream stage to condition on

  const setBranches = bs => onChange({ ...stage, branches: bs });
  const setBranch = (bid, nb) => setBranches(branches.map(b => b.id === bid ? nb : b));
  // Update one branch's device. When a Fill-from-data just stamped a NEW `source.var` on the
  // device, also adopt that CSV column name as the stage's column name — combined into ONE
  // onChange so the branch + varName updates can't clobber each other (stale-closure race).
  const setBranchDevice = (bid, dev) => {
    const prev = branches.find(b => b.id === bid);
    const branches2 = branches.map(b => b.id === bid ? { ...b, device: dev } : b);
    const newVar = dev.source && dev.source.var;
    const prevVar = prev && prev.device.source && prev.device.source.var;
    const varName = (newVar && newVar !== prevVar) ? newVar.replace(/\s/g, "_") : stage.varName;
    onChange({ ...stage, branches: branches2, varName });
  };

  const addBranch = () => {
    const def = branches.find(b => b.condVar === null) || branches[0];
    const up = upstreamStages[0];
    const vals = up ? stageOutcomes(up) : [];
    const nb = { id:uid(), condVar: up ? up.id : null, condVal: vals[0] || "", device: cloneDeviceFresh(def.device) };
    // Keep the default branch last so it always reads as the "otherwise" fall-through.
    const cond = branches.filter(b => b.condVar !== null);
    const dft = branches.filter(b => b.condVar === null);
    setBranches([...cond, nb, ...dft]);
  };
  const remBranch = bid => { const b = branches.find(x => x.id === bid); if (b.condVar === null) return; setBranches(branches.filter(x => x.id !== bid)); };
  // Convert a branch's device to another type IN PLACE — preserve labels/colors/counts
  // (convertDevice), rather than stamping a fresh default. A brand-new branch still uses
  // mkDeviceOfType (a genuine fresh add) via addBranch/cloneDeviceFresh above.
  const changeBranchType = (bid, type) => { const b = branches.find(x => x.id === bid); if (b.device.type === type) return; setBranchDevice(bid, convertDevice(b.device, type)); };

  return (
    <div style={{ background:"var(--surface)", borderRadius:12, boxShadow:"0 2px 10px var(--shadow-sm)",
      border: forked ? "1.5px solid #c4b5fd" : "1.5px solid var(--border)", padding:12,
      display:"flex", flexDirection:"column", gap:7, flex:"1 1 200px", minWidth:184, maxWidth:260, position:"relative" }}>
      {locked && <div style={{ position:"absolute", inset:0, borderRadius:12, zIndex:10, background:"transparent", cursor:"not-allowed" }} />}
      {/* Stage header: column name + reorder/remove */}
      <div style={{ display:"flex", alignItems:"center", gap:4 }}>
        <span style={{ fontSize:12, color:"var(--text-faint)" }}>var:</span>
        <input value={stage.varName} disabled={locked} aria-label="Column name"
          title={nameError ? "Column names must be unique and non-blank" : undefined}
          onChange={e => onChange({ ...stage, varName:e.target.value.replace(/\s/g, "_") })}
          style={{ ...iSm, flex:1, fontFamily:"monospace", fontSize:12, borderColor: nameError ? "#ef4444" : undefined, boxShadow: nameError ? "0 0 0 1px #ef4444" : undefined }} />
        <button disabled={index === 0 || locked} onClick={() => onMove(index, -1)} style={btnArr} aria-label={"Move column " + stage.varName + " left"}>←</button>
        <button disabled={index === total - 1 || locked} onClick={() => onMove(index, 1)} style={btnArr} aria-label={"Move column " + stage.varName + " right"}>→</button>
        <button disabled={locked} onClick={onRemove} style={{ ...btnArr, color:"var(--red-ink)" }} aria-label={"Remove column " + stage.varName}>✕</button>
      </div>

      {/* Device-type selector for a plain (non-forked) stage: convert in place, preserving
          labels/colors/counts. Forked stages carry a per-branch selector in the branch header
          instead. Hidden for row-sample mixers (not a plain category device). */}
      {!forked && !branches[0].device.rowSample && (
        <div style={{ display:"flex", alignItems:"center", gap:5, fontSize:12, color:"var(--text-faint)" }}>
          <span>type:</span>
          <select value={branches[0].device.type} disabled={locked}
            onChange={e => changeBranchType(branches[0].id, e.target.value)}
            style={{ ...iSm, fontSize:12, padding:"2px 3px", flex:1 }} aria-label="Device type">
            {DTYPE_OPTS.map(([t, l]) => <option key={t} value={t}>{l}</option>)}
          </select>
        </div>
      )}

      {branches.map(branch => {
        const isDefault = branch.condVar === null;
        return (
          <div key={branch.id} style={{ borderTop: forked ? "1px dashed var(--border)" : "none", paddingTop: forked ? 6 : 0 }}>
            {forked && (
              <div style={{ display:"flex", alignItems:"center", gap:4, marginBottom:4 }}>
                {isDefault ? (
                  <span style={{ fontSize:12, fontWeight:700, color:"var(--purple-ink)" }}>otherwise</span>
                ) : (
                  <BranchConditionEditor branch={branch} upstreamStages={upstreamStages} nameOf={nameOf}
                    onChange={nb => setBranch(branch.id, nb)} locked={locked} />
                )}
                <select value={branch.device.type} disabled={locked}
                  onChange={e => changeBranchType(branch.id, e.target.value)}
                  style={{ ...iSm, fontSize:12, padding:"2px 3px", marginLeft:"auto" }}>
                  {DTYPE_OPTS.map(([t, l]) => <option key={t} value={t}>{l}</option>)}
                </select>
                {!isDefault && <button disabled={locked} onClick={() => remBranch(branch.id)} style={btnX} aria-label="Remove branch">×</button>}
              </div>
            )}
            <BranchDeviceBody device={branch.device} animState={animStates[branch.device.id] || null}
              locked={locked} onChange={dev => setBranchDevice(branch.id, dev)} dataset={dataset}
              casesEligible={casesEligible && !forked} />
          </div>
        );
      })}

      {canFork && !locked && (
        <button onClick={addBranch} style={{ ...btnPlus, marginTop:2 }}
          title="Add a branch whose device depends on an upstream draw">
          ⑂ {forked ? "add branch" : "make conditional"}
        </button>
      )}
    </div>
  );
}

export { SpinnerDevice, StacksDevice, MixerDevice, DeviceCard, StageCard };
