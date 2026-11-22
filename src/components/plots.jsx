import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, useId } from "react";
import { toCanvas } from "html-to-image";
import { iSm, btnX, btnNav, btnPlus, ctrlLbl } from "../lib/styles";
import { colorAt, clamp, toNum, minutesToTime, colKind, sortCats, collapseCats, OTHER_CAT, fitDotR, uid } from "../lib/util";
import { numericSummary, kdeCurve, lsFit, ladFit, statLabel, statKey, computeStat, quantile } from "../lib/stats";
import { validateExpr, lexExpr, aliasFor } from "../lib/expr";
import { useContainerWidth } from "../lib/hooks";
import { makeScale, stackDots } from "../lib/scale";
import { clampVal, snapValue, snapMeasure, regions, binRegions, evenCuts, conservativeBand, clipLine, makeBins, MAX_BINS } from "../lib/measure";
import { Sel, ChkLabel, InlineEdit, NumInput } from "./ui";
import { FormulaPanel, FormulaMenu, DERIVED_FN_GROUPS } from "./formulas";
import { renameInFormula, fmtFormulaVal } from "../lib/formula";

// Format a proportion (0–1) for on-plot read-outs — fixed 3 decimals so the plots
// match the proportion-valued collected statistics (e.g. 0.851, not 85%).
const fmtP = v => (Number.isFinite(v) ? v.toFixed(3) : "—");
// Most cuts a multi-divider may carry (k cuts → k+1 bins); beyond this the read-outs crowd.
const MAX_CUTS = 9;

// ── Click-to-track helpers ─────────────────────────────────────────────────────
// A statistic is promoted into Collect Statistics by clicking the number that
// shows it on the plot (not a separate chip). Both helpers fall back to a plain,
// non-interactive label when no `onTrackStat` is supplied (e.g. the EDA plot) or
// when `spec` is null (e.g. an "Other" bucket with no clean target), so existing
// plots render pixel-identically there.

// SVG value label that toggles tracking of `spec` on click.
function TrackText({ x, y, anchor = "middle", color, fontSize = 9, label, spec, trackable, trackedKeys, onTrackStat, nameOf }) {
  if (!trackable || !spec) {
    return <text x={x} y={y} textAnchor={anchor} fontSize={fontSize} fill={color} fontWeight={700}>{label}</text>;
  }
  const lbl = statLabel(spec, nameOf);
  const tracked = trackedKeys && trackedKeys.has(statKey(spec));
  const w = String(label).length * fontSize * 0.62 + 8, h = fontSize + 5;
  const rx = anchor === "start" ? x - 4 : anchor === "end" ? x - w + 4 : x - w / 2;
  const tip = tracked ? "Tracking " + lbl + " — activate to remove" : "Track " + lbl;
  return (
    <g style={{ cursor:"pointer" }} role="button" tabIndex={0} aria-pressed={!!tracked} aria-label={tip}
      onClick={e => { e.stopPropagation(); onTrackStat(spec); }}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onTrackStat(spec); } }}>
      <title>{tracked ? "Tracking " + lbl + " — click to remove" : "Click to track " + lbl}</title>
      <rect x={rx} y={y - h + 3} width={w} height={h} rx={3}
        fill={tracked ? "var(--xsel-head)" : "var(--xsel-cell)"} stroke={tracked ? "#6366f1" : "var(--xsel-head)"} strokeWidth={1} />
      <text x={x} y={y} textAnchor={anchor} fontSize={fontSize} fill={tracked ? "var(--accent-ink)" : color} fontWeight={800}>{label}</text>
    </g>
  );
}

// HTML count/percent number (cat plots) that toggles tracking of `spec` on click — or,
// when the ruler's cat-difference mode is active (`measureSelect` supplied), picks the
// number as operand A or B for a difference instead of tracking it.
function CatNum({ text, spec, dim, trackable, trackedKeys, onTrackStat, measureSelect, measureRole, nameOf }) {
  if (measureSelect && spec) {
    const sel = !!measureRole;
    return (
      <span data-mkey={statKey(spec)} role="button" tabIndex={0} aria-pressed={sel}
        onClick={e => { e.stopPropagation(); measureSelect(spec); }}
        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); measureSelect(spec); } }}
        title={sel ? "Selected as " + measureRole + " — click to deselect" : "Click to pick as A or B for the ruler difference"}
        aria-label={(sel ? "Selected as " + measureRole + ", " : "Pick for ruler difference: ") + text}
        style={{ cursor:"pointer", padding:"0 3px", borderRadius:4, fontWeight:700,
          background: sel ? "var(--ruler-soft)" : "transparent",
          color: sel ? "var(--ruler-text)" : (dim ? "var(--text-faint)" : "var(--ruler-line)"),
          boxShadow: sel ? "none" : "inset 0 -1px 0 #5eead4" }}>
        {text}{sel ? " " + measureRole : ""}
      </span>
    );
  }
  if (!trackable || !spec) return <span style={{ color: dim ? "var(--text-faint)" : "var(--accent-ink)" }}>{text}</span>;
  const lbl = statLabel(spec, nameOf);
  const tracked = trackedKeys && trackedKeys.has(statKey(spec));
  return (
    <span role="button" tabIndex={0} aria-pressed={!!tracked}
      onClick={e => { e.stopPropagation(); onTrackStat(spec); }}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onTrackStat(spec); } }}
      title={tracked ? "Tracking " + lbl + " — click to remove" : "Click to track " + lbl}
      aria-label={(tracked ? "Tracking " + lbl + ", activate to remove. Value " : "Track " + lbl + ". Value ") + text}
      style={{ cursor:"pointer", padding:"0 3px", borderRadius:4, fontWeight:700,
        background: tracked ? "var(--xsel-head)" : "transparent",
        color: "var(--accent-ink)",
        boxShadow: tracked ? "none" : "inset 0 -1px 0 #a5b4fc" }}>
      {text}
    </span>
  );
}

// ── Measurement overlay (Phase 6) ──────────────────────────────────────────────
// Shared draggable divider lines, mounted INSIDE a host plot's <svg>. The host owns
// the value↔pixel mapping (`sx`/`inv`, both linear) and the data domain; this only
// renders the vertical line(s) + handle(s) + region shading and reports drags back via
// `onChange`. Pointer events with capture; clientX is mapped to svg-attribute pixels
// via `W / rect.width` so it stays correct under the plot's `maxWidth:100%` scaling.
//   cuts: [v] (single) | [lo, hi] (range) — values in data units, in array order.
// Translucent region shading for the divider, rendered as its own layer so callers can
// paint it BEHIND the dots (the dots stay visible + clickable). Single → split the two
// sides; range → highlight the middle band (`band="middle"`) or the two outer regions
// (`band="tails"`) between the two lines. `dir` ("left"/"right"/"none") focuses one tail for
// a one-sided cut.
function DividerShades({ topY, botY, sx, xlo, xhi, cuts, dir = "none", band = "middle", multi = false }) {
  const xL = sx(xlo), xR = sx(xhi);
  // Clamp cut pixels to the plate so an off-window cut yields an empty outer band rather
  // than a rect that overshoots the axis (the true value still drives the read-out/code).
  const cx = v => clamp(sx(v), Math.min(xL, xR), Math.max(xL, xR));
  const shades = [];
  if (multi) {
    // Multi bins: tint every other region so adjacent bins read as separate bands.
    const edges = [xL, ...[...cuts].sort((a, b) => a - b).map(cx), xR];
    for (let j = 1; j < edges.length - 1; j += 2)
      shades.push(<rect key={"b" + j} x={edges[j]} y={topY} width={Math.max(0, edges[j + 1] - edges[j])} height={botY - topY} fill="#6366f1" fillOpacity={0.08} />);
  } else if (cuts.length === 1) {
    const xv = cx(cuts[0]);
    if (dir === "left") shades.push(<rect key="lt" x={xL} y={topY} width={Math.max(0, xv - xL)} height={botY - topY} fill="#3b82f6" fillOpacity={0.14} />);
    else if (dir === "right") shades.push(<rect key="ge" x={xv} y={topY} width={Math.max(0, xR - xv)} height={botY - topY} fill="#f59e0b" fillOpacity={0.14} />);
    else {
      shades.push(<rect key="lt" x={xL} y={topY} width={Math.max(0, xv - xL)} height={botY - topY} fill="#3b82f6" fillOpacity={0.07} />);
      shades.push(<rect key="ge" x={xv} y={topY} width={Math.max(0, xR - xv)} height={botY - topY} fill="#f59e0b" fillOpacity={0.07} />);
    }
  } else if (cuts.length === 2) {
    const a = cx(Math.min(cuts[0], cuts[1])), b = cx(Math.max(cuts[0], cuts[1]));
    if (band === "tails") {
      // Highlight the two outer regions (a two-sided p-value), leaving the middle clear.
      shades.push(<rect key="lt" x={xL} y={topY} width={Math.max(0, a - xL)} height={botY - topY} fill="#6366f1" fillOpacity={0.1} />);
      shades.push(<rect key="gt" x={b} y={topY} width={Math.max(0, xR - b)} height={botY - topY} fill="#6366f1" fillOpacity={0.1} />);
    } else {
      shades.push(<rect key="mid" x={a} y={topY} width={Math.max(0, b - a)} height={botY - topY} fill="#6366f1" fillOpacity={0.1} />);
    }
  }
  return <g style={{ pointerEvents: "none" }}>{shades}</g>;
}

function DividerLines({ W, topY, botY, sx, inv, xlo, xhi, cuts, onChange, snapCandidates, fmt, dir = "none" }) {
  const [dragI, setDragI] = useState(-1);
  const pxPerUnit = Math.abs(sx(xhi) - sx(xlo)) / (Math.abs(xhi - xlo) || 1);

  // Suppress text selection across the page for the duration of a drag (the cut spans
  // other text elements — axis labels, read-outs — so a local user-select isn't enough).
  const setSelecting = on => {
    const s = document.body.style;
    s.userSelect = s.webkitUserSelect = on ? "none" : "";
  };
  useEffect(() => () => setSelecting(false), []); // restore if unmounted mid-drag

  const onDown = i => e => {
    e.stopPropagation();
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
    setSelecting(true);
    setDragI(i);
  };
  const onMove = e => {
    if (dragI < 0) return;
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const ratio = W / (rect.width || W);
    let v = clampVal(inv((e.clientX - rect.left) * ratio), xlo, xhi);
    v = snapValue(v, snapCandidates, pxPerUnit);
    const next = cuts.slice(); next[dragI] = v; onChange(next);
  };
  const onUp = e => { try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) {} setSelecting(false); setDragI(-1); };

  // A cut may sit beyond the visible window (an unclamped typed value). The line + handle are
  // drawn at the CLAMPED edge pixel; `offOf` reports which side a cut overshoots so we can add
  // an outward arrow marking it as off-window. The true value still labels the handle.
  const pxL = sx(xlo), pxR = sx(xhi), pxMin = Math.min(pxL, pxR), pxMax = Math.max(pxL, pxR);
  const clampPx = p => (p < pxMin ? pxMin : p > pxMax ? pxMax : p);
  const lo = Math.min(xlo, xhi), hi = Math.max(xlo, xhi);
  const offOf = v => (v < lo ? -1 : v > hi ? 1 : 0);
  // Many cuts can crowd: when two labels sit within 40px, fan them apart sideways — the left
  // one hangs off its line to the left, the right one to the right — at the same height (there
  // is no room above: the plot's top edge borders the controls row).
  const anchorOf = {};
  {
    const order = cuts.map((v, i) => [clampPx(sx(v)), i]).sort((a, b) => a[0] - b[0]);
    order.forEach(([x, i], k) => {
      const near = j => j >= 0 && j < order.length && Math.abs(order[j][0] - x) < 40;
      anchorOf[i] = near(k + 1) ? "end" : near(k - 1) ? "start" : "middle";
    });
  }

  // Direction arrow for a one-sided single divider: a short horizontal arrow at mid-height
  // pointing into the shaded tail (blue ◂ left, orange ▸ right).
  let arrow = null;
  if (dir !== "none" && cuts.length === 1) {
    const x = clampPx(sx(cuts[0])), my = (topY + botY) / 2, right = dir === "right";
    const tip = x + (right ? 26 : -26), base = x + (right ? 8 : -8), col = right ? "#d97706" : "#2563eb";
    const back = tip + (right ? -7 : 7);
    arrow = (
      <g style={{ pointerEvents: "none" }}>
        <line x1={base} y1={my} x2={tip} y2={my} stroke={col} strokeWidth={2} />
        <path d={`M ${tip} ${my} L ${back} ${my - 4} L ${back} ${my + 4} Z`} fill={col} />
      </g>
    );
  }

  return (
    <g>
      {arrow}
      {cuts.map((v, i) => {
        const off = offOf(v);
        const x = clampPx(sx(v));
        // Off-window marker: a short arrow at the edge pointing further out, so the clamped
        // line reads as "the real cut is beyond here." Drawn near the top, clear of the arrow above.
        const my = topY + 22, oT = x + (off > 0 ? 22 : -22), oB = x + (off > 0 ? 5 : -5), oBk = oT + (off > 0 ? -6 : 6);
        return (
          <g key={i} style={{ cursor:"ew-resize", touchAction:"none" }}
            onPointerDown={onDown(i)} onPointerMove={onMove} onPointerUp={onUp}>
            {/* wide transparent hit area for easy grabbing */}
            <line x1={x} y1={topY} x2={x} y2={botY} stroke="transparent" strokeWidth={14} />
            <line x1={x} y1={topY} x2={x} y2={botY} stroke="#6366f1" strokeWidth={dragI === i ? 2.5 : 1.5} strokeDasharray="4 3" />
            {off !== 0 && (
              <g style={{ pointerEvents:"none" }}>
                <line x1={oB} y1={my} x2={oT} y2={my} stroke="#6366f1" strokeWidth={2} />
                <path d={`M ${oT} ${my} L ${oBk} ${my - 4} L ${oBk} ${my + 4} Z`} fill="#6366f1" />
              </g>
            )}
            {/* the cut value (true, unclamped), directly above the grab handle */}
            {fmt && <text x={x + (anchorOf[i] === "end" ? -3 : anchorOf[i] === "start" ? 3 : 0)} y={topY - 12} textAnchor={anchorOf[i]} fontSize={12} fontWeight={700}
              fill={off !== 0 ? "#6366f1" : "var(--accent-ink)"}>{off !== 0 ? (off > 0 ? "» " : "« ") + fmt(v) : fmt(v)}</text>}
            {/* grab handle at the top of the line */}
            <rect x={x - 5} y={topY - 9} width={10} height={9} rx={2} fill="#6366f1" stroke="#fff" strokeWidth={1} />
          </g>
        );
      })}
    </g>
  );
}

// Build a countBetween / propBetween stat spec from a measure.js region (so a divider
// region's on-plot count / proportion can be tracked, like a categorical cell number).
// Open/closed bounds match `regions`: only "> hi" is strict-lower, only "< v"/"< lo"
// strict-upper; ±Infinity edges become unbounded (null).
function regionSpec(r, fn, base) {
  return {
    fn,
    variable: base.variable,
    condVar: base.condVar || "",
    condVal: base.condVal || "",
    lo: r.lo === -Infinity ? null : r.lo,
    hi: r.hi === Infinity ? null : r.hi,
    loOpen: r.loOpen ?? r.key === "gt",
    hiOpen: r.hiOpen ?? r.key === "lt",
  };
}

// On-plot region read-outs for the divider: a count and/or proportion centered in each
// region's on-screen span at height `y`. Each number is a click-to-track target in
// Sample Results (plain text elsewhere), mirroring the categorical plots' # / % numbers.
function RegionLabels({ regions: regs, sx, xL, xR, y, showCount, showPct, total, base, trackProps }) {
  if (!regs || (!showCount && !showPct)) return null;
  return (
    <g>
      {regs.map(r => {
        const a = Math.max(xL, r.lo === -Infinity ? xL : sx(r.lo));
        const b = Math.min(xR, r.hi === Infinity ? xR : sx(r.hi));
        const cx = (a + b) / 2;
        const both = showCount && showPct;
        // Match the categorical plots' convention: count on the left, percent on the
        // right in parentheses (each still individually click-to-track).
        return (
          <g key={r.key}>
            {showCount && <TrackText x={both ? cx - 3 : cx} y={y} anchor={both ? "end" : "middle"} color="var(--text-2)" fontSize={12}
              label={String(r.n)} spec={regionSpec(r, "countBetween", base)} {...trackProps} />}
            {showPct && <TrackText x={both ? cx + 3 : cx} y={y} anchor={both ? "start" : "middle"} color="var(--text-2)" fontSize={12}
              label={"(" + (total ? fmtP(r.p) : "—") + ")"} spec={regionSpec(r, "propBetween", base)} {...trackProps} />}
          </g>
        );
      })}
    </g>
  );
}

// ── Ruler overlay (Phase 6c) ────────────────────────────────────────────────────
// Two draggable endpoints on a numeric axis, connected by a measurement bar; the
// read-out is the signed distance A − B. Mounted INSIDE a host plot's <svg>, sharing
// the host's value↔pixel mapping like DividerLines. Each endpoint snaps to a data dot
// (a plain constant) or a visible measure (carrying a stat `spec`), so when both land on
// measures the bar reads a difference of two statistics — the headline being a
// difference of group means. When trackable, a "＋ track" affordance authors that
// difference as a Phase 5 derived column via `onTrackDiff`.
//   pts: [{ value, spec, label }, { value, spec, label }] — A then B, in data units.
function RulerOverlay({ W, topY, botY, lineY, sx, inv, xlo, xhi, pts, onChange, snapCandidates, fmt, trackable, onTrackDiff, onCutDrag, cutSnap }) {
  const [dragI, setDragI] = useState(-1);
  const [dragCut, setDragCut] = useState(-1);
  const pxPerUnit = Math.abs(sx(xhi) - sx(xlo)) / (Math.abs(xhi - xlo) || 1);

  const setSelecting = on => {
    const s = document.body.style;
    s.userSelect = s.webkitUserSelect = on ? "none" : "";
  };
  useEffect(() => () => setSelecting(false), []);

  const onDown = i => e => {
    e.stopPropagation(); e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
    setSelecting(true); setDragI(i);
  };
  const onMove = e => {
    if (dragI < 0) return;
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const ratio = W / (rect.width || W); // uniform (the svg keeps its aspect under maxWidth)
    const v = clampVal(inv((e.clientX - rect.left) * ratio), xlo, xhi);
    const cursorY = (e.clientY - rect.top) * ratio; // svg-attribute y, to pick among stacked targets
    const snapped = snapMeasure(v, snapCandidates, pxPerUnit, cursorY);
    const next = pts.slice(); next[dragI] = snapped; onChange(next);
  };
  const onUp = e => { try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) {} setSelecting(false); setDragI(-1); };
  // When an endpoint is anchored to the divider, its handle sits on top of the divider's own
  // grab handle (the ruler's full-height hit line covers it), so we offer a ring on the box
  // that drags the divider directly — the anchored endpoint then follows via `resolveVal`.
  const onCutDown = k => e => {
    e.stopPropagation(); e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
    setSelecting(true); setDragCut(k);
  };
  const onCutMove = e => {
    if (dragCut < 0 || !onCutDrag) return;
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const ratio = W / (rect.width || W);
    let v = clampVal(inv((e.clientX - rect.left) * ratio), xlo, xhi);
    v = snapValue(v, cutSnap, pxPerUnit);
    onCutDrag(dragCut, v);
  };
  const onCutUp = e => { try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) {} setSelecting(false); setDragCut(-1); };

  const fmtNum = v => parseFloat(Number(v).toFixed(4));
  const a = pts[0], b = pts[1];
  const xa = sx(a.value), xb = sx(b.value);
  const diff = a.value - b.value;
  const midX = (xa + xb) / 2;
  // The difference is trackable only if at least one endpoint is a real measure (a
  // difference of two constants is just a number, with no cross-repetition identity).
  const canTrack = trackable && (a.spec || b.spec);
  const opLabel = p => p.spec ? p.label : fmtNum(p.value);

  // The candidate an endpoint is currently anchored to (a measure matched by spec, or a
  // data dot matched by value), so we can draw a ring over that exact target. Returns the
  // marker's pixel position, or null when the endpoint is a free constant.
  const anchorOf = p => {
    if (!snapCandidates) return null;
    let c;
    if (p.spec) { const key = statKey(p.spec); c = snapCandidates.find(k => k.spec && statKey(k.spec) === key); }
    else c = snapCandidates.find(k => !k.spec && k.y != null && Math.abs(k.value - p.value) < 1e-9);
    return (c && c.y != null) ? { x: sx(c.value), y: c.y } : null;
  };

  return (
    <g>
      {/* connector bar between the endpoints */}
      <line x1={xa} y1={lineY} x2={xb} y2={lineY} stroke="var(--ruler-line)" strokeWidth={1.5} />
      {pts.map((p, i) => {
        const x = sx(p.value);
        const ring = anchorOf(p);
        const big = dragI === i;
        return (
          <g key={i} style={{ cursor:"ew-resize", touchAction:"none" }}
            onPointerDown={onDown(i)} onPointerMove={onMove} onPointerUp={onUp}>
            {/* wide transparent hit area + visible guide line */}
            <line x1={x} y1={topY} x2={x} y2={botY} stroke="transparent" strokeWidth={14} />
            <line x1={x} y1={topY} x2={x} y2={botY} stroke="var(--ruler-line)" strokeWidth={big ? 2.5 : 1.5} strokeDasharray="2 3" />
            {/* anchor ring over the exact target this endpoint is tied to */}
            {ring && (
              <g>
                <circle cx={ring.x} cy={ring.y} r={big ? 8 : 6.5} fill="none" stroke="var(--ruler-line)" strokeWidth={big ? 2.5 : 1.8} />
                <circle cx={ring.x} cy={ring.y} r={1.6} fill="var(--ruler-line)" />
              </g>
            )}
            {/* end cap on the connector bar */}
            <line x1={x} y1={lineY - 5} x2={x} y2={lineY + 5} stroke="var(--ruler-line)" strokeWidth={2} />
            {/* handle + letter */}
            <rect x={x - 6} y={lineY - 9} width={12} height={9} rx={2} fill="var(--ruler-line)" stroke="#fff" strokeWidth={1} />
            <text x={x} y={lineY - 1.5} textAnchor="middle" fontSize={11} fontWeight={800} fill="#fff">{i === 0 ? "A" : "B"}</text>
            {/* what this endpoint landed on (measure name or constant value) */}
            <text x={x} y={lineY + 16} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--ruler-text)">{opLabel(p)}</text>
            {/* anchored to the divider → a ruler-colored ring on the divider's own grab box
                (at topY) that drags the divider directly; the endpoint then follows. */}
            {p.cut != null && onCutDrag && (
              <g style={{ cursor:"ew-resize", touchAction:"none" }}
                onPointerDown={onCutDown(p.cut)} onPointerMove={onCutMove} onPointerUp={onCutUp}>
                <title>Drag the divider</title>
                <circle cx={x} cy={topY - 4} r={7.5} fill="var(--ruler-line)" fillOpacity={0.18} />
                <circle cx={x} cy={topY - 4} r={7.5} fill="none" stroke="var(--ruler-line)" strokeWidth={dragCut === p.cut ? 2.5 : 1.8} />
              </g>
            )}
          </g>
        );
      })}
      {/* signed-distance read-out at the bar midpoint */}
      <text x={midX} y={lineY - 7} textAnchor="middle" fontSize={12} fontWeight={800} fill="var(--ruler-text)">
        A − B = {fmtNum(diff)}
      </text>
      {/* ＋ track affordance (Sample Results only) */}
      {canTrack && (() => {
        const ty = lineY - 20, label = "＋ track";
        const w = label.length * 5.4 + 10;
        return (
          <g style={{ cursor:"pointer" }} onClick={e => { e.stopPropagation(); onTrackDiff(a, b); }}>
            <title>Track A − B as a derived column in Collect Statistics</title>
            <rect x={midX - w / 2} y={ty - 9} width={w} height={13} rx={3} fill="var(--ruler-soft)" stroke="#5eead4" strokeWidth={1} />
            <text x={midX} y={ty} textAnchor="middle" fontSize={11} fontWeight={800} fill="var(--ruler-text)">{label}</text>
          </g>
        );
      })()}
    </g>
  );
}

// One cached LAD fit (Plot's "Match LAD" and the absolute-residual comparison): the last
// rows array + variable pair it was fit for. Module-level because it sits below Plot's early
// returns, where a hook can't go.
const ladCache = { rows: null, key: null, fit: null };

// ── Scatter ruler (mechanic 2) ──────────────────────────────────────────────────
// The numeric ruler turned upright for the num × num scatter: two endpoints A and B on the
// y axis, each a full-width dotted guide, read-out A − B. Drag either guide (anywhere along
// it, or its handle on the bar); passing the pointer over a dot snaps it to that point's y,
// over the line snaps it to the line, and a ring marks the anchor. One end on a point and the
// other on the line under/over it reads that point's residual, y − ŷ — the starting residual
// for "Measure All". Rendered in two layers so the ref line's handles sit between them:
// `layer="base"` holds the guides' grab strips and the measured residuals (so the ref line's
// handles win where they overlap a guide); `layer="top"` the bar, its handles, rings, labels.
// `res` is the resolved ruler { x, ends:[{ y, x, kind }] }; `onDrag(k, px, py)` moves end k.
function ScatterRuler({ layer, res, residMode, line, measured, measSq, nPts = 0, sx, toPy, W, area, clipId, onDrag, fmtY }) {
  const drag = useRef(null); // end index being dragged
  const [active, setActive] = useState(-1);
  const svgPt = e => {
    const svg = e.currentTarget.ownerSVGElement || e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const ratio = W / (rect.width || W);
    return { px: (e.clientX - rect.left) * ratio, py: (e.clientY - rect.top) * ratio };
  };
  const down = k => e => {
    e.stopPropagation(); e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (x) {}
    drag.current = k; setActive(k);
  };
  const move = e => { if (drag.current == null) return; const { px, py } = svgPt(e); onDrag(drag.current, px, py); };
  const up = e => { try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (x) {} drag.current = null; setActive(-1); };
  const grip = k => ({ onPointerDown: down(k), onPointerMove: move, onPointerUp: up, onPointerCancel: up });
  const col = "var(--ruler-line)";
  if (!res) return null;
  const ys = res.ends.map(e => toPy(e.y));

  if (layer === "base") {
    // Residual squares: the fill stays light and fades further as the point count grows (the
    // outline stays solid, so each square still reads) so a big
    // dataset's overlapping squares don't turn into a solid block (0.3 at ≤ 20 points,
    // ~0.1 at 200, floor 0.06).
    const sqA = clampVal(0.3 * Math.sqrt(20 / Math.max(nPts, 1)), 0.06, 0.3);
    return (
      <g>
        <defs><clipPath id={clipId}><rect x={area.x} y={area.y} width={area.w} height={area.h} /></clipPath></defs>
        {line && measured && measured.length > 0 && (
          <g clipPath={"url(#" + clipId + ")"} style={{ pointerEvents:"none" }}>
            {measured.map(p => {
              const yh = line.m * p.x + line.b, footY = toPy(yh), r = p.y - yh;
              if (!Number.isFinite(footY)) return null;
              const side = Math.abs(footY - p.py);
              // Grow the square away from the line: with r and m the same sign the line rises
              // to the right of a point above it, so the square goes left (and vice versa).
              const left = (r > 0) === (line.m > 0);
              return (
                <g key={p.i}>
                  {measSq && side > 0.5 && <rect x={left ? p.px - side : p.px} y={Math.min(p.py, footY)} width={side} height={side}
                    fill="var(--ruler-soft)" fillOpacity={sqA} stroke={col} strokeOpacity={0.7} strokeWidth={0.9} />}
                  <line x1={p.px} y1={p.py} x2={p.px} y2={footY} stroke={col} strokeWidth={1.5} strokeDasharray="3 2" />
                  <circle cx={p.px} cy={footY} r={2} fill={col} />
                </g>
              );
            })}
          </g>
        )}
        {ys.map((y, k) => (
          <g key={k} style={{ cursor:"ns-resize", touchAction:"none" }} {...grip(k)}>
            <line x1={area.x} y1={y} x2={area.x + area.w} y2={y} stroke="transparent" strokeWidth={14} />
            <line x1={area.x} y1={y} x2={area.x + area.w} y2={y} stroke={col} strokeWidth={active === k ? 2.5 : 1.5} strokeDasharray="2 3" />
            <title>Drag {k === 0 ? "A" : "B"} — over a dot or the line to snap to it</title>
          </g>
        ))}
      </g>
    );
  }

  const x = sx(res.x);
  const opLabel = e => (e.kind === "pt" ? "y = " : e.kind === "line" ? "ŷ = " : "") + fmtY(e.y);
  let lbl = "A − B = " + fmtY(res.ends[0].y - res.ends[1].y);
  if (residMode) {
    const pe = res.ends.find(e => e.kind === "pt"), le = res.ends.find(e => e.kind === "line");
    lbl = "residual = y − ŷ = " + fmtY(pe.y - le.y);
  }
  const bw = lbl.length * 6.2 + 10, midY = (ys[0] + ys[1]) / 2;
  const flip = x + 12 + bw > area.x + area.w;
  const bx = flip ? x - 12 - bw : x + 12;
  return (
    <g>
      <line x1={x} y1={ys[0]} x2={x} y2={ys[1]} stroke={col} strokeWidth={1.5} style={{ pointerEvents:"none" }} />
      {res.ends.map((e, k) => {
        const y = ys[k], big = active === k;
        const ring = e.kind === "free" ? null : { x: sx(e.x), y };
        return (
          <g key={k} style={{ cursor:"ns-resize", touchAction:"none" }} {...grip(k)}>
            {ring && (
              <g style={{ pointerEvents:"none" }}>
                <circle cx={ring.x} cy={ring.y} r={big ? 8 : 6.5} fill="none" stroke={col} strokeWidth={big ? 2.5 : 1.8} />
                <circle cx={ring.x} cy={ring.y} r={1.6} fill={col} />
              </g>
            )}
            <line x1={x - 5} y1={y} x2={x + 5} y2={y} stroke={col} strokeWidth={2} />
            <rect x={x - 19} y={y - 6} width={12} height={12} rx={2} fill={col} stroke="#fff" strokeWidth={1} />
            <text x={x - 13} y={y + 4} textAnchor="middle" fontSize={10} fontWeight={800} fill="#fff" style={{ pointerEvents:"none" }}>{k === 0 ? "A" : "B"}</text>
            <text x={x - 23} y={y + 4} textAnchor="end" fontSize={11} fontWeight={600} fill="var(--ruler-text)" style={{ pointerEvents:"none" }}>{opLabel(e)}</text>
          </g>
        );
      })}
      <g style={{ pointerEvents:"none" }}>
        <rect x={bx} y={midY - 9} width={bw} height={17} rx={3} fill="var(--ruler-soft)" stroke="#5eead4" strokeWidth={1} />
        <text x={bx + 5} y={midY + 4} fontSize={12} fontWeight={800} fill="var(--ruler-text)">{lbl}</text>
      </g>
    </g>
  );
}

// ── Movable reference line (scatter) ────────────────────────────────────────────
// A student-placed line y = m·x + b on the num × num scatter, pivoting on a fixed point at
// the horizontal centre of the plot (x = xc). The centre handle — or the line itself —
// drags it up and down (changes the height yc at the pivot); either end handle rotates it
// about the pivot, so any slope is reachable by dragging. The line is stored as { yc, m }
// in data units. Residuals to it are measured with the scatter ruler (ScatterRuler).
function RefLineOverlay({ line, xc, box, sx, toPy, invX, invY, W, onChange }) {
  const drag = useRef(null); // { kind: "shift" | "rotate", startY, startYc }
  const { yc, m } = line;
  const b = yc - m * xc;
  const seg = clipLine(m, b, box.xlo, box.xhi, box.ylo, box.yhi);
  const svgPt = e => {
    const svg = e.currentTarget.ownerSVGElement || e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const ratio = W / (rect.width || W);
    return { px: (e.clientX - rect.left) * ratio, py: (e.clientY - rect.top) * ratio };
  };
  const down = kind => e => {
    e.stopPropagation(); e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (x) {}
    drag.current = { kind, startY: invY(svgPt(e).py), startYc: yc };
  };
  const move = e => {
    const d = drag.current;
    if (!d) return;
    const { px, py } = svgPt(e);
    if (d.kind === "shift") {
      const ny = clampVal(d.startYc + (invY(py) - d.startY), box.ylo, box.yhi);
      onChange({ yc: ny, m });
    } else {
      // Slope from the pivot to the pointer; ignore the pointer while it is right on the
      // pivot's vertical (the slope would blow up).
      if (Math.abs(px - sx(xc)) < 4) return;
      onChange({ yc, m: (invY(py) - yc) / (invX(px) - xc) });
    }
  };
  const up = e => { try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (x) {} drag.current = null; };
  const handlers = kind => ({ onPointerDown: down(kind), onPointerMove: move, onPointerUp: up, onPointerCancel: up });
  if (!seg) return null;

  const p1 = { x: sx(seg[0].x), y: toPy(seg[0].y) }, p2 = { x: sx(seg[1].x), y: toPy(seg[1].y) };
  const cx = sx(xc), cy = toPy(yc);
  // End handles sit just inside the visible ends of the line, pulled toward the pivot.
  const inset = (p, q) => {
    const dx = q.x - p.x, dy = q.y - p.y, L = Math.hypot(dx, dy) || 1, k = Math.min(14, L / 3) / L;
    return { x: p.x + dx * k, y: p.y + dy * k };
  };
  const h1 = inset(p1, { x: cx, y: cy }), h2 = inset(p2, { x: cx, y: cy });
  const col = "var(--purple-ink)";

  return (
    <g>
      {/* the line, with a wide invisible stroke so grabbing it anywhere shifts it */}
      <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={col} strokeWidth={2.25} style={{ pointerEvents:"none" }} />
      <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="transparent" strokeWidth={14}
        style={{ cursor:"ns-resize", touchAction:"none" }} {...handlers("shift")}>
        <title>Drag to move the line up or down</title>
      </line>
      {[h1, h2].map((h, i) => (
        <circle key={i} cx={h.x} cy={h.y} r={6} fill="var(--surface)" stroke={col} strokeWidth={2}
          style={{ cursor:"grab", touchAction:"none" }} {...handlers("rotate")}>
          <title>Drag to change the slope (the line turns about its centre point)</title>
        </circle>
      ))}
      <g style={{ cursor:"ns-resize", touchAction:"none" }} {...handlers("shift")}>
        <circle cx={cx} cy={cy} r={7} fill={col} stroke="var(--surface)" strokeWidth={1.5} />
        <path d={`M${cx} ${cy - 4.5} l-2.5 3 h5 Z M${cx} ${cy + 4.5} l-2.5 -3 h5 Z`} fill="var(--surface)" />
        <title>Drag to move the line up or down (it pivots here)</title>
      </g>
    </g>
  );
}

// ── Cat-difference connector (Phase 6c, mechanic 3) ─────────────────────────────
// The categorical plots are HTML, so the ruler's "line between the two things" is an
// absolutely-positioned SVG overlay that measures the two selected numbers (tagged with
// data-mkey) inside `containerRef` and draws a connector with the A − B read-out and the
// ＋ track affordance ON the line — matching the numeric ruler instead of a chip row.
function MeasureConnector({ containerRef, aKey, bKey, diff, fmt, trackable, onTrack }) {
  const [g, setG] = useState(null);
  useLayoutEffect(() => {
    const cont = containerRef.current;
    if (!cont || !aKey || !bKey) { setG(null); return; }
    const measure = () => {
      let an = null, bn = null;
      cont.querySelectorAll("[data-mkey]").forEach(el => {
        if (el.dataset.mkey === aKey) an = el;
        else if (el.dataset.mkey === bKey) bn = el;
      });
      if (!an || !bn) { setG(null); return; }
      const cr = cont.getBoundingClientRect(), a = an.getBoundingClientRect(), b = bn.getBoundingClientRect();
      setG({ w: cr.width, h: cr.height,
        ax: a.left + a.width / 2 - cr.left, ay: a.top + a.height / 2 - cr.top,
        bx: b.left + b.width / 2 - cr.left, by: b.top + b.height / 2 - cr.top });
    };
    measure();
    const ro = new ResizeObserver(measure); ro.observe(cont);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, [containerRef, aKey, bKey, diff]);
  if (!g) return null;
  const mx = (g.ax + g.bx) / 2, my = (g.ay + g.by) / 2;
  const diffLabel = "A − B = " + fmt(diff);
  const lw = diffLabel.length * 6 + 14;
  const pill = "＋ track", pw = pill.length * 5.4 + 12;
  return (
    <svg width={g.w} height={g.h} style={{ position:"absolute", top:0, left:0, pointerEvents:"none", overflow:"visible" }}>
      <line x1={g.ax} y1={g.ay} x2={g.bx} y2={g.by} stroke="var(--ruler-line)" strokeWidth={2} />
      <circle cx={g.ax} cy={g.ay} r={4} fill="var(--ruler-line)" />
      <circle cx={g.bx} cy={g.by} r={4} fill="var(--ruler-line)" />
      <g transform={"translate(" + mx + "," + my + ")"}>
        <rect x={-lw / 2} y={trackable ? -23 : -10} width={lw} height={trackable ? 35 : 18} rx={5} fill="var(--surface)" stroke="#5eead4" strokeWidth={1.5} />
        <text x={0} y={trackable ? -10 : 3} textAnchor="middle" fontSize={13} fontWeight={800} fill="var(--ruler-text)">{diffLabel}</text>
        {trackable && (
          <g style={{ cursor:"pointer", pointerEvents:"auto" }} onClick={e => { e.stopPropagation(); onTrack(); }}>
            <rect x={-pw / 2} y={2} width={pw} height={14} rx={3} fill="var(--ruler-soft)" stroke="#5eead4" strokeWidth={1} />
            <text x={0} y={12} textAnchor="middle" fontSize={12} fontWeight={800} fill="var(--ruler-text)">{pill}</text>
          </g>
        )}
      </g>
    </svg>
  );
}

// Trim a rasterized canvas to its drawn content: scan from each edge inward, dropping rows /
// columns that are entirely the background color, then keep a small padding. Removes the plot's
// (or sampler's) surrounding whitespace so the pasted image is cropped to the actual content.
// Reads pixels from the html-to-image canvas (same-origin data-URL source → not tainted).
function cropCanvas(canvas, pad = 8) {
  const w = canvas.width, h = canvas.height;
  if (!w || !h) return canvas;
  const ctx = canvas.getContext("2d");
  let data;
  try { data = ctx.getImageData(0, 0, w, h).data; } catch { return canvas; }
  const br = data[0], bg = data[1], bb = data[2];   // background = top-left pixel
  const isBg = (x, y) => { const i = (y * w + x) * 4;
    return Math.abs(data[i] - br) < 6 && Math.abs(data[i + 1] - bg) < 6 && Math.abs(data[i + 2] - bb) < 6; };
  const rowBg = y => { for (let x = 0; x < w; x++) if (!isBg(x, y)) return false; return true; };
  const colBg = x => { for (let y = 0; y < h; y++) if (!isBg(x, y)) return false; return true; };
  let top = 0, bottom = h - 1, left = 0, right = w - 1;
  while (top < bottom && rowBg(top)) top++;
  while (bottom > top && rowBg(bottom)) bottom--;
  while (left < right && colBg(left)) left++;
  while (right > left && colBg(right)) right--;
  top = Math.max(0, top - pad); left = Math.max(0, left - pad);
  bottom = Math.min(h - 1, bottom + pad); right = Math.min(w - 1, right + pad);
  const cw = right - left + 1, ch = bottom - top + 1;
  if (cw <= 0 || ch <= 0 || (cw === w && ch === h)) return canvas;
  const out = document.createElement("canvas");
  out.width = cw; out.height = ch;
  out.getContext("2d").drawImage(canvas, left, top, cw, ch, 0, 0, cw, ch);
  return out;
}

// Copy a node as a PNG to the clipboard (for pasting into an assignment). Works on every plot
// mode and the sampler — numeric plots are SVG, categorical ones / the sampler are HTML, and
// html-to-image rasterizes both, inlining computed styles so CSS-var theming + dark mode come
// through. The result is cropped to its drawn content (cropCanvas) to drop surrounding
// whitespace. Clipboard-image write needs a secure context (localhost / https) + the click
// gesture; if unsupported we surface an error rather than throwing. Nodes tagged
// `data-no-capture` (always the button itself; optionally caller-marked controls) are excluded.
// Rows scrolled out of view inside a scroll box are excluded too (pruneScrolledOut): a mixer
// filled from a continuous column can list thousands of ball types in a 120px box, and
// html-to-image would clone + style-inline every hidden row, freezing the tab before failing.
// Temporarily tag (data-no-capture) every direct child of a scroll container inside `root`
// that lies wholly outside the container's visible box; returns the tagged elements so the
// caller can untag them. The clone resets scrollTop to 0, so the rows that were visible land
// at the top of the box and the PNG still shows what was on screen.
function pruneScrolledOut(root) {
  const tagged = [];
  root.querySelectorAll("*").forEach(el => {
    const vOver = el.scrollHeight > el.clientHeight + 1, hOver = el.scrollWidth > el.clientWidth + 1;
    if (!vOver && !hOver) return;
    const cs = getComputedStyle(el), scrolls = v => v === "auto" || v === "scroll";
    if (!((vOver && scrolls(cs.overflowY)) || (hOver && scrolls(cs.overflowX)))) return;
    const box = el.getBoundingClientRect();
    for (const ch of el.children) {
      if (ch.dataset.noCapture === "1") continue;
      const r = ch.getBoundingClientRect();
      if (r.bottom <= box.top || r.top >= box.bottom || r.right <= box.left || r.left >= box.right) {
        ch.setAttribute("data-no-capture", "1"); tagged.push(ch);
      }
    }
  });
  return tagged;
}

export function CopyImageButton({ targetRef, options, label = "⧉ Copy image", title = "Copy this plot as an image to the clipboard", style }) {
  const [msg, setMsg] = useState("");      // transient status: "ok" | "err" | ""
  const copy = async () => {
    const node = targetRef.current;
    if (!node) return;
    const fail = () => { setMsg("err"); setTimeout(() => setMsg(""), 2200); };
    if (!navigator.clipboard || !navigator.clipboard.write || typeof ClipboardItem === "undefined") { fail(); return; }
    // Marker class for capture-only layout overrides (e.g. left-aligning the sampler's run
    // controls so a one-device sampler crops narrow instead of spanning the panel width).
    // html-to-image inlines computed styles, so the class-driven CSS is honored in the PNG.
    node.classList.add("capturing-image");
    // html-to-image clones nodes via cloneNode, which copies the `checked` *attribute* (the
    // initial mount state) but not the live `.checked` property React controls — so a
    // without-replacement checkbox would still rasterize as checked. Sync the attribute to the
    // current property before capture, then restore, so the image matches the checkbox state.
    const checkboxes = Array.from(node.querySelectorAll('input[type="checkbox"]'));
    const prevChecked = checkboxes.map(c => c.hasAttribute("checked"));
    checkboxes.forEach(c => { if (c.checked) c.setAttribute("checked", ""); else c.removeAttribute("checked"); });
    const pruned = pruneScrolledOut(node);
    try {
      // Match the on-screen theme so the PNG isn't transparent when pasted into Word.
      const bgc = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim() || "#fff";
      const filter = n => !(n && n.dataset && n.dataset.noCapture === "1");
      const blobP = toCanvas(node, { pixelRatio: 2, backgroundColor: bgc, skipFonts: true, cacheBust: true, filter, ...options })
        .then(canvas => new Promise((res, rej) => cropCanvas(canvas).toBlob(b => b ? res(b) : rej(new Error("toBlob")), "image/png")));
      // Hand the clipboard a Promise<Blob> and start the write now, inside the click gesture,
      // so a slow rasterize can't outlive the user activation the write needs.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blobP })]);
      setMsg("ok"); setTimeout(() => setMsg(""), 2200);
    } catch { fail(); }
    finally {
      node.classList.remove("capturing-image");
      checkboxes.forEach((c, i) => { if (prevChecked[i]) c.setAttribute("checked", ""); else c.removeAttribute("checked"); });
      pruned.forEach(el => el.removeAttribute("data-no-capture"));
    }
  };
  // The wrapper is tagged data-no-capture so the button never appears in an image of a region
  // that contains it (e.g. the sampler).
  return (
    <span data-no-capture="1" style={{ marginLeft:"auto", display:"inline-flex", alignItems:"center", gap:6, ...style }}>
      <span role="status" aria-live="polite" style={{ fontSize:12, fontWeight:700, whiteSpace:"nowrap",
        color: msg === "err" ? "var(--text-faint)" : "var(--green-ink)" }}>
        {msg === "ok" ? "✓ Copied image" : msg === "err" ? "Copy unavailable" : ""}
      </span>
      <button onClick={copy} title={title}
        style={{ ...btnNav, display:"inline-flex", alignItems:"center", gap:4, whiteSpace:"nowrap" }}>
        {label}
      </button>
    </span>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// PLOT — the shared, interactive plot primitive (controls + plot body, no table).
// Used by both EDA and Sample Results. X/Y selection is *controlled* by the parent
// so a sibling data table can highlight the selected columns; dot size and the stat
// overlay toggles are local state. Renders the same four modes as the EDA plot:
//   1) cat × cat grid   2) num × cat split dot plots
//   3) single categorical bins   4) scatter / univariate numeric (SVG)
// ══════════════════════════════════════════════════════════════════════════════
// Drop one key from an object (immutable).
const dropKey = (o, k) => { const n = { ...o }; delete n[k]; return n; };
// A category axis's levels in display order: a binned variable's intervals (every one, empty
// ones filled to 0 in `counts` so they still draw), else the observed categories, sorted.
const levelsOf = (levels, v, counts) => {
  const L = levels && levels[v];
  if (!L) return sortCats(Object.keys(counts));
  L.forEach(c => { if (!(c in counts)) counts[c] = 0; });
  return L;
};

function Plot({ rows: rowsIn, headers, nameOf, xVar: xVarIn, yVar: yVarIn, setXVar, setYVar, width, onTrackStat, onTrackDiff, trackedKeys, varKinds, selectedIds, onToggleSelect, onDivider, onOverlays, initialView, onViewChange }) {
  // X = "none" with a Y: a Y-only plot. Everything below treats it as the univariate case on
  // the Y variable (the effective `xVar`), so stats/overlays/specs are the plain univariate
  // ones; only the drawing differs (a vertical dot plot). `yOnly` never pairs with Y = none —
  // the effect below moves a variable onto Y — but until it runs, fall back to the first column.
  const yOnly = xVarIn === "none";
  const xVar = yOnly ? (yVarIn !== "none" ? yVarIn : headers[0] || "") : xVarIn;
  const yVar = yOnly ? "none" : yVarIn;
  // `headers` / `xVar` / `yVar` are device IDS on sampler plots; `nm(id)` resolves the
  // display name. EDA passes real header strings and no `nameOf`, so `nm` is identity
  // there and every label renders unchanged.
  const nm = nameOf || (h => h);
  // `initialView` (optional) seeds the local view state on mount so a saved/opened
  // session restores exactly what was on screen; each hook falls back to its original
  // default via `??`, so a host that passes no `initialView` is byte-identical to before.
  const iv = initialView;
  const [dotSize, setDotSize] = useState(() => iv?.dotSize ?? 5);

  // Stat overlay toggles
  const [showBox, setShowBox] = useState(() => iv?.showBox ?? false);
  const [showMean, setShowMean] = useState(() => iv?.showMean ?? false);
  const [showSD, setShowSD] = useState(() => iv?.showSD ?? false);
  const [showLS, setShowLS] = useState(() => iv?.showLS ?? false);
  const [showDensity, setShowDensity] = useState(() => iv?.showDensity ?? false);
  // Categorical cell labels (counts off by default; opt-in via "# Count")
  const [showCount, setShowCount] = useState(() => iv?.showCount ?? false);
  const [showPct, setShowPct] = useState(() => iv?.showPct ?? false);
  // Collapse high-cardinality categorical axes (>10 categories)
  const [expandCats, setExpandCats] = useState(() => iv?.expandCats ?? false);
  // Headers the student chose to plot AS CATEGORIES although they're detected numeric (0/1
  // indicators, a handful of years). View-only: it changes the plot mode, never the data or
  // the device-derived kinds App uses to validate tracked stats. An array so it's JSON-safe.
  const [asCat, setAsCat] = useState(() => iv?.asCat ?? []);
  const toggleAsCat = h => { setAsCat(a => (a.includes(h) ? a.filter(x => x !== h) : [...a, h])); setBins(b => dropKey(b, h)); };
  // Headers binned into equal-width intervals { [h]: { n } | { w } }: a numeric variable
  // grouped as interval categories ("0–29", "30–59", …). View-only like `asCat`.
  const [bins, setBins] = useState(() => iv?.bins ?? {});
  const toggleBins = h => { setBins(b => (b[h] ? dropKey(b, h) : { ...b, [h]: { n: 4 } })); setAsCat(a => a.filter(x => x !== h)); };
  // Divider measurement tool (Phase 6): off by default; opt-in per plot. The on-plot
  // count / proportion read-outs are themselves off until toggled (like the categorical
  // # Count / % Percent labels).
  const [divOn, setDivOn] = useState(() => iv?.divOn ?? false);
  // "single" (one cut) | "range" (a 2-cut band) | "multi" (k cuts → k+1 bins, exploratory).
  // Older saved views only carry the boolean `divRange`.
  const [divMode, setDivMode] = useState(() => iv?.divMode ?? (iv?.divRange ? "range" : "single"));
  const divRange = divMode === "range", divMulti = divMode === "multi";
  const [divCuts, setDivCuts] = useState(() => iv?.divCuts ?? []);
  const [divShowCount, setDivShowCount] = useState(() => iv?.divShowCount ?? false);
  const [divShowPct, setDivShowPct] = useState(() => iv?.divShowPct ?? false);
  // Inference framing for the single divider: `divDir` picks a one-sided tail (an arrow
  // highlights it and only that tail's proportion shows → a p-value); `divBy` records whether
  // the student last set a VALUE (drag/type → read a probability) or a PERCENTAGE (`divPct`,
  // a tail/middle fraction → the cut snaps to that empirical quantile → read a critical value
  // / CI). The two are linked: editing the value box switches to "value", the % box to "pct".
  const [divDir, setDivDir] = useState(() => iv?.divDir ?? "none"); // "none" | "left" | "right"
  const [divBy, setDivBy] = useState(() => iv?.divBy ?? "value");  // "value" | "pct"
  const [divPct, setDivPct] = useState(() => iv?.divPct ?? 0.05);   // fraction: tail (single) / middle-or-tails (range)
  // Range-mode framing: "middle" highlights the central band (a CI); "tails" highlights the two
  // outer regions (a two-sided p-value). In tails mode `divPct` is the COMBINED tail mass, so the
  // central band that snaps to it covers 1 - divPct. Only meaningful when `divRange`.
  const [divBand, setDivBand] = useState(() => iv?.divBand ?? "middle"); // "middle" | "tails"
  // Ruler measurement tool (Phase 6c): off by default; opt-in per plot. Endpoints carry
  // their snapped operand ({ value, spec, label }) so a difference of two measures can be
  // tracked as a derived column.
  const [rulerOn, setRulerOn] = useState(() => iv?.rulerOn ?? false);
  const [rulerPts, setRulerPts] = useState([]);
  // Mechanic 2 (scatter): the vertical ruler { xv, yv, x, ends:[{ pt, line, y }×2] } — the
  // variables it was drawn for, its x, and each end anchored to a data point (`pt`, an index
  // into the plotted points), to the active line (`line`), or free at `y`. `sweepSt` is the
  // "Measure All" sweep { start, count, dt } (start = the ruler's point; count grows on a
  // timer), and `measFn` / `measOf` pick the summary shown once every residual is drawn.
  // Mechanic 3 (cat difference): up to two clicked stat specs whose difference is reported.
  const [sRuler, setSRuler] = useState(null);
  const [sweepSt, setSweepSt] = useState(null);
  const [measFn, setMeasFn] = useState(() => iv?.measFn ?? "sum");
  const [measOf, setMeasOf] = useState(() => iv?.measOf ?? "raw");
  const [measOpt, setMeasOpt] = useState(() => iv?.measOpt ?? false); // "Show optimal" (LS / LAD)
  const measN = useRef(0);
  const rulerClipId = "rclip" + useId().replace(/:/g, "");
  const [catSel, setCatSel] = useState([]);
  // Movable reference line (num × num scatter): off by default. `refLine` is
  // { x, y, yc, m } — the variables it was placed for, plus its height at the plot's
  // centre pivot and its slope, in data units. A line for other variables is ignored
  // (the line resets, flat at the mean of y).
  const [refOn, setRefOn] = useState(() => iv?.refOn ?? false);
  const [refLine, setRefLine] = useState(() => iv?.refLine ?? null);

  // Measure All: draw one more residual every `dt` ms until all `measN` points are done.
  // A new sample (rows) or turning the ruler off ends the sweep. Above the early returns.
  useEffect(() => {
    if (!sweepSt || sweepSt.count >= measN.current) return;
    const t = setTimeout(() => setSweepSt(m => m && { ...m, count: m.count + 1 }), sweepSt.dt);
    return () => clearTimeout(t);
  }, [sweepSt]);
  useEffect(() => { setSweepSt(null); }, [rowsIn]);
  useEffect(() => { if (!rulerOn) setSweepSt(null); }, [rulerOn]);

  // Report the raw view state up so a host can persist it (Save/Open). Mirrors the proven
  // onDivider/onOverlays pattern but stays separate — different purpose, different data. It
  // reports the raw `divCuts` (NOT the render-derived `effCuts`), so re-seeding can't feedback.
  // MUST sit above the early returns below — otherwise it silently won't fire on an empty plot
  // and would throw "Rendered more hooks" the day a host stops guarding for empty rows.
  useEffect(() => {
    if (!onViewChange) return;
    onViewChange({ dotSize, showBox, showMean, showSD, showLS, showDensity, showCount, showPct,
      expandCats, divOn, divMode, divCuts, divShowCount, divShowPct,
      divDir, divBy, divPct, divBand, rulerOn, asCat, bins, refOn, refLine, measFn, measOf, measOpt });
  }, [onViewChange, dotSize, showBox, showMean, showSD, showLS, showDensity, showCount, showPct,
      expandCats, asCat.join("\u0001"), JSON.stringify(bins), divOn, divMode, divCuts.join(","), divShowCount, divShowPct,
      divDir, divBy, divPct, divBand, rulerOn, refOn, refLine, measFn, measOf, measOpt]);

  const plotRef = useRef(null);
  const bodyRef = useRef(null);            // wraps just the plot body (no controls) for image copy
  const measuredW = useContainerWidth(plotRef, 280, 760);
  const plotW = width || measuredW;

  // Each column's type as colInfo[col] = {numeric,time}. Sampler plots pass an
  // authoritative `varKinds` (derived from device outcomes) so a column's kind is fixed
  // up front and can't flip when a rare non-numeric draw appears; EDA passes none and
  // falls back to inferring from the rows via colKind (its data is a static upload).
  // `detected` keeps that kind; `colInfo` applies the student's as-categories override on
  // top (plain numeric only — a time column keeps its time axis).
  const detected = useMemo(() => {
    const map = {};
    headers.forEach(h => { map[h] = (varKinds && varKinds[h]) || colKind(rowsIn, h); });
    return map;
  }, [rowsIn, headers, varKinds]);
  const canAsCat = h => !!(detected[h] && detected[h].numeric && !detected[h].time);
  // Binned headers: each value becomes its interval's label (rows keep their _id, so
  // selection still links to the table); `binLevels` lists every interval in order, empty
  // ones included, for the category plots. Everything below reads the binned `rows`.
  const binKey = JSON.stringify(bins);
  const binned = useMemo(() => {
    const out = {};
    Object.keys(bins).forEach(h => {
      if (!canAsCat(h) || !headers.includes(h)) return;
      const b = makeBins(rowsIn.map(r => toNum(r[h])), bins[h]);
      if (b) out[h] = b;
    });
    return out;
  }, [rowsIn, detected, binKey, headers.join("\u0001")]);
  const rows = useMemo(() => {
    const hs = Object.keys(binned);
    if (!hs.length) return rowsIn;
    return rowsIn.map(r => {
      const o = { ...r };
      hs.forEach(h => { const v = toNum(r[h]); o[h] = Number.isFinite(v) ? binned[h].labels[binned[h].index(v)] : ""; });
      return o;
    });
  }, [rowsIn, binned]);
  const binLevels = useMemo(() => {
    const L = {};
    Object.keys(binned).forEach(h => { L[h] = binned[h].labels; });
    return L;
  }, [binned]);
  const colInfo = useMemo(() => {
    const map = { ...detected };
    asCat.forEach(h => { if (canAsCat(h)) map[h] = { numeric:false, time:false }; });
    Object.keys(binned).forEach(h => { map[h] = { numeric:false, time:false }; });
    return map;
  }, [detected, asCat.join("\u0001"), binned]);

  // Keep X/Y valid as the available columns change (callbacks into the parent's state)
  useEffect(() => { if (headers.length && xVarIn !== "none" && !headers.includes(xVarIn)) setXVar(headers[0]); }, [headers.join(",")]);
  useEffect(() => {
    if (yOnly) { if (headers.length && !headers.includes(yVarIn)) setYVar(headers[0]); return; }
    if (yVarIn !== "none" && (!headers.includes(yVarIn) || yVarIn === xVarIn)) setYVar("none");
  }, [headers.join(","), xVarIn, yVarIn]);
  // Picking X = none with no Y moves the current X onto Y, so the same variable turns upright.
  const pickX = v => { if (v === "none" && yVarIn === "none") setYVar(xVarIn); setXVar(v); };

  if (!rows.length) return <div style={{ color:"var(--text-faint)", padding:24, textAlign:"center" }}>No data yet.</div>;
  if (!xVar) return null;

  const xInfo = colInfo[xVar] || { numeric:false, time:false };
  const yInfo = (yVar !== "none" && colInfo[yVar]) || { numeric:false, time:false };
  const xNumeric = xInfo.numeric, xTime = xInfo.time;
  const yNumeric = yVar !== "none" && yInfo.numeric, yTime = yInfo.time;
  const bivariate = yVar !== "none";

  const W = plotW, PL = 56, PR = 20, PT = 20;
  const iW = W - PL - PR, iH = 210; // plot area; footer height is computed below
  const R = dotSize;

  // ── Build scales (numeric / time only; categorical handled by cell plots) ──
  const buildScale = (col, size, isNum, isTime) =>
    makeScale(rows.map(r => r[col]), size, { numeric: isNum, time: isTime, toNumber: toNum, pad: 0.05, tickCount: 6, precision: 2 });

  const xS = buildScale(xVar, iW, xNumeric, xTime);
  const yS = bivariate ? buildScale(yVar, iH, yNumeric, yTime) : null;

  // ── Compute dot positions ──
  // On a numeric axis, also drop cells that don't parse to a finite number — a
  // column classified numeric by colKind may still hold up to ~20% non-numeric
  // values, and feeding those to a numeric scale yields NaN pixel positions
  // (invisible dots + "Received NaN for the `cx` attribute" warnings). Categorical
  // axes only need the empty check.
  const axisOk = (v, numeric) =>
    v !== undefined && v !== "" && (!numeric || Number.isFinite(toNum(v)));
  const valid = rows.filter(r => {
    if (!axisOk(r[xVar], xNumeric)) return false;
    if (bivariate && !axisOk(r[yVar], yNumeric)) return false;
    return true;
  });
  const xps = valid.map(r => xS.scale(r[xVar]));
  const yOffsets = yS ? null : stackDots(xps, R, iH, 1);
  const dots = valid.map((r, i) => ({
    id: r._id,
    x: PL + xps[i],
    y: PT + (yS ? iH - yS.scale(r[yVar]) : yOffsets[i]),
  }));

  // Frequency y-axis for univariate-numeric dot plots (no Y scale): integer ticks aligned to
  // the dot rows. A dot at stack index f (1-based) has center y = PT + iH - R - (f-1)*spacing
  // (matches stackDots), so tick f sits on the f-th row. "Nice" integer step keeps ~6 labels.
  const freqAxis = (() => {
    if (yS || !xNumeric || !yOffsets || !yOffsets.tallest) return null;
    const tallest = yOffsets.tallest, spacing = yOffsets.dotSpacing;
    const niceStep = t => {
      if (t <= 8) return 1;
      const raw = t / 6, mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / mag;
      return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
    };
    const step = niceStep(tallest), ticks = [];
    for (let f = step; f <= tallest + 1e-9; f += step) ticks.push(Math.round(f));
    return { ticks, spacing };
  })();

  // ── Univariate numeric summary (for box/mean/SD overlays) ──
  const xNums = rows.map(r => toNum(r[xVar])).filter(v => !isNaN(v));
  const xSummary = xNumeric ? numericSummary(xNums) : null;
  const fmtX = xTime ? minutesToTime : (v => parseFloat(v.toFixed(2)));

  // LS fit for bivariate numeric
  let ls = null, lad = () => null;
  if (bivariate && xNumeric && yNumeric) {
    const pairs = rows.map(r => ({ x: toNum(r[xVar]), y: toNum(r[yVar]) })).filter(p => !isNaN(p.x) && !isNaN(p.y));
    ls = lsFit(pairs);
    // The LAD fit, computed only when asked for (Match LAD / the absolute-residual comparison)
    // and cached per data + variables, so dragging the ref line doesn't refit every frame.
    lad = () => {
      if (ladCache.rows !== rows || ladCache.key !== JSON.stringify([xVar, yVar])) {
        ladCache.rows = rows; ladCache.key = JSON.stringify([xVar, yVar]); ladCache.fit = ladFit(pairs);
      }
      return ladCache.fit;
    };
  }

  const sx = v => PL + xS.scale(v);
  // ── Show values ──
  // Numeric overlay values appear automatically whenever any stat overlay is on (and are
  // always on in the click-to-track Sample Results context). There is no separate toggle.
  // A binned variable is a view of the data that App can't recompute per sample, so stats
  // aren't collectable while one is on an axis.
  const binnedInView = !!(binned[xVar] || (yVar !== "none" && binned[yVar]));
  const trackable = !!onTrackStat && !binnedInView;
  const showVals = trackable || showMean || showSD || showBox || showLS;
  // Univariate numeric overlays hug the axis: the mean triangle's tip sits on the
  // x-axis, the ±SD bar is directly beneath it (adjacent to the mean), and the
  // boxplot is separated below. Tick labels sit below the strip.
  const axisY = PT + iH;
  const sdBarY = axisY + 7;        // ±SD bar runs through the mean triangle (centred on the mean)
  const meanBaseY = axisY + 13;    // triangle base
  const meanValY = axisY + 23;     // mean value, below the triangle
  const boxCy = axisY + 38;        // boxplot centre, with room above + below for values
  const medianValY = axisY + 59;   // median value, below the box
  const hasUniOverlay = !bivariate && xSummary && (showBox || showMean || showSD);
  let overlayBottom = axisY;
  if (hasUniOverlay) {
    if (showMean) overlayBottom = Math.max(overlayBottom, showVals ? meanValY : meanBaseY);
    if (showSD) overlayBottom = Math.max(overlayBottom, sdBarY + 4);
    if (showBox) overlayBottom = Math.max(overlayBottom, showVals ? medianValY : boxCy + 9);
  }
  const tickLblY = hasUniOverlay ? overlayBottom + 14 : axisY + 16;
  // Angle the X tick labels when adjacent numeric labels would collide (e.g. very large
  // values): estimate each label's width (~6.7px/char at 12px) and compare to the tick gap.
  // Rotated -35° (anchored at the tick), they fan down-left, so reserve extra footer height.
  const xTickW = (xNumeric || xTime)
    ? xS.ticks.reduce((m, t) => Math.max(m, String(xS.fmt(t)).length), 0) * 6.7 : 0;
  const xTickGap = xS.ticks.length > 1 ? Math.abs(sx(xS.ticks[1]) - sx(xS.ticks[0])) : iW;
  const angleXTicks = xTickW > xTickGap * 0.92;
  const xTickExtra = angleXTicks ? Math.ceil(xTickW * 0.57) : 0; // ≈ width·sin(35°)
  const H = tickLblY + 18 + xTickExtra; // tick labels (+ angled overhang) + axis title

  // Which toggle groups apply to the current variable selection
  const showStatToggles = (xNumeric && !bivariate) || (bivariate && (xNumeric !== yNumeric));
  const showCatToggles = (!bivariate && !xNumeric) || (bivariate && !xNumeric && !yNumeric);
  const toggleExpand = () => setExpandCats(e => !e);

  // ── Click-to-track ──
  // When a parent supplies onTrackStat (Sample Results), the numbers drawn on the
  // plot become clickable: clicking one toggles tracking that statistic in Collect
  // Statistics. `trackable`/`showVals` are derived above (overlay values are always
  // visible in this context, so a number is always present to click).
  const trackProps = { trackable, trackedKeys, onTrackStat, nameOf };

  // ── Linked highlighting (Phase D1) ──
  // When the host owns a row-selection set (EDA), each dot becomes a one-to-one click
  // target for its source row: clicking toggles `r._id` in the shared set, and selected
  // dots/rows highlight together. Bundled and threaded into every plot mode.
  const selectable = !!onToggleSelect;
  const isSel = id => !!(selectedIds && selectedIds.has(id));
  const selProps = { selectedIds, onToggleSelect };

  // ── Divider tool (Phase 6) ──
  // Gated to plots with a continuous numeric X axis: univariate numeric, or num × cat
  // with the numeric variable on X (horizontal split plot). Off for scatter (deferred),
  // cat × cat, uni-cat, and numeric-on-Y. The cut values live in data units and are
  // shared with the child SplitDotPlots so a single line spans all groups.
  const dividerAvailable = (!bivariate && xNumeric && !yOnly) || (bivariate && xNumeric && !yNumeric);
  let divDomain = null;
  if (dividerAvailable && !bivariate) {
    divDomain = { lo: xS.lo, hi: xS.hi, values: xNums, fmt: fmtX,
      snap: [...xNums, ...(showMean && xSummary ? [xSummary.mean] : []), ...(showBox && xSummary ? [xSummary.median, xSummary.q1, xSummary.q3] : [])] };
  } else if (dividerAvailable) {
    // num × cat horizontal: numeric var is X, category var is Y (mirror SplitDotPlots'
    // domain + top-10 collapse so the line and per-group read-outs line up exactly).
    const numVar = xVar, catVar = yVar;
    const nums = rows.map(r => toNum(r[numVar])).filter(v => !isNaN(v));
    const mn = Math.min(...nums), mx = Math.max(...nums), range = (mx - mn) || 1, pad = range * 0.05;
    const catCount = {};
    rows.forEach(r => { const v = r[catVar]; if (v !== "" && v !== undefined) catCount[v] = (catCount[v] || 0) + 1; });
    const allCats = levelsOf(binLevels, catVar, catCount);
    const cats = collapseCats(allCats, catCount, expandCats || !!binLevels[catVar]).shown;
    const catSet = new Set(cats.filter(c => c !== OTHER_CAT));
    const groupOf = v => catSet.has(v) ? v : OTHER_CAT;
    const groups = cats.map(cat => ({ label: cat,
      values: rows.map(r => groupOf(r[catVar]) === cat ? toNum(r[numVar]) : NaN).filter(v => !isNaN(v)) }));
    const gMeans = showMean ? groups.map(g => g.values.reduce((a, b) => a + b, 0) / (g.values.length || 1)) : [];
    divDomain = { lo: mn - pad, hi: mx + pad, values: nums, fmt: xTime ? minutesToTime : (v => parseFloat(v.toFixed(2))),
      groups, snap: [...nums, ...gMeans] };
  }
  // Effective cut values: user-set `divCuts` when they match the current mode + domain,
  // else sensible defaults derived from the domain (so the line follows the data until
  // the student grabs it). Drag/typing then makes `divCuts` authoritative.
  const showDivider = divOn && !!divDomain;
  // The percentage drives the cut only when there's a tail/middle to target (a single
  // direction, or range mode) — a two-sided single divider is always value-driven.
  // Multi mode is exploratory (no tail/middle framing), so it is always value-driven.
  const divSingle = divMode === "single";
  const pctActive = divBy === "pct" && (divRange || (divSingle && divDir !== "none"));
  let effCuts = [];
  if (showDivider && divMulti) {
    // Multi: keep the user's cuts (2..MAX_CUTS, finite); else 3 equal-width cuts over the data.
    const ok = v => typeof v === "number" && isFinite(v);
    const { lo, hi } = divDomain;
    effCuts = divCuts.length >= 2 && divCuts.length <= MAX_CUTS && divCuts.every(ok) ? divCuts
      : divDomain.values.length ? evenCuts(divDomain.values, 3, "width")
      : [1, 2, 3].map(j => lo + j * (hi - lo) / 4);
  } else if (showDivider) {
    const { lo, hi } = divDomain, want = divRange ? 2 : 1;
    if (pctActive && divDomain.values.length) {
      const vals = divDomain.values, m = divPct;
      // Range (CI) → the smallest achievable central band covering ≥ m (conservative — covers
      // at least the set proportion; `conservativeBand`). Single tail → a standard interpolating
      // percentile critical value (the 1-m percentile for a right tail, the m percentile for a
      // left tail; constraint #5 `quantile`).
      const sorted = [...vals].sort((a, b) => a - b); // quantile() expects sorted input
      const q = t => clampVal(quantile(sorted, t), lo, hi);
      // Tails mode: the box is combined tail mass, so the central band covers 1 - m.
      const cover = divBand === "tails" ? 1 - m : m;
      effCuts = divRange
        ? conservativeBand(vals, cover).map(c => clampVal(c, lo, hi))
        : [q(divDir === "right" ? 1 - m : m)];
    } else {
      // Value mode: keep the user's cuts whenever the count matches the mode — even when a
      // cut lies OUTSIDE the visible window (a two-sided p-value may need a tail past the
      // data range). The line is drawn clamped to the edge with an off-window arrow; the
      // read-out + generated code use the true value. Only fall back to defaults when the
      // mode just switched (wrong count) or a cut is non-finite.
      const ok = v => typeof v === "number" && isFinite(v);
      effCuts = (divCuts.length === want && divCuts.every(ok))
        ? divCuts
        : (divRange ? [lo + (hi - lo) / 3, lo + 2 * (hi - lo) / 3] : [(lo + hi) / 2]);
    }
  }
  // Editing a value (drag or type) makes the cut authoritative (value mode); typing a
  // percentage snaps the cut to that quantile (pct mode). The two boxes stay linked.
  const onDivDrag = next => { setDivCuts(next); setDivBy("value"); };
  const setCut = (i, raw) => {
    // No clamp: a typed value may sit beyond the window (drag still clamps to the axis).
    const v = parseFloat(raw);
    if (isNaN(v)) return;
    const next = effCuts.slice(); next[i] = v; setDivCuts(next); setDivBy("value");
  };
  const setPct = raw => {
    const p = parseFloat(raw);
    if (isNaN(p)) return;
    setDivPct(clampVal(p, 0.0001, 0.9999)); setDivBy("pct"); // stored as a proportion (0–1)
  };
  // Multi-mode cut editing. A new cut splits the widest gap among the sorted cuts and the
  // data's min/max (so it lands somewhere visible and useful); removal keeps at least 2.
  const addCut = () => {
    if (effCuts.length >= MAX_CUTS) return;
    let mn = Infinity, mx = -Infinity;
    for (const x of divDomain.values) { if (x < mn) mn = x; if (x > mx) mx = x; }
    if (!isFinite(mn)) { mn = divDomain.lo; mx = divDomain.hi; }
    const pts = [mn, ...[...effCuts].sort((a, b) => a - b), mx];
    let best = 0;
    for (let j = 1; j < pts.length - 1; j++) if (pts[j + 1] - pts[j] > pts[best + 1] - pts[best]) best = j;
    setDivCuts([...effCuts, (pts[best] + pts[best + 1]) / 2]); setDivBy("value");
  };
  const removeCut = i => {
    if (effCuts.length <= 2) return;
    setDivCuts(effCuts.filter((_, j) => j !== i)); setDivBy("value");
  };
  const spaceCuts = how => {
    if (!divDomain.values.length) return;
    setDivCuts(evenCuts(divDomain.values, effCuts.length, how, quantile)); setDivBy("value");
  };
  const switchDivMode = m => { if (m === divMode) return; setDivMode(m); setDivCuts([]); setDivBy("value"); };
  // Overall regions for the univariate on-plot read-out (num × cat read-outs are
  // computed per-group inside SplitDotPlots).
  const divRegions = !showDivider ? null
    : divMulti ? binRegions(divDomain.values, effCuts) : regions(divDomain.values, effCuts);
  // The single divider's focused region when a tail direction is chosen (right → the ≥ side,
  // left → the < side); null for two-sided / range. Drives the one-tail read-out + the linked
  // % box (its proportion is what "tail %" shows in value mode).
  const divDirected = showDivider && divSingle && divDir !== "none";
  // The focused tail is always inclusive of the cut: right → x ≥ v ("ge", already inclusive);
  // left → x ≤ v (built here so it matches the generated p-value `mean(vec <= v)`, not the
  // strict "lt" region). Range middle → the central band; range tails → the two outer regions,
  // each INCLUSIVE of its cut (x ≤ lo, x ≥ hi — a two-sided p-value counts the observed
  // statistic, matching the generated `mean(vec <= lo | vec >= hi)`), combined so the box /
  // read-out reflect combined tail mass.
  const divTailRegions = divRegions && divRange && divBand === "tails" ? (() => {
    const lo = Math.min(effCuts[0], effCuts[1]), hi = Math.max(effCuts[0], effCuts[1]);
    const vals = divDomain.values, total = vals.length, prop = n => (total ? n / total : NaN);
    const nLo = vals.filter(x => x <= lo).length, nHi = vals.filter(x => x >= hi).length;
    return [
      { key: "le", lo: -Infinity, hi: lo, n: nLo, p: prop(nLo) },
      { key: "geHi", lo: hi, hi: Infinity, n: nHi, p: prop(nHi) },
    ];
  })() : null;
  const focusRegion = !divRegions ? null
    : divRange ? (divTailRegions
        ? (() => {
            const lo = divTailRegions[0].hi, hi = divTailRegions[1].lo, total = divDomain.values.length;
            const n = divDomain.values.filter(x => x <= lo || x >= hi).length; // union (a value counts once)
            return { key: "tails", n, p: total ? n / total : NaN };
          })()
        : divRegions.find(r => r.key === "mid"))
    : !divSingle ? null
    : divDir === "right" ? divRegions.find(r => r.key === "ge")
    : divDir === "left" ? (() => {
        const v = effCuts[0], total = divDomain.values.length;
        const n = divDomain.values.filter(x => x <= v).length;
        return { key: "le", lo: -Infinity, hi: v, n, p: total ? n / total : NaN };
      })()
    : null;
  const shownPct = divBy === "pct" ? divPct : (focusRegion ? focusRegion.p : NaN);
  const divProps = { divOn: showDivider, divCuts: effCuts, onDivChange: onDivDrag,
    divSnap: showDivider ? divDomain.snap : null, divShowCount, divShowPct,
    divFmt: showDivider ? divDomain.fmt : null, divMulti };
  // Report the active divider to a host that wants to mirror it (the Collect plot lifts this
  // into App so the generated inference code uses the real cutoff / framing). `variable` is
  // the current X header; `cuts` are in stat units. Null when the divider is off.
  // `bounds` are each cut's neighbouring data values, so codegen's `cutLit` can print the shortest
  // literal that classifies the data like the exact cut (a cut snapped onto a dot must not round
  // across it). One O(N) scan per cut; keyed as a string so the effect only re-reports on change.
  const divBounds = showDivider && onDivider ? effCuts.map(c => {
    let maxBelow = -Infinity, minAtOrAbove = Infinity, maxAtOrBelow = -Infinity, minAbove = Infinity;
    for (const x of divDomain.values) {
      if (x < c) { if (x > maxBelow) maxBelow = x; } else if (x < minAtOrAbove) minAtOrAbove = x;
      if (x > c) { if (x < minAbove) minAbove = x; } else if (x > maxAtOrBelow) maxAtOrBelow = x;
    }
    return { maxBelow, minAtOrAbove, maxAtOrBelow, minAbove };
  }) : null;
  const divBoundsKey = divBounds ? divBounds.map(b => [b.maxBelow, b.minAtOrAbove, b.maxAtOrBelow, b.minAbove].join(",")).join(";") : "";
  useEffect(() => {
    if (!onDivider) return;
    onDivider(showDivider
      ? { variable: xVar, cuts: effCuts, mode: divMode, range: divRange, dir: divSingle ? divDir : "none", by: divBy, pct: divPct, band: divRange ? divBand : "middle", bounds: divBounds }
      : null);
  }, [onDivider, showDivider, xVar, divMode, divDir, divBy, divPct, divBand, effCuts.join(","), divBoundsKey]);

  // Report active univariate summary overlays (boxplot / mean / ±1 SD) the same way, so the Collect
  // plot can drive code that computes those statistics over the sampling distribution. Only the
  // univariate-numeric case carries these overlays; null when none are on (or not applicable).
  const uniNumeric = !bivariate && !!xSummary;
  useEffect(() => {
    if (!onOverlays) return;
    const on = uniNumeric && (showMean || showSD || showBox);
    onOverlays(on ? { variable: xVar, mean: showMean, sd: showSD, box: showBox } : null);
  }, [onOverlays, uniNumeric, showMean, showSD, showBox, xVar]);

  // ── Ruler tool (Phase 6c) ──
  // Mechanic 1 (axis distance / difference of measures) shares the divider's gating and
  // geometry — a continuous numeric X (univariate or num × cat horizontal) — reusing
  // `divDomain` for lo/hi/fmt. Each endpoint is either a free constant or *anchored* to a
  // measure (carries a stat spec); an anchored endpoint recomputes its value from the
  // CURRENT data every render (so it follows a new sample), and snaps to data dots or
  // measures while dragging. The univariate snap candidates carry a marker `y` so the
  // overlay can draw a ring over the exact target; num × cat builds its own candidates in
  // `SplitDotPlots` (where the per-group geometry lives).
  // Three independent mechanics share the 📐 Ruler toggle, gated to the plot they apply
  // to: axis-distance/difference-of-measures (mechanic 1, numeric X), residual-to-LS-line
  // (mechanic 2, num × num scatter), and difference-of-two-clicked-measures (mechanic 3,
  // categorical plots).
  const rulerAxisAvail = dividerAvailable;
  const rulerResidAvail = bivariate && xNumeric && yNumeric && !!yS;
  const rulerCatDiffAvail = (bivariate && !xNumeric && !yNumeric) || (!bivariate && !xNumeric);
  const rulerAvailable = !yOnly && (rulerAxisAvail || rulerResidAvail || rulerCatDiffAvail);
  const showRuler = rulerOn && rulerAxisAvail && !!divDomain; // mechanic 1 (axis)
  const showResidRuler = rulerOn && rulerResidAvail;          // mechanic 2 (residual)
  const showCatRuler = rulerOn && rulerCatDiffAvail;          // mechanic 3 (cat difference)

  // Resolve a stored endpoint to its live value: a measure recomputes from `rows` (so a
  // new single sample moves it), a constant keeps its number; clamp into the domain.
  const resolveVal = pt => {
    if (pt && pt.cut != null) {                  // follows the live divider cut
      const v = effCuts[pt.cut];
      return Number.isFinite(v) ? v : pt.value;  // divider off / gone → keep last value
    }
    if (!pt || !pt.spec) return pt ? pt.value : NaN;
    const v = computeStat(pt.spec, rows);
    return Number.isFinite(v) ? v : pt.value;
  };
  // Univariate snap candidates (with a marker y for the anchor ring). Measures are always
  // offered when the ruler is on — not gated on the overlay toggles — so anchoring to the
  // mean / median / quartiles is discoverable, with the ring marking the target. Box
  // quartiles only when the box is shown (so the ring sits on a visible box).
  let rulerSnap = null;
  if (showRuler && !bivariate) {
    // Measures first (so they win a tie against a coincident data dot), then the dots.
    rulerSnap = [];
    if (xSummary) {
      rulerSnap.push({ value: xSummary.mean, spec: { fn: "mean", variable: xVar }, label: "mean", y: axisY + 7 });
      if (showBox) rulerSnap.push(
        { value: xSummary.median, spec: { fn: "median", variable: xVar }, label: "median", y: boxCy },
        { value: xSummary.q1, spec: { fn: "q1", variable: xVar }, label: "Q1", y: boxCy },
        { value: xSummary.q3, spec: { fn: "q3", variable: xVar }, label: "Q3", y: boxCy });
    }
    const bottomY = {}; // value → lowest dot y (nearest the axis), for the dot ring
    valid.forEach((r, i) => {
      const v = toNum(r[xVar]);
      if (!Number.isFinite(v)) return;
      if (bottomY[v] === undefined || dots[i].y > bottomY[v]) bottomY[v] = dots[i].y;
    });
    Object.keys(bottomY).forEach(k => rulerSnap.push({ value: +k, spec: null, label: null, y: bottomY[k] }));
    // Divider cut(s): a full-height line has no y, so snapMeasure uses horizontal distance
    // only — the cut wins everywhere along the line except close to a measure's marker.
    if (showDivider) effCuts.forEach((c, k) => rulerSnap.push(
      { value: c, cut: k, spec: null,
        label: divMulti ? "cut " + (k + 1) : divRange ? (k === 0 ? "low cut" : "high cut") : "cut", y: null }));
  }
  // A stored endpoint set is reusable only if its anchors still reference this plot's
  // variables (else a variable switch left them stale → fall back to fresh defaults).
  const specOk = p => !p.spec || (p.spec.variable === xVar && (!p.spec.condVar || p.spec.condVar === yVar));
  let effPts = [];
  if (showRuler) {
    const { lo, hi } = divDomain;
    const base = (rulerPts.length === 2 && rulerPts.every(specOk))
      ? rulerPts
      // A (index 0) defaults to the right, B (index 1) to the left, so A − B starts positive.
      : [{ value: lo + 2 * (hi - lo) / 3, spec: null, label: null }, { value: lo + (hi - lo) / 3, spec: null, label: null }];
    effPts = base.map(p => ({ ...p, value: clampVal(resolveVal(p), lo, hi) }));
  }
  const setRulerPt = (i, raw) => {
    const v = clampVal(parseFloat(raw), divDomain.lo, divDomain.hi);
    if (isNaN(v)) return;
    const next = effPts.slice(); next[i] = { value: v, spec: null, label: null }; setRulerPts(next);
  };
  const rulerProps = { rulerOn: showRuler, rulerPts: effPts, onRulerChange: setRulerPts,
    rulerFmt: showRuler ? divDomain.fmt : null, rulerShowBox: showBox, onTrackDiff };

  const toPy = v => PT + iH - (yS ? yS.scale(v) : 0);

  // Movable reference line (num × num scatter). The pivot is the horizontal centre of the
  // plot (x = xc); a stored line for other variables is replaced by the default — flat at
  // the mean of y. Residual sums run over every plotted point.
  const refAvail = bivariate && xNumeric && yNumeric && !!yS;
  const showRef = refOn && refAvail && valid.length > 0;
  let refEff = null, refPts = null, refXc = NaN;
  if (showRef) {
    refXc = (xS.lo + xS.hi) / 2;
    refPts = valid.map((r, i) => ({ px: dots[i].x, py: dots[i].y, x: toNum(r[xVar]), y: toNum(r[yVar]) }))
      .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    const fresh = !refLine || refLine.x !== xVar || refLine.y !== yVar || !Number.isFinite(refLine.yc) || !Number.isFinite(refLine.m);
    const meanY = refPts.reduce((a, p) => a + p.y, 0) / (refPts.length || 1);
    refEff = fresh ? { yc: meanY, m: 0 } : { yc: clampVal(refLine.yc, yS.lo, yS.hi), m: refLine.m };
  }
  const setRef = l => setRefLine({ x: xVar, y: yVar, yc: l.yc, m: l.m });
  // Typed slope / intercept: the intercept moves the line's height at the pivot.
  const setRefSlope = n => { if (Number.isFinite(n) && refEff) setRef({ yc: refEff.yc - refEff.m * refXc + n * refXc, m: n }); };
  const setRefIntercept = n => { if (Number.isFinite(n) && refEff) setRef({ yc: n + refEff.m * refXc, m: refEff.m }); };
  const f3 = v => (Number.isFinite(v) ? parseFloat(v.toFixed(3)) : "—");

  // Mechanic 2 (scatter ruler): two endpoints A and B on the y axis, like the numeric ruler
  // turned upright — each a full-width dotted guide, read-out A − B. The line it can snap to
  // is the ref line when shown, else the LS line when shown, else none. With no stored ruler
  // (or one for other variables) it opens as a generic Δy: A at 2/3 of the y range, B at 1/3.
  // Each end is anchored to a data point (`pt`, an index into the plotted points), to the line
  // at some x (`line`, `x`), or free at `y`, and resolves live: a point end follows its point,
  // a line end follows the line (so moving the line updates the reading). Residual mode = one
  // end on a point and the other on the line directly under/over it (same x).
  let sPts = null, sLine = null, sRes = null, residMode = false, sweep = null, measDone = false;
  const invX = px => xS.lo + ((px - PL) / iW) * (xS.hi - xS.lo);
  const invY = py => yS.lo + ((PT + iH - py) / iH) * (yS.hi - yS.lo);
  const rulerDefault = () => ({ xv: xVar, yv: yVar, bx: xS.lo + 0.85 * (xS.hi - xS.lo),
    ends: [{ pt: null, line: false, y: yS.lo + 2 * (yS.hi - yS.lo) / 3 }, { pt: null, line: false, y: yS.lo + (yS.hi - yS.lo) / 3 }] });
  const rawRuler = () => (sRuler && sRuler.xv === xVar && sRuler.yv === yVar) ? sRuler : rulerDefault();
  const resolveRuler = r => {
    // A line end whose partner is on a point always reads that point's residual: wherever it
    // was snapped onto the line, it resolves to the foot at the point's x (handy when the
    // points are dense near the line — snap to it somewhere clear instead).
    const ptOf = e => (e.pt != null && sPts[e.pt]) ? sPts[e.pt] : null;
    const ends = r.ends.map((e, k) => {
      const p = ptOf(e);
      if (p) return { y: p.y, x: p.x, kind: "pt" };
      if (e.line && sLine) {
        const op = ptOf(r.ends[1 - k]), x = op ? op.x : e.x;
        return { y: sLine.m * x + sLine.b, x, kind: "line" };
      }
      return { y: clampVal(e.y, yS.lo, yS.hi), x: null, kind: "free" };
    });
    // The bar sits at a point end's x, else a line end's x, else its own resting x.
    const pe = ends.find(e => e.kind === "pt") || ends.find(e => e.kind === "line");
    return { x: pe ? pe.x : r.bx, ends };
  };
  if (showResidRuler) {
    sPts = valid.map((r, i) => ({ i, px: dots[i].x, py: dots[i].y, x: toNum(r[xVar]), y: toNum(r[yVar]) }))
      .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    sPts.forEach((p, k) => { p.i = k; });
    sLine = showRef ? { m: refEff.m, b: refEff.yc - refEff.m * refXc, who: "ref" }
      : (showLS && ls ? { m: ls.slope, b: ls.intercept, who: "ls" } : null);
    sRes = resolveRuler(rawRuler());
    const pe = sRes.ends.find(e => e.kind === "pt"), le = sRes.ends.find(e => e.kind === "line");
    residMode = !!(pe && le && Math.abs(pe.x - le.x) <= 1e-9 * (Math.abs(pe.x) + 1));
    measN.current = sPts.length;
    // Measure All order: left to right (ties by y), starting at the ruler's point and wrapping.
    const startPt = residMode ? rawRuler().ends.find(e => e.pt != null).pt : null;
    if (sweepSt && residMode && sweepSt.start === startPt) {
      const order = sPts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
      const k = order.findIndex(p => p.i === startPt);
      sweep = order.slice(k).concat(order.slice(0, k)).slice(0, sweepSt.count);
      measDone = sweepSt.count >= sPts.length;
    }
  }
  // Where a dragged end lands with the pointer at (px, py): the closest of a data dot (within
  // 10px), the line's foot under/over the other end's dot (within 12px — the residual spot),
  // or the line itself (within 8px vertically, at the pointer's x); else free at the
  // pointer's height. `other` is the other end's stored anchor.
  const snapEnd = (px, py, other) => {
    const lineY = x => sLine.m * x + sLine.b;
    let best = { pt: null, line: false, y: clampVal(invY(py), yS.lo, yS.hi) }, bd = Infinity;
    sPts.forEach((p, k) => { const d = Math.hypot(p.px - px, p.py - py); if (d < 10 && d < bd) { bd = d; best = { pt: k, line: false, y: p.y }; } });
    if (sLine) {
      // The residual foot under/over the other end's dot wins over a plain line snap nearby,
      // so landing on the line close to that dot always reads the exact residual.
      const op = other && other.pt != null ? sPts[other.pt] : null;
      const fd = op ? Math.hypot(op.px - px, toPy(lineY(op.x)) - py) : Infinity;
      if (fd < 12 && fd < bd) { bd = fd; best = { pt: null, line: true, x: op.x, y: lineY(op.x) }; }
      else {
        const x = clampVal(invX(px), xS.lo, xS.hi), d = Math.abs(toPy(lineY(x)) - py);
        if (d < 8 && d < bd) { bd = d; best = { pt: null, line: true, x, y: lineY(x) }; }
      }
    }
    return best;
  };
  // Dragging an end ends a Measure All sweep. (A line end paired with a point end follows that
  // point's x in `resolveRuler`, so moving the point end to a new dot needs no fix-up here.)
  const onRulerDrag = (k, px, py) => {
    setSweepSt(null);
    const r = rawRuler();
    const ends = r.ends.slice();
    ends[k] = snapEnd(px, py, ends[1 - k]);
    setSRuler({ ...r, ends });
  };
  const startMeasure = () => {
    const n = sPts ? sPts.length : 0;
    if (!residMode || !n) return;
    setSweepSt({ start: rawRuler().ends.find(e => e.pt != null).pt, count: 1, dt: Math.round(clampVal(2000 / n, 15, 60)) });
  };
  // The summary once every residual is drawn: Sum / Mean / Median of the raw, absolute, or
  // squared residuals, for the measured line and (when measuring to the ref line with LS
  // Line on) the LS line for comparison.
  const residSummary = (m, b) => {
    const v = sPts.map(p => { const r = p.y - (m * p.x + b); return measOf === "abs" ? Math.abs(r) : measOf === "sq" ? r * r : r; });
    if (!v.length) return NaN;
    if (measFn === "mean") return v.reduce((a, c) => a + c, 0) / v.length;
    if (measFn === "median") return quantile(v.slice().sort((a, c) => a - c), 0.5);
    return v.reduce((a, c) => a + c, 0);
  };
  const measLabel = (measFn === "sum" ? "Sum" : measFn === "mean" ? "Mean" : "Median") + " of "
    + (measOf === "abs" ? "absolute " : measOf === "sq" ? "squared " : "") + "residuals";
  const measVal = measDone && sLine ? residSummary(sLine.m, sLine.b) : NaN;
  // "Show optimal": the sum / mean of squared residuals is smallest for the LS line, of absolute
  // residuals for the LAD line. A median (or raw residuals) has no such line, so no toggle.
  const optAvail = measDone && measFn !== "median" && (measOf === "sq" || measOf === "abs");
  const optFit = optAvail && measOpt ? (measOf === "sq" ? ls : lad()) : null;
  const measOptVal = optFit ? residSummary(optFit.slope, optFit.intercept) : NaN;

  // Mechanic 3 (cat difference): up to two clicked stat specs; their live difference.
  const measureSelect = spec => setCatSel(prev => {
    const key = statKey(spec);
    const idx = prev.findIndex(s => statKey(s) === key);
    if (idx >= 0) return prev.filter((_, i) => i !== idx); // deselect
    const next = [...prev, spec];
    return next.length > 2 ? next.slice(next.length - 2) : next; // keep the last two
  });
  const measureRoleOf = spec => {
    if (!showCatRuler) return null;
    const i = catSel.findIndex(s => statKey(s) === statKey(spec));
    return i === 0 ? "A" : i === 1 ? "B" : null;
  };
  const catVals = catSel.map(s => computeStat(s, rows));
  const catDiff = catSel.length === 2 ? catVals[0] - catVals[1] : NaN;
  const fmtNum = v => (Number.isFinite(v) ? parseFloat(v.toFixed(4)) : "—");
  // Bundle handed to the categorical plots: the click-to-select handler + role lookup for
  // each number, plus the connector data (the two selected keys, their difference, and the
  // track affordance) so the read-out renders ON a line between the two cells.
  const measure = showCatRuler ? {
    select: measureSelect,
    roleOf: measureRoleOf,
    aKey: catSel[0] ? statKey(catSel[0]) : null,
    bKey: catSel[1] ? statKey(catSel[1]) : null,
    diff: catDiff,
    fmt: fmtNum,
    trackable: !!(trackable && onTrackDiff),
    onTrack: () => { if (catSel.length === 2) onTrackDiff({ spec: catSel[0] }, { spec: catSel[1] }); },
  } : null;

  // A numeric-detected variable can be flipped to plot as categories (and back): "123" while
  // numeric, "Aa" (highlighted) while treated as categories. Hidden for cat/time columns.
  const asCatChip = h => {
    if (!canAsCat(h)) return null;
    const on = asCat.includes(h);
    return (
      <button onClick={() => toggleAsCat(h)} aria-pressed={on}
        title={on ? `Plotting ${nm(h)} as categories — click to treat as numeric` : `Treat ${nm(h)} as categories (e.g. 0/1 codes or years)`}
        style={{ padding:"2px 7px", marginLeft:-4, border:"1px solid var(--border-2)", borderRadius:6,
          background: on ? "#6366f1" : "var(--surface)", color: on ? "#fff" : "var(--text-2)",
          fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>{on ? "Aa" : "123"}</button>
    );
  };

  // "Bins": group a numeric variable into equal-width intervals. While on, a bin-count and a
  // bin-width box (linked: typing one sets the other) sit beside it.
  const binChip = h => {
    if (!canAsCat(h)) return null;
    const b = binned[h], on = !!bins[h];
    return (<>
      <button onClick={() => toggleBins(h)} aria-pressed={on}
        title={on ? `Grouping ${nm(h)} into intervals — click to plot it as numbers` : `Group ${nm(h)} into equal-width intervals`}
        style={{ padding:"2px 7px", marginLeft:-4, border:"1px solid var(--border-2)", borderRadius:6,
          background: on ? "#6366f1" : "var(--surface)", color: on ? "#fff" : "var(--text-2)",
          fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>Bins</button>
      {on && b && (
        <span style={{ display:"inline-flex", gap:4, alignItems:"center", fontSize:12, color:"var(--text-2)" }}>
          <NumInput min={2} max={MAX_BINS} step={1} value={b.k} aria-label={`Number of bins for ${nm(h)}`}
            onChange={v => v >= 2 && setBins(s => ({ ...s, [h]: { n: Math.min(MAX_BINS, Math.round(v)) } }))} style={{ ...iSm, width:44 }} />
          bins, width
          <NumInput min={0} step="any" value={b.w} aria-label={`Bin width for ${nm(h)}`}
            onChange={v => v > 0 && setBins(s => ({ ...s, [h]: { w: v } }))} style={{ ...iSm, width:60 }} />
        </span>
      )}
    </>);
  };

  return (
    <div ref={plotRef} style={{ flex:"2 1 460px", minWidth:320 }}>
      {/* Controls */}
      <div style={{ display:"flex", gap:8, marginBottom:8, flexWrap:"wrap", alignItems:"center" }}>
        <Sel label="X" value={xVarIn} onChange={pickX} options={["none", ...headers]} labels={["— none —", ...headers.map(nm)]} />
        {!yOnly && asCatChip(xVar)}{!yOnly && binChip(xVar)}
        {yOnly
          ? <Sel label="Y" value={xVar} onChange={setYVar} options={headers} labels={headers.map(nm)} />
          : <Sel label="Y" value={yVar} onChange={setYVar} options={["none", ...headers.filter(h => h !== xVar)]} labels={["— none —", ...headers.filter(h => h !== xVar).map(nm)]} />}
        {yOnly ? <>{asCatChip(xVar)}{binChip(xVar)}</> : yVar !== "none" && <>{asCatChip(yVar)}{binChip(yVar)}</>}
        <label style={ctrlLbl}>dot size
          <input type="range" min={1} max={12} value={dotSize} onChange={e => setDotSize(+e.target.value)} style={{ width:55, marginLeft:4 }} />
        </label>
        <CopyImageButton targetRef={bodyRef} />
      </div>

      {/* Stat toggles — adapt to the variable types */}
      <div style={{ display:"flex", gap:10, marginBottom:8, flexWrap:"wrap", fontSize:12 }}>
        {showStatToggles && (
          <>
            <ChkLabel checked={showBox} onChange={setShowBox} label="Boxplot" />
            <ChkLabel checked={showMean} onChange={setShowMean} label="△ Mean" />
            <ChkLabel checked={showSD} onChange={setShowSD} label="↔ ±1 SD" />
            {((xNumeric && !bivariate) || (bivariate && (xNumeric !== yNumeric))) && <ChkLabel checked={showDensity} onChange={setShowDensity} label="∿ Density" />}
          </>
        )}
        {bivariate && xNumeric && yNumeric && (
          <ChkLabel checked={showLS} onChange={setShowLS} label="LS Line" />
        )}
        {refAvail && <ChkLabel checked={refOn} onChange={setRefOn} label="Ref line" />}
        {showCatToggles && (
          <>
            <ChkLabel checked={showCount} onChange={setShowCount} label="# Count" />
            <ChkLabel checked={showPct} onChange={setShowPct} label="Proportion" />
          </>
        )}
        {dividerAvailable && <ChkLabel checked={divOn} onChange={setDivOn} label="Divider" />}
        {rulerAvailable && <ChkLabel checked={rulerOn} onChange={setRulerOn} label="Ruler" />}
      </div>

      {/* Divider controls (Phase 6) — the read-outs themselves live on the plot */}
      {showDivider && (
        <div style={{ display:"flex", gap:12, marginBottom:10, flexWrap:"wrap", alignItems:"center", fontSize:12 }}>
          {/* Divider mode: Single (one cut) | Range (a band) | Multi (k cuts → k+1 bins). Switching
              re-seeds the cuts for the new mode and returns to value mode. */}
          <div style={{ display:"flex", border:"1px solid var(--border-2)", borderRadius:6, overflow:"hidden" }}>
            {[["single", "Single"], ["range", "↔ Range"], ["multi", "⫴ Multi"]].map(([val, lab]) => (
              <button key={val} onClick={() => switchDivMode(val)}
                style={{ padding:"3px 9px", border:"none", borderLeft: val === "single" ? "none" : "1px solid var(--border)",
                  background: divMode === val ? "#6366f1" : "var(--surface)", color: divMode === val ? "#fff" : "var(--text-2)",
                  fontSize:12, fontWeight:600, cursor:"pointer" }}>{lab}</button>
            ))}
          </div>
          {/* Single-divider tail direction: Both (two-sided) | ◂ Left | Right ▸. A tail focuses
              one side (arrow + one proportion → p-value / critical value). Switching framing
              returns to value mode so the % box re-reads the live proportion. */}
          {divSingle && (
            <div style={{ display:"flex", border:"1px solid var(--border-2)", borderRadius:6, overflow:"hidden" }}>
              {[["none", "Both"], ["left", "◂ Left"], ["right", "Right ▸"]].map(([val, lab]) => (
                <button key={val} onClick={() => { setDivDir(val); setDivBy("value"); }}
                  style={{ padding:"3px 9px", border:"none", borderLeft: val === "none" ? "none" : "1px solid var(--border)",
                    background: divDir === val ? "#6366f1" : "var(--surface)", color: divDir === val ? "#fff" : "var(--text-2)",
                    fontSize:12, fontWeight:600, cursor:"pointer" }}>{lab}</button>
              ))}
            </div>
          )}
          {/* Range framing: Middle (central band → CI) | Tails (outer regions → two-sided p-value).
              Switching returns to value mode so the % box re-reads the live proportion. */}
          {divRange && (
            <div style={{ display:"flex", border:"1px solid var(--border-2)", borderRadius:6, overflow:"hidden" }}>
              {[["middle", "Middle"], ["tails", "Tails"]].map(([val, lab]) => (
                <button key={val} onClick={() => { setDivBand(val); setDivBy("value"); }}
                  style={{ padding:"3px 9px", border:"none", borderLeft: val === "middle" ? "none" : "1px solid var(--border)",
                    background: divBand === val ? "#6366f1" : "var(--surface)", color: divBand === val ? "#fff" : "var(--text-2)",
                    fontSize:12, fontWeight:600, cursor:"pointer" }}>{lab}</button>
              ))}
            </div>
          )}
          {effCuts.map((v, i) => (
            <label key={i} style={ctrlLbl}>{divMulti ? i + 1 : divRange ? (i === 0 ? "low" : "high") : "at"}
              <NumInput step="any" value={v} round={4}
                onChange={n => setCut(i, n)} style={{ ...iSm, width:72, marginLeft:4 }} />
              {divMulti && effCuts.length > 2 && (
                <button onClick={() => removeCut(i)} style={btnX} title="Remove this cut">×</button>
              )}
            </label>
          ))}
          {/* Multi: add a cut (splits the widest gap) and respace all cuts at once — equal-width
              bins, or equal-count bins at the j/(k+1) quantiles. No tail/middle framing here. */}
          {divMulti && (
            <>
              {effCuts.length < MAX_CUTS && <button onClick={addCut} style={btnPlus}>＋ cut</button>}
              <span style={ctrlLbl}>Spacing
                <button onClick={() => spaceCuts("width")} style={{ ...btnNav, marginLeft:4 }} title="Bins of equal width across the data">Equal width</button>
                <button onClick={() => spaceCuts("count")} style={{ ...btnNav, marginLeft:4 }} title="Cuts at quantiles, so each bin holds about the same number of values">Equal count</button>
              </span>
            </>
          )}
          {/* Linked percentage: range → middle %, single tail → tail %. Editing it snaps the
              cut(s) to the empirical quantile (→ critical value / CI); reading it shows the
              proportion at the current cut (→ p-value). Hidden for a two-sided single divider. */}
          {(divRange || (divSingle && divDir !== "none")) && (
            <label style={{ ...ctrlLbl, color: divBy === "pct" ? "var(--accent-ink)" : undefined }}>{divRange ? (divBand === "tails" ? "tails" : "middle") : "tail"}
              <NumInput step="any" min="0" max="1" round={3}
                value={isNaN(shownPct) ? "" : shownPct}
                onChange={n => setPct(n)} style={{ ...iSm, width:64, marginLeft:4 }} />
            </label>
          )}
          <ChkLabel checked={divShowCount} onChange={setDivShowCount} label="# Count" />
          <ChkLabel checked={divShowPct} onChange={setDivShowPct} label="Proportion" />
        </div>
      )}

      {/* Ruler controls (Phase 6c) — typed endpoint values stay in sync with the drag;
          each endpoint shows whether it is anchored to a measure or a free value. */}
      {showRuler && (
        <div style={{ display:"flex", gap:12, marginBottom:10, flexWrap:"wrap", alignItems:"center", fontSize:12 }}>
          {effPts.map((p, i) => (
            <label key={i} style={ctrlLbl}>{i === 0 ? "A" : "B"}
              <NumInput step="any" value={p.value} round={4}
                onChange={n => setRulerPt(i, n)} style={{ ...iSm, width:72, marginLeft:4 }} />
              {p.spec && <span title="anchored — follows this measure as the data changes"
                style={{ marginLeft:4, padding:"1px 5px", borderRadius:4, background:"var(--ruler-soft)", color:"var(--ruler-text)", fontWeight:700, fontSize:12 }}>◎ {p.label}</span>}
            </label>
          ))}
          <span style={{ color:"var(--ruler-text)", fontWeight:700 }}>A − B = {parseFloat((effPts[0].value - effPts[1].value).toFixed(4))}</span>
        </div>
      )}

      {/* Ruler — vertical Δy ruler on the scatter (mechanic 2): Measure All + the summary */}
      {showResidRuler && (
        <div style={{ display:"flex", gap:12, marginBottom:10, flexWrap:"wrap", alignItems:"center", fontSize:12 }}>
          {!sLine && <span style={{ color:"var(--text-3)" }}>Turn on Ref line (or LS Line) to measure residuals.</span>}
          {sLine && (
            <button onClick={startMeasure} disabled={!residMode || !!(sweepSt && !measDone && sweep)} style={{ ...btnNav, opacity: residMode ? 1 : 0.5 }}
              title={residMode ? "Measure every point's residual, left to right from this one" : "Put one end on a data point and the other on the line first"}>
              Measure All</button>
          )}
          {sLine && !residMode && <span style={{ color:"var(--text-3)" }}>Drag A over a data point and B onto the {sLine.who === "ref" ? "reference" : "LS"} line above or below it to measure that point's residual.</span>}
          {measDone && (<>
            <Sel label="Summary" value={measFn} onChange={setMeasFn} options={["sum","mean","median"]} labels={["Sum","Mean","Median"]} />
            <Sel label="Of" value={measOf} onChange={setMeasOf} options={["raw","abs","sq"]} labels={["Residuals","Absolute residuals","Squared residuals"]} />
            {optAvail && <ChkLabel checked={measOpt} onChange={setMeasOpt} label="Show optimal" />}
          </>)}
          <button onClick={() => { setSweepSt(null); setSRuler(null); }} style={btnNav} title="Put A and B back where they started">Reset ruler</button>
        </div>
      )}

      {/* Reference line — equation inputs, Match LS, Reset */}
      {showRef && (
        <div style={{ display:"flex", gap:12, marginBottom:10, flexWrap:"wrap", alignItems:"center", fontSize:12 }}>
          <span style={{ color:"var(--purple-ink)", fontWeight:700 }}>ŷ =</span>
          <label style={ctrlLbl}>slope
            <NumInput step="any" value={refEff.m} round={4} onChange={setRefSlope} style={{ ...iSm, width:72, marginLeft:4 }} />
          </label>
          <label style={ctrlLbl}>intercept
            <NumInput step="any" value={refEff.yc - refEff.m * refXc} round={4} onChange={setRefIntercept} style={{ ...iSm, width:72, marginLeft:4 }} />
          </label>
          {ls && <button onClick={() => setRef({ yc: ls.slope * refXc + ls.intercept, m: ls.slope })} style={btnNav}
            title="Put the reference line on the least-squares line">Match LS</button>}
          {ls && <button onClick={() => { const f = lad(); if (f) setRef({ yc: f.slope * refXc + f.intercept, m: f.slope }); }} style={btnNav}
            title="Put the reference line on the least-absolute-deviations line (the smallest sum of absolute residuals). When several lines tie, it uses their average, which ties too.">Match LAD</button>}
          <button onClick={() => setRefLine(null)} style={btnNav} title="Reset: flat at the mean of y">Reset</button>
        </div>
      )}

      {/* Ruler — difference of two clicked numbers (mechanic 3, categorical). The read-out
          + ＋ track live ON the connector line over the plot; only a slim hint/clear here. */}
      {showCatRuler && (
        <div style={{ display:"flex", gap:10, marginBottom:10, flexWrap:"wrap", alignItems:"center", fontSize:12 }}>
          <span style={{ color:"var(--text-3)" }}>
            {catSel.length < 2
              ? "click two numbers on the table to compare them — a connector line shows A − B"
              : "A − B (and ＋ track) are shown on the connector line"}
          </span>
          {catSel.length > 0 && <button onClick={() => setCatSel([])} style={{ ...btnX, fontSize:12 }}>clear</button>}
        </div>
      )}

      {/* Click-to-track hint (suppressed while the cat-difference ruler claims clicks) */}
      {trackable && !showCatRuler && (
        <div style={{ fontSize:12, color:"var(--text-faint)", marginBottom:8 }}>
          Click a number on the plot to collect that statistic (click again to stop).
        </div>
      )}

      {/* Plot — rendering depends on variable types. Wrapped in bodyRef so the Copy-image
          button rasterizes just the plot (not the controls above). */}
      <div ref={bodyRef}>
      {(() => {
        // MODE 1: both categorical → grid of cells with stacked dots + count/%
        if (bivariate && !xNumeric && !yNumeric) {
          return <CatCatGrid rows={rows} levels={binLevels} xVar={xVar} yVar={yVar} nameOf={nameOf} R={R} width={W}
            showCount={showCount} showPct={showPct} expanded={expandCats} onToggleExpand={toggleExpand}
            {...trackProps} {...selProps} measure={measure} />;
        }
        // MODE 2: one categorical + one numeric → split dot plots by category.
        // Respect the axis choice: numeric-X stays horizontal; numeric-Y draws
        // vertical distributions side by side.
        if (bivariate && (xNumeric !== yNumeric)) {
          const catVar = xNumeric ? yVar : xVar;
          const numVar = xNumeric ? xVar : yVar;
          const numTime = xNumeric ? xTime : yTime;
          return <SplitDotPlots rows={rows} levels={binLevels} catVar={catVar} numVar={numVar} nameOf={nameOf} R={R} width={W} isTime={numTime}
            orientation={xNumeric ? "h" : "v"}
            showBox={showBox} showMean={showMean} showSD={showSD} showValues={showVals} showDensity={showDensity}
            expanded={expandCats} onToggleExpand={toggleExpand} {...trackProps} {...selProps} {...divProps} {...rulerProps} />;
        }
        // MODE 2b: Y only (X = none), numeric → one vertical dot plot (the split plot's
        // vertical layout with a single group: dots stack sideways off a numeric y axis)
        if (yOnly && xNumeric) {
          return <SplitDotPlots rows={rows} catVar={null} numVar={xVar} nameOf={nameOf} R={R} width={W} isTime={xTime}
            orientation="v" showBox={showBox} showMean={showMean} showSD={showSD} showValues={showVals} showDensity={showDensity}
            {...trackProps} {...selProps} />;
        }
        // MODE 3: single categorical → binned stacked-dot cells
        if (!bivariate && !xNumeric) {
          return <UniCatPlot rows={rows} levels={binLevels} catVar={xVar} nameOf={nameOf} R={R} width={W}
            showCount={showCount} showPct={showPct} expanded={expandCats} onToggleExpand={toggleExpand} {...trackProps} {...selProps}
            measure={measure} />;
        }
        // MODE 4: scatter (both numeric) or univariate numeric → SVG
        return (
          <svg width={W} height={H} role={trackable ? undefined : "img"}
            aria-label={(yS ? "Scatter plot of " + nm(yVar) + " versus " + nm(xVar) : "Dot plot of " + nm(xVar)) + " — " + dots.length + (yS ? " points" : " values")}
            style={{ display:"block", overflow:"visible", maxWidth:"100%" }}>
            {/* grid */}
            {xS.ticks.map((t, i) => <line key={"xg"+i} x1={sx(t)} y1={PT} x2={sx(t)} y2={PT + iH} stroke="var(--grid)" strokeWidth={1} />)}
            {yS && yS.ticks.map((t, i) => <line key={"yg"+i} x1={PL} y1={PT + iH - yS.scale(t)} x2={PL + iW} y2={PT + iH - yS.scale(t)} stroke="var(--grid)" strokeWidth={1} />)}
            {/* axes */}
            <line x1={PL} y1={PT + iH} x2={PL + iW} y2={PT + iH} stroke="var(--axis)" strokeWidth={1.5} />
            <line x1={PL} y1={PT} x2={PL} y2={PT + iH} stroke="var(--axis)" strokeWidth={1.5} />
            {/* x ticks */}
            {xS.ticks.map((t, i) => (
              <g key={"xt"+i}>
                <line x1={sx(t)} y1={PT + iH} x2={sx(t)} y2={PT + iH + 4} stroke="var(--axis)" />
                <text x={sx(t)} y={tickLblY} textAnchor={angleXTicks ? "end" : "middle"} fontSize={12} fill="var(--text-3)"
                  transform={angleXTicks ? "rotate(-35," + sx(t) + "," + tickLblY + ")" : undefined}>{xS.fmt(t)}</text>
              </g>
            ))}
            {/* y ticks */}
            {yS && yS.ticks.map((t, i) => (
              <g key={"yt"+i}>
                <line x1={PL - 4} y1={PT + iH - yS.scale(t)} x2={PL} y2={PT + iH - yS.scale(t)} stroke="var(--axis)" />
                <text x={PL - 7} y={PT + iH - yS.scale(t)} textAnchor="end" dominantBaseline="middle" fontSize={12} fill="var(--text-3)">{yS.fmt(t)}</text>
              </g>
            ))}
            {/* frequency y ticks (univariate numeric) — aligned to the stacked dot rows */}
            {freqAxis && freqAxis.ticks.map((f, i) => {
              const y = PT + iH - R - (f - 1) * freqAxis.spacing;
              return (
                <g key={"ft"+i}>
                  <line x1={PL - 4} y1={y} x2={PL} y2={y} stroke="var(--axis)" />
                  <text x={PL - 7} y={y} textAnchor="end" dominantBaseline="middle" fontSize={12} fill="var(--text-3)">{f}</text>
                </g>
              );
            })}
            {/* axis labels */}
            <text x={PL + iW / 2} y={H - 6} textAnchor="middle" fontSize={13} fill="var(--text-2)" fontWeight={600}>{nm(xVar)}</text>
            {yS && <text x={14} y={PT + iH / 2} textAnchor="middle" fontSize={13} fill="var(--text-2)" fontWeight={600} transform={"rotate(-90,14," + (PT + iH / 2) + ")"}>{nm(yVar)}</text>}
            {freqAxis && <text x={14} y={PT + iH / 2} textAnchor="middle" fontSize={13} fill="var(--text-2)" fontWeight={600} transform={"rotate(-90,14," + (PT + iH / 2) + ")"}>Frequency</text>}
            {/* divider shading — painted BEHIND the dots so dots stay visible + clickable */}
            {showDivider && <DividerShades topY={PT} botY={PT + iH} sx={sx} xlo={divDomain.lo} xhi={divDomain.hi} cuts={effCuts} dir={divSingle ? divDir : "none"} band={divRange ? divBand : "middle"} multi={divMulti} />}
            {/* dots — one per row; click toggles linked highlighting (D1) */}
            {dots.map((d, i) => {
              const sel = isSel(d.id);
              return <circle key={d.id || i} cx={d.x} cy={d.y} r={sel ? R + 1 : R}
                fill={sel ? "#f97316" : "#3b82f6"}
                fillOpacity={sel ? 1 : Math.min(0.85, Math.max(0.2, 70 / Math.sqrt(dots.length + 1)))}
                // hairline outline keeps each dot's boundary ≥3:1 (1.4.11) even at low fill opacity
                stroke={sel ? "#7c2d12" : "var(--dot-outline)"} strokeWidth={sel ? 1.5 : 0.75}
                style={selectable ? { cursor:"pointer" } : undefined}
                onClick={selectable && d.id ? () => onToggleSelect(d.id) : undefined} />;
            })}
            {/* Density curve — a Gaussian KDE (Silverman bandwidth) over the univariate-numeric
                data, x-aligned to the dots via `sx` and anchored to the axis baseline. */}
            {showDensity && xSummary && !bivariate && (() => {
              const curve = kdeCurve(xNums, xS.lo, xS.hi);
              if (!curve) return null;
              const peak = Math.max(...curve.map(p => p.y)) || 1;
              const h = iH * 0.9;
              const d = curve.map((p, i) => (i ? "L" : "M") + sx(p.x).toFixed(1) + " " + (PT + iH - (p.y / peak) * h).toFixed(1)).join(" ");
              return <path d={d} fill="none" stroke="var(--accent-ink)" strokeWidth={2} strokeOpacity={0.85} style={{ pointerEvents:"none" }} />;
            })()}
            {/* LS line */}
            {showLS && ls && yS && (() => {
              const x1 = xS.lo, x2 = xS.hi;
              const y1 = ls.slope * x1 + ls.intercept, y2v = ls.slope * x2 + ls.intercept;
              return (
                <g>
                  <line x1={sx(x1)} y1={PT + iH - yS.scale(y1)} x2={sx(x2)} y2={PT + iH - yS.scale(y2v)} stroke="#ef4444" strokeWidth={2} />
                  {trackable ? (
                    // Slope and intercept are individually clickable to track.
                    <g>
                      <TrackText x={PL + iW - 4} y={PT + 12} anchor="end" color="var(--red-ink)" fontSize={12}
                        label={"slope " + parseFloat(ls.slope.toFixed(3))}
                        spec={{ fn:"slope", variable:xVar, variable2:yVar }} {...trackProps} />
                      <TrackText x={PL + iW - 4} y={PT + 28} anchor="end" color="var(--red-ink)" fontSize={12}
                        label={"intercept " + parseFloat(ls.intercept.toFixed(3))}
                        spec={{ fn:"intercept", variable:xVar, variable2:yVar }} {...trackProps} />
                    </g>
                  ) : showVals && (
                    <text x={PL + iW - 4} y={PT + 12} textAnchor="end" fontSize={12} fill="var(--red-ink)" fontWeight={700}>
                      ŷ = {parseFloat(ls.slope.toFixed(3))}x + {parseFloat(ls.intercept.toFixed(3))} · R² = {parseFloat(ls.r2.toFixed(3))} · r = {parseFloat(ls.r.toFixed(3))}
                    </text>
                  )}
                </g>
              );
            })()}
            {/* ±1 SD bar — runs through the mean triangle, centred on the mean */}
            {showSD && xSummary && !bivariate && (() => {
              const loX = sx(xSummary.mean - xSummary.sd), hiX = sx(xSummary.mean + xSummary.sd), mx = sx(xSummary.mean);
              const labelX = Math.max(hiX, mx + 9) + 5; // keep the value clear of the triangle
              return (
                <g>
                  <line x1={loX} y1={sdBarY} x2={hiX} y2={sdBarY} stroke="var(--sd-mark)" strokeWidth={2} />
                  <line x1={loX} y1={sdBarY - 4} x2={loX} y2={sdBarY + 4} stroke="var(--sd-mark)" strokeWidth={2} />
                  <line x1={hiX} y1={sdBarY - 4} x2={hiX} y2={sdBarY + 4} stroke="var(--sd-mark)" strokeWidth={2} />
                  {showVals && <TrackText x={labelX} y={sdBarY + 3} anchor="start" color="var(--amber-ink)" fontSize={12}
                    label={"±1 SD = " + parseFloat(xSummary.sd.toFixed(2))} spec={{ fn:"sd", variable:xVar }} {...trackProps} />}
                </g>
              );
            })()}
            {/* Mean triangle — tip sits on the x-axis (the axis being averaged) */}
            {showMean && xSummary && !bivariate && (() => {
              const mx = sx(xSummary.mean);
              return (
                <g>
                  {/* the #059669 stroke is load-bearing for WCAG 1.4.11: the #10b981 fill alone
                      is only ~2.5:1 on a white surface, the darker outline lifts it past 3:1 */}
                  <polygon points={mx + "," + axisY + " " + (mx - 6) + "," + meanBaseY + " " + (mx + 6) + "," + meanBaseY} fill="#10b981" stroke="#059669" strokeWidth={1} />
                  {showVals && <TrackText x={mx} y={meanValY} anchor="middle" color="var(--green-ink)" fontSize={12}
                    label={fmtX(xSummary.mean)} spec={{ fn:"mean", variable:xVar }} {...trackProps} />}
                </g>
              );
            })()}
            {/* Boxplot (univariate numeric) — Tukey whiskers, separated below */}
            {showBox && xSummary && !bivariate && (
              <g>
                <line x1={sx(xSummary.whiskerLo)} y1={boxCy} x2={sx(xSummary.whiskerHi)} y2={boxCy} stroke="var(--box-line)" strokeWidth={1.5} />
                <line x1={sx(xSummary.whiskerLo)} y1={boxCy - 6} x2={sx(xSummary.whiskerLo)} y2={boxCy + 6} stroke="var(--box-line)" strokeWidth={1.5} />
                <line x1={sx(xSummary.whiskerHi)} y1={boxCy - 6} x2={sx(xSummary.whiskerHi)} y2={boxCy + 6} stroke="var(--box-line)" strokeWidth={1.5} />
                <rect x={sx(xSummary.q1)} y={boxCy - 9} width={Math.max(1, sx(xSummary.q3) - sx(xSummary.q1))} height={18} fill="rgba(99,102,241,0.18)" stroke="#6366f1" strokeWidth={1.5} />
                <line x1={sx(xSummary.median)} y1={boxCy - 9} x2={sx(xSummary.median)} y2={boxCy + 9} stroke="#6366f1" strokeWidth={2.5} />
                {showVals && <TrackText x={sx(xSummary.median)} y={medianValY} anchor="middle" color="var(--accent-ink)" fontSize={12}
                  label={fmtX(xSummary.median)} spec={{ fn:"median", variable:xVar }} {...trackProps} />}
              </g>
            )}
            {/* Divider tool (univariate numeric) */}
            {showDivider && (
              <>
                <DividerLines W={W} topY={PT} botY={PT + iH} sx={sx}
                  inv={px => xS.lo + ((px - PL) / iW) * (xS.hi - xS.lo)}
                  xlo={divDomain.lo} xhi={divDomain.hi} cuts={effCuts} onChange={onDivDrag}
                  snapCandidates={divDomain.snap} fmt={divDomain.fmt} dir={divSingle ? divDir : "none"} />
                {/* Directional single divider shows only the focused tail; its Count / Proportion
                    read-outs follow their checkboxes (no auto-on), matching the usual regions.
                    Range + Tails shows just the two inclusive tails (≤ lo, ≥ hi). */}
                <RegionLabels regions={divDirected && focusRegion ? [focusRegion] : divTailRegions || divRegions} sx={sx} xL={sx(divDomain.lo)} xR={sx(divDomain.hi)}
                  y={PT + 9} showCount={divShowCount} showPct={divShowPct} total={divDomain.values.length}
                  base={{ variable: xVar }} trackProps={trackProps} />
              </>
            )}
            {/* Ruler tool (univariate numeric) */}
            {showRuler && (
              <RulerOverlay W={W} topY={PT} botY={PT + iH} lineY={PT + 22} sx={sx}
                inv={px => xS.lo + ((px - PL) / iW) * (xS.hi - xS.lo)}
                xlo={divDomain.lo} xhi={divDomain.hi} pts={effPts} onChange={setRulerPts}
                snapCandidates={rulerSnap} fmt={divDomain.fmt} trackable={trackable} onTrackDiff={onTrackDiff}
                cutSnap={showDivider ? divDomain.snap : null}
                onCutDrag={showDivider ? (k, v) => { const next = effCuts.slice(); next[k] = v; onDivDrag(next); } : null} />
            )}
            {/* Scatter ruler, base layer: dotted guides + Measure All residuals */}
            {showResidRuler && (
              <ScatterRuler layer="base" line={sLine} measured={sweep} measSq={measOf === "sq"} nPts={sPts ? sPts.length : 0} sx={sx} toPy={toPy} W={W} res={sRes}
                area={{ x: PL, y: PT, w: iW, h: iH }} clipId={rulerClipId} onDrag={onRulerDrag} />
            )}
            {/* Movable reference line (scatter) — above the ruler's capture area */}
            {showRef && (
              <RefLineOverlay line={refEff} xc={refXc} box={{ xlo: xS.lo, xhi: xS.hi, ylo: yS.lo, yhi: yS.hi }}
                sx={sx} toPy={toPy} W={W} invX={invX} invY={invY} onChange={setRef} />
            )}
            {/* Scatter ruler, top layer: the ruler and its handles win over the ref line's */}
            {showResidRuler && (
              <ScatterRuler layer="top" res={sRes} residMode={residMode} sx={sx} toPy={toPy} W={W}
                area={{ x: PL, y: PT, w: iW, h: iH }} onDrag={onRulerDrag}
                fmtY={v => f3(v)} />
            )}
            {measDone && Number.isFinite(measVal) && (
              <text x={PL + 6} y={PT + (showRef ? 29 : 13)} fontSize={12} fontWeight={800} fill="var(--ruler-text)" style={{ pointerEvents:"none" }}>
                {measLabel} = {f3(measVal)}
                {Number.isFinite(measOptVal) && <tspan fill="var(--red-ink)" fontWeight={700}>{"   " + (measOf === "sq" ? "LS" : "LAD")
                  + " line: " + f3(measOptVal) + " (smallest possible)"}</tspan>}
              </text>
            )}
            {showRef && (() => {
              const bb = refEff.yc - refEff.m * refXc;
              return <text x={PL + 6} y={PT + 13} fontSize={12} fontWeight={700} fill="var(--purple-ink)" style={{ pointerEvents:"none" }}>
                ref ŷ = {f3(refEff.m)}x {bb < 0 ? "−" : "+"} {f3(Math.abs(bb))}
              </text>;
            })()}
          </svg>
        );
      })()}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// DERIVED-STATISTIC FORMULAS (Collect Statistics) — the same persistent-row behaviour as
// the EDA / Sample Results formula panel: "＋ formula" adds a row, and every derived
// column stays listed as an editable  name = formula  row. Formulas use the collected
// columns' letters (A, B, …) plus numbers, + − × ÷ ^ ( ) abs sqrt round log exp (lib/expr.js).
// A valid formula commits on Enter / blur / menu insert: a new row becomes a column, an
// edited row refills its column for every collected row (no re-sampling). An invalid
// edit shows an error and the column keeps its last valid formula.
// Every formula is worked out row by row over the collected table, so the result is always
// a column (there is no single-value case here, unlike the within-sample formula panel).
//   columns: [{ id, label }]   plain tracked stats
//   derived: the derived tracked stats { id, tokens, inputs, name? }
//   onAdd(tokens, inputIds, name, id) · onUpdate(id, tokens, inputIds) · onRename(id, name) · onRemove(id)
// ══════════════════════════════════════════════════════════════════════════════
const OP_TXT = { "+": " + ", "-": " - ", "*": " * ", "/": " / ", "^": "^" };
// A stored formula as typed text, using the columns' current letters.
function tokensToText(tokens, aliasOf) {
  return (tokens || []).map(t => t.k === "num" ? String(t.v) : t.k === "col" ? (aliasOf[t.id] || "?")
    : t.k === "op" ? (OP_TXT[t.v] || t.v) : t.k === "fn" ? t.v : t.k === "lp" ? "(" : t.k === "rp" ? ")" : t.k === "comma" ? ", " : "").join("");
}

function DerivedBuilder({ columns, derived = [], onAdd, onUpdate, onRename, onRemove }) {
  // A row added with ＋ formula that isn't a column yet: { id, name }. Its id is reused
  // for the column it becomes, so the row (and its caret) survives that switch.
  const [draft, setDraft] = useState(null);
  const colIds = columns.map(c => c.id).join(",");
  const aliasOf = useMemo(() => {
    const m = {}; columns.forEach((c, i) => { m[c.id] = aliasFor(i); }); return m;
  }, [colIds]);
  const aliasToId = useMemo(() => {
    const m = {}; columns.forEach((c, i) => { m[aliasFor(i)] = c.id; }); return m;
  }, [colIds]);
  useEffect(() => { if (!columns.length) setDraft(null); }, [columns.length]);

  const parse = text => {
    const { tokens, ok } = lexExpr(text, aliasToId);
    const structOk = validateExpr(tokens);
    return { tokens, lexOk: ok, structOk, valid: text.trim().length > 0 && ok && structOk };
  };
  const inputsOf = tokens => [...new Set(tokens.filter(t => t.k === "col").map(t => t.id))];
  const chips = columns.map(c => ({ key: c.id, letter: aliasOf[c.id], name: c.label, insert: aliasOf[c.id],
    desc: `Inserts ${aliasOf[c.id]}, the collected column ${c.label}: one value per collected sample.` }));

  const rows = [
    ...derived.map(s => ({ id: s.id, text: tokensToText(s.tokens, aliasOf), name: s.name || "", isDraft: false })),
    ...(draft ? [{ id: draft.id, text: "", name: draft.name, isDraft: true }] : []),
  ];
  const commitText = (row, text, name) => {
    const p = parse(text);
    if (!p.valid) return;
    if (row.isDraft) { onAdd(p.tokens, inputsOf(p.tokens), (name || "").trim(), row.id); setDraft(null); }
    else onUpdate(row.id, p.tokens, inputsOf(p.tokens));
  };
  const rename = (row, name) => {
    if (row.isDraft) setDraft(d => d && { ...d, name });
    else if (name.trim() !== row.name) onRename(row.id, name.trim());
  };
  const remove = row => { if (row.isDraft) setDraft(null); else onRemove(row.id); };

  return (
    <div>
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:2 }}>
        <div style={{ fontSize:12, fontWeight:700, color:"var(--text-3)", letterSpacing:1, textTransform:"uppercase" }}>Formulas</div>
        <button onClick={() => { if (!draft) setDraft({ id: uid(), name: "" }); }} disabled={!columns.length}
          title={columns.length ? "Combine collected columns into a new column" : "Track a statistic first"}
          style={{ ...btnPlus, color:"var(--accent-ink)", cursor:columns.length ? "pointer" : "not-allowed", opacity:columns.length ? 1 : 0.5 }}>＋ formula</button>
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize:12, color:"var(--text-faint)" }}>
          {columns.length
            ? <>Add a formula to combine collected columns into a new column (like <code>A - B</code> for a difference of means). It fills in every collected row at once, with no re-sampling.</>
            : <>Track at least one statistic first, then add a formula to combine collected columns (like <code>A - B</code> for a difference of two means).</>}
        </div>
      ) : rows.map(row => (
        <DerivedRow key={row.id} row={row} chips={chips} parse={parse}
          multi={columns.length > 1} autoFocus={row.isDraft}
          onCommitText={(t, n) => commitText(row, t, n)} onRename={n => rename(row, n)} onRemove={() => remove(row)} />
      ))}
    </div>
  );
}

function DerivedRow({ row, chips, parse, multi, autoFocus, onCommitText, onRename, onRemove }) {
  const [text, setText] = useState(row.text);
  const [name, setName] = useState(row.name);
  const [menuOpen, setMenuOpen] = useState(!!autoFocus);
  const rowRef = useRef(null);
  const inputRef = useRef(null);
  const selRef = useRef(null);
  const focused = useRef(false);
  // Follow the stored formula (e.g. letters shifting after a column is removed) unless
  // the student is mid-edit in the field.
  useLayoutEffect(() => { if (!focused.current) setText(row.text); }, [row.text]);
  useLayoutEffect(() => { setName(row.name); }, [row.name]);
  useEffect(() => { if (autoFocus && inputRef.current) inputRef.current.focus(); }, []);
  const noteSel = e => { selRef.current = { s: e.currentTarget.selectionStart, e: e.currentTarget.selectionEnd }; };
  // Blurring into this row's own controls (the ƒx menu) isn't a commit; the insert commits.
  const leavingRow = e => !(e.relatedTarget && rowRef.current && rowRef.current.contains(e.relatedTarget));
  const commit = t => onCommitText(t, name);

  // Insert at the remembered caret (wrapping a selection), commit, and put the caret back.
  const insert = (open, close = "") => {
    const sel = selRef.current || { s: text.length, e: text.length };
    const s = Math.min(sel.s, text.length), e = Math.min(Math.max(sel.e, s), text.length);
    const mid = text.slice(s, e);
    const next = text.slice(0, s) + open + mid + close + text.slice(e);
    const p = s + open.length + mid.length + (mid ? close.length : 0);
    selRef.current = { s: p, e: p };
    setText(next);
    commit(next);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      try { el.setSelectionRange(p, p); } catch { /* not focusable here */ }
    });
  };

  const p = parse(text);
  const summaryFn = (text.match(/\b(mean|median|sd|sum|count|min|max|q1|q3|if|join)\s*\(/i) || [])[1];
  const msg = !text.trim() ? null
    : summaryFn && !p.lexOk ? (/^(if|join)$/i.test(summaryFn)
      ? `${summaryFn.toLowerCase()}() isn't available here: these formulas stay numeric`
      : `${summaryFn.toLowerCase()}() isn't available here: each row is one sample, so a summary of the column belongs on the Collect plot`)
    : !p.lexOk ? "Unrecognised symbol: use the column letters, numbers, + − × ÷ ^ ( ) and abs sqrt round log exp"
    : !p.structOk ? "Incomplete formula" : null;
  const stale = !row.isDraft && !p.valid; // the column keeps its last valid formula
  return (
    <div ref={rowRef} style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap", padding:"5px 0", borderBottom:"1px solid var(--border)" }}>
      <input value={name} onChange={e => setName(e.target.value)}
        onBlur={() => { if (name !== row.name) onRename(name); }}
        onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setName(row.name); }}
        placeholder="name" aria-label="Derived column name (optional)" title="Optional: defaults to the formula"
        style={{ ...iSm, width:90, fontWeight:700 }} />
      <span style={{ color:"var(--text-3)", fontSize:13 }}>=</span>
      <input ref={inputRef} value={text} spellCheck={false} aria-label="Derived statistic formula"
        placeholder={multi ? "e.g. A - B" : "e.g. 2 * A"}
        onChange={e => { setText(e.target.value); noteSel(e); }}
        onSelect={noteSel}
        onFocus={() => { focused.current = true; }}
        onBlur={e => { focused.current = false; if (leavingRow(e)) commit(text); }}
        onKeyDown={e => {
          if (e.key === "Enter") { e.preventDefault(); commit(text); }
          if (e.key === "Escape") { setText(row.text); e.currentTarget.blur(); }
        }}
        style={{ ...iSm, flex:"1 1 180px", minWidth:140, fontFamily:"ui-monospace, Consolas, monospace",
          ...(msg ? { border:"1px solid #fca5a5" } : null) }} />
      <button onClick={() => setMenuOpen(o => !o)} aria-expanded={menuOpen} aria-label="Columns and functions menu"
        title="Insert a column, function or operator"
        style={{ ...btnPlus, fontStyle:"italic", fontWeight:700, color:"var(--accent-ink)", background: menuOpen ? "var(--xsel-cell)" : undefined }}>ƒx</button>
      <span style={{ flex:"0 0 auto", minWidth:110, fontSize:12 }} aria-live="polite">
        {!text.trim() ? <span style={{ color:"var(--text-faint)" }}>type a formula</span>
          : msg ? <span role="alert" style={{ color:"var(--red-ink, #b91c1c)" }}>{msg}{stale ? " (the column keeps its last formula)" : ""}</span>
          : <span style={{ color:"var(--green-ink)" }} title="Worked out for every collected row, so it's a new column in the table">→ new column</span>}
      </span>
      <button title="Delete formula" aria-label={`Delete formula ${row.name || row.text || "draft"}`} onClick={onRemove} style={{ ...btnX }}>×</button>
      {menuOpen && <FormulaMenu chips={chips} onInsert={insert} groups={DERIVED_FN_GROUPS}
        chipsTitle="Collected columns · type the letter" />}
    </div>
  );
}

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// DISTRIBUTION PLOT \u2014 sampling-distribution view over collected-statistic columns.
// Each column is one tracked statistic's accumulated values;
// the shared Plot's X selector doubles as the column selector and its overlay
// toggles (mean/SD/box) apply to the chosen distribution. Replaces the old
// StatDistPlot small-multiples with one EDA-grade, selectable plot.
//   columns: [{ label, values:number[] }]  (one value per repetition/sample)
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// Scroll a table row (tagged `data-rowid`) into view within its own scroll container,
// accounting for the sticky header. Only nudges the container's own scrollTop — never
// the page. Used to reveal the row a just-clicked plot dot highlights.
function scrollRowIntoView(container, id) {
  if (!container || id == null) return;
  const row = container.querySelector(`[data-rowid="${String(id).replace(/"/g, '\\"')}"]`);
  if (!row) return;
  const cRect = container.getBoundingClientRect();
  const rRect = row.getBoundingClientRect();
  const bTop = parseFloat(getComputedStyle(container).borderTopWidth) || 0;
  const head = container.querySelector("thead");
  const headH = head ? head.offsetHeight : 0;
  // Visible band excludes the sticky header (top) and a horizontal scrollbar, if any
  // (bottom) — clientHeight omits the scrollbar, so a wide table's bottom bar no longer
  // covers the row we just revealed.
  const visTop = cRect.top + bTop + headH;
  const visBottom = cRect.top + bTop + container.clientHeight;
  if (rRect.top < visTop) container.scrollTop -= (visTop - rRect.top);
  else if (rRect.bottom > visBottom) container.scrollTop += (rRect.bottom - visBottom);
}

function DistributionPlot({ columns, width, rowIds, selectedIds, onToggleSelect, onDivider, onOverlays, initialView, onViewChange }) {
  // Disambiguate any repeated labels so each column is a distinct header/key
  // (tracked stats are already unique; custom names may collide).
  const headers = useMemo(() => {
    const out = [], seen = {};
    columns.forEach(c => {
      if (seen[c.label]) out.push(c.label + " (" + (++seen[c.label]) + ")");
      else { seen[c.label] = 1; out.push(c.label); }
    });
    return out;
  }, [columns.map(c => c.label).join("")]);

  // Seed xVar from a saved STAT ID → its current display label (ids survive renames; a label
  // gets a " (2)" collision suffix). Idiom mirrors handleDivider's headers.indexOf ↔ columns[k].
  const [xVar, setXVar] = useState(() => {
    const id = initialView?.xVar;
    if (id) { const k = columns.findIndex(c => c.id === id); if (k >= 0 && headers[k]) return headers[k]; }
    return headers[0] || "";
  });
  const [yVar, setYVar] = useState(() => initialView?.yVar ?? "none");
  // Combined view reported up for Save/Open (Phase 4). Collect has no host-level selection (it's
  // App's collectSelectedIds prop), so only xVar/yVar/plot travel; xVar → stat id on the way out.
  const [plotView, setPlotView] = useState(() => initialView?.plot ?? null);
  useEffect(() => {
    if (!onViewChange) return;
    const k = headers.indexOf(xVar);
    onViewChange({ xVar: k >= 0 && columns[k] ? columns[k].id : null, yVar, plot: plotView });
  }, [onViewChange, headers, columns, xVar, yVar, plotView]);

  // One row per repetition; non-finite stat values (e.g. an empty group in a
  // small/without-replacement sample) become blank so the plot skips them.
  const rows = useMemo(() => {
    const len = Math.max(0, ...columns.map(c => c.values.length));
    const out = [];
    for (let i = 0; i < len; i++) {
      // `_id` ties each plotted point to its collected-statistics row (same index)
      // for linked highlighting; falls back to the index when no ids are supplied.
      const o = { _id: (rowIds && rowIds[i]) != null ? rowIds[i] : i };
      columns.forEach((c, k) => {
        const v = c.values[i];
        o[headers[k]] = (typeof v === "number" && isFinite(v)) ? v : "";
      });
      out.push(o);
    }
    return out;
  }, [columns, headers, rowIds]);

  // Translate the divider's X header back to its column id (a tracked-stat id) so the host
  // can match it to the generated code's statistic. `headers[k]` ↔ `columns[k]` by index.
  const handleDivider = useCallback(d => {
    if (!onDivider) return;
    if (!d) { onDivider(null); return; }
    const k = headers.indexOf(d.variable);
    onDivider({ statId: k >= 0 && columns[k] ? columns[k].id : null, cuts: d.cuts, mode: d.mode, range: d.range, dir: d.dir, by: d.by, pct: d.pct, band: d.band, bounds: d.bounds });
  }, [onDivider, headers, columns]);

  // Same header→stat-id translation for the summary overlays.
  const handleOverlays = useCallback(o => {
    if (!onOverlays) return;
    if (!o) { onOverlays(null); return; }
    const k = headers.indexOf(o.variable);
    onOverlays({ statId: k >= 0 && columns[k] ? columns[k].id : null, mean: o.mean, sd: o.sd, box: o.box });
  }, [onOverlays, headers, columns]);

  if (!columns.length) return null;
  return <Plot rows={rows} headers={headers} xVar={xVar} yVar={yVar} setXVar={setXVar} setYVar={setYVar} width={width}
    selectedIds={selectedIds} onToggleSelect={onToggleSelect} onDivider={onDivider ? handleDivider : undefined}
    onOverlays={onOverlays ? handleOverlays : undefined}
    initialView={initialView?.plot} onViewChange={setPlotView} />;
}

// ══════════════════════════════════════════════════════════════════════════════
// EDA PLOT — exploratory plot with toggleable statistics overlays
// ══════════════════════════════════════════════════════════════════════════════
// `formulas` / `formulaResult` (optional): the dataset's formulas and their applied result
// (lib/formula.js applyFormulas, computed once in App so the sampler's Fill-from-data sees the
// same columns). Column formulas show as read-only table columns and are plottable; summary
// formulas show once in the Formulas panel.
function EDAPlot({ rows, headers, onChange, formulas, formulaResult, onFormulasChange, initialView, onViewChange }) {
  // X/Y selection lives here so the sibling DataTable can highlight the chosen
  // columns; the Plot owns dot size + overlay toggles. (Plot keeps X/Y valid.)
  // `initialView` (optional, from an opened session) seeds these; each falls back
  // to its original default via `??`, so a host without it is byte-identical.
  const [xVar, setXVar] = useState(() => initialView?.xVar ?? (headers[0] || ""));
  const [yVar, setYVar] = useState(() => initialView?.yVar ?? "none");

  // Linked highlighting (D1): a shared set of selected row `_id`s, toggled by
  // clicking a plot dot or a table row, highlighting both together. On select, a
  // `scrollTarget` nudges the table to reveal the just-highlighted row.
  const [selectedIds, setSelectedIds] = useState(() => new Set(initialView?.selectedIds || []));
  const [scrollTarget, setScrollTarget] = useState(null);
  // Raw plot-toggle blob reported up from the inner Plot; combined with this host's
  // xVar/yVar/selectedIds and reported to App for Save/Open (Phase 4).
  const [plotView, setPlotView] = useState(() => initialView?.plot ?? null);
  // An optional second plot of the same data (its own X/Y and toggles) sharing the
  // selection, so clicking a dot in either plot or a table row highlights it everywhere —
  // e.g. compare where the same cases fall on two variables. `second` is its saved
  // { xVar, yVar, plot } (null = only one plot).
  const [second, setSecond] = useState(() => initialView?.second ?? null);
  const setX2 = v => setSecond(s => s && { ...s, xVar: typeof v === "function" ? v(s.xVar) : v });
  const setY2 = v => setSecond(s => s && { ...s, yVar: typeof v === "function" ? v(s.yVar) : v });
  const setPlot2 = useCallback(v => setSecond(s => s && { ...s, plot: v }), []);
  const addSecond = () => setSecond({ xVar: headers[1] || headers[0] || "", yVar: "none", plot: null });
  useEffect(() => {
    if (!onViewChange) return;
    onViewChange({ xVar, yVar, selectedIds: [...selectedIds], plot: plotView, second });
  }, [onViewChange, xVar, yVar, selectedIds, plotView, second]);
  const toggleId = id => {
    const adding = !selectedIds.has(id);
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    if (adding) setScrollTarget({ id });
  };

  // The table is editable whenever the host supplies an onChange (EDA's single
  // dataset slot — both uploaded CSVs and manually-entered data flow back up).
  const editable = !!onChange;
  const fList = formulas || [];
  const fResults = (formulaResult && formulaResult.results) || [];
  const fCols = fResults.filter(r => r.kind === "column");
  // Plot over data + column formulas. (A formula column's key is its name in EDA.)
  const plotRows = formulaResult && fCols.length ? formulaResult.rows : rows;
  const plotHeaders = fCols.length ? [...headers, ...fCols.map(c => c.key)] : headers;
  // A renamed data column carries its new name into every formula that uses it, and the
  // X/Y selection follows it. (DataTable reports a rename as a same-length header list with
  // one entry changed.)
  const handleChange = (nh, nr) => {
    if (onFormulasChange && fList.length && nh.length === headers.length) {
      const diff = nh.map((h, i) => h !== headers[i] ? i : -1).filter(i => i >= 0);
      if (diff.length === 1 && !nh.includes(headers[diff[0]])) {
        const oldN = headers[diff[0]], newN = nh[diff[0]];
        onFormulasChange(fList.map(f => ({ ...f, text: renameInFormula(f.text, oldN, newN, [...headers, ...fList.map(x => x.name)]) })));
      }
    }
    if (nh.length === headers.length) {
      const i = headers.indexOf(xVar); if (i >= 0 && nh[i] !== xVar) setXVar(nh[i]);
      const j = headers.indexOf(yVar); if (j >= 0 && nh[j] !== yVar) setYVar(nh[j]);
      if (second) {
        const a = headers.indexOf(second.xVar), b = headers.indexOf(second.yVar);
        if (a >= 0 && nh[a] !== second.xVar) setX2(nh[a]);
        if (b >= 0 && nh[b] !== second.yVar) setY2(nh[b]);
      }
    }
    onChange(nh, nr);
  };
  // Renaming a formula that is plotted keeps the plot on it.
  const handleFormulas = next => {
    const ren = Object.fromEntries(fList.map(f => { const n = next.find(x => x.id === f.id); return [f.name, n ? n.name : null]; }));
    if (ren[xVar]) setXVar(ren[xVar]);
    if (ren[yVar]) setYVar(ren[yVar]);
    if (second && ren[second.xVar]) setX2(ren[second.xVar]);
    if (second && ren[second.yVar]) setY2(ren[second.yVar]);
    onFormulasChange(next);
  };
  if (!rows.length && !editable) return <div style={{ color:"var(--text-faint)", padding:24, textAlign:"center" }}>No data loaded.</div>;

  return (
    <div style={{ display:"flex", gap:14, flexWrap:"wrap", alignItems:"flex-start" }}>
      {/* LEFT: data viewer / editor, then the formulas that extend it */}
      <div style={{ flex:"1 1 240px", minWidth:200, maxWidth:420 }}>
        <DataTable rows={rows} headers={headers} xVar={xVar} yVar={yVar} editable={editable} onChange={handleChange}
          selectedIds={selectedIds} onToggleSelect={toggleId} scrollTarget={scrollTarget}
          formulaCols={fCols} computedRows={formulaResult && formulaResult.rows} />
        {onFormulasChange && (
          <FormulaPanel formulas={fList} results={fResults} colNames={headers} onChange={handleFormulas} />
        )}
      </div>
      {/* RIGHT: shared interactive plot(s) — a second plot links through the same selection */}
      <div style={{ flex:"2 1 460px", minWidth:320 }}>
        <Plot rows={plotRows} headers={plotHeaders} xVar={xVar} yVar={yVar} setXVar={setXVar} setYVar={setYVar}
          selectedIds={selectedIds} onToggleSelect={toggleId}
          initialView={initialView?.plot} onViewChange={setPlotView} />
        {second ? (
          <div style={{ marginTop:14, paddingTop:12, borderTop:"1px solid var(--border)" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
              <span style={{ fontSize:12, color:"var(--text-3)" }}>Plot 2 — click a dot in either plot (or a table row) to highlight that case in both.</span>
              <button onClick={() => setSecond(null)} style={btnNav} title="Remove the second plot">× Remove plot</button>
            </div>
            <Plot rows={plotRows} headers={plotHeaders} xVar={second.xVar} yVar={second.yVar} setXVar={setX2} setYVar={setY2}
              selectedIds={selectedIds} onToggleSelect={toggleId}
              initialView={second.plot} onViewChange={setPlot2} />
          </div>
        ) : rows.length > 0 && (
          <button onClick={addSecond} style={{ ...btnNav, marginTop:10 }} title="Add a second plot of this data; selections highlight in both">＋ Add plot</button>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SAMPLE RESULTS — mirrors the EDA layout (table left, shared Plot right) for the
// raw draws of a sampler run. The table is chronological: newest rows append at
// the BOTTOM and the scroll view auto-follows as draws stream in.
// ══════════════════════════════════════════════════════════════════════════════
// `computedCols` (optional): formula columns ({ key, numeric }) among `varNames` — shown
// italic and number-formatted in the Draws table (their values are computed, not drawn).
function SampleResults({ sampleData, varNames, varKinds, nameOf, onTrackStat, onTrackDiff, trackedStats, initialView, onViewChange, computedCols }) {
  // `varNames` are device IDS (the plot/table headers); `nameOf(id)` resolves the
  // display name. `nm` falls back to identity so this still works if no map is passed.
  // `initialView` (optional) seeds the view for Save/Open; xVar here is a column id, so it
  // persists verbatim (ids survive renames).
  const nm = nameOf || (h => h);
  const [xVar, setXVar] = useState(() => initialView?.xVar ?? (varNames[0] || ""));
  const [yVar, setYVar] = useState(() => initialView?.yVar ?? "none");
  const scrollRef = useRef(null);
  const trackedKeys = useMemo(() => new Set((trackedStats || []).map(statKey)), [trackedStats]);

  // Linked highlighting (D1): clicking a draw-dot or a Draws-table row highlights both.
  // Keyed by each draw's stable `_id`; on select, scroll the row into view.
  const [selectedIds, setSelectedIds] = useState(() => new Set(initialView?.selectedIds || []));
  const [scrollTarget, setScrollTarget] = useState(null);
  // Combined host+plot view reported up for Save/Open (Phase 4).
  const [plotView, setPlotView] = useState(() => initialView?.plot ?? null);
  useEffect(() => {
    if (!onViewChange) return;
    onViewChange({ xVar, yVar, selectedIds: [...selectedIds], plot: plotView });
  }, [onViewChange, xVar, yVar, selectedIds, plotView]);
  const toggleId = id => {
    const adding = !selectedIds.has(id);
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    if (adding) setScrollTarget({ id });
  };
  const isSel = id => selectedIds.has(id);

  // Auto-scroll the table to the bottom as new draws arrive
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sampleData.length]);
  // Reveal the row whose dot was just clicked
  useEffect(() => { scrollRowIntoView(scrollRef.current, scrollTarget && scrollTarget.id); }, [scrollTarget]);

  if (!sampleData.length) {
    return <div style={{ color:"var(--text-faint)", textAlign:"center", padding:24 }}>Press "Draw Sample" to begin</div>;
  }

  const cols = ["_sample", ...varNames];
  const computed = Object.fromEntries((computedCols || []).map(c => [c.key, c]));
  const cellText = (c, v) => computed[c] && computed[c].numeric && v !== "" && v !== undefined ? fmtFormulaVal(Number(v)) : v;
  const HL = "var(--highlight)"; // selected-row highlight (amber); overrides column tint
  const cellColor = c => c === "_sample" ? "var(--text-faint)" : (c === xVar ? "var(--accent-ink)" : (c === yVar ? "var(--green-ink)" : "var(--text)"));
  const cellBg = (c, sel) => sel ? HL : (c === xVar ? "var(--xsel-cell)" : (c === yVar ? "var(--ysel-cell)" : "transparent"));

  return (
    <div style={{ display:"flex", gap:14, flexWrap:"wrap", alignItems:"flex-start" }}>
      {/* LEFT: data table (chronological, auto-scrolling) */}
      <div style={{ flex:"1 1 240px", minWidth:200, maxWidth:340 }}>
        <div style={{ fontSize:12, fontWeight:700, color:"var(--text-3)", letterSpacing:1, textTransform:"uppercase", marginBottom:8 }}>Draws</div>
        <div ref={scrollRef} style={{ maxHeight:300, overflow:"auto", border:"1px solid var(--border)", borderRadius:8 }}>
          <table style={{ borderCollapse:"collapse", fontSize:12, width:"100%" }}>
            <caption className="sr-only">Raw draws — one row per draw, one column per sampler variable.</caption>
            <thead>
              <tr>
                {cols.map(c => (
                  <th key={c} scope="col" style={{ position:"sticky", top:0, background: c === xVar ? "var(--xsel-head)" : (c === yVar ? "var(--ysel-head)" : "var(--surface-2)"), color: c === "_sample" ? "var(--text-faint)" : "var(--text)", fontWeight: c === "_sample" ? 600 : 700, padding:"4px 8px", textAlign: c === "_sample" ? "right" : "left", borderBottom:"1px solid var(--border)", whiteSpace:"nowrap" }}>{c === "_sample" ? "#" : (computed[c] ? <><span style={{ color:"var(--accent-ink)", marginRight:3 }}>ƒ</span><i>{nm(c)}</i></> : nm(c))}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sampleData.map((row, i) => {
                const sel = isSel(row._id);
                return (
                <tr key={row._id || i} data-rowid={row._id} aria-selected={sel} onClick={() => toggleId(row._id)} style={{ borderBottom:"1px solid var(--border)", cursor:"pointer" }}>
                  {cols.map(c => (
                    <td key={c} style={{ padding:"3px 8px", color:cellColor(c), background:cellBg(c, sel), textAlign: c === "_sample" || (computed[c] && computed[c].numeric) ? "right" : "left", fontStyle: computed[c] ? "italic" : undefined, whiteSpace:"nowrap", maxWidth:120, overflow:"hidden", textOverflow:"ellipsis" }}>{cellText(c, row[c])}</td>
                  ))}
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {/* RIGHT: shared interactive plot */}
      <Plot rows={sampleData} headers={varNames} nameOf={nameOf} xVar={xVar} yVar={yVar} setXVar={setXVar} setYVar={setYVar}
        varKinds={varKinds} onTrackStat={onTrackStat} onTrackDiff={onTrackDiff} trackedKeys={trackedKeys}
        selectedIds={selectedIds} onToggleSelect={toggleId}
        initialView={initialView?.plot} onViewChange={setPlotView} />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// DATA TABLE — scrollable view of the raw rows; X/Y columns highlighted
// ══════════════════════════════════════════════════════════════════════════════

const WIN_ROWS = 500, WIN_COLS = 25; // initial render window; grows as you scroll (RStudio-style)

// `formulaCols` (optional): column formulas ({ key, name, numeric }) shown read-only after
// the data columns; their values come from `computedRows` (index-aligned with `rows`). The
// editing helpers only ever touch `rows`/`headers`, so a formula value is never written back.
function DataTable({ rows, headers, xVar, yVar, editable = false, onChange, selectedIds, onToggleSelect, scrollTarget, formulaCols = [], computedRows }) {
  // Windowed rendering (no virtualization library): a large CSV would otherwise paint every
  // row × column at once and stall. Render only the first WIN_ROWS × WIN_COLS, appending a
  // page as the user scrolls toward an edge. Edit/select helpers still operate on the full
  // arrays (by _id / header name), so windowing is display-only.
  const selectable = !!onToggleSelect;
  const scrollRef = useRef(null);
  const [visRows, setVisRows] = useState(WIN_ROWS);
  const [visCols, setVisCols] = useState(WIN_COLS);
  // Spreadsheet-style editing (editable mode): one focused-cell buffer + a ref registry so
  // keyboard navigation can focus a target cell. `pendingFocus` defers focusing a cell that
  // doesn't exist yet (just-created row/column, or one past the current window) until it mounts.
  const [editing, setEditing] = useState(null);     // { key, text } | null  (key = rowIdheader)
  const cellRefs = useRef({});
  const [pendingFocus, setPendingFocus] = useState(null);
  // Reset the window when a new dataset loads (header signature changes); clamp so editing —
  // which rebuilds the same-length arrays each keystroke — never collapses the view.
  useEffect(() => { setVisRows(WIN_ROWS); setVisCols(WIN_COLS); }, [headers.join("")]);
  // Grow the window as the scroll position nears the bottom / right edge.
  const onScroll = e => {
    const el = e.currentTarget;
    if (visRows < rows.length && el.scrollHeight - el.scrollTop - el.clientHeight < 200)
      setVisRows(v => Math.min(rows.length, v + WIN_ROWS));
    if (visCols < headers.length && el.scrollWidth - el.scrollLeft - el.clientWidth < 200)
      setVisCols(c => Math.min(headers.length, c + WIN_COLS));
  };
  // Reveal the row whose dot was just clicked. If it's past the current window, expand to
  // include it first, then scroll once the row has actually rendered (next animation frame).
  useEffect(() => {
    if (!scrollTarget) return;
    const idx = rows.findIndex(r => r._id === scrollTarget.id);
    if (idx >= 0 && idx >= visRows) setVisRows(Math.min(rows.length, idx + 1));
    const raf = requestAnimationFrame(() => scrollRowIntoView(scrollRef.current, scrollTarget.id));
    return () => cancelAnimationFrame(raf);
  }, [scrollTarget]);
  const visHeaders = headers.slice(0, visCols);
  const visRowList = rows.slice(0, visRows);
  const isSel = id => !!(selectedIds && selectedIds.has(id));
  const HL = "var(--highlight)"; // selected-row highlight (amber); overrides column tint
  const cellBg = (h, sel) => sel ? HL : (h === xVar ? "var(--xsel-cell)" : (h === yVar ? "var(--ysel-cell)" : "transparent"));
  const headBg = h => h === xVar ? "var(--xsel-head)" : (h === yVar ? "var(--ysel-head)" : "var(--stathdr-bg)");

  // ── Edit helpers (editable mode): each rebuilds {headers, rows} and calls onChange ──
  const uniqueHeader = base => { let n = base, i = 1; while (headers.includes(n)) n = `${base}${++i}`; return n; };

  // ── Spreadsheet keyboard navigation (editable body cells) ──
  // Cell identity: a header can be arbitrary text, so join with a control char a header/id won't
  // contain. The focused input shows the live buffer; every other cell shows its stored value.
  const SEP = "";
  const keyFor = (rid, h) => rid + SEP + h;
  const isFocused = (rid, h) => !!editing && editing.key === keyFor(rid, h);
  // Apply the focused cell's buffer to a fresh rows array (without calling onChange yet), so a
  // navigation that ALSO creates a row/column can commit + create in a single onChange.
  const rowsWithCommit = () => {
    if (!editing) return rows;
    const i = editing.key.indexOf(SEP);
    const rid = editing.key.slice(0, i), h = editing.key.slice(i + 1);
    return rows.map(r => r._id === rid ? { ...r, [h]: editing.text } : r);
  };
  const commitOnly = () => { if (editing) { onChange(headers, rowsWithCommit()); setEditing(null); } };
  // Move focus to the cell at full-array indices (tr, tc), growing the window to include it.
  const moveTo = (tr, tc) => {
    onChange(headers, rowsWithCommit()); setEditing(null);
    if (tr >= visRows) setVisRows(Math.min(rows.length, tr + 1));
    if (tc >= visCols) setVisCols(Math.min(headers.length, tc + 1));
    setPendingFocus(keyFor(rows[tr]._id, headers[tc]));
  };
  const onCellKeyDown = (e, r, c, rid, h) => {
    const lastRow = rows.length - 1, lastCol = headers.length - 1, el = e.target;
    if (e.key === "ArrowUp") { if (r > 0) { e.preventDefault(); moveTo(r - 1, c); } return; }
    if (e.key === "ArrowDown") { if (r < lastRow) { e.preventDefault(); moveTo(r + 1, c); } return; }
    // Left/Right move a cell only at the field edge, so you can still edit within a cell.
    if (e.key === "ArrowLeft") { if (el.selectionStart === 0 && el.selectionEnd === 0 && c > 0) { e.preventDefault(); moveTo(r, c - 1); } return; }
    if (e.key === "ArrowRight") { if (el.selectionStart === el.value.length && el.selectionEnd === el.value.length && c < lastCol) { e.preventDefault(); moveTo(r, c + 1); } return; }
    if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) { if (c > 0) moveTo(r, c - 1); return; }
      if (c < lastCol) { moveTo(r, c + 1); return; }
      // Past the right edge → create a new column and step into it on this row.
      const name = uniqueHeader("col");
      const committed = rowsWithCommit().map(rr => ({ ...rr, [name]: "" }));
      setEditing(null); onChange([...headers, name], committed);
      setVisCols(headers.length + 1); setPendingFocus(keyFor(rid, name));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (r < lastRow) { moveTo(r + 1, c); return; }
      // Past the bottom → create a new row and step into it in this column.
      const id = uid();
      const committed = [...rowsWithCommit(), { _id: id, ...Object.fromEntries(headers.map(hh => [hh, ""])) }];
      setEditing(null); onChange(headers, committed);
      setVisRows(rows.length + 1); setPendingFocus(keyFor(id, h));
      return;
    }
    if (e.key === "Escape") { setEditing(null); el.blur(); }
  };
  // Focus a pending target once it has rendered (after a window grow or a row/column creation).
  // Leaves `pendingFocus` set until the element exists, so a later render retries.
  useEffect(() => {
    if (!pendingFocus) return;
    const el = cellRefs.current[pendingFocus];
    if (el) { el.focus(); if (el.select) el.select(); setPendingFocus(null); }
  }, [pendingFocus, visRows, visCols, rows, headers]);
  const renameHeader = (oldH, raw) => {
    const newH = raw.trim();
    if (!newH || newH === oldH || headers.includes(newH)) return; // ignore empty/duplicate
    onChange(
      headers.map(h => h === oldH ? newH : h),
      rows.map(r => { const { [oldH]: val, ...rest } = r; return { ...rest, [newH]: val }; }),
    );
  };
  const addCol = () => { const h = uniqueHeader("col"); onChange([...headers, h], rows.map(r => ({ ...r, [h]: "" }))); };
  const delCol = h => onChange(headers.filter(x => x !== h), rows.map(r => { const { [h]: _drop, ...rest } = r; return rest; }));
  const addRow = () => onChange(headers, [...rows, { _id: uid(), ...Object.fromEntries(headers.map(h => [h, ""])) }]);
  const delRow = id => onChange(headers, rows.filter(r => r._id !== id));

  return (
    <div style={{ minWidth:200 }}>
      <div style={{ fontSize:12, fontWeight:700, color:"var(--text-3)", letterSpacing:1, textTransform:"uppercase", marginBottom:8 }}>Data</div>
      <div ref={scrollRef} onScroll={onScroll} style={{ maxHeight:300, overflow:"auto", border:"1px solid var(--border)", borderRadius:8 }}>
        <table style={{ borderCollapse:"collapse", fontSize:12, width:"100%" }}>
          <caption className="sr-only">Dataset rows — one row per case, one column per variable.</caption>
          <thead>
            <tr>
              <th scope="col" style={{ position:"sticky", top:0, background:"var(--surface-2)", color:"var(--text-faint)", fontWeight:600, padding:"4px 6px", textAlign:"right", borderBottom:"1px solid var(--border)" }}>#</th>
              {visHeaders.map(h => (
                <th key={h} scope="col" style={{ position:"sticky", top:0, background:headBg(h), color:"var(--text)", fontWeight:700, padding:"4px 8px", textAlign:"left", borderBottom:"1px solid var(--border)", whiteSpace:"nowrap" }}>
                  {editable ? (
                    <span style={{ display:"inline-flex", alignItems:"center", gap:2 }}>
                      <InlineEdit value={h} onChange={v => renameHeader(h, v)} style={{ fontWeight:700 }} />
                      <button title="Delete column" onClick={() => delCol(h)} style={{ ...btnX, fontSize:13 }}>×</button>
                    </span>
                  ) : h}
                </th>
              ))}
              {editable && (
                <th style={{ position:"sticky", top:0, background:"var(--surface-2)", borderBottom:"1px solid var(--border)", padding:"2px 6px" }}>
                  <button title="Add column" onClick={addCol} style={{ ...btnX, color:"var(--accent-ink)", fontSize:15 }}>＋</button>
                </th>
              )}
              {formulaCols.map(fc => (
                <th key={"f:" + fc.key} scope="col" title="Formula column (computed, read-only)"
                  style={{ position:"sticky", top:0, background:headBg(fc.key), color:"var(--text)", fontWeight:700, fontStyle:"italic", padding:"4px 8px", textAlign:"left", borderBottom:"1px solid var(--border)", whiteSpace:"nowrap" }}>
                  <span style={{ color:"var(--accent-ink)", fontStyle:"normal", marginRight:3 }}>ƒ</span>{fc.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visRowList.map((r, i) => {
              const sel = isSel(r._id);
              return (
              <tr key={r._id || i} data-rowid={r._id} aria-selected={selectable ? sel : undefined} style={{ borderBottom:"1px solid var(--border)" }}>
                {/* row-number cell doubles as the select handle (clicking a data cell
                    edits it, so selection lives here to avoid clobbering inline edit) */}
                <td onClick={selectable ? () => onToggleSelect(r._id) : undefined}
                  title={selectable ? "Select row" : undefined}
                  style={{ color:"var(--text-faint)", padding:"3px 6px", textAlign:"right", whiteSpace:"nowrap", background: sel ? HL : undefined, cursor: selectable ? "pointer" : "default" }}>
                  {editable && <button title="Delete row" onClick={e => { e.stopPropagation(); delRow(r._id); }} style={{ ...btnX, fontSize:12, marginRight:2 }}>×</button>}
                  {i + 1}
                </td>
                {visHeaders.map((h, ci) => (
                  <td key={h} style={{ padding:"3px 8px", color:"var(--text-2)", background:cellBg(h, sel), whiteSpace:"nowrap", maxWidth:120, overflow:"hidden", textOverflow:"ellipsis" }}>
                    {editable ? (
                      <input
                        ref={el => { cellRefs.current[keyFor(r._id, h)] = el; }}
                        value={isFocused(r._id, h) ? editing.text : (r[h] ?? "")}
                        onChange={e => setEditing({ key: keyFor(r._id, h), text: e.target.value })}
                        onFocus={() => setEditing({ key: keyFor(r._id, h), text: r[h] ?? "" })}
                        onBlur={commitOnly}
                        onKeyDown={e => onCellKeyDown(e, i, ci, r._id, h)}
                        aria-label={`${h}, row ${i + 1}`}
                        style={{ width:"100%", boxSizing:"border-box", font:"inherit", fontSize:12, padding:"1px 3px", borderRadius:3, color:"var(--text-2)", background:"transparent", border: isFocused(r._id, h) ? "1px solid #6366f1" : "1px solid transparent", outline:"none" }}
                      />
                    ) : r[h]}
                  </td>
                ))}
                {editable && <td style={{ background: sel ? HL : undefined }} />}
                {formulaCols.map(fc => {
                  const v = computedRows && computedRows[i] ? computedRows[i][fc.key] : "";
                  return (
                    <td key={"f:" + fc.key} style={{ padding:"3px 8px", color:"var(--text-3)", fontStyle:"italic", background:cellBg(fc.key, sel), whiteSpace:"nowrap", maxWidth:120, overflow:"hidden", textOverflow:"ellipsis", textAlign: fc.numeric ? "right" : "left" }}>
                      {fc.numeric && v !== "" ? fmtFormulaVal(Number(v)) : v}
                    </td>
                  );
                })}
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {(visRowList.length < rows.length || visHeaders.length < headers.length) && (
        <div style={{ fontSize:12, color:"var(--text-faint)", marginTop:4 }}>
          Showing {visRowList.length}/{rows.length} rows
          {headers.length > visHeaders.length ? `, ${visHeaders.length}/${headers.length} cols` : ""} — scroll to load more
        </div>
      )}
      {editable && (
        <div style={{ marginTop:6 }}>
          <button onClick={addRow} style={{ ...btnPlus, color:"var(--accent-ink)", borderColor:"#a5b4fc", background:"var(--xsel-cell)" }}>＋ row</button>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// COLLECT TABLE — one column per tracked statistic, one row per collected sample.
// Mirrors DataTable. Rows live in `collectRows` (keyed by stat id) and accumulate
// across runs; columns are the `trackedStats` specs (named by statLabel), each with
// a remove control. (Accumulation itself is wired in a later phase.)
// ══════════════════════════════════════════════════════════════════════════════
function CollectTable({ trackedStats, collectRows, onRemove, onRename, labelFor = statLabel, titleFor, selectedIds, onToggleSelect, scrollTarget }) {
  const selectable = !!onToggleSelect;
  const isSel = id => !!(selectedIds && selectedIds.has(id));
  const HL = "var(--highlight)";
  const scrollRef = useRef(null);
  // Which column header is being renamed (pencil affordance). Seeded with the existing
  // custom name; committing an empty string clears it back to the formula/auto label.
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState("");
  const beginRename = s => { setDraft(s.name || ""); setEditingId(s.id); };
  const commitRename = () => { if (onRename && editingId != null) onRename(editingId, draft.trim()); setEditingId(null); };
  // Reveal the row whose distribution-plot dot was just clicked (key for 500-row collects)
  useEffect(() => { scrollRowIntoView(scrollRef.current, scrollTarget && scrollTarget.id); }, [scrollTarget]);
  if (!trackedStats.length) {
    return (
      <div style={{ flex:"1 1 280px", minWidth:220, color:"var(--text-faint)", fontSize:13, padding:"16px 8px", lineHeight:1.5 }}>
        No tracked statistics yet. In <strong>Sample Results</strong> above, enable a statistic
        (e.g. count, mean) on your plot above and click on that value to add a column here.
      </div>
    );
  }
  // Render every collected row so each distribution-plot dot has a reachable row for
  // linked highlighting; collected counts (≈500 default) stay light to render.
  const fmt = v => (typeof v === "number" ? (isFinite(v) ? parseFloat(v.toFixed(4)) : "—") : v);
  return (
    <div style={{ flex:"1 1 280px", minWidth:220 }}>
      <div style={{ fontSize:12, fontWeight:700, color:"var(--text-3)", letterSpacing:1, textTransform:"uppercase", marginBottom:8 }}>
        Collected statistics {collectRows.length > 0 && <span style={{ color:"var(--text-faint)", fontWeight:600 }}>· {collectRows.length} rows</span>}
      </div>
      <div ref={scrollRef} style={{ maxHeight:300, overflow:"auto", border:"1px solid var(--border)", borderRadius:8 }}>
        <table style={{ borderCollapse:"collapse", fontSize:12, width:"100%" }}>
          <caption className="sr-only">Collected statistics — one row per repetition, one column per tracked statistic.</caption>
          <thead>
            <tr>
              <th scope="col" style={{ position:"sticky", top:0, background:"var(--surface-2)", color:"var(--text-faint)", fontWeight:600, padding:"4px 6px", textAlign:"right", borderBottom:"1px solid var(--border)" }}>#</th>
              {trackedStats.map(s => (
                <th key={s.id} scope="col" title={titleFor ? titleFor(s) : undefined} style={{ position:"sticky", top:0, background: s.kind === "derived" ? "var(--derived-bg)" : "var(--stathdr-bg)", color:"var(--text)", fontWeight:700, padding:"4px 8px", textAlign:"left", borderBottom:"1px solid var(--border)", whiteSpace:"nowrap" }}>
                  {s.kind === "derived" && <span title="Derived column" style={{ marginRight:3 }}>ƒ</span>}
                  {editingId === s.id ? (
                    <input autoFocus value={draft}
                      onChange={e => setDraft(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={e => { if (e.key === "Enter") commitRename(); else if (e.key === "Escape") setEditingId(null); }}
                      placeholder={labelFor(s)}
                      style={{ fontFamily:"monospace", fontSize:12, width:Math.max(70, draft.length * 7 + 16), border:"1px solid #6366f1", borderRadius:3, padding:"1px 4px", background:"var(--surface)", color:"var(--text)" }} />
                  ) : (
                    <span style={{ fontFamily:"monospace", color: s.kind === "derived" ? "var(--derived-text)" : "var(--accent-ink)" }}>{labelFor(s)}</span>
                  )}
                  {onRename && editingId !== s.id && (
                    <button onClick={() => beginRename(s)} title="Rename column" style={{ ...btnX, fontSize:12, marginLeft:3, verticalAlign:"middle", color:"var(--text-3)" }}>✎</button>
                  )}
                  <button onClick={() => onRemove(s.id)} title="Remove column" style={{ ...btnX, fontSize:13, marginLeft:2, verticalAlign:"middle" }}>×</button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {collectRows.length === 0 ? (
              <tr>
                <td colSpan={trackedStats.length + 1} style={{ padding:"12px 8px", color:"var(--text-faint)", textAlign:"center" }}>
                  No samples collected yet.
                </td>
              </tr>
            ) : collectRows.map((row, i) => {
              const sel = isSel(row._id);
              return (
              <tr key={row._id || i} data-rowid={row._id} aria-selected={selectable ? sel : undefined} onClick={selectable ? () => onToggleSelect(row._id) : undefined}
                style={{ borderBottom:"1px solid var(--border)", cursor: selectable ? "pointer" : "default" }}>
                <td style={{ color:"var(--text-faint)", padding:"3px 6px", textAlign:"right", background: sel ? HL : undefined }}>{i + 1}</td>
                {trackedStats.map(s => (
                  <td key={s.id} style={{ padding:"3px 8px", color:"var(--text-2)", whiteSpace:"nowrap", background: sel ? HL : undefined }}>{fmt(row[s.id])}</td>
                ))}
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// UNI-CAT PLOT — single categorical variable as binned stacked-dot columns
// (a 1-D version of CatCatGrid). Collapses to top 10 + "Other" past 10 categories.
// ══════════════════════════════════════════════════════════════════════════════
function UniCatPlot({ rows, levels, catVar, nameOf, R, width, showCount = true, showPct = false, expanded, onToggleExpand, trackable, trackedKeys, onTrackStat, measure, selectedIds, onToggleSelect }) {
  const nm = nameOf || (h => h);
  const measureSelect = measure && measure.select, measureRoleOf = measure && measure.roleOf;
  const selectable = !!onToggleSelect;
  const isSel = id => !!(selectedIds && selectedIds.has(id));
  const wrapRef = useRef(null);
  // Keep the actual rows per category (not just counts) so each dot is one case and
  // can link back to its table row (D1).
  const rowsByCat = {};
  rows.forEach(r => { const v = r[catVar]; if (v !== "" && v !== undefined) { (rowsByCat[v] = rowsByCat[v] || []).push(r); } });
  const counts = {};
  Object.keys(rowsByCat).forEach(c => { counts[c] = rowsByCat[c].length; });
  const allCats = levelsOf(levels, catVar, counts);
  const total = allCats.reduce((a, c) => a + counts[c], 0);
  const { shown } = collapseCats(allCats, counts, expanded || !!(levels && levels[catVar]));
  const namedSet = new Set(shown.filter(c => c !== OTHER_CAT));
  // Rows for a shown cell: named category → its bucket; the "Other" cell collects
  // every row whose category fell outside the shown named set.
  const cellRowsOf = c => c === OTHER_CAT
    ? rows.filter(r => { const v = r[catVar]; return v !== "" && v !== undefined && !namedSet.has(v); })
    : (rowsByCat[c] || []);
  const cellCount = c => cellRowsOf(c).length;

  const W = width || 520;
  const DOT_AREA_H = 220;            // height of each category's stacked-dot area
  const hasLabel = showCount || showPct;
  const estColW = clamp(W / Math.max(shown.length, 1), 48, 180);
  const maxCount = Math.max(1, ...shown.map(cellCount));
  // Uniform dot size so the tallest category's dots all fit; tall stacks wrap
  // into multiple columns within the cell (a 1-D version of the 2-way table).
  const dotR = fitDotR(maxCount, estColW - 14, DOT_AREA_H, 2, Math.min(R + 2, 9));

  return (
    <div ref={wrapRef} style={{ width: W, position:"relative" }}>
      {measure && measure.aKey && measure.bKey && (
        <MeasureConnector containerRef={wrapRef} aKey={measure.aKey} bKey={measure.bKey}
          diff={measure.diff} fmt={measure.fmt} trackable={measure.trackable} onTrack={measure.onTrack} />
      )}
      <div style={{ display:"flex", alignItems:"stretch" }}>
        {shown.map((c, ci) => {
          const cellRows = cellRowsOf(c);
          const cnt = cellRows.length;
          const color = colorAt(ci);
          // Each visible number is a click target: count → count of catVar=c;
          // percent → proportion catVar=c. "Other" has no clean target.
          const colOk = c !== OTHER_CAT;
          const base = { variable:catVar, target:String(c) };
          const countSpec = colOk ? { ...base, fn:"countVal" } : null;
          const propSpec = colOk ? { ...base, fn:"proportion" } : null;
          return (
            <div key={c} style={{ flex:"1 1 0", minWidth:48, maxWidth:180, borderLeft: ci ? "1px solid var(--border)" : "none",
              display:"flex", flexDirection:"column", alignItems:"center", padding:"0 6px", boxSizing:"border-box" }}>
              {hasLabel && (
                <div style={{ fontSize:12, fontWeight:600, minHeight:16, display:"flex", gap:4 }}>
                  {showCount && <CatNum text={cnt} dim={cnt === 0} spec={countSpec} trackable={trackable} trackedKeys={trackedKeys} onTrackStat={onTrackStat} nameOf={nm} measureSelect={measureSelect} measureRole={countSpec && measureRoleOf ? measureRoleOf(countSpec) : null} />}
                  {showPct && <CatNum text={`(${total ? fmtP(cnt / total) : "—"})`} dim={cnt === 0} spec={propSpec} trackable={trackable} trackedKeys={trackedKeys} onTrackStat={onTrackStat} nameOf={nm} measureSelect={measureSelect} measureRole={propSpec && measureRoleOf ? measureRoleOf(propSpec) : null} />}
                </div>
              )}
              {/* bottom-anchored dot grid: fills a row left→right, then stacks
                  rows upward, so column height reflects the count */}
              <div style={{ height: DOT_AREA_H, width:"100%", display:"flex", flexDirection:"row",
                flexWrap:"wrap-reverse", alignContent:"flex-start", justifyContent:"flex-start", gap:2, overflow:"hidden" }}>
                {cellRows.map((r, i) => {
                  const sel = isSel(r._id);
                  return <div key={r._id || i}
                    onClick={selectable ? () => onToggleSelect(r._id) : undefined}
                    style={{ width:dotR * 2, height:dotR * 2, borderRadius:"50%", background:color, flexShrink:0,
                      cursor: selectable ? "pointer" : "default",
                      // hairline keeps each dot's boundary ≥3:1 (1.4.11) for light palette hues; the
                      // selected state overrides with its own dark ring
                      boxShadow: sel ? "0 0 0 2px #1f2937" : "inset 0 0 0 1px var(--dot-outline)" }} />;
                })}
              </div>
              <div style={{ borderTop:"1px solid var(--border-2)", width:"100%", marginTop:2 }} />
              <div style={{ fontSize:12, color:"var(--text-2)", fontWeight:600, paddingTop:4, textAlign:"center",
                overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:"100%" }}>{c}</div>
            </div>
          );
        })}
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:10, marginTop:4 }}>
        <span style={{ fontSize:12, color:"var(--text-2)", fontWeight:700 }}>{nm(catVar)}</span>
        {allCats.length > 10 && (
          <button onClick={onToggleExpand} style={{ ...btnNav, fontSize:12 }}>
            {expanded ? "Collapse to top 10" : `Show all ${allCats.length}`}
          </button>
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

function CatCatGrid({ rows, levels, xVar, yVar, nameOf, R, width, showCount = true, showPct = false, expanded, onToggleExpand, trackable, trackedKeys, onTrackStat, measure, selectedIds, onToggleSelect }) {
  const nm = nameOf || (h => h);
  const measureSelect = measure && measure.select, measureRoleOf = measure && measure.roleOf;
  const selectable = !!onToggleSelect;
  const isSel = id => !!(selectedIds && selectedIds.has(id));
  const wrapRef = useRef(null);
  // Per-axis counts drive collapsing of high-cardinality axes (>10 categories)
  const xCount = {}, yCount = {};
  rows.forEach(r => {
    const xc = r[xVar], yc = r[yVar];
    if (xc !== "" && xc !== undefined) xCount[xc] = (xCount[xc] || 0) + 1;
    if (yc !== "" && yc !== undefined) yCount[yc] = (yCount[yc] || 0) + 1;
  });
  const allX = levelsOf(levels, xVar, xCount), allY = levelsOf(levels, yVar, yCount);
  const X = collapseCats(allX, xCount, expanded || !!(levels && levels[xVar])), Y = collapseCats(allY, yCount, expanded || !!(levels && levels[yVar]));
  const xCats = X.shown, yCats = Y.shown;
  const xSet = new Set(xCats.filter(c => c !== OTHER_CAT));
  const ySet = new Set(yCats.filter(c => c !== OTHER_CAT));
  const collapsible = allX.length > 10 || allY.length > 10;

  // Color per Y-category (rows), like the reference image
  const yColor = {};
  yCats.forEach((yc, i) => { yColor[yc] = colorAt(i); });

  // Build grid[yc][xc] as the actual rows in each cell (not just counts), folding
  // overflow categories into "Other", so every dot is one case linkable to its row (D1).
  const grid = {};
  yCats.forEach(yc => { grid[yc] = {}; xCats.forEach(xc => grid[yc][xc] = []); });
  rows.forEach(r => {
    let xc = r[xVar], yc = r[yVar];
    if (xc === "" || xc === undefined || yc === "" || yc === undefined) return;
    xc = xSet.has(xc) ? xc : OTHER_CAT;
    yc = ySet.has(yc) ? yc : OTHER_CAT;
    if (grid[yc] && grid[yc][xc] !== undefined) grid[yc][xc].push(r);
  });

  // Row totals for row-conditional % (each Y-category row sums to 100%): P(X | Y)
  const rowTotals = {};
  yCats.forEach(yc => { rowTotals[yc] = xCats.reduce((a, xc) => a + grid[yc][xc].length, 0); });

  const LABEL_W = 96, CELL_MIN = 54, CELL_MAX = 150;
  const CELL_H = clamp(Math.round(250 / Math.max(yCats.length, 1)), 56, 110);
  const hasLabel = showCount || showPct;
  // Size dots uniformly so the densest cell's dots all fit (no clipping)
  let maxCell = 0;
  yCats.forEach(yc => xCats.forEach(xc => { if (grid[yc][xc].length > maxCell) maxCell = grid[yc][xc].length; }));
  const estCellW = clamp(((width || 520) - LABEL_W) / Math.max(xCats.length, 1), CELL_MIN, CELL_MAX);
  const dotAreaH = CELL_H - (hasLabel ? 18 : 0) - 8;
  const dotR = fitDotR(maxCell, estCellW - 12, dotAreaH, 2, Math.min(R + 2, 8));

  return (
    <div ref={wrapRef} style={{ width: width ? width : "100%", position:"relative" }}>
      {measure && measure.aKey && measure.bKey && (
        <MeasureConnector containerRef={wrapRef} aKey={measure.aKey} bKey={measure.bKey}
          diff={measure.diff} fmt={measure.fmt} trackable={measure.trackable} onTrack={measure.onTrack} />
      )}
      <div style={{ display:"flex", flexDirection:"column" }}>
        {/* Rows */}
        {yCats.map(yc => (
          <div key={yc} style={{ display:"flex", alignItems:"stretch", borderBottom:"1px solid var(--border)" }}>
            {/* Row label */}
            <div style={{ width:LABEL_W, flexShrink:0, display:"flex", alignItems:"center",
              justifyContent:"flex-end", paddingRight:10, fontSize:12, color:"var(--text-2)", fontWeight:600,
              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
              {yc}
            </div>
            {/* Cells */}
            {xCats.map(xc => {
              const cellRows = grid[yc][xc];
              const c = cellRows.length;
              const rowTot = rowTotals[yc] || 0;
              // Each visible number is a click target: count → count of X=xc given
              // Y=yc; proportion → that row-conditional proportion P(X=xc | Y=yc).
              // OTHER buckets can't form a clean target, so they stay non-clickable.
              const cellOk = xc !== OTHER_CAT && yc !== OTHER_CAT;
              const base = { variable:xVar, target:String(xc), condVar:yVar, condVal:String(yc) };
              const countSpec = cellOk ? { ...base, fn:"countVal" } : null;
              const propSpec = cellOk ? { ...base, fn:"proportion" } : null;
              return (
                <div key={xc} style={{ flex:"1 1 0", minWidth:CELL_MIN, maxWidth:CELL_MAX, height:CELL_H,
                  borderLeft:"1px solid var(--border)", padding:"4px 6px", boxSizing:"border-box",
                  display:"flex", flexDirection:"column" }}>
                  {hasLabel && (
                    <div style={{ fontSize:12, fontWeight:600, display:"flex", gap:4, flexWrap:"wrap" }}>
                      {showCount && <CatNum text={c} dim={c === 0} spec={countSpec} trackable={trackable} trackedKeys={trackedKeys} onTrackStat={onTrackStat} nameOf={nm} measureSelect={measureSelect} measureRole={countSpec && measureRoleOf ? measureRoleOf(countSpec) : null} />}
                      {showPct && <CatNum text={`(${rowTot ? fmtP(c / rowTot) : "—"})`} dim={c === 0} spec={propSpec} trackable={trackable} trackedKeys={trackedKeys} onTrackStat={onTrackStat} nameOf={nm} measureSelect={measureSelect} measureRole={propSpec && measureRoleOf ? measureRoleOf(propSpec) : null} />}
                    </div>
                  )}
                  {/* Stacked dots — one per case, click toggles linked highlighting (D1) */}
                  <div style={{ display:"flex", flexWrap:"wrap", gap:2, alignContent:"flex-start", marginTop:3, flex:1, overflow:"hidden" }}>
                    {cellRows.map((r, i) => {
                      const sel = isSel(r._id);
                      return <div key={r._id || i}
                        onClick={selectable ? () => onToggleSelect(r._id) : undefined}
                        style={{ width:dotR * 2, height:dotR * 2, borderRadius:"50%", background:yColor[yc], flexShrink:0,
                          cursor: selectable ? "pointer" : "default",
                          boxShadow: sel ? "0 0 0 2px #1f2937" : "inset 0 0 0 1px var(--dot-outline)" }} />;
                    })}
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
            <div key={xc} style={{ flex:"1 1 0", minWidth:CELL_MIN, maxWidth:CELL_MAX, textAlign:"center", paddingTop:5,
              fontSize:12, color:"var(--text-2)", fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{xc}</div>
          ))}
        </div>
        {/* Axis titles */}
        <div style={{ textAlign:"center", marginTop:4, fontSize:12, color:"var(--text-2)", fontWeight:700,
          marginLeft:LABEL_W }}>{nm(xVar)}</div>
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:10, fontSize:12, color:"var(--text-3)", marginTop:4, marginLeft:LABEL_W - 10 }}>
        <span>Rows = {nm(yVar)} · row-conditional proportion: P({nm(xVar)} | {nm(yVar)})</span>
        {collapsible && (
          <button onClick={onToggleExpand} style={{ ...btnNav, fontSize:12 }}>
            {expanded ? "Collapse to top 10" : "Show all categories"}
          </button>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SPLIT DOT PLOTS — one numeric axis, split into stacked rows by a categorical
// variable, for comparing distributions across groups. Optional box/mean/SD per group.
// ══════════════════════════════════════════════════════════════════════════════

function SplitDotPlots({ rows, levels, catVar, numVar, nameOf, R, width, isTime, orientation = "h", showBox, showMean, showSD, showValues, showDensity, expanded, onToggleExpand, trackable, trackedKeys, onTrackStat, divOn, divCuts, onDivChange, divSnap, divShowCount, divShowPct, divFmt, divMulti, rulerOn, rulerPts, onRulerChange, rulerShowBox, rulerFmt, onTrackDiff, selectedIds, onToggleSelect }) {
  const nm = nameOf || (h => h);
  const selectable = !!onToggleSelect;
  const isSel = id => !!(selectedIds && selectedIds.has(id));
  // Per-group tracking spec: a numeric stat conditioned on this group (null for the
  // "Other" bucket or when the plot isn't trackable).
  // catVar null = a single group holding every row (the Y-only plot): plain univariate specs.
  const single = !catVar;
  const grpSpec = (cat, fn) => !(trackable && cat !== OTHER_CAT) ? null
    : single ? { fn, variable:numVar } : { fn, variable:numVar, condVar:catVar, condVal:String(cat) };
  const tp = { trackable, trackedKeys, onTrackStat };
  // Collapse high-cardinality grouping variable into top 10 + "Other"
  const catCount = {};
  const ALL = "all";
  if (single) catCount[ALL] = rows.length;
  else rows.forEach(r => { const v = r[catVar]; if (v !== "" && v !== undefined) catCount[v] = (catCount[v] || 0) + 1; });
  const allCats = single ? [ALL] : levelsOf(levels, catVar, catCount);
  const { shown: cats, isCollapsed } = single ? { shown: allCats, isCollapsed: false } : collapseCats(allCats, catCount, expanded || !!(levels && levels[catVar]));
  const catSet = new Set(cats.filter(c => c !== OTHER_CAT));
  const groupOf = v => single ? ALL : catSet.has(v) ? v : OTHER_CAT;

  // Shared numeric scale across all groups for fair comparison (time-aware)
  const allNums = rows.map(r => toNum(r[numVar])).filter(v => !isNaN(v));
  if (!allNums.length) return <div style={{ color:"var(--text-faint)", padding:20 }}>No numeric data.</div>;
  const mn = Math.min(...allNums), mx = Math.max(...allNums);
  const range = mx - mn || 1, pad = range * 0.05, lo = mn - pad, hi = mx + pad;
  const fmt = isTime ? minutesToTime : (v => parseFloat(v.toFixed(2)));

  const W = width || 520;
  const dotR = Math.max(3, Math.min(R, 6));
  const nT = 6;
  const ticks = Array.from({ length: nT }, (_, i) => mn + (i / (nT - 1)) * range);

  // ── Vertical orientation: numeric on Y, category distributions side by side ──
  if (orientation === "v") {
    const PL = 54, PR = 16, PT = 16, PB = 52;
    const iW = W - PL - PR;
    const H = 320, iH = H - PT - PB;
    const colW = iW / Math.max(cats.length, 1);
    const sy = v => PT + (1 - (v - lo) / (hi - lo)) * iH;
    return (
      <div style={{ width: width ? width : "100%" }}>
        <svg width={W} height={H} role={trackable ? undefined : "img"}
          aria-label={single ? "Dot plot of " + nm(numVar) + " — " + allNums.length + " values"
            : "Split dot plot of " + nm(numVar) + " by " + nm(catVar) + " — " + cats.length + " groups"}
          style={{ display:"block", overflow:"visible", maxWidth:"100%" }}>
          {/* horizontal gridlines + y-axis ticks */}
          {ticks.map((t, i) => <line key={"g"+i} x1={PL} y1={sy(t)} x2={W - PR} y2={sy(t)} stroke="var(--grid)" strokeWidth={1} />)}
          <line x1={PL} y1={PT} x2={PL} y2={PT + iH} stroke="var(--axis)" strokeWidth={1.5} />
          {ticks.map((t, i) => (
            <g key={"yt"+i}>
              <line x1={PL - 4} y1={sy(t)} x2={PL} y2={sy(t)} stroke="var(--axis)" />
              <text x={PL - 7} y={sy(t)} textAnchor="end" dominantBaseline="middle" fontSize={12} fill="var(--text-3)">{fmt(t)}</text>
            </g>
          ))}
          {cats.map((cat, gi) => {
            const x0 = PL + colW * gi, center = x0 + colW / 2;
            // Keep the rows (not just the numbers) so each dot links to its table row (D1)
            const groupRows = rows.filter(r => groupOf(r[catVar]) === cat && !isNaN(toNum(r[numVar])));
            const groupNums = groupRows.map(r => toNum(r[numVar]));
            const summary = numericSummary(groupNums);
            const binOf = v => Math.round(sy(v) / (dotR * 2 + 1));
            const binCounts = {};
            groupNums.forEach(v => { const k = binOf(v); binCounts[k] = (binCounts[k] || 0) + 1; });
            const widest = Math.max(1, ...Object.values(binCounts));
            // data baseline; dots to the right, overlays to the left (a lone group keeps its
            // overlays near the axis and gives the dots the rest of the width)
            const xData = single ? x0 + Math.min(colW * 0.46, 70) : x0 + colW * 0.46;
            const dotAreaW = (x0 + colW) - xData - 4;
            const hsp = Math.min(dotR * 2 + 1, (dotAreaW - dotR) / widest);
            const stacks = {};
            const groupDots = groupNums.map((v, di) => {
              const key = binOf(v); stacks[key] = (stacks[key] || 0) + 1;
              return { id: groupRows[di]._id, x: xData + dotR + 3 + (stacks[key] - 1) * hsp, y: sy(v) };
            });
            const color = colorAt(gi);
            const bx = xData - 32;                  // vertical boxplot, just left of the mean/SD cluster
            const sdMidX = xData - 5;               // ±SD runs vertically through the mean triangle
            return (
              <g key={cat}>
                {gi > 0 && <line x1={x0} y1={PT} x2={x0} y2={PT + iH} stroke="var(--grid)" strokeWidth={1} />}
                {/* per-category baseline the mean tip touches */}
                <line x1={xData} y1={PT} x2={xData} y2={PT + iH} stroke="var(--grid)" strokeWidth={1} />
                {groupDots.map((d, i) => {
                  const sel = isSel(d.id);
                  return <circle key={d.id || i} cx={d.x} cy={d.y} r={sel ? dotR + 1 : dotR}
                    fill={sel ? "#f97316" : color}
                    fillOpacity={sel ? 1 : Math.min(0.85, Math.max(0.3, 60 / Math.sqrt(groupDots.length + 1)))}
                    stroke={sel ? "#1f2937" : "var(--dot-outline)"} strokeWidth={sel ? 1.5 : 0.75}
                    style={selectable ? { cursor:"pointer" } : undefined}
                    onClick={selectable && d.id ? () => onToggleSelect(d.id) : undefined} />;
                })}
                {/* per-group density curve — value→y, density extends rightward from the baseline */}
                {showDensity && summary && (() => {
                  const curve = kdeCurve(groupNums, lo, hi);
                  if (!curve) return null;
                  const peak = Math.max(...curve.map(p => p.y)) || 1;
                  const w = Math.max(0, dotAreaW - dotR) * 0.95;
                  const d = curve.map((p, i) => (i ? "L" : "M") + (xData + (p.y / peak) * w).toFixed(1) + " " + sy(p.x).toFixed(1)).join(" ");
                  return <path d={d} fill="none" stroke={color} strokeWidth={1.75} strokeOpacity={0.85} style={{ pointerEvents:"none" }} />;
                })()}
                {/* boxplot (vertical, Tukey whiskers) */}
                {showBox && summary && (
                  <g>
                    <line x1={bx} y1={sy(summary.whiskerLo)} x2={bx} y2={sy(summary.whiskerHi)} stroke="var(--box-line)" strokeWidth={1.2} />
                    <line x1={bx - 4} y1={sy(summary.whiskerLo)} x2={bx + 4} y2={sy(summary.whiskerLo)} stroke="var(--box-line)" strokeWidth={1.2} />
                    <line x1={bx - 4} y1={sy(summary.whiskerHi)} x2={bx + 4} y2={sy(summary.whiskerHi)} stroke="var(--box-line)" strokeWidth={1.2} />
                    <rect x={bx - 6} y={sy(summary.q3)} width={12} height={Math.max(1, sy(summary.q1) - sy(summary.q3))} fill="rgba(99,102,241,0.15)" stroke={color} strokeWidth={1.2} />
                    <line x1={bx - 6} y1={sy(summary.median)} x2={bx + 6} y2={sy(summary.median)} stroke={color} strokeWidth={2} />
                    {showValues && <TrackText x={bx - 9} y={sy(summary.median) + 3} anchor="end" color="var(--accent-ink)" fontSize={12} label={fmt(summary.median)} spec={grpSpec(cat, "median")} {...tp} />}
                  </g>
                )}
                {/* mean triangle — points right, tip on the data baseline; value just
                    to the left of the triangle */}
                {showMean && summary && (() => {
                  const my = sy(summary.mean);
                  return (
                    <g>
                      <polygon points={xData + "," + my + " " + (xData - 10) + "," + (my - 5) + " " + (xData - 10) + "," + (my + 5)}
                        fill="#10b981" stroke="#059669" strokeWidth={0.8} />
                      {showValues && <TrackText x={xData - 13} y={my + 3} anchor="end" color="var(--green-ink)" fontSize={12} label={fmt(summary.mean)} spec={grpSpec(cat, "mean")} {...tp} />}
                    </g>
                  );
                })()}
                {/* ±1 SD — runs vertically through the mean triangle, centred on the mean */}
                {showSD && summary && (() => {
                  const topY = sy(summary.mean + summary.sd), botY = sy(summary.mean - summary.sd);
                  const labelY = Math.min(topY, sy(summary.mean) - 8) - 4; // keep value off the triangle
                  return (
                    <g>
                      <line x1={sdMidX} y1={topY} x2={sdMidX} y2={botY} stroke="var(--sd-mark)" strokeWidth={2} />
                      <line x1={sdMidX - 3} y1={topY} x2={sdMidX + 3} y2={topY} stroke="var(--sd-mark)" strokeWidth={2} />
                      <line x1={sdMidX - 3} y1={botY} x2={sdMidX + 3} y2={botY} stroke="var(--sd-mark)" strokeWidth={2} />
                      {showValues && <TrackText x={sdMidX} y={labelY} anchor="middle" color="var(--amber-ink)" fontSize={11} label={"±SD " + parseFloat(summary.sd.toFixed(2))} spec={grpSpec(cat, "sd")} {...tp} />}
                    </g>
                  );
                })()}
                {/* category label */}
                {!single && <text x={center} y={PT + iH + 16} textAnchor="middle" fontSize={13} fill="var(--text-2)" fontWeight={600}>{cat}</text>}
                <text x={center} y={PT + iH + (single ? 16 : 28)} textAnchor="middle" fontSize={12} fill="var(--text-3)">n={groupNums.length}</text>
              </g>
            );
          })}
          <line x1={PL} y1={PT + iH} x2={W - PR} y2={PT + iH} stroke="var(--axis)" strokeWidth={1.5} />
          {!single && <text x={PL + iW / 2} y={H - 4} textAnchor="middle" fontSize={13} fill="var(--text-2)" fontWeight={600}>{nm(catVar)}</text>}
          <text x={14} y={PT + iH / 2} textAnchor="middle" fontSize={13} fill="var(--text-2)" fontWeight={600} transform={"rotate(-90,14," + (PT + iH / 2) + ")"}>{nm(numVar)}</text>
        </svg>
        {allCats.length > 10 && (
          <button onClick={onToggleExpand} style={{ ...btnNav, fontSize:12, marginTop:4 }}>
            {expanded ? "Collapse to top 10 groups" : `Show all ${allCats.length} groups`}
          </button>
        )}
      </div>
    );
  }

  // ── Horizontal orientation (default): numeric on X, groups stacked vertically ──
  const PL = 90, PR = 20, PT = 10, PB = 44;
  const iW = W - PL - PR;
  const GROUP_H = 116;
  const H = PT + cats.length * GROUP_H + PB;
  const sx = v => PL + ((v - lo) / (hi - lo)) * iW;

  // Ruler snap candidates across every group band, each with a marker `y` so the overlay
  // can ring the exact target. Group means are always offered (the headline difference of
  // means); box quartiles only when the box is shown; individual dots are plain constants.
  // (Populated during the group map below; read by the shared RulerOverlay after it.)
  const rulerCands = [];

  return (
    <div style={{ width: width ? width : "100%" }}>
      <svg width={W} height={H} role={trackable ? undefined : "img"}
        aria-label={"Split dot plot of " + nm(numVar) + " by " + nm(catVar) + " — " + cats.length + " groups"}
        style={{ display:"block", overflow:"visible", maxWidth:"100%" }}>
        {/* vertical gridlines */}
        {ticks.map((t, i) => <line key={"g"+i} x1={sx(t)} y1={PT} x2={sx(t)} y2={H - PB} stroke="var(--grid)" strokeWidth={1} />)}

        {cats.map((cat, gi) => {
          const top = PT + gi * GROUP_H;
          const baseY = top + GROUP_H - 52; // dots stack upward from here; mean/SD/box below
          // Keep the rows (not just the numbers) so each dot links to its table row (D1)
          const groupRows = rows.filter(r => groupOf(r[catVar]) === cat && !isNaN(toNum(r[numVar])));
          const groupNums = groupRows.map(r => toNum(r[numVar]));
          const summary = numericSummary(groupNums);
          // First pass: bin counts to find the tallest stack, so dots fit the band
          const binOf = v => Math.round(sx(v) / (dotR * 2 + 1));
          const binCounts = {};
          groupNums.forEach(v => { const k = binOf(v); binCounts[k] = (binCounts[k] || 0) + 1; });
          const tallest = Math.max(1, ...Object.values(binCounts));
          const avail = baseY - top - 4;
          const spacing = Math.min(dotR * 2 + 1, avail / tallest);
          const stacks = {};
          const groupDots = groupNums.map((v, di) => {
            const x = sx(v); const key = binOf(v);
            stacks[key] = (stacks[key] || 0) + 1;
            return { id: groupRows[di]._id, x, y: baseY - (stacks[key] - 1) * spacing };
          });
          const color = colorAt(gi);
          // Ruler snap candidates for this band (mean ring sits on the triangle; box
          // quartiles on the box; each dot is a plain constant). Skip the "Other" bucket
          // for measures (no clean spec), but its dots are still snappable constants.
          if (rulerOn) {
            const gb = baseY + dotR + 1, by = baseY + dotR + 32;
            if (summary && cat !== OTHER_CAT) {
              rulerCands.push({ value: summary.mean, spec: { fn: "mean", variable: numVar, condVar: catVar, condVal: String(cat) }, label: "mean(" + cat + ")", y: gb + 5 });
              if (rulerShowBox) rulerCands.push(
                { value: summary.median, spec: { fn: "median", variable: numVar, condVar: catVar, condVal: String(cat) }, label: "median(" + cat + ")", y: by },
                { value: summary.q1, spec: { fn: "q1", variable: numVar, condVar: catVar, condVal: String(cat) }, label: "Q1(" + cat + ")", y: by },
                { value: summary.q3, spec: { fn: "q3", variable: numVar, condVar: catVar, condVal: String(cat) }, label: "Q3(" + cat + ")", y: by });
            }
            groupDots.forEach((d, k) => rulerCands.push({ value: groupNums[k], spec: null, label: null, y: d.y }));
          }
          return (
            <g key={cat}>
              {/* group separator */}
              {gi > 0 && <line x1={PL} y1={top} x2={W - PR} y2={top} stroke="var(--grid)" strokeWidth={1} />}
              {/* group label */}
              <text x={PL - 10} y={top + GROUP_H / 2 - 6} textAnchor="end" dominantBaseline="middle"
                fontSize={13} fill="var(--text-2)" fontWeight={600}>{cat}</text>
              <text x={PL - 10} y={top + GROUP_H / 2 + 8} textAnchor="end" dominantBaseline="middle"
                fontSize={12} fill="var(--text-3)">n={groupNums.length}</text>
              {/* baseline */}
              <line x1={PL} y1={baseY + dotR + 1} x2={W - PR} y2={baseY + dotR + 1} stroke="var(--border-2)" strokeWidth={1} />
              {/* dots — one per row; click toggles linked highlighting (D1) */}
              {groupDots.map((d, i) => {
                const sel = isSel(d.id);
                return <circle key={d.id || i} cx={d.x} cy={d.y} r={sel ? dotR + 1 : dotR}
                  fill={sel ? "#f97316" : color}
                  fillOpacity={sel ? 1 : Math.min(0.85, Math.max(0.3, 60 / Math.sqrt(groupDots.length + 1)))}
                  stroke={sel ? "#1f2937" : "var(--dot-outline)"} strokeWidth={sel ? 1.5 : 0.75}
                  style={selectable ? { cursor:"pointer" } : undefined}
                  onClick={selectable && d.id ? () => onToggleSelect(d.id) : undefined} />;
              })}
              {/* per-group density curve — value→x, density scaled to the band height */}
              {showDensity && summary && (() => {
                const curve = kdeCurve(groupNums, lo, hi);
                if (!curve) return null;
                const peak = Math.max(...curve.map(p => p.y)) || 1;
                const hgt = Math.max(0, avail) * 0.95;
                const d = curve.map((p, i) => (i ? "L" : "M") + sx(p.x).toFixed(1) + " " + (baseY - (p.y / peak) * hgt).toFixed(1)).join(" ");
                return <path d={d} fill="none" stroke={color} strokeWidth={1.75} strokeOpacity={0.85} style={{ pointerEvents:"none" }} />;
              })()}
              {/* ±1 SD — runs through the mean triangle, centred on the mean */}
              {showSD && summary && (() => {
                const gb = baseY + dotR + 1, y = gb + 5, mx = sx(summary.mean);
                const loX = sx(summary.mean - summary.sd), hiX = sx(summary.mean + summary.sd);
                const labelX = Math.max(hiX, mx + 9) + 4;
                return (
                  <g>
                    <line x1={loX} y1={y} x2={hiX} y2={y} stroke="var(--sd-mark)" strokeWidth={2} />
                    <line x1={loX} y1={y - 3} x2={loX} y2={y + 3} stroke="var(--sd-mark)" strokeWidth={2} />
                    <line x1={hiX} y1={y - 3} x2={hiX} y2={y + 3} stroke="var(--sd-mark)" strokeWidth={2} />
                    {showValues && <TrackText x={labelX} y={y + 3} anchor="start" color="var(--amber-ink)" fontSize={11} label={"±SD " + parseFloat(summary.sd.toFixed(2))} spec={grpSpec(cat, "sd")} {...tp} />}
                  </g>
                );
              })()}
              {/* mean triangle — tip on the group baseline (axis being averaged) */}
              {showMean && summary && (() => {
                const gb = baseY + dotR + 1, mx = sx(summary.mean);
                return (
                  <g>
                    <polygon points={mx + "," + gb + " " + (mx - 5) + "," + (gb + 10) + " " + (mx + 5) + "," + (gb + 10)} fill="#10b981" stroke="#059669" strokeWidth={0.8} />
                    {showValues && <TrackText x={mx} y={gb + 20} anchor="middle" color="var(--green-ink)" fontSize={12} label={fmt(summary.mean)} spec={grpSpec(cat, "mean")} {...tp} />}
                  </g>
                );
              })()}
              {/* boxplot — separated below */}
              {showBox && summary && (() => {
                const by = baseY + dotR + 32;
                return (
                  <g>
                    <line x1={sx(summary.whiskerLo)} y1={by} x2={sx(summary.whiskerHi)} y2={by} stroke="var(--box-line)" strokeWidth={1.2} />
                    <line x1={sx(summary.whiskerLo)} y1={by - 4} x2={sx(summary.whiskerLo)} y2={by + 4} stroke="var(--box-line)" strokeWidth={1.2} />
                    <line x1={sx(summary.whiskerHi)} y1={by - 4} x2={sx(summary.whiskerHi)} y2={by + 4} stroke="var(--box-line)" strokeWidth={1.2} />
                    <rect x={sx(summary.q1)} y={by - 5} width={Math.max(1, sx(summary.q3) - sx(summary.q1))} height={10} fill="rgba(99,102,241,0.15)" stroke={color} strokeWidth={1.2} />
                    <line x1={sx(summary.median)} y1={by - 5} x2={sx(summary.median)} y2={by + 5} stroke={color} strokeWidth={2} />
                    {showValues && <TrackText x={sx(summary.median)} y={by + 15} anchor="middle" color="var(--accent-ink)" fontSize={12} label={fmt(summary.median)} spec={grpSpec(cat, "median")} {...tp} />}
                  </g>
                );
              })()}
              {/* Divider region read-outs for this group, at the top of its band. The
                  count / proportion are conditioned on this group (collectable in Sample
                  Results); the "Other" bucket has no clean target, so it stays plain. */}
              {divOn && divCuts && divCuts.length > 0 && (divShowCount || divShowPct) && (
                <RegionLabels regions={divMulti ? binRegions(groupNums, divCuts) : regions(groupNums, divCuts)} sx={sx} xL={PL} xR={W - PR}
                  y={top + 10} showCount={divShowCount} showPct={divShowPct} total={groupNums.length}
                  base={{ variable: numVar, condVar: catVar, condVal: String(cat) }}
                  trackProps={cat === OTHER_CAT ? { ...tp, trackable: false } : tp} />
              )}
            </g>
          );
        })}

        {/* Shared divider cut(s) as ruler snap targets — appended after the group means
            (which carry a y) so a measure still wins an exact coincident tie at its marker. */}
        {rulerOn && divOn && divCuts && divCuts.length ? (divCuts.forEach((c, k) => rulerCands.push(
          { value: c, cut: k, spec: null,
            label: divMulti ? "cut " + (k + 1) : divCuts.length > 1 ? (k === 0 ? "low cut" : "high cut") : "cut", y: null })), null) : null}

        {/* x axis */}
        <line x1={PL} y1={H - PB} x2={W - PR} y2={H - PB} stroke="var(--axis)" strokeWidth={1.5} />
        {ticks.map((t, i) => (
          <g key={"t"+i}>
            <line x1={sx(t)} y1={H - PB} x2={sx(t)} y2={H - PB + 4} stroke="var(--axis)" />
            <text x={sx(t)} y={H - PB + 16} textAnchor="middle" fontSize={12} fill="var(--text-3)">{fmt(t)}</text>
          </g>
        ))}
        <text x={PL + iW / 2} y={H - 6} textAnchor="middle" fontSize={13} fill="var(--text-2)" fontWeight={600}>{nm(numVar)} (by {nm(catVar)})</text>
        {/* Divider tool (Phase 6) — one shared cut line across every group band */}
        {divOn && divCuts && divCuts.length > 0 && (
          <DividerLines W={W} topY={PT} botY={H - PB} sx={sx}
            inv={px => lo + ((px - PL) / iW) * (hi - lo)}
            xlo={lo} xhi={hi} cuts={divCuts} onChange={onDivChange} snapCandidates={divSnap} fmt={divFmt} />
        )}
        {/* Ruler tool (Phase 6c) — one shared measurement bar across every group band */}
        {rulerOn && rulerPts && rulerPts.length === 2 && (
          <RulerOverlay W={W} topY={PT} botY={H - PB} lineY={PT + 22} sx={sx}
            inv={px => lo + ((px - PL) / iW) * (hi - lo)}
            xlo={lo} xhi={hi} pts={rulerPts} onChange={onRulerChange} snapCandidates={rulerCands}
            fmt={rulerFmt} trackable={trackable} onTrackDiff={onTrackDiff}
            cutSnap={divOn ? divSnap : null}
            onCutDrag={divOn && divCuts ? (k, v) => { const next = divCuts.slice(); next[k] = v; onDivChange(next); } : null} />
        )}
      </svg>
      {allCats.length > 10 && (
        <button onClick={onToggleExpand} style={{ ...btnNav, fontSize:12, marginTop:4 }}>
          {expanded ? "Collapse to top 10 groups" : `Show all ${allCats.length} groups`}
        </button>
      )}
    </div>
  );
}


export { Plot, SampleResults, DerivedBuilder, DistributionPlot, EDAPlot, DataTable, CollectTable, UniCatPlot, CatCatGrid, SplitDotPlots };
