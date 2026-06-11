import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from "react";
import { iSm, btnX, btnNav, btnPlus, ctrlLbl } from "../lib/styles";
import { COLORS, clamp, toNum, minutesToTime, colKind, collapseCats, OTHER_CAT, fitDotR, uid } from "../lib/util";
import { numericSummary, lsFit, statLabel, statKey, computeStat, FN_OPTS, quantile } from "../lib/stats";
import { evalExpr, validateExpr, lexExpr, aliasFor } from "../lib/expr";
import { useContainerWidth } from "../lib/hooks";
import { makeScale, stackDots } from "../lib/scale";
import { clampVal, snapValue, snapMeasure, regions, conservativeBand } from "../lib/measure";
import { Sel, ChkLabel, InlineEdit, NumInput } from "./ui";

// Format a proportion (0–1) for on-plot read-outs — fixed 3 decimals so the plots
// match the proportion-valued collected statistics (e.g. 0.851, not 85%).
const fmtP = v => (Number.isFinite(v) ? v.toFixed(3) : "—");

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
  return (
    <g style={{ cursor:"pointer" }} onClick={e => { e.stopPropagation(); onTrackStat(spec); }}>
      <title>{tracked ? "Tracking " + lbl + " — click to remove" : "Click to track " + lbl}</title>
      <rect x={rx} y={y - h + 3} width={w} height={h} rx={3}
        fill={tracked ? "#c7d2fe" : "#eef2ff"} stroke={tracked ? "#6366f1" : "#c7d2fe"} strokeWidth={1} />
      <text x={x} y={y} textAnchor={anchor} fontSize={fontSize} fill={tracked ? "#3730a3" : color} fontWeight={800}>{label}</text>
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
      <span data-mkey={statKey(spec)} onClick={e => { e.stopPropagation(); measureSelect(spec); }}
        title={sel ? "Selected as " + measureRole + " — click to deselect" : "Click to pick as A or B for the ruler difference"}
        style={{ cursor:"pointer", padding:"0 3px", borderRadius:4, fontWeight:700,
          background: sel ? "#ccfbf1" : "transparent",
          color: sel ? "#0f766e" : (dim ? "#bbb" : "#0d9488"),
          boxShadow: sel ? "none" : "inset 0 -1px 0 #5eead4" }}>
        {text}{sel ? " " + measureRole : ""}
      </span>
    );
  }
  if (!trackable || !spec) return <span style={{ color: dim ? "#bbb" : "#3730a3" }}>{text}</span>;
  const lbl = statLabel(spec, nameOf);
  const tracked = trackedKeys && trackedKeys.has(statKey(spec));
  return (
    <span onClick={e => { e.stopPropagation(); onTrackStat(spec); }}
      title={tracked ? "Tracking " + lbl + " — click to remove" : "Click to track " + lbl}
      style={{ cursor:"pointer", padding:"0 3px", borderRadius:4, fontWeight:700,
        background: tracked ? "#c7d2fe" : "transparent",
        color: tracked ? "#1e1b4b" : "#4338ca",
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
function DividerLines({ W, topY, botY, sx, inv, xlo, xhi, cuts, onChange, snapCandidates, shade, fmt, dir = "none" }) {
  const [dragI, setDragI] = useState(-1);
  const pxPerUnit = Math.abs(sx(xhi) - sx(xlo)) / (Math.abs(xhi - xlo) || 1);
  const xL = sx(xlo), xR = sx(xhi);

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

  // Region shading (behind, translucent so dots show through). Single → split the two
  // sides; range → highlight the middle band between the two lines.
  const shades = [];
  if (shade && cuts.length === 1) {
    const xv = sx(cuts[0]);
    // Two-sided: shade both halves faintly. Directional: shade only the focused tail (the
    // arrow points into it), the side whose proportion is the p-value / critical value.
    if (dir === "left") shades.push(<rect key="lt" x={xL} y={topY} width={Math.max(0, xv - xL)} height={botY - topY} fill="#3b82f6" fillOpacity={0.14} />);
    else if (dir === "right") shades.push(<rect key="ge" x={xv} y={topY} width={Math.max(0, xR - xv)} height={botY - topY} fill="#f59e0b" fillOpacity={0.14} />);
    else {
      shades.push(<rect key="lt" x={xL} y={topY} width={Math.max(0, xv - xL)} height={botY - topY} fill="#3b82f6" fillOpacity={0.07} />);
      shades.push(<rect key="ge" x={xv} y={topY} width={Math.max(0, xR - xv)} height={botY - topY} fill="#f59e0b" fillOpacity={0.07} />);
    }
  } else if (shade && cuts.length === 2) {
    const a = sx(Math.min(cuts[0], cuts[1])), b = sx(Math.max(cuts[0], cuts[1]));
    shades.push(<rect key="mid" x={a} y={topY} width={Math.max(0, b - a)} height={botY - topY} fill="#6366f1" fillOpacity={0.1} />);
  }
  // Direction arrow for a one-sided single divider: a short horizontal arrow at mid-height
  // pointing into the shaded tail (blue ◂ left, orange ▸ right).
  let arrow = null;
  if (dir !== "none" && cuts.length === 1) {
    const x = sx(cuts[0]), my = (topY + botY) / 2, right = dir === "right";
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
      {shades}
      {arrow}
      {cuts.map((v, i) => {
        const x = sx(v);
        return (
          <g key={i} style={{ cursor:"ew-resize", touchAction:"none" }}
            onPointerDown={onDown(i)} onPointerMove={onMove} onPointerUp={onUp}>
            {/* wide transparent hit area for easy grabbing */}
            <line x1={x} y1={topY} x2={x} y2={botY} stroke="transparent" strokeWidth={14} />
            <line x1={x} y1={topY} x2={x} y2={botY} stroke="#6366f1" strokeWidth={dragI === i ? 2.5 : 1.5} strokeDasharray="4 3" />
            {/* the cut value, directly above the grab handle */}
            {fmt && <text x={x} y={topY - 12} textAnchor="middle" fontSize={9} fontWeight={700} fill="#4338ca">{fmt(v)}</text>}
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
    loOpen: r.key === "gt",
    hiOpen: r.key === "lt",
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
            {showCount && <TrackText x={both ? cx - 3 : cx} y={y} anchor={both ? "end" : "middle"} color="#475569" fontSize={9}
              label={String(r.n)} spec={regionSpec(r, "countBetween", base)} {...trackProps} />}
            {showPct && <TrackText x={both ? cx + 3 : cx} y={y} anchor={both ? "start" : "middle"} color="#475569" fontSize={9}
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
function RulerOverlay({ W, topY, botY, lineY, sx, inv, xlo, xhi, pts, onChange, snapCandidates, fmt, trackable, onTrackDiff }) {
  const [dragI, setDragI] = useState(-1);
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
      <line x1={xa} y1={lineY} x2={xb} y2={lineY} stroke="#0d9488" strokeWidth={1.5} />
      {pts.map((p, i) => {
        const x = sx(p.value);
        const ring = anchorOf(p);
        const big = dragI === i;
        return (
          <g key={i} style={{ cursor:"ew-resize", touchAction:"none" }}
            onPointerDown={onDown(i)} onPointerMove={onMove} onPointerUp={onUp}>
            {/* wide transparent hit area + visible guide line */}
            <line x1={x} y1={topY} x2={x} y2={botY} stroke="transparent" strokeWidth={14} />
            <line x1={x} y1={topY} x2={x} y2={botY} stroke="#0d9488" strokeWidth={big ? 2.5 : 1.5} strokeDasharray="2 3" />
            {/* anchor ring over the exact target this endpoint is tied to */}
            {ring && (
              <g>
                <circle cx={ring.x} cy={ring.y} r={big ? 8 : 6.5} fill="none" stroke="#0d9488" strokeWidth={big ? 2.5 : 1.8} />
                <circle cx={ring.x} cy={ring.y} r={1.6} fill="#0d9488" />
              </g>
            )}
            {/* end cap on the connector bar */}
            <line x1={x} y1={lineY - 5} x2={x} y2={lineY + 5} stroke="#0d9488" strokeWidth={2} />
            {/* handle + letter */}
            <rect x={x - 6} y={lineY - 9} width={12} height={9} rx={2} fill="#0d9488" stroke="#fff" strokeWidth={1} />
            <text x={x} y={lineY - 1.5} textAnchor="middle" fontSize={7} fontWeight={800} fill="#fff">{i === 0 ? "A" : "B"}</text>
            {/* what this endpoint landed on (measure name or constant value) */}
            <text x={x} y={lineY + 16} textAnchor="middle" fontSize={8} fontWeight={600} fill="#0f766e">{opLabel(p)}</text>
          </g>
        );
      })}
      {/* signed-distance read-out at the bar midpoint */}
      <text x={midX} y={lineY - 7} textAnchor="middle" fontSize={9} fontWeight={800} fill="#0f766e">
        A − B = {fmtNum(diff)}
      </text>
      {/* ＋ track affordance (Sample Results only) */}
      {canTrack && (() => {
        const ty = lineY - 20, label = "＋ track";
        const w = label.length * 5.4 + 10;
        return (
          <g style={{ cursor:"pointer" }} onClick={e => { e.stopPropagation(); onTrackDiff(a, b); }}>
            <title>Track A − B as a derived column in Collect Statistics</title>
            <rect x={midX - w / 2} y={ty - 9} width={w} height={13} rx={3} fill="#ccfbf1" stroke="#5eead4" strokeWidth={1} />
            <text x={midX} y={ty} textAnchor="middle" fontSize={8} fontWeight={800} fill="#0f766e">{label}</text>
          </g>
        );
      })()}
    </g>
  );
}

// ── Residual overlay (Phase 6c, mechanic 2) ────────────────────────────────────
// Scatter-plot ruler: pick a data point and read its vertical residual to the LS line
// (y − ŷ). One endpoint is the point, the other its foot on the line at the same x.
// Visual-only — the measured point has no stable cross-repetition identity, so its
// trackability is deferred. Drawn inside the scatter <svg>; a transparent capture rect
// lets a click/drag select the nearest point.
function ResidualOverlay({ scatterPts, ls, sx, toPy, xlo, xhi, W, area, sel, onSel, fmtY }) {
  const [drag, setDrag] = useState(false);
  const pick = (e) => {
    const svg = e.currentTarget.ownerSVGElement || e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const ratio = W / (rect.width || W);
    const cx = (e.clientX - rect.left) * ratio, cy = (e.clientY - rect.top) * ratio;
    let best = -1, bd = Infinity;
    scatterPts.forEach((p, i) => { const d = Math.hypot(p.px - cx, p.py - cy); if (d < bd) { bd = d; best = i; } });
    if (best >= 0) onSel(best);
  };
  const down = e => { e.stopPropagation(); try { e.currentTarget.setPointerCapture(e.pointerId); } catch (x) {} setDrag(true); pick(e); };
  const move = e => { if (drag) pick(e); };
  const up = e => { try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (x) {} setDrag(false); };

  const lineY1 = toPy(ls.slope * xlo + ls.intercept), lineY2 = toPy(ls.slope * xhi + ls.intercept);
  const p = (sel != null && sel >= 0 && sel < scatterPts.length) ? scatterPts[sel] : null;
  let footY = null, resid = NaN, midY = null;
  if (p) { const yhat = ls.slope * p.x + ls.intercept; footY = toPy(yhat); resid = p.y - yhat; midY = (p.py + footY) / 2; }
  const lbl = p ? "y − ŷ = " + fmtY(resid) : "";

  return (
    <g>
      {/* transparent capture area for click/drag selection */}
      <rect x={area.x} y={area.y} width={area.w} height={area.h} fill="transparent"
        style={{ cursor:"crosshair", touchAction:"none" }}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} />
      {/* the LS line the residual is measured to */}
      <line x1={sx(xlo)} y1={lineY1} x2={sx(xhi)} y2={lineY2} stroke="#0d9488" strokeWidth={1.6} />
      {p && (
        <g>
          <line x1={p.px} y1={p.py} x2={p.px} y2={footY} stroke="#0d9488" strokeWidth={2} strokeDasharray="3 2" />
          <circle cx={p.px} cy={footY} r={3} fill="#fff" stroke="#0d9488" strokeWidth={1.6} />
          <circle cx={p.px} cy={p.py} r={6} fill="none" stroke="#0d9488" strokeWidth={2} />
          <rect x={p.px + 7} y={midY - 8} width={lbl.length * 5 + 8} height={14} rx={3} fill="#ccfbf1" stroke="#5eead4" strokeWidth={1} />
          <text x={p.px + 11} y={midY + 2} fontSize={9} fontWeight={800} fill="#0f766e">{lbl}</text>
        </g>
      )}
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
      <line x1={g.ax} y1={g.ay} x2={g.bx} y2={g.by} stroke="#0d9488" strokeWidth={2} />
      <circle cx={g.ax} cy={g.ay} r={4} fill="#0d9488" />
      <circle cx={g.bx} cy={g.by} r={4} fill="#0d9488" />
      <g transform={"translate(" + mx + "," + my + ")"}>
        <rect x={-lw / 2} y={trackable ? -23 : -10} width={lw} height={trackable ? 35 : 18} rx={5} fill="#ffffff" stroke="#5eead4" strokeWidth={1.5} />
        <text x={0} y={trackable ? -10 : 3} textAnchor="middle" fontSize={11} fontWeight={800} fill="#0f766e">{diffLabel}</text>
        {trackable && (
          <g style={{ cursor:"pointer", pointerEvents:"auto" }} onClick={e => { e.stopPropagation(); onTrack(); }}>
            <rect x={-pw / 2} y={2} width={pw} height={14} rx={3} fill="#ccfbf1" stroke="#5eead4" strokeWidth={1} />
            <text x={0} y={12} textAnchor="middle" fontSize={9} fontWeight={800} fill="#0f766e">{pill}</text>
          </g>
        )}
      </g>
    </svg>
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
function Plot({ rows, headers, nameOf, xVar, yVar, setXVar, setYVar, width, onTrackStat, onTrackDiff, trackedKeys, varKinds, selectedIds, onToggleSelect, onDivider }) {
  // `headers` / `xVar` / `yVar` are device IDS on sampler plots; `nm(id)` resolves the
  // display name. EDA passes real header strings and no `nameOf`, so `nm` is identity
  // there and every label renders unchanged.
  const nm = nameOf || (h => h);
  const [dotSize, setDotSize] = useState(5);

  // Stat overlay toggles
  const [showBox, setShowBox] = useState(false);
  const [showMean, setShowMean] = useState(false);
  const [showSD, setShowSD] = useState(false);
  const [showLS, setShowLS] = useState(false);
  const [showValues, setShowValues] = useState(false);
  // Categorical cell labels
  const [showCount, setShowCount] = useState(true);
  const [showPct, setShowPct] = useState(false);
  // Collapse high-cardinality categorical axes (>10 categories)
  const [expandCats, setExpandCats] = useState(false);
  // Divider measurement tool (Phase 6): off by default; opt-in per plot. The on-plot
  // count / proportion read-outs are themselves off until toggled (like the categorical
  // # Count / % Percent labels).
  const [divOn, setDivOn] = useState(false);
  const [divRange, setDivRange] = useState(false);
  const [divCuts, setDivCuts] = useState([]);
  const [divShowCount, setDivShowCount] = useState(false);
  const [divShowPct, setDivShowPct] = useState(false);
  // Inference framing for the single divider: `divDir` picks a one-sided tail (an arrow
  // highlights it and only that tail's proportion shows → a p-value); `divBy` records whether
  // the student last set a VALUE (drag/type → read a probability) or a PERCENTAGE (`divPct`,
  // a tail/middle fraction → the cut snaps to that empirical quantile → read a critical value
  // / CI). The two are linked: editing the value box switches to "value", the % box to "pct".
  const [divDir, setDivDir] = useState("none"); // "none" | "left" | "right"
  const [divBy, setDivBy] = useState("value");  // "value" | "pct"
  const [divPct, setDivPct] = useState(0.05);   // fraction: tail (single) / middle (range)
  // Ruler measurement tool (Phase 6c): off by default; opt-in per plot. Endpoints carry
  // their snapped operand ({ value, spec, label }) so a difference of two measures can be
  // tracked as a derived column.
  const [rulerOn, setRulerOn] = useState(false);
  const [rulerPts, setRulerPts] = useState([]);
  // Mechanic 2 (residual): which scatter point is measured. Mechanic 3 (cat difference):
  // up to two clicked stat specs whose difference the ruler reports.
  const [residSel, setResidSel] = useState(null);
  const [catSel, setCatSel] = useState([]);

  const plotRef = useRef(null);
  const measuredW = useContainerWidth(plotRef, 280, 760);
  const plotW = width || measuredW;

  // Each column's type as colInfo[col] = {numeric,time}. Sampler plots pass an
  // authoritative `varKinds` (derived from device outcomes) so a column's kind is fixed
  // up front and can't flip when a rare non-numeric draw appears; EDA passes none and
  // falls back to inferring from the rows via colKind (its data is a static upload).
  const colInfo = useMemo(() => {
    const map = {};
    headers.forEach(h => { map[h] = (varKinds && varKinds[h]) || colKind(rows, h); });
    return map;
  }, [rows, headers, varKinds]);

  // Keep X/Y valid as the available columns change (callbacks into the parent's state)
  useEffect(() => { if (headers.length && !headers.includes(xVar)) setXVar(headers[0]); }, [headers.join(",")]);
  useEffect(() => { if (yVar !== "none" && (!headers.includes(yVar) || yVar === xVar)) setYVar("none"); }, [headers.join(","), xVar]);

  if (!rows.length) return <div style={{ color:"#bbb", padding:24, textAlign:"center" }}>No data yet.</div>;
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

  // ── Univariate numeric summary (for box/mean/SD overlays) ──
  const xNums = rows.map(r => toNum(r[xVar])).filter(v => !isNaN(v));
  const xSummary = xNumeric ? numericSummary(xNums) : null;
  const fmtX = xTime ? minutesToTime : (v => parseFloat(v.toFixed(2)));

  // LS fit for bivariate numeric
  let ls = null;
  if (bivariate && xNumeric && yNumeric) {
    const pairs = rows.map(r => ({ x: toNum(r[xVar]), y: toNum(r[yVar]) })).filter(p => !isNaN(p.x) && !isNaN(p.y));
    ls = lsFit(pairs);
  }

  const sx = v => PL + xS.scale(v);
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
    if (showMean) overlayBottom = Math.max(overlayBottom, showValues ? meanValY : meanBaseY);
    if (showSD) overlayBottom = Math.max(overlayBottom, sdBarY + 4);
    if (showBox) overlayBottom = Math.max(overlayBottom, showValues ? medianValY : boxCy + 9);
  }
  const tickLblY = hasUniOverlay ? overlayBottom + 14 : axisY + 16;
  const H = tickLblY + 18; // tick labels + axis title

  // Which toggle groups apply to the current variable selection
  const showStatToggles = (xNumeric && !bivariate) || (bivariate && (xNumeric !== yNumeric));
  const showCatToggles = (!bivariate && !xNumeric) || (bivariate && !xNumeric && !yNumeric);
  const toggleExpand = () => setExpandCats(e => !e);

  // ── Click-to-track ──
  // When a parent supplies onTrackStat (Sample Results), the numbers drawn on the
  // plot become clickable: clicking one toggles tracking that statistic in Collect
  // Statistics. Numeric overlay values are forced visible here (so there is always
  // a number to click), which makes the separate "Show values" toggle redundant.
  const trackable = !!onTrackStat;
  const showVals = showValues || trackable;
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
  const dividerAvailable = (!bivariate && xNumeric) || (bivariate && xNumeric && !yNumeric);
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
    const allCats = Object.keys(catCount).sort();
    const cats = collapseCats(allCats, catCount, expandCats).shown;
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
  const pctActive = divBy === "pct" && (divRange || divDir !== "none");
  let effCuts = [];
  if (showDivider) {
    const { lo, hi } = divDomain, want = divRange ? 2 : 1;
    if (pctActive && divDomain.values.length) {
      const vals = divDomain.values, m = divPct;
      // Range (CI) → the smallest achievable central band covering ≥ m (conservative — covers
      // at least the set proportion; `conservativeBand`). Single tail → a standard interpolating
      // percentile critical value (the 1-m percentile for a right tail, the m percentile for a
      // left tail; constraint #5 `quantile`).
      const sorted = [...vals].sort((a, b) => a - b); // quantile() expects sorted input
      const q = t => clampVal(quantile(sorted, t), lo, hi);
      effCuts = divRange
        ? conservativeBand(vals, m).map(c => clampVal(c, lo, hi))
        : [q(divDir === "right" ? 1 - m : m)];
    } else {
      const inRange = v => v >= lo && v <= hi;
      effCuts = (divCuts.length === want && divCuts.every(inRange))
        ? divCuts
        : (divRange ? [lo + (hi - lo) / 3, lo + 2 * (hi - lo) / 3] : [(lo + hi) / 2]);
    }
  }
  // Editing a value (drag or type) makes the cut authoritative (value mode); typing a
  // percentage snaps the cut to that quantile (pct mode). The two boxes stay linked.
  const onDivDrag = next => { setDivCuts(next); setDivBy("value"); };
  const setCut = (i, raw) => {
    const v = clampVal(parseFloat(raw), divDomain.lo, divDomain.hi);
    if (isNaN(v)) return;
    const next = effCuts.slice(); next[i] = v; setDivCuts(next); setDivBy("value");
  };
  const setPct = raw => {
    const p = parseFloat(raw);
    if (isNaN(p)) return;
    setDivPct(clampVal(p, 0.0001, 0.9999)); setDivBy("pct"); // stored as a proportion (0–1)
  };
  // Overall regions for the univariate on-plot read-out (num × cat read-outs are
  // computed per-group inside SplitDotPlots).
  const divRegions = showDivider ? regions(divDomain.values, effCuts) : null;
  // The single divider's focused region when a tail direction is chosen (right → the ≥ side,
  // left → the < side); null for two-sided / range. Drives the one-tail read-out + the linked
  // % box (its proportion is what "tail %" shows in value mode).
  const divDirected = showDivider && !divRange && divDir !== "none";
  // The focused tail is always inclusive of the cut: right → x ≥ v ("ge", already inclusive);
  // left → x ≤ v (built here so it matches the generated p-value `mean(vec <= v)`, not the
  // strict "lt" region). Range → the middle band.
  const focusRegion = !divRegions ? null
    : divRange ? divRegions.find(r => r.key === "mid")
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
    divFmt: showDivider ? divDomain.fmt : null };
  // Report the active divider to a host that wants to mirror it (the Collect plot lifts this
  // into App so the generated inference code uses the real cutoff / framing). `variable` is
  // the current X header; `cuts` are in stat units. Null when the divider is off.
  useEffect(() => {
    if (!onDivider) return;
    onDivider(showDivider
      ? { variable: xVar, cuts: effCuts, range: divRange, dir: divRange ? "none" : divDir, by: divBy, pct: divPct }
      : null);
  }, [onDivider, showDivider, xVar, divRange, divDir, divBy, divPct, effCuts.join(",")]);

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
  const rulerResidAvail = bivariate && xNumeric && yNumeric && !!ls;
  const rulerCatDiffAvail = (bivariate && !xNumeric && !yNumeric) || (!bivariate && !xNumeric);
  const rulerAvailable = rulerAxisAvail || rulerResidAvail || rulerCatDiffAvail;
  const showRuler = rulerOn && rulerAxisAvail && !!divDomain; // mechanic 1 (axis)
  const showResidRuler = rulerOn && rulerResidAvail;          // mechanic 2 (residual)
  const showCatRuler = rulerOn && rulerCatDiffAvail;          // mechanic 3 (cat difference)

  // Resolve a stored endpoint to its live value: a measure recomputes from `rows` (so a
  // new single sample moves it), a constant keeps its number; clamp into the domain.
  const resolveVal = pt => {
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
  }
  // A stored endpoint set is reusable only if its anchors still reference this plot's
  // variables (else a variable switch left them stale → fall back to fresh defaults).
  const specOk = p => !p.spec || (p.spec.variable === xVar && (!p.spec.condVar || p.spec.condVar === yVar));
  let effPts = [];
  if (showRuler) {
    const { lo, hi } = divDomain;
    const base = (rulerPts.length === 2 && rulerPts.every(specOk))
      ? rulerPts
      : [{ value: lo + (hi - lo) / 3, spec: null, label: null }, { value: lo + 2 * (hi - lo) / 3, spec: null, label: null }];
    effPts = base.map(p => ({ ...p, value: clampVal(resolveVal(p), lo, hi) }));
  }
  const setRulerPt = (i, raw) => {
    const v = clampVal(parseFloat(raw), divDomain.lo, divDomain.hi);
    if (isNaN(v)) return;
    const next = effPts.slice(); next[i] = { value: v, spec: null, label: null }; setRulerPts(next);
  };
  const rulerProps = { rulerOn: showRuler, rulerPts: effPts, onRulerChange: setRulerPts,
    rulerFmt: showRuler ? divDomain.fmt : null, rulerShowBox: showBox, onTrackDiff };

  // Mechanic 2 (residual): scatter points in pixel + data space, with the measured point
  // defaulting to the largest |residual| so the tool shows something on enable.
  const toPy = v => PT + iH - (yS ? yS.scale(v) : 0);
  let scatterPts = null, residIdx = -1, residual = NaN;
  if (showResidRuler) {
    scatterPts = valid.map((r, i) => ({ px: dots[i].x, py: dots[i].y, x: toNum(r[xVar]), y: toNum(r[yVar]) }));
    if (scatterPts.length) {
      const resOf = p => p.y - (ls.slope * p.x + ls.intercept);
      residIdx = (residSel != null && residSel >= 0 && residSel < scatterPts.length)
        ? residSel
        : scatterPts.reduce((best, _, i) => Math.abs(resOf(scatterPts[i])) > Math.abs(resOf(scatterPts[best])) ? i : best, 0);
      residual = resOf(scatterPts[residIdx]);
    }
  }

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

  return (
    <div ref={plotRef} style={{ flex:"2 1 460px", minWidth:320 }}>
      {/* Controls */}
      <div style={{ display:"flex", gap:8, marginBottom:8, flexWrap:"wrap", alignItems:"center" }}>
        <Sel label="X" value={xVar} onChange={setXVar} options={headers} labels={headers.map(nm)} />
        <Sel label="Y" value={yVar} onChange={setYVar} options={["none", ...headers.filter(h => h !== xVar)]} labels={["— none —", ...headers.filter(h => h !== xVar).map(nm)]} />
        <label style={ctrlLbl}>dot size
          <input type="range" min={1} max={12} value={dotSize} onChange={e => setDotSize(+e.target.value)} style={{ width:55, marginLeft:4 }} />
        </label>
      </div>

      {/* Stat toggles — adapt to the variable types */}
      <div style={{ display:"flex", gap:10, marginBottom:8, flexWrap:"wrap", fontSize:12 }}>
        {showStatToggles && (
          <>
            <ChkLabel checked={showBox} onChange={setShowBox} label="Boxplot" />
            <ChkLabel checked={showMean} onChange={setShowMean} label="△ Mean" />
            <ChkLabel checked={showSD} onChange={setShowSD} label="↔ ±1 SD" />
          </>
        )}
        {bivariate && xNumeric && yNumeric && (
          <ChkLabel checked={showLS} onChange={setShowLS} label="LS Line" />
        )}
        {!trackable && (showStatToggles || (bivariate && xNumeric && yNumeric)) && (
          <ChkLabel checked={showValues} onChange={setShowValues} label="Show values" />
        )}
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
          <ChkLabel checked={divRange} onChange={v => { setDivRange(v); setDivBy("value"); }} label="↔ Range (band)" />
          {/* Single-divider tail direction: Both (two-sided) | ◂ Left | Right ▸. A tail focuses
              one side (arrow + one proportion → p-value / critical value). Switching framing
              returns to value mode so the % box re-reads the live proportion. */}
          {!divRange && (
            <div style={{ display:"flex", border:"1px solid #ddd", borderRadius:6, overflow:"hidden" }}>
              {[["none", "Both"], ["left", "◂ Left"], ["right", "Right ▸"]].map(([val, lab]) => (
                <button key={val} onClick={() => { setDivDir(val); setDivBy("value"); }}
                  style={{ padding:"3px 9px", border:"none", borderLeft: val === "none" ? "none" : "1px solid #eee",
                    background: divDir === val ? "#6366f1" : "#fff", color: divDir === val ? "#fff" : "#666",
                    fontSize:11, fontWeight:600, cursor:"pointer" }}>{lab}</button>
              ))}
            </div>
          )}
          {effCuts.map((v, i) => (
            <label key={i} style={ctrlLbl}>{divRange ? (i === 0 ? "low" : "high") : "at"}
              <NumInput step="any" value={v} round={4}
                onChange={n => setCut(i, n)} style={{ ...iSm, width:72, marginLeft:4 }} />
            </label>
          ))}
          {/* Linked percentage: range → middle %, single tail → tail %. Editing it snaps the
              cut(s) to the empirical quantile (→ critical value / CI); reading it shows the
              proportion at the current cut (→ p-value). Hidden for a two-sided single divider. */}
          {(divRange || divDir !== "none") && (
            <label style={{ ...ctrlLbl, color: divBy === "pct" ? "#4338ca" : undefined }}>{divRange ? "middle" : "tail"}
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
                style={{ marginLeft:4, padding:"1px 5px", borderRadius:4, background:"#ccfbf1", color:"#0f766e", fontWeight:700, fontSize:11 }}>◎ {p.label}</span>}
            </label>
          ))}
          <span style={{ color:"#0f766e", fontWeight:700 }}>A − B = {parseFloat((effPts[0].value - effPts[1].value).toFixed(4))}</span>
          <span style={{ color:"#94a3b8" }}>drag onto a dot, mean, median or quartile to anchor it; move up/down to pick between values at the same spot (a ring marks the target)</span>
        </div>
      )}

      {/* Ruler — residual read-out (mechanic 2, scatter; visual only) */}
      {showResidRuler && (
        <div style={{ display:"flex", gap:12, marginBottom:10, flexWrap:"wrap", alignItems:"center", fontSize:12 }}>
          <span style={{ color:"#0f766e", fontWeight:700 }}>residual y − ŷ = {scatterPts && scatterPts.length ? parseFloat(residual.toFixed(3)) : "—"}</span>
          <span style={{ color:"#94a3b8" }}>click or drag to a point — the bar shows its vertical distance to the LS line</span>
        </div>
      )}

      {/* Ruler — difference of two clicked numbers (mechanic 3, categorical). The read-out
          + ＋ track live ON the connector line over the plot; only a slim hint/clear here. */}
      {showCatRuler && (
        <div style={{ display:"flex", gap:10, marginBottom:10, flexWrap:"wrap", alignItems:"center", fontSize:12 }}>
          <span style={{ color:"#94a3b8" }}>
            {catSel.length < 2
              ? "click two numbers on the table to compare them — a connector line shows A − B"
              : "A − B (and ＋ track) are shown on the connector line"}
          </span>
          {catSel.length > 0 && <button onClick={() => setCatSel([])} style={{ ...btnX, fontSize:12 }}>clear</button>}
        </div>
      )}

      {/* Click-to-track hint (suppressed while the cat-difference ruler claims clicks) */}
      {trackable && !showCatRuler && (
        <div style={{ fontSize:11, color:"#bbb", marginBottom:8 }}>
          Click a number on the plot to collect that statistic (click again to stop).
        </div>
      )}

      {/* Plot — rendering depends on variable types */}
      {(() => {
        // MODE 1: both categorical → grid of cells with stacked dots + count/%
        if (bivariate && !xNumeric && !yNumeric) {
          return <CatCatGrid rows={rows} xVar={xVar} yVar={yVar} nameOf={nameOf} R={R} width={W}
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
          return <SplitDotPlots rows={rows} catVar={catVar} numVar={numVar} nameOf={nameOf} R={R} width={W} isTime={numTime}
            orientation={xNumeric ? "h" : "v"}
            showBox={showBox} showMean={showMean} showSD={showSD} showValues={showVals}
            expanded={expandCats} onToggleExpand={toggleExpand} {...trackProps} {...selProps} {...divProps} {...rulerProps} />;
        }
        // MODE 3: single categorical → binned stacked-dot cells
        if (!bivariate && !xNumeric) {
          return <UniCatPlot rows={rows} catVar={xVar} nameOf={nameOf} R={R} width={W}
            showCount={showCount} showPct={showPct} expanded={expandCats} onToggleExpand={toggleExpand} {...trackProps} {...selProps}
            measure={measure} />;
        }
        // MODE 4: scatter (both numeric) or univariate numeric → SVG
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
                <text x={sx(t)} y={tickLblY} textAnchor="middle" fontSize={10} fill="#999">{xS.fmt(t)}</text>
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
            <text x={PL + iW / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="#666" fontWeight={600}>{nm(xVar)}</text>
            {yS && <text x={14} y={PT + iH / 2} textAnchor="middle" fontSize={11} fill="#666" fontWeight={600} transform={"rotate(-90,14," + (PT + iH / 2) + ")"}>{nm(yVar)}</text>}
            {/* dots — one per row; click toggles linked highlighting (D1) */}
            {dots.map((d, i) => {
              const sel = isSel(d.id);
              return <circle key={d.id || i} cx={d.x} cy={d.y} r={sel ? R + 1 : R}
                fill={sel ? "#f97316" : "#3b82f6"}
                fillOpacity={sel ? 1 : Math.min(0.85, Math.max(0.2, 70 / Math.sqrt(dots.length + 1)))}
                stroke={sel ? "#7c2d12" : "none"} strokeWidth={sel ? 1.5 : 0}
                style={selectable ? { cursor:"pointer" } : undefined}
                onClick={selectable && d.id ? () => onToggleSelect(d.id) : undefined} />;
            })}
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
                      <TrackText x={PL + iW - 4} y={PT + 12} anchor="end" color="#ef4444" fontSize={10}
                        label={"slope " + parseFloat(ls.slope.toFixed(3))}
                        spec={{ fn:"slope", variable:xVar, variable2:yVar }} {...trackProps} />
                      <TrackText x={PL + iW - 4} y={PT + 28} anchor="end" color="#ef4444" fontSize={10}
                        label={"intercept " + parseFloat(ls.intercept.toFixed(3))}
                        spec={{ fn:"intercept", variable:xVar, variable2:yVar }} {...trackProps} />
                    </g>
                  ) : showValues && (
                    <text x={PL + iW - 4} y={PT + 12} textAnchor="end" fontSize={10} fill="#ef4444" fontWeight={700}>
                      ŷ = {parseFloat(ls.slope.toFixed(3))}x + {parseFloat(ls.intercept.toFixed(3))} · R² = {parseFloat(ls.r2.toFixed(3))}
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
                  <line x1={loX} y1={sdBarY} x2={hiX} y2={sdBarY} stroke="#f59e0b" strokeWidth={2} />
                  <line x1={loX} y1={sdBarY - 4} x2={loX} y2={sdBarY + 4} stroke="#f59e0b" strokeWidth={2} />
                  <line x1={hiX} y1={sdBarY - 4} x2={hiX} y2={sdBarY + 4} stroke="#f59e0b" strokeWidth={2} />
                  {showVals && <TrackText x={labelX} y={sdBarY + 3} anchor="start" color="#d97706" fontSize={9}
                    label={"±1 SD = " + parseFloat(xSummary.sd.toFixed(2))} spec={{ fn:"sd", variable:xVar }} {...trackProps} />}
                </g>
              );
            })()}
            {/* Mean triangle — tip sits on the x-axis (the axis being averaged) */}
            {showMean && xSummary && !bivariate && (() => {
              const mx = sx(xSummary.mean);
              return (
                <g>
                  <polygon points={mx + "," + axisY + " " + (mx - 6) + "," + meanBaseY + " " + (mx + 6) + "," + meanBaseY} fill="#10b981" stroke="#059669" strokeWidth={1} />
                  {showVals && <TrackText x={mx} y={meanValY} anchor="middle" color="#059669" fontSize={9}
                    label={fmtX(xSummary.mean)} spec={{ fn:"mean", variable:xVar }} {...trackProps} />}
                </g>
              );
            })()}
            {/* Boxplot (univariate numeric) — Tukey whiskers, separated below */}
            {showBox && xSummary && !bivariate && (
              <g>
                <line x1={sx(xSummary.whiskerLo)} y1={boxCy} x2={sx(xSummary.whiskerHi)} y2={boxCy} stroke="#475569" strokeWidth={1.5} />
                <line x1={sx(xSummary.whiskerLo)} y1={boxCy - 6} x2={sx(xSummary.whiskerLo)} y2={boxCy + 6} stroke="#475569" strokeWidth={1.5} />
                <line x1={sx(xSummary.whiskerHi)} y1={boxCy - 6} x2={sx(xSummary.whiskerHi)} y2={boxCy + 6} stroke="#475569" strokeWidth={1.5} />
                <rect x={sx(xSummary.q1)} y={boxCy - 9} width={Math.max(1, sx(xSummary.q3) - sx(xSummary.q1))} height={18} fill="rgba(99,102,241,0.18)" stroke="#6366f1" strokeWidth={1.5} />
                <line x1={sx(xSummary.median)} y1={boxCy - 9} x2={sx(xSummary.median)} y2={boxCy + 9} stroke="#6366f1" strokeWidth={2.5} />
                {showVals && <TrackText x={sx(xSummary.median)} y={medianValY} anchor="middle" color="#4338ca" fontSize={9}
                  label={fmtX(xSummary.median)} spec={{ fn:"median", variable:xVar }} {...trackProps} />}
              </g>
            )}
            {/* Divider tool (univariate numeric) */}
            {showDivider && (
              <>
                <DividerLines W={W} topY={PT} botY={PT + iH} sx={sx}
                  inv={px => xS.lo + ((px - PL) / iW) * (xS.hi - xS.lo)}
                  xlo={divDomain.lo} xhi={divDomain.hi} cuts={effCuts} onChange={onDivDrag}
                  snapCandidates={divDomain.snap} shade fmt={divDomain.fmt} dir={divRange ? "none" : divDir} />
                {/* Directional single divider shows only the focused tail's proportion (always),
                    plus the Count read-out when its checkbox is on; otherwise the usual regions. */}
                <RegionLabels regions={divDirected && focusRegion ? [focusRegion] : divRegions} sx={sx} xL={sx(divDomain.lo)} xR={sx(divDomain.hi)}
                  y={PT + 9} showCount={divShowCount} showPct={divShowPct || divDirected} total={divDomain.values.length}
                  base={{ variable: xVar }} trackProps={trackProps} />
              </>
            )}
            {/* Ruler tool (univariate numeric) */}
            {showRuler && (
              <RulerOverlay W={W} topY={PT} botY={PT + iH} lineY={PT + 22} sx={sx}
                inv={px => xS.lo + ((px - PL) / iW) * (xS.hi - xS.lo)}
                xlo={divDomain.lo} xhi={divDomain.hi} pts={effPts} onChange={setRulerPts}
                snapCandidates={rulerSnap} fmt={divDomain.fmt} trackable={trackable} onTrackDiff={onTrackDiff} />
            )}
            {/* Ruler — residual to LS line (scatter) */}
            {showResidRuler && scatterPts && scatterPts.length > 0 && (
              <ResidualOverlay scatterPts={scatterPts} ls={ls} sx={sx} toPy={toPy}
                xlo={xS.lo} xhi={xS.hi} W={W} area={{ x: PL, y: PT, w: iW, h: iH }}
                sel={residIdx} onSel={setResidSel} fmtY={v => parseFloat(Number(v).toFixed(3))} />
            )}
          </svg>
        );
      })()}
    </div>
  );
}

function StatDefiner({ stat, varNames, nameOf, sampleData, onChange, onRemove }) {
  // `varNames` are device IDS; the Sels show display names via `nm` but store the id in
  // the spec. `allVals`/`condVals` read rows by that id (correct, rows are id-keyed).
  const nm = nameOf || (h => h);
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
        <Sel label="Variable" value={stat.variable || ""} onChange={v => onChange({ ...stat, variable:v })} options={["", ...varNames]} labels={["—", ...varNames.map(nm)]} />
        {needsTwo && <Sel label="vs" value={stat.variable2 || ""} onChange={v => onChange({ ...stat, variable2:v })} options={["", ...varNames]} labels={["—", ...varNames.map(nm)]} />}
        {needsTarget && allVals.length > 0 && <Sel label="= value" value={stat.target || ""} onChange={v => onChange({ ...stat, target:v })} options={["", ...allVals]} labels={["—", ...allVals]} />}
        {needsTarget && !allVals.length && <label style={ctrlLbl}>= <input value={stat.target || ""} onChange={e => onChange({ ...stat, target:e.target.value })} style={{ ...iSm, width:50, marginLeft:3 }} /></label>}
        <Sel label="| filter" value={stat.condVar || "none"} onChange={v => onChange({ ...stat, condVar:v === "none" ? "" : v, condVal:"" })} options={["none", ...varNames]} labels={["(none)", ...varNames.map(nm)]} />
        {stat.condVar && <Sel label="=" value={stat.condVal || ""} onChange={v => onChange({ ...stat, condVal:v })} options={["", ...condVals]} labels={["—", ...condVals]} />}
      </div>
      <div style={{ marginTop:5, fontSize:11, color:"#6366f1", fontFamily:"monospace" }}>→ {statLabel(stat, nameOf)}</div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// DERIVED-STATISTIC CALCULATOR (Phase 5) — assemble a new column from the statistics
// already collected. The expression is TYPED into a text field using short column
// aliases (A, B, …) plus operators / numbers / parens / sqrt / abs; column chips
// insert their alias at the cursor as a shortcut. A live preview evaluates on the
// current sample, and the value backfills every existing row when the column is added.
//   columns: [{ id, label, value }]   (value = stat computed on the current sample)
//   onAdd(tokens, inputIds)
// ══════════════════════════════════════════════════════════════════════════════
function DerivedBuilder({ columns, onAdd }) {
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const inputRef = useRef(null);
  // Position-based aliases (A, B, …) ↔ stat ids, for both the chip legend and lexing.
  const aliasOf = useMemo(() => {
    const m = {}; columns.forEach((c, i) => { m[c.id] = aliasFor(i); }); return m;
  }, [columns.map(c => c.id).join(",")]);
  const aliasToId = useMemo(() => {
    const m = {}; columns.forEach((c, i) => { m[aliasFor(i)] = c.id; }); return m;
  }, [columns.map(c => c.id).join(",")]);
  const valById = useMemo(() => {
    const m = {}; columns.forEach(c => { m[c.id] = c.value; }); return m;
  }, [columns]);

  const { tokens, ok: lexOk } = lexExpr(text, aliasToId);
  const structOk = validateExpr(tokens);
  const valid = text.trim().length > 0 && lexOk && structOk;
  const preview = valid ? evalExpr(tokens, id => valById[id]) : NaN;
  const fmt = v => (typeof v === "number" && isFinite(v) ? parseFloat(v.toFixed(4)) : "—");

  // Insert a snippet at the caret (falls back to append) and keep focus after it.
  const insertAtCaret = snippet => {
    const el = inputRef.current;
    const start = el && el.selectionStart != null ? el.selectionStart : text.length;
    const end = el && el.selectionEnd != null ? el.selectionEnd : text.length;
    const next = text.slice(0, start) + snippet + text.slice(end);
    setText(next);
    requestAnimationFrame(() => { if (el) { el.focus(); const p = start + snippet.length; el.setSelectionRange(p, p); } });
  };

  const add = () => {
    if (!valid) return;
    const inputIds = [...new Set(tokens.filter(t => t.k === "col").map(t => t.id))];
    onAdd(tokens, inputIds, name.trim());
    setText(""); setName("");
  };

  if (!columns.length) {
    return <div style={{ fontSize:12, color:"#bbb", padding:"6px 0" }}>
      Track at least one statistic above first — then combine collected columns here (e.g. a difference of two means).
    </div>;
  }
  const msg = !text.trim() ? null : !lexOk ? "unrecognised symbol — use the column letters, numbers, + − × ÷ ^ ( ) sqrt abs" : !structOk ? "incomplete" : null;
  return (
    <div>
      {/* Column chips — click to insert the alias at the caret; legend shows full label */}
      <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:8 }}>
        {columns.map(c => (
          <button key={c.id} onClick={() => insertAtCaret(aliasOf[c.id])} title={"Insert " + aliasOf[c.id] + " = " + c.label + " (" + fmt(c.value) + " on this sample)"}
            style={{ ...btnPlus, color:"#4338ca", borderColor:"#a5b4fc", background:"#eef2ff", display:"inline-flex", gap:5, alignItems:"center" }}>
            <strong>{aliasOf[c.id]}</strong>
            <span style={{ fontFamily:"monospace", fontSize:10, color:"#6366f1", maxWidth:160, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.label}</span>
          </button>
        ))}
        <span style={{ width:1, height:18, background:"#e5e7eb", margin:"2px 1px" }} />
        {/* Math palette — typing works too; these are discoverability shortcuts that
            insert at the caret. Binary operators carry surrounding spaces for legibility
            (the lexer ignores whitespace). */}
        {[[" + ", "+"], [" − ", "−"], [" × ", "×"], [" ÷ ", "÷"], ["^", "^"], ["(", "("], [")", ")"]].map(([snip, lbl]) => (
          <button key={lbl} onClick={() => insertAtCaret(snip)} style={{ ...btnPlus, fontFamily:"monospace", minWidth:26, color:"#475569" }}>{lbl}</button>
        ))}
        <button onClick={() => insertAtCaret("sqrt(")} style={{ ...btnPlus, fontFamily:"monospace", color:"#475569" }}>sqrt(</button>
        <button onClick={() => insertAtCaret("abs(")} style={{ ...btnPlus, fontFamily:"monospace", color:"#475569" }}>abs(</button>
      </div>
      {/* Typed expression + live preview */}
      <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
        <span style={{ fontSize:13, color:"#94a3b8", fontWeight:700 }}>=</span>
        <input ref={inputRef} value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") add(); }}
          placeholder="e.g. (A − B)  or  (A − M)^2 + (B − M)^2"
          style={{ ...iSm, flex:"1 1 260px", minWidth:220, fontFamily:"monospace", fontSize:13, padding:"7px 10px",
            border: msg ? "1px solid #fca5a5" : "1px solid #ddd" }} />
        {valid && (
          <span style={{ fontSize:11, color:"#64748b" }}>
            on this sample → <strong style={{ color: isFinite(preview) ? "#10b981" : "#b45309", fontFamily:"monospace" }}>{fmt(preview)}</strong>
          </span>
        )}
      </div>
      {msg && <div style={{ fontSize:11, color:"#ef4444", marginTop:4 }}>{msg}</div>}
      <div style={{ marginTop:8, display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
        <label style={{ ...ctrlLbl, fontSize:11 }}>Name
          <input value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") add(); }}
            placeholder="optional — defaults to the formula"
            style={{ ...iSm, width:220, marginLeft:5 }} />
        </label>
        <button onClick={add} disabled={!valid}
          style={{ padding:"7px 16px", background:"#6366f1", color:"#fff", border:"none", borderRadius:8, fontWeight:700, fontSize:13, cursor:valid ? "pointer" : "not-allowed", opacity:valid ? 1 : 0.5 }}>
          ＋ Add derived column
        </button>
        <span style={{ fontSize:11, color:"#bbb" }}>Backfills every collected row instantly — no re-sampling.</span>
      </div>
    </div>
  );
}

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// DISTRIBUTION PLOT \u2014 sampling-distribution view over collected-statistic columns.
// Each column is one tracked (or manually-defined) statistic's accumulated values;
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
  const head = container.querySelector("thead");
  const headH = head ? head.offsetHeight : 0;
  if (rRect.top < cRect.top + headH) container.scrollTop -= (cRect.top + headH - rRect.top);
  else if (rRect.bottom > cRect.bottom) container.scrollTop += (rRect.bottom - cRect.bottom);
}

function DistributionPlot({ columns, width, rowIds, selectedIds, onToggleSelect, onDivider }) {
  // Disambiguate any repeated labels so each column is a distinct header/key
  // (tracked stats are already unique; manually-defined ones may collide).
  const headers = useMemo(() => {
    const out = [], seen = {};
    columns.forEach(c => {
      if (seen[c.label]) out.push(c.label + " (" + (++seen[c.label]) + ")");
      else { seen[c.label] = 1; out.push(c.label); }
    });
    return out;
  }, [columns.map(c => c.label).join("")]);

  const [xVar, setXVar] = useState(headers[0] || "");
  const [yVar, setYVar] = useState("none");

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
    onDivider({ statId: k >= 0 && columns[k] ? columns[k].id : null, cuts: d.cuts, range: d.range, dir: d.dir, by: d.by, pct: d.pct });
  }, [onDivider, headers, columns]);

  if (!columns.length) return null;
  return <Plot rows={rows} headers={headers} xVar={xVar} yVar={yVar} setXVar={setXVar} setYVar={setYVar} width={width}
    selectedIds={selectedIds} onToggleSelect={onToggleSelect} onDivider={onDivider ? handleDivider : undefined} />;
}

// ══════════════════════════════════════════════════════════════════════════════
// EDA PLOT — exploratory plot with toggleable statistics overlays
// ══════════════════════════════════════════════════════════════════════════════
function EDAPlot({ rows, headers, onChange }) {
  // X/Y selection lives here so the sibling DataTable can highlight the chosen
  // columns; the Plot owns dot size + overlay toggles. (Plot keeps X/Y valid.)
  const [xVar, setXVar] = useState(headers[0] || "");
  const [yVar, setYVar] = useState("none");

  // Linked highlighting (D1): a shared set of selected row `_id`s, toggled by
  // clicking a plot dot or a table row, highlighting both together. On select, a
  // `scrollTarget` nudges the table to reveal the just-highlighted row.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [scrollTarget, setScrollTarget] = useState(null);
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
  if (!rows.length && !editable) return <div style={{ color:"#bbb", padding:24, textAlign:"center" }}>No data loaded.</div>;

  return (
    <div style={{ display:"flex", gap:14, flexWrap:"wrap", alignItems:"flex-start" }}>
      {/* LEFT: data viewer / editor */}
      <DataTable rows={rows} headers={headers} xVar={xVar} yVar={yVar} editable={editable} onChange={onChange}
        selectedIds={selectedIds} onToggleSelect={toggleId} scrollTarget={scrollTarget} />
      {/* RIGHT: shared interactive plot */}
      <Plot rows={rows} headers={headers} xVar={xVar} yVar={yVar} setXVar={setXVar} setYVar={setYVar}
        selectedIds={selectedIds} onToggleSelect={toggleId} />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SAMPLE RESULTS — mirrors the EDA layout (table left, shared Plot right) for the
// raw draws of a sampler run. The table is chronological: newest rows append at
// the BOTTOM and the scroll view auto-follows as draws stream in.
// ══════════════════════════════════════════════════════════════════════════════
function SampleResults({ sampleData, varNames, varKinds, nameOf, onTrackStat, onTrackDiff, trackedStats }) {
  // `varNames` are device IDS (the plot/table headers); `nameOf(id)` resolves the
  // display name. `nm` falls back to identity so this still works if no map is passed.
  const nm = nameOf || (h => h);
  const [xVar, setXVar] = useState(varNames[0] || "");
  const [yVar, setYVar] = useState("none");
  const scrollRef = useRef(null);
  const trackedKeys = useMemo(() => new Set((trackedStats || []).map(statKey)), [trackedStats]);

  // Linked highlighting (D1): clicking a draw-dot or a Draws-table row highlights both.
  // Keyed by each draw's stable `_id`; on select, scroll the row into view.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [scrollTarget, setScrollTarget] = useState(null);
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
    return <div style={{ color:"#bbb", textAlign:"center", padding:24 }}>Press "Draw Sample" to begin</div>;
  }

  const cols = ["_sample", ...varNames];
  const HL = "#fde68a"; // selected-row highlight (amber); overrides column tint
  const cellColor = c => c === "_sample" ? "#bbb" : (c === xVar ? "#3730a3" : (c === yVar ? "#047857" : "#2c3e50"));
  const cellBg = (c, sel) => sel ? HL : (c === xVar ? "#eef2ff" : (c === yVar ? "#ecfdf5" : "transparent"));

  return (
    <div style={{ display:"flex", gap:14, flexWrap:"wrap", alignItems:"flex-start" }}>
      {/* LEFT: data table (chronological, auto-scrolling) */}
      <div style={{ flex:"1 1 240px", minWidth:200, maxWidth:340 }}>
        <div style={{ fontSize:11, fontWeight:700, color:"#aaa", letterSpacing:1, textTransform:"uppercase", marginBottom:8 }}>Draws</div>
        <div ref={scrollRef} style={{ maxHeight:300, overflow:"auto", border:"1px solid #eee", borderRadius:8 }}>
          <table style={{ borderCollapse:"collapse", fontSize:11, width:"100%" }}>
            <thead>
              <tr>
                {cols.map(c => (
                  <th key={c} style={{ position:"sticky", top:0, background: c === xVar ? "#c7d2fe" : (c === yVar ? "#a7f3d0" : "#f8f9fa"), color: c === "_sample" ? "#bbb" : "#334155", fontWeight: c === "_sample" ? 600 : 700, padding:"4px 8px", textAlign: c === "_sample" ? "right" : "left", borderBottom:"1px solid #e5e7eb", whiteSpace:"nowrap" }}>{c === "_sample" ? "#" : nm(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sampleData.map((row, i) => {
                const sel = isSel(row._id);
                return (
                <tr key={row._id || i} data-rowid={row._id} onClick={() => toggleId(row._id)} style={{ borderBottom:"1px solid #f5f5f5", cursor:"pointer" }}>
                  {cols.map(c => (
                    <td key={c} style={{ padding:"3px 8px", color:cellColor(c), background:cellBg(c, sel), textAlign: c === "_sample" ? "right" : "left", whiteSpace:"nowrap", maxWidth:120, overflow:"hidden", textOverflow:"ellipsis" }}>{row[c]}</td>
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
        selectedIds={selectedIds} onToggleSelect={toggleId} />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// DATA TABLE — scrollable view of the raw rows; X/Y columns highlighted
// ══════════════════════════════════════════════════════════════════════════════

function DataTable({ rows, headers, xVar, yVar, editable = false, onChange, selectedIds, onToggleSelect, scrollTarget }) {
  // Render every row so each plot dot has a reachable table row for linked
  // highlighting (D1). Datasets here are EDA-sized; if a pathologically large CSV
  // ever lags, add windowed rendering (no virtualization library).
  const selectable = !!onToggleSelect;
  const scrollRef = useRef(null);
  // Reveal the row whose dot was just clicked (no-op when it's already in view).
  useEffect(() => { scrollRowIntoView(scrollRef.current, scrollTarget && scrollTarget.id); }, [scrollTarget]);
  const isSel = id => !!(selectedIds && selectedIds.has(id));
  const HL = "#fde68a"; // selected-row highlight (amber); overrides column tint
  const cellBg = (h, sel) => sel ? HL : (h === xVar ? "#eef2ff" : (h === yVar ? "#ecfdf5" : "transparent"));
  const headBg = h => h === xVar ? "#c7d2fe" : (h === yVar ? "#a7f3d0" : "#f1f5f9");

  // ── Edit helpers (editable mode): each rebuilds {headers, rows} and calls onChange ──
  const editCell = (id, h, v) => onChange(headers, rows.map(r => r._id === id ? { ...r, [h]: v } : r));
  const uniqueHeader = base => { let n = base, i = 1; while (headers.includes(n)) n = `${base}${++i}`; return n; };
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
    <div style={{ flex:"1 1 240px", minWidth:200, maxWidth:340 }}>
      <div style={{ fontSize:11, fontWeight:700, color:"#aaa", letterSpacing:1, textTransform:"uppercase", marginBottom:8 }}>Data</div>
      <div ref={scrollRef} style={{ maxHeight:300, overflow:"auto", border:"1px solid #eee", borderRadius:8 }}>
        <table style={{ borderCollapse:"collapse", fontSize:11, width:"100%" }}>
          <thead>
            <tr>
              <th style={{ position:"sticky", top:0, background:"#f8f9fa", color:"#bbb", fontWeight:600, padding:"4px 6px", textAlign:"right", borderBottom:"1px solid #e5e7eb" }}>#</th>
              {headers.map(h => (
                <th key={h} style={{ position:"sticky", top:0, background:headBg(h), color:"#334155", fontWeight:700, padding:"4px 8px", textAlign:"left", borderBottom:"1px solid #e5e7eb", whiteSpace:"nowrap" }}>
                  {editable ? (
                    <span style={{ display:"inline-flex", alignItems:"center", gap:2 }}>
                      <InlineEdit value={h} onChange={v => renameHeader(h, v)} style={{ fontWeight:700 }} />
                      <button title="Delete column" onClick={() => delCol(h)} style={{ ...btnX, fontSize:13 }}>×</button>
                    </span>
                  ) : h}
                </th>
              ))}
              {editable && (
                <th style={{ position:"sticky", top:0, background:"#f8f9fa", borderBottom:"1px solid #e5e7eb", padding:"2px 6px" }}>
                  <button title="Add column" onClick={addCol} style={{ ...btnX, color:"#6366f1", fontSize:15 }}>＋</button>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const sel = isSel(r._id);
              return (
              <tr key={r._id || i} data-rowid={r._id} style={{ borderBottom:"1px solid #f5f5f5" }}>
                {/* row-number cell doubles as the select handle (clicking a data cell
                    edits it, so selection lives here to avoid clobbering inline edit) */}
                <td onClick={selectable ? () => onToggleSelect(r._id) : undefined}
                  title={selectable ? "Select row" : undefined}
                  style={{ color:"#ccc", padding:"3px 6px", textAlign:"right", whiteSpace:"nowrap", background: sel ? HL : undefined, cursor: selectable ? "pointer" : "default" }}>
                  {editable && <button title="Delete row" onClick={e => { e.stopPropagation(); delRow(r._id); }} style={{ ...btnX, fontSize:12, marginRight:2 }}>×</button>}
                  {i + 1}
                </td>
                {headers.map(h => (
                  <td key={h} style={{ padding:"3px 8px", color:"#555", background:cellBg(h, sel), whiteSpace:"nowrap", maxWidth:120, overflow:"hidden", textOverflow:"ellipsis" }}>
                    {editable ? <InlineEdit value={r[h] ?? ""} onChange={v => editCell(r._id, h, v)} /> : r[h]}
                  </td>
                ))}
                {editable && <td style={{ background: sel ? HL : undefined }} />}
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editable && (
        <div style={{ marginTop:6 }}>
          <button onClick={addRow} style={{ ...btnPlus, color:"#4338ca", borderColor:"#a5b4fc", background:"#eef2ff" }}>＋ row</button>
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
function CollectTable({ trackedStats, collectRows, onRemove, labelFor = statLabel, titleFor, selectedIds, onToggleSelect, scrollTarget }) {
  const selectable = !!onToggleSelect;
  const isSel = id => !!(selectedIds && selectedIds.has(id));
  const HL = "#fde68a";
  const scrollRef = useRef(null);
  // Reveal the row whose distribution-plot dot was just clicked (key for 500-row collects)
  useEffect(() => { scrollRowIntoView(scrollRef.current, scrollTarget && scrollTarget.id); }, [scrollTarget]);
  if (!trackedStats.length) {
    return (
      <div style={{ flex:"1 1 280px", minWidth:220, color:"#bbb", fontSize:13, padding:"16px 8px", lineHeight:1.5 }}>
        No tracked statistics yet. In <strong>Sample Results</strong> above, enable an overlay
        (or click a two-way table cell) and press <strong style={{ color:"#6366f1" }}>＋ track</strong> to add a column here.
      </div>
    );
  }
  // Render every collected row so each distribution-plot dot has a reachable row for
  // linked highlighting; collected counts (≈500 default) stay light to render.
  const fmt = v => (typeof v === "number" ? (isFinite(v) ? parseFloat(v.toFixed(4)) : "—") : v);
  return (
    <div style={{ flex:"1 1 280px", minWidth:220 }}>
      <div style={{ fontSize:11, fontWeight:700, color:"#aaa", letterSpacing:1, textTransform:"uppercase", marginBottom:8 }}>
        Collected statistics {collectRows.length > 0 && <span style={{ color:"#ccc", fontWeight:600 }}>· {collectRows.length} rows</span>}
      </div>
      <div ref={scrollRef} style={{ maxHeight:300, overflow:"auto", border:"1px solid #eee", borderRadius:8 }}>
        <table style={{ borderCollapse:"collapse", fontSize:11, width:"100%" }}>
          <thead>
            <tr>
              <th style={{ position:"sticky", top:0, background:"#f8f9fa", color:"#bbb", fontWeight:600, padding:"4px 6px", textAlign:"right", borderBottom:"1px solid #e5e7eb" }}>#</th>
              {trackedStats.map(s => (
                <th key={s.id} title={titleFor ? titleFor(s) : undefined} style={{ position:"sticky", top:0, background: s.kind === "derived" ? "#fef3c7" : "#f1f5f9", color:"#334155", fontWeight:700, padding:"4px 8px", textAlign:"left", borderBottom:"1px solid #e5e7eb", whiteSpace:"nowrap" }}>
                  <span title={s.kind === "derived" ? "Derived column" : undefined} style={{ fontFamily:"monospace", color: s.kind === "derived" ? "#b45309" : "#4338ca" }}>{labelFor(s)}</span>
                  <button onClick={() => onRemove(s.id)} title="Remove column" style={{ ...btnX, fontSize:13, marginLeft:4, verticalAlign:"middle" }}>×</button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {collectRows.length === 0 ? (
              <tr>
                <td colSpan={trackedStats.length + 1} style={{ padding:"12px 8px", color:"#bbb", textAlign:"center" }}>
                  No samples collected yet.
                </td>
              </tr>
            ) : collectRows.map((row, i) => {
              const sel = isSel(row._id);
              return (
              <tr key={row._id || i} data-rowid={row._id} onClick={selectable ? () => onToggleSelect(row._id) : undefined}
                style={{ borderBottom:"1px solid #f5f5f5", cursor: selectable ? "pointer" : "default" }}>
                <td style={{ color:"#ccc", padding:"3px 6px", textAlign:"right", background: sel ? HL : undefined }}>{i + 1}</td>
                {trackedStats.map(s => (
                  <td key={s.id} style={{ padding:"3px 8px", color:"#555", whiteSpace:"nowrap", background: sel ? HL : undefined }}>{fmt(row[s.id])}</td>
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
function UniCatPlot({ rows, catVar, nameOf, R, width, showCount = true, showPct = false, expanded, onToggleExpand, trackable, trackedKeys, onTrackStat, measure, selectedIds, onToggleSelect }) {
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
  const allCats = Object.keys(counts).sort();
  const total = allCats.reduce((a, c) => a + counts[c], 0);
  const { shown } = collapseCats(allCats, counts, expanded);
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
          const color = COLORS[ci % COLORS.length];
          // Each visible number is a click target: count → count of catVar=c;
          // percent → proportion catVar=c. "Other" has no clean target.
          const colOk = c !== OTHER_CAT;
          const base = { variable:catVar, target:String(c) };
          const countSpec = colOk ? { ...base, fn:"countVal" } : null;
          const propSpec = colOk ? { ...base, fn:"proportion" } : null;
          return (
            <div key={c} style={{ flex:"1 1 0", minWidth:48, maxWidth:180, borderLeft: ci ? "1px solid #f0f0f0" : "none",
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
                      cursor: selectable ? "pointer" : "default", boxShadow: sel ? "0 0 0 2px #1f2937" : "none" }} />;
                })}
              </div>
              <div style={{ borderTop:"1px solid #ccc", width:"100%", marginTop:2 }} />
              <div style={{ fontSize:11, color:"#444", fontWeight:600, paddingTop:4, textAlign:"center",
                overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:"100%" }}>{c}</div>
            </div>
          );
        })}
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:10, marginTop:4 }}>
        <span style={{ fontSize:11, color:"#666", fontWeight:700 }}>{nm(catVar)}</span>
        {allCats.length > 10 && (
          <button onClick={onToggleExpand} style={{ ...btnNav, fontSize:10 }}>
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

function CatCatGrid({ rows, xVar, yVar, nameOf, R, width, showCount = true, showPct = false, expanded, onToggleExpand, trackable, trackedKeys, onTrackStat, measure, selectedIds, onToggleSelect }) {
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
  const allX = Object.keys(xCount).sort(), allY = Object.keys(yCount).sort();
  const X = collapseCats(allX, xCount, expanded), Y = collapseCats(allY, yCount, expanded);
  const xCats = X.shown, yCats = Y.shown;
  const xSet = new Set(xCats.filter(c => c !== OTHER_CAT));
  const ySet = new Set(yCats.filter(c => c !== OTHER_CAT));
  const collapsible = allX.length > 10 || allY.length > 10;

  // Color per Y-category (rows), like the reference image
  const yColor = {};
  yCats.forEach((yc, i) => { yColor[yc] = COLORS[i % COLORS.length]; });

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
          <div key={yc} style={{ display:"flex", alignItems:"stretch", borderBottom:"1px solid #eee" }}>
            {/* Row label */}
            <div style={{ width:LABEL_W, flexShrink:0, display:"flex", alignItems:"center",
              justifyContent:"flex-end", paddingRight:10, fontSize:12, color:"#444", fontWeight:600,
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
                  borderLeft:"1px solid #eee", padding:"4px 6px", boxSizing:"border-box",
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
                          cursor: selectable ? "pointer" : "default", boxShadow: sel ? "0 0 0 2px #1f2937" : "none" }} />;
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
              fontSize:12, color:"#444", fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{xc}</div>
          ))}
        </div>
        {/* Axis titles */}
        <div style={{ textAlign:"center", marginTop:4, fontSize:11, color:"#666", fontWeight:700,
          marginLeft:LABEL_W }}>{nm(xVar)}</div>
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:10, fontSize:10, color:"#aaa", marginTop:4, marginLeft:LABEL_W - 10 }}>
        <span>Rows = {nm(yVar)} · row-conditional proportion: P({nm(xVar)} | {nm(yVar)})</span>
        {collapsible && (
          <button onClick={onToggleExpand} style={{ ...btnNav, fontSize:10 }}>
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

function SplitDotPlots({ rows, catVar, numVar, nameOf, R, width, isTime, orientation = "h", showBox, showMean, showSD, showValues, expanded, onToggleExpand, trackable, trackedKeys, onTrackStat, divOn, divCuts, onDivChange, divSnap, divShowCount, divShowPct, divFmt, rulerOn, rulerPts, onRulerChange, rulerShowBox, rulerFmt, onTrackDiff, selectedIds, onToggleSelect }) {
  const nm = nameOf || (h => h);
  const selectable = !!onToggleSelect;
  const isSel = id => !!(selectedIds && selectedIds.has(id));
  // Per-group tracking spec: a numeric stat conditioned on this group (null for the
  // "Other" bucket or when the plot isn't trackable).
  const grpSpec = (cat, fn) => (trackable && cat !== OTHER_CAT) ? { fn, variable:numVar, condVar:catVar, condVal:String(cat) } : null;
  const tp = { trackable, trackedKeys, onTrackStat };
  // Collapse high-cardinality grouping variable into top 10 + "Other"
  const catCount = {};
  rows.forEach(r => { const v = r[catVar]; if (v !== "" && v !== undefined) catCount[v] = (catCount[v] || 0) + 1; });
  const allCats = Object.keys(catCount).sort();
  const { shown: cats, isCollapsed } = collapseCats(allCats, catCount, expanded);
  const catSet = new Set(cats.filter(c => c !== OTHER_CAT));
  const groupOf = v => catSet.has(v) ? v : OTHER_CAT;

  // Shared numeric scale across all groups for fair comparison (time-aware)
  const allNums = rows.map(r => toNum(r[numVar])).filter(v => !isNaN(v));
  if (!allNums.length) return <div style={{ color:"#bbb", padding:20 }}>No numeric data.</div>;
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
        <svg width={W} height={H} style={{ display:"block", overflow:"visible", maxWidth:"100%" }}>
          {/* horizontal gridlines + y-axis ticks */}
          {ticks.map((t, i) => <line key={"g"+i} x1={PL} y1={sy(t)} x2={W - PR} y2={sy(t)} stroke="#f5f5f5" strokeWidth={1} />)}
          <line x1={PL} y1={PT} x2={PL} y2={PT + iH} stroke="#ccc" strokeWidth={1.5} />
          {ticks.map((t, i) => (
            <g key={"yt"+i}>
              <line x1={PL - 4} y1={sy(t)} x2={PL} y2={sy(t)} stroke="#bbb" />
              <text x={PL - 7} y={sy(t)} textAnchor="end" dominantBaseline="middle" fontSize={10} fill="#999">{fmt(t)}</text>
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
            const xData = x0 + colW * 0.46;        // data baseline; dots to the right, overlays to the left
            const dotAreaW = (x0 + colW) - xData - 4;
            const hsp = Math.min(dotR * 2 + 1, (dotAreaW - dotR) / widest);
            const stacks = {};
            const groupDots = groupNums.map((v, di) => {
              const key = binOf(v); stacks[key] = (stacks[key] || 0) + 1;
              return { id: groupRows[di]._id, x: xData + dotR + 3 + (stacks[key] - 1) * hsp, y: sy(v) };
            });
            const color = COLORS[gi % COLORS.length];
            const bx = xData - 32;                  // vertical boxplot, just left of the mean/SD cluster
            const sdMidX = xData - 5;               // ±SD runs vertically through the mean triangle
            return (
              <g key={cat}>
                {gi > 0 && <line x1={x0} y1={PT} x2={x0} y2={PT + iH} stroke="#f0f0f0" strokeWidth={1} />}
                {/* per-category baseline the mean tip touches */}
                <line x1={xData} y1={PT} x2={xData} y2={PT + iH} stroke="#f3f4f6" strokeWidth={1} />
                {groupDots.map((d, i) => {
                  const sel = isSel(d.id);
                  return <circle key={d.id || i} cx={d.x} cy={d.y} r={sel ? dotR + 1 : dotR}
                    fill={sel ? "#f97316" : color}
                    fillOpacity={sel ? 1 : Math.min(0.85, Math.max(0.3, 60 / Math.sqrt(groupDots.length + 1)))}
                    stroke={sel ? "#1f2937" : "none"} strokeWidth={sel ? 1.5 : 0}
                    style={selectable ? { cursor:"pointer" } : undefined}
                    onClick={selectable && d.id ? () => onToggleSelect(d.id) : undefined} />;
                })}
                {/* boxplot (vertical, Tukey whiskers) */}
                {showBox && summary && (
                  <g>
                    <line x1={bx} y1={sy(summary.whiskerLo)} x2={bx} y2={sy(summary.whiskerHi)} stroke="#475569" strokeWidth={1.2} />
                    <line x1={bx - 4} y1={sy(summary.whiskerLo)} x2={bx + 4} y2={sy(summary.whiskerLo)} stroke="#475569" strokeWidth={1.2} />
                    <line x1={bx - 4} y1={sy(summary.whiskerHi)} x2={bx + 4} y2={sy(summary.whiskerHi)} stroke="#475569" strokeWidth={1.2} />
                    <rect x={bx - 6} y={sy(summary.q3)} width={12} height={Math.max(1, sy(summary.q1) - sy(summary.q3))} fill="rgba(99,102,241,0.15)" stroke={color} strokeWidth={1.2} />
                    <line x1={bx - 6} y1={sy(summary.median)} x2={bx + 6} y2={sy(summary.median)} stroke={color} strokeWidth={2} />
                    {showValues && <TrackText x={bx - 9} y={sy(summary.median) + 3} anchor="end" color="#4338ca" fontSize={9} label={fmt(summary.median)} spec={grpSpec(cat, "median")} {...tp} />}
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
                      {showValues && <TrackText x={xData - 13} y={my + 3} anchor="end" color="#059669" fontSize={9} label={fmt(summary.mean)} spec={grpSpec(cat, "mean")} {...tp} />}
                    </g>
                  );
                })()}
                {/* ±1 SD — runs vertically through the mean triangle, centred on the mean */}
                {showSD && summary && (() => {
                  const topY = sy(summary.mean + summary.sd), botY = sy(summary.mean - summary.sd);
                  const labelY = Math.min(topY, sy(summary.mean) - 8) - 4; // keep value off the triangle
                  return (
                    <g>
                      <line x1={sdMidX} y1={topY} x2={sdMidX} y2={botY} stroke="#f59e0b" strokeWidth={2} />
                      <line x1={sdMidX - 3} y1={topY} x2={sdMidX + 3} y2={topY} stroke="#f59e0b" strokeWidth={2} />
                      <line x1={sdMidX - 3} y1={botY} x2={sdMidX + 3} y2={botY} stroke="#f59e0b" strokeWidth={2} />
                      {showValues && <TrackText x={sdMidX} y={labelY} anchor="middle" color="#d97706" fontSize={8} label={"±SD " + parseFloat(summary.sd.toFixed(2))} spec={grpSpec(cat, "sd")} {...tp} />}
                    </g>
                  );
                })()}
                {/* category label */}
                <text x={center} y={PT + iH + 16} textAnchor="middle" fontSize={11} fill="#444" fontWeight={600}>{cat}</text>
                <text x={center} y={PT + iH + 28} textAnchor="middle" fontSize={9} fill="#aaa">n={groupNums.length}</text>
              </g>
            );
          })}
          <line x1={PL} y1={PT + iH} x2={W - PR} y2={PT + iH} stroke="#ccc" strokeWidth={1.5} />
          <text x={PL + iW / 2} y={H - 4} textAnchor="middle" fontSize={11} fill="#666" fontWeight={600}>{nm(catVar)}</text>
          <text x={14} y={PT + iH / 2} textAnchor="middle" fontSize={11} fill="#666" fontWeight={600} transform={"rotate(-90,14," + (PT + iH / 2) + ")"}>{nm(numVar)}</text>
        </svg>
        {allCats.length > 10 && (
          <button onClick={onToggleExpand} style={{ ...btnNav, fontSize:10, marginTop:4 }}>
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
      <svg width={W} height={H} style={{ display:"block", overflow:"visible", maxWidth:"100%" }}>
        {/* vertical gridlines */}
        {ticks.map((t, i) => <line key={"g"+i} x1={sx(t)} y1={PT} x2={sx(t)} y2={H - PB} stroke="#f5f5f5" strokeWidth={1} />)}

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
          const color = COLORS[gi % COLORS.length];
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
              {gi > 0 && <line x1={PL} y1={top} x2={W - PR} y2={top} stroke="#f0f0f0" strokeWidth={1} />}
              {/* group label */}
              <text x={PL - 10} y={top + GROUP_H / 2 - 6} textAnchor="end" dominantBaseline="middle"
                fontSize={11} fill="#444" fontWeight={600}>{cat}</text>
              <text x={PL - 10} y={top + GROUP_H / 2 + 8} textAnchor="end" dominantBaseline="middle"
                fontSize={9} fill="#aaa">n={groupNums.length}</text>
              {/* baseline */}
              <line x1={PL} y1={baseY + dotR + 1} x2={W - PR} y2={baseY + dotR + 1} stroke="#e0e0e0" strokeWidth={1} />
              {/* dots — one per row; click toggles linked highlighting (D1) */}
              {groupDots.map((d, i) => {
                const sel = isSel(d.id);
                return <circle key={d.id || i} cx={d.x} cy={d.y} r={sel ? dotR + 1 : dotR}
                  fill={sel ? "#f97316" : color}
                  fillOpacity={sel ? 1 : Math.min(0.85, Math.max(0.3, 60 / Math.sqrt(groupDots.length + 1)))}
                  stroke={sel ? "#1f2937" : "none"} strokeWidth={sel ? 1.5 : 0}
                  style={selectable ? { cursor:"pointer" } : undefined}
                  onClick={selectable && d.id ? () => onToggleSelect(d.id) : undefined} />;
              })}
              {/* ±1 SD — runs through the mean triangle, centred on the mean */}
              {showSD && summary && (() => {
                const gb = baseY + dotR + 1, y = gb + 5, mx = sx(summary.mean);
                const loX = sx(summary.mean - summary.sd), hiX = sx(summary.mean + summary.sd);
                const labelX = Math.max(hiX, mx + 9) + 4;
                return (
                  <g>
                    <line x1={loX} y1={y} x2={hiX} y2={y} stroke="#f59e0b" strokeWidth={2} />
                    <line x1={loX} y1={y - 3} x2={loX} y2={y + 3} stroke="#f59e0b" strokeWidth={2} />
                    <line x1={hiX} y1={y - 3} x2={hiX} y2={y + 3} stroke="#f59e0b" strokeWidth={2} />
                    {showValues && <TrackText x={labelX} y={y + 3} anchor="start" color="#d97706" fontSize={8} label={"±SD " + parseFloat(summary.sd.toFixed(2))} spec={grpSpec(cat, "sd")} {...tp} />}
                  </g>
                );
              })()}
              {/* mean triangle — tip on the group baseline (axis being averaged) */}
              {showMean && summary && (() => {
                const gb = baseY + dotR + 1, mx = sx(summary.mean);
                return (
                  <g>
                    <polygon points={mx + "," + gb + " " + (mx - 5) + "," + (gb + 10) + " " + (mx + 5) + "," + (gb + 10)} fill="#10b981" stroke="#059669" strokeWidth={0.8} />
                    {showValues && <TrackText x={mx} y={gb + 20} anchor="middle" color="#059669" fontSize={9} label={fmt(summary.mean)} spec={grpSpec(cat, "mean")} {...tp} />}
                  </g>
                );
              })()}
              {/* boxplot — separated below */}
              {showBox && summary && (() => {
                const by = baseY + dotR + 32;
                return (
                  <g>
                    <line x1={sx(summary.whiskerLo)} y1={by} x2={sx(summary.whiskerHi)} y2={by} stroke="#475569" strokeWidth={1.2} />
                    <line x1={sx(summary.whiskerLo)} y1={by - 4} x2={sx(summary.whiskerLo)} y2={by + 4} stroke="#475569" strokeWidth={1.2} />
                    <line x1={sx(summary.whiskerHi)} y1={by - 4} x2={sx(summary.whiskerHi)} y2={by + 4} stroke="#475569" strokeWidth={1.2} />
                    <rect x={sx(summary.q1)} y={by - 5} width={Math.max(1, sx(summary.q3) - sx(summary.q1))} height={10} fill="rgba(99,102,241,0.15)" stroke={color} strokeWidth={1.2} />
                    <line x1={sx(summary.median)} y1={by - 5} x2={sx(summary.median)} y2={by + 5} stroke={color} strokeWidth={2} />
                    {showValues && <TrackText x={sx(summary.median)} y={by + 15} anchor="middle" color="#4338ca" fontSize={9} label={fmt(summary.median)} spec={grpSpec(cat, "median")} {...tp} />}
                  </g>
                );
              })()}
              {/* Divider region read-outs for this group, at the top of its band. The
                  count / proportion are conditioned on this group (collectable in Sample
                  Results); the "Other" bucket has no clean target, so it stays plain. */}
              {divOn && divCuts && divCuts.length > 0 && (divShowCount || divShowPct) && (
                <RegionLabels regions={regions(groupNums, divCuts)} sx={sx} xL={PL} xR={W - PR}
                  y={top + 10} showCount={divShowCount} showPct={divShowPct} total={groupNums.length}
                  base={{ variable: numVar, condVar: catVar, condVal: String(cat) }}
                  trackProps={cat === OTHER_CAT ? { ...tp, trackable: false } : tp} />
              )}
            </g>
          );
        })}

        {/* x axis */}
        <line x1={PL} y1={H - PB} x2={W - PR} y2={H - PB} stroke="#ccc" strokeWidth={1.5} />
        {ticks.map((t, i) => (
          <g key={"t"+i}>
            <line x1={sx(t)} y1={H - PB} x2={sx(t)} y2={H - PB + 4} stroke="#bbb" />
            <text x={sx(t)} y={H - PB + 16} textAnchor="middle" fontSize={10} fill="#999">{fmt(t)}</text>
          </g>
        ))}
        <text x={PL + iW / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="#666" fontWeight={600}>{nm(numVar)} (by {nm(catVar)})</text>
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
            fmt={rulerFmt} trackable={trackable} onTrackDiff={onTrackDiff} />
        )}
      </svg>
      {allCats.length > 10 && (
        <button onClick={onToggleExpand} style={{ ...btnNav, fontSize:10, marginTop:4 }}>
          {expanded ? "Collapse to top 10 groups" : `Show all ${allCats.length} groups`}
        </button>
      )}
    </div>
  );
}


export { Plot, SampleResults, StatDefiner, DerivedBuilder, DistributionPlot, EDAPlot, DataTable, CollectTable, UniCatPlot, CatCatGrid, SplitDotPlots };
