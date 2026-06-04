import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { iSm, btnX, btnNav, ctrlLbl } from "../lib/styles";
import { COLORS, clamp, toNum, minutesToTime, colKind, collapseCats, OTHER_CAT, fitDotR } from "../lib/util";
import { numericSummary, lsFit, statLabel, FN_OPTS } from "../lib/stats";
import { useContainerWidth } from "../lib/hooks";
import { makeScale, stackDots } from "../lib/scale";
import { Sel, ChkLabel } from "./ui";

// ── Click-to-track helpers ─────────────────────────────────────────────────────
// A statistic is promoted into Collect Statistics by clicking the number that
// shows it on the plot (not a separate chip). Both helpers fall back to a plain,
// non-interactive label when no `onTrackStat` is supplied (e.g. the EDA plot) or
// when `spec` is null (e.g. an "Other" bucket with no clean target), so existing
// plots render pixel-identically there.

// SVG value label that toggles tracking of `spec` on click.
function TrackText({ x, y, anchor = "middle", color, fontSize = 9, label, spec, trackable, trackedLabels, onTrackStat }) {
  if (!trackable || !spec) {
    return <text x={x} y={y} textAnchor={anchor} fontSize={fontSize} fill={color} fontWeight={700}>{label}</text>;
  }
  const lbl = statLabel(spec);
  const tracked = trackedLabels && trackedLabels.has(lbl);
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

// HTML count/percent number (cat plots) that toggles tracking of `spec` on click.
function CatNum({ text, spec, dim, trackable, trackedLabels, onTrackStat }) {
  if (!trackable || !spec) return <span style={{ color: dim ? "#bbb" : "#3730a3" }}>{text}</span>;
  const lbl = statLabel(spec);
  const tracked = trackedLabels && trackedLabels.has(lbl);
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

// ══════════════════════════════════════════════════════════════════════════════
// PLOT — the shared, interactive plot primitive (controls + plot body, no table).
// Used by both EDA and Sample Results. X/Y selection is *controlled* by the parent
// so a sibling data table can highlight the selected columns; dot size and the stat
// overlay toggles are local state. Renders the same four modes as the EDA plot:
//   1) cat × cat grid   2) num × cat split dot plots
//   3) single categorical bins   4) scatter / univariate numeric (SVG)
// ══════════════════════════════════════════════════════════════════════════════
function Plot({ rows, headers, xVar, yVar, setXVar, setYVar, width, onTrackStat, trackedLabels }) {
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

  const plotRef = useRef(null);
  const measuredW = useContainerWidth(plotRef, 280, 760);
  const plotW = width || measuredW;

  // Detect each column's type once per (rows, headers). colInfo[col] = {numeric,time}.
  const colInfo = useMemo(() => {
    const map = {};
    headers.forEach(h => { map[h] = colKind(rows, h); });
    return map;
  }, [rows, headers]);

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
  const valid = rows.filter(r => {
    const xv = r[xVar];
    if (xv === undefined || xv === "") return false;
    if (bivariate && (r[yVar] === undefined || r[yVar] === "")) return false;
    return true;
  });
  const xps = valid.map(r => xS.scale(r[xVar]));
  const yOffsets = yS ? null : stackDots(xps, R, iH, 1);
  const dots = valid.map((r, i) => ({
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
  const trackProps = { trackable, trackedLabels, onTrackStat };

  return (
    <div ref={plotRef} style={{ flex:"2 1 460px", minWidth:320 }}>
      {/* Controls */}
      <div style={{ display:"flex", gap:8, marginBottom:8, flexWrap:"wrap", alignItems:"center" }}>
        <Sel label="X" value={xVar} onChange={setXVar} options={headers} />
        <Sel label="Y" value={yVar} onChange={setYVar} options={["none", ...headers.filter(h => h !== xVar)]} labels={["— none —", ...headers.filter(h => h !== xVar)]} />
        <label style={ctrlLbl}>dot size
          <input type="range" min={1} max={12} value={dotSize} onChange={e => setDotSize(+e.target.value)} style={{ width:55, marginLeft:4 }} />
        </label>
      </div>

      {/* Stat toggles — adapt to the variable types */}
      <div style={{ display:"flex", gap:10, marginBottom:8, flexWrap:"wrap", fontSize:12 }}>
        {showStatToggles && (
          <>
            <ChkLabel checked={showBox} onChange={setShowBox} label="📦 Boxplot" />
            <ChkLabel checked={showMean} onChange={setShowMean} label="△ Mean" />
            <ChkLabel checked={showSD} onChange={setShowSD} label="↔ ±1 SD" />
          </>
        )}
        {bivariate && xNumeric && yNumeric && (
          <ChkLabel checked={showLS} onChange={setShowLS} label="📈 LS Line" />
        )}
        {!trackable && (showStatToggles || (bivariate && xNumeric && yNumeric)) && (
          <ChkLabel checked={showValues} onChange={setShowValues} label="🔢 Show values" />
        )}
        {showCatToggles && (
          <>
            <ChkLabel checked={showCount} onChange={setShowCount} label="# Count" />
            <ChkLabel checked={showPct} onChange={setShowPct} label="% Percent" />
          </>
        )}
      </div>

      {/* Click-to-track hint */}
      {trackable && (
        <div style={{ fontSize:11, color:"#bbb", marginBottom:8 }}>
          💡 Click a number on the plot to collect that statistic (click again to stop).
        </div>
      )}

      {/* Plot — rendering depends on variable types */}
      {(() => {
        // MODE 1: both categorical → grid of cells with stacked dots + count/%
        if (bivariate && !xNumeric && !yNumeric) {
          return <CatCatGrid rows={rows} xVar={xVar} yVar={yVar} R={R} width={W}
            showCount={showCount} showPct={showPct} expanded={expandCats} onToggleExpand={toggleExpand}
            {...trackProps} />;
        }
        // MODE 2: one categorical + one numeric → split dot plots by category.
        // Respect the axis choice: numeric-X stays horizontal; numeric-Y draws
        // vertical distributions side by side.
        if (bivariate && (xNumeric !== yNumeric)) {
          const catVar = xNumeric ? yVar : xVar;
          const numVar = xNumeric ? xVar : yVar;
          const numTime = xNumeric ? xTime : yTime;
          return <SplitDotPlots rows={rows} catVar={catVar} numVar={numVar} R={R} width={W} isTime={numTime}
            orientation={xNumeric ? "h" : "v"}
            showBox={showBox} showMean={showMean} showSD={showSD} showValues={showVals}
            expanded={expandCats} onToggleExpand={toggleExpand} {...trackProps} />;
        }
        // MODE 3: single categorical → binned stacked-dot cells
        if (!bivariate && !xNumeric) {
          return <UniCatPlot rows={rows} catVar={xVar} R={R} width={W}
            showCount={showCount} showPct={showPct} expanded={expandCats} onToggleExpand={toggleExpand} {...trackProps} />;
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
            <text x={PL + iW / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="#666" fontWeight={600}>{xVar}</text>
            {yS && <text x={14} y={PT + iH / 2} textAnchor="middle" fontSize={11} fill="#666" fontWeight={600} transform={"rotate(-90,14," + (PT + iH / 2) + ")"}>{yVar}</text>}
            {/* dots */}
            {dots.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r={R} fill="#3b82f6" fillOpacity={Math.min(0.85, Math.max(0.2, 70 / Math.sqrt(dots.length + 1)))} />)}
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
          </svg>
        );
      })()}
    </div>
  );
}

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

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// DISTRIBUTION PLOT \u2014 sampling-distribution view over collected-statistic columns.
// Each column is one tracked (or manually-defined) statistic's accumulated values;
// the shared Plot's X selector doubles as the column selector and its overlay
// toggles (mean/SD/box) apply to the chosen distribution. Replaces the old
// StatDistPlot small-multiples with one EDA-grade, selectable plot.
//   columns: [{ label, values:number[] }]  (one value per repetition/sample)
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
function DistributionPlot({ columns, width }) {
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
      const o = {};
      columns.forEach((c, k) => {
        const v = c.values[i];
        o[headers[k]] = (typeof v === "number" && isFinite(v)) ? v : "";
      });
      out.push(o);
    }
    return out;
  }, [columns, headers]);

  if (!columns.length) return null;
  return <Plot rows={rows} headers={headers} xVar={xVar} yVar={yVar} setXVar={setXVar} setYVar={setYVar} width={width} />;
}

// ══════════════════════════════════════════════════════════════════════════════
// EDA PLOT — exploratory plot with toggleable statistics overlays
// ══════════════════════════════════════════════════════════════════════════════
function EDAPlot({ rows, headers }) {
  // X/Y selection lives here so the sibling DataTable can highlight the chosen
  // columns; the Plot owns dot size + overlay toggles. (Plot keeps X/Y valid.)
  const [xVar, setXVar] = useState(headers[0] || "");
  const [yVar, setYVar] = useState("none");

  if (!rows.length) return <div style={{ color:"#bbb", padding:24, textAlign:"center" }}>No data loaded.</div>;

  return (
    <div style={{ display:"flex", gap:14, flexWrap:"wrap", alignItems:"flex-start" }}>
      {/* LEFT: data viewer */}
      <DataTable rows={rows} headers={headers} xVar={xVar} yVar={yVar} />
      {/* RIGHT: shared interactive plot */}
      <Plot rows={rows} headers={headers} xVar={xVar} yVar={yVar} setXVar={setXVar} setYVar={setYVar} />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SAMPLE RESULTS — mirrors the EDA layout (table left, shared Plot right) for the
// raw draws of a sampler run. The table is chronological: newest rows append at
// the BOTTOM and the scroll view auto-follows as draws stream in.
// ══════════════════════════════════════════════════════════════════════════════
function SampleResults({ sampleData, varNames, onTrackStat, trackedStats }) {
  const [xVar, setXVar] = useState(varNames[0] || "");
  const [yVar, setYVar] = useState("none");
  const scrollRef = useRef(null);
  const trackedLabels = useMemo(() => new Set((trackedStats || []).map(statLabel)), [trackedStats]);

  // Auto-scroll the table to the bottom as new draws arrive
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sampleData.length]);

  if (!sampleData.length) {
    return <div style={{ color:"#bbb", textAlign:"center", padding:24 }}>Press "Draw Sample" to begin</div>;
  }

  const cols = ["_sample", ...varNames];
  const cellColor = c => c === "_sample" ? "#bbb" : (c === xVar ? "#3730a3" : (c === yVar ? "#047857" : "#2c3e50"));
  const cellBg = c => c === xVar ? "#eef2ff" : (c === yVar ? "#ecfdf5" : "transparent");
  // Cap the rendered rows for performance; the most recent draws are kept.
  const MAX_ROWS = 200;
  const shown = sampleData.slice(-MAX_ROWS);
  const offset = sampleData.length - shown.length;

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
                  <th key={c} style={{ position:"sticky", top:0, background: c === xVar ? "#c7d2fe" : (c === yVar ? "#a7f3d0" : "#f8f9fa"), color: c === "_sample" ? "#bbb" : "#334155", fontWeight: c === "_sample" ? 600 : 700, padding:"4px 8px", textAlign: c === "_sample" ? "right" : "left", borderBottom:"1px solid #e5e7eb", whiteSpace:"nowrap" }}>{c === "_sample" ? "#" : c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((row, i) => (
                <tr key={offset + i} style={{ borderBottom:"1px solid #f5f5f5" }}>
                  {cols.map(c => (
                    <td key={c} style={{ padding:"3px 8px", color:cellColor(c), background:cellBg(c), textAlign: c === "_sample" ? "right" : "left", whiteSpace:"nowrap", maxWidth:120, overflow:"hidden", textOverflow:"ellipsis" }}>{row[c]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {sampleData.length > MAX_ROWS && <div style={{ fontSize:10, color:"#aaa", marginTop:4 }}>Showing last {MAX_ROWS} of {sampleData.length} draws</div>}
      </div>
      {/* RIGHT: shared interactive plot */}
      <Plot rows={sampleData} headers={varNames} xVar={xVar} yVar={yVar} setXVar={setXVar} setYVar={setYVar}
        onTrackStat={onTrackStat} trackedLabels={trackedLabels} />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// DATA TABLE — scrollable view of the raw rows; X/Y columns highlighted
// ══════════════════════════════════════════════════════════════════════════════

function DataTable({ rows, headers, xVar, yVar }) {
  const MAX_ROWS = 500; // guard against pathologically large datasets
  const shown = rows.slice(0, MAX_ROWS);
  const cellBg = h => h === xVar ? "#eef2ff" : (h === yVar ? "#ecfdf5" : "transparent");
  const headBg = h => h === xVar ? "#c7d2fe" : (h === yVar ? "#a7f3d0" : "#f1f5f9");
  return (
    <div style={{ flex:"1 1 240px", minWidth:200, maxWidth:340 }}>
      <div style={{ fontSize:11, fontWeight:700, color:"#aaa", letterSpacing:1, textTransform:"uppercase", marginBottom:8 }}>Data</div>
      <div style={{ maxHeight:300, overflow:"auto", border:"1px solid #eee", borderRadius:8 }}>
        <table style={{ borderCollapse:"collapse", fontSize:11, width:"100%" }}>
          <thead>
            <tr>
              <th style={{ position:"sticky", top:0, background:"#f8f9fa", color:"#bbb", fontWeight:600, padding:"4px 6px", textAlign:"right", borderBottom:"1px solid #e5e7eb" }}>#</th>
              {headers.map(h => (
                <th key={h} style={{ position:"sticky", top:0, background:headBg(h), color:"#334155", fontWeight:700, padding:"4px 8px", textAlign:"left", borderBottom:"1px solid #e5e7eb", whiteSpace:"nowrap" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i} style={{ borderBottom:"1px solid #f5f5f5" }}>
                <td style={{ color:"#ccc", padding:"3px 6px", textAlign:"right" }}>{i + 1}</td>
                {headers.map(h => (
                  <td key={h} style={{ padding:"3px 8px", color:"#555", background:cellBg(h), whiteSpace:"nowrap", maxWidth:120, overflow:"hidden", textOverflow:"ellipsis" }}>{r[h]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > MAX_ROWS && <div style={{ fontSize:10, color:"#aaa", marginTop:4 }}>Showing first {MAX_ROWS} of {rows.length} rows</div>}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// COLLECT TABLE — one column per tracked statistic, one row per collected sample.
// Mirrors DataTable. Rows live in `collectRows` (keyed by stat id) and accumulate
// across runs; columns are the `trackedStats` specs (named by statLabel), each with
// a remove control. (Accumulation itself is wired in a later phase.)
// ══════════════════════════════════════════════════════════════════════════════
function CollectTable({ trackedStats, collectRows, onRemove }) {
  if (!trackedStats.length) {
    return (
      <div style={{ flex:"1 1 280px", minWidth:220, color:"#bbb", fontSize:13, padding:"16px 8px", lineHeight:1.5 }}>
        No tracked statistics yet. In <strong>Sample Results</strong> above, enable an overlay
        (or click a two-way table cell) and press <strong style={{ color:"#6366f1" }}>＋ track</strong> to add a column here.
      </div>
    );
  }
  const MAX_ROWS = 200;
  const shown = collectRows.slice(-MAX_ROWS);
  const offset = collectRows.length - shown.length;
  const fmt = v => (typeof v === "number" ? (isFinite(v) ? parseFloat(v.toFixed(4)) : "—") : v);
  return (
    <div style={{ flex:"1 1 280px", minWidth:220 }}>
      <div style={{ fontSize:11, fontWeight:700, color:"#aaa", letterSpacing:1, textTransform:"uppercase", marginBottom:8 }}>
        Collected statistics {collectRows.length > 0 && <span style={{ color:"#ccc", fontWeight:600 }}>· {collectRows.length} rows</span>}
      </div>
      <div style={{ maxHeight:300, overflow:"auto", border:"1px solid #eee", borderRadius:8 }}>
        <table style={{ borderCollapse:"collapse", fontSize:11, width:"100%" }}>
          <thead>
            <tr>
              <th style={{ position:"sticky", top:0, background:"#f8f9fa", color:"#bbb", fontWeight:600, padding:"4px 6px", textAlign:"right", borderBottom:"1px solid #e5e7eb" }}>#</th>
              {trackedStats.map(s => (
                <th key={s.id} style={{ position:"sticky", top:0, background:"#f1f5f9", color:"#334155", fontWeight:700, padding:"4px 8px", textAlign:"left", borderBottom:"1px solid #e5e7eb", whiteSpace:"nowrap" }}>
                  <span style={{ fontFamily:"monospace", color:"#4338ca" }}>{statLabel(s)}</span>
                  <button onClick={() => onRemove(s.id)} title="Remove column" style={{ ...btnX, fontSize:13, marginLeft:4, verticalAlign:"middle" }}>×</button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td colSpan={trackedStats.length + 1} style={{ padding:"12px 8px", color:"#bbb", textAlign:"center" }}>
                  No samples collected yet.
                </td>
              </tr>
            ) : shown.map((row, i) => (
              <tr key={row._id || offset + i} style={{ borderBottom:"1px solid #f5f5f5" }}>
                <td style={{ color:"#ccc", padding:"3px 6px", textAlign:"right" }}>{offset + i + 1}</td>
                {trackedStats.map(s => (
                  <td key={s.id} style={{ padding:"3px 8px", color:"#555", whiteSpace:"nowrap" }}>{fmt(row[s.id])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {collectRows.length > MAX_ROWS && <div style={{ fontSize:10, color:"#aaa", marginTop:4 }}>Showing last {MAX_ROWS} of {collectRows.length} rows</div>}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// UNI-CAT PLOT — single categorical variable as binned stacked-dot columns
// (a 1-D version of CatCatGrid). Collapses to top 10 + "Other" past 10 categories.
// ══════════════════════════════════════════════════════════════════════════════
function UniCatPlot({ rows, catVar, R, width, showCount = true, showPct = false, expanded, onToggleExpand, trackable, trackedLabels, onTrackStat }) {
  const counts = {};
  rows.forEach(r => { const v = r[catVar]; if (v !== "" && v !== undefined) counts[v] = (counts[v] || 0) + 1; });
  const allCats = Object.keys(counts).sort();
  const total = allCats.reduce((a, c) => a + counts[c], 0);
  const { shown } = collapseCats(allCats, counts, expanded);
  const namedSum = shown.filter(c => c !== OTHER_CAT).reduce((a, c) => a + counts[c], 0);
  const cellCount = c => c === OTHER_CAT ? total - namedSum : counts[c];

  const W = width || 520;
  const DOT_AREA_H = 220;            // height of each category's stacked-dot area
  const hasLabel = showCount || showPct;
  const estColW = clamp(W / Math.max(shown.length, 1), 48, 180);
  const maxCount = Math.max(1, ...shown.map(cellCount));
  // Uniform dot size so the tallest category's dots all fit; tall stacks wrap
  // into multiple columns within the cell (a 1-D version of the 2-way table).
  const dotR = fitDotR(maxCount, estColW - 14, DOT_AREA_H, 2, Math.min(R + 2, 9));

  return (
    <div style={{ width: W }}>
      <div style={{ display:"flex", alignItems:"stretch" }}>
        {shown.map((c, ci) => {
          const cnt = cellCount(c);
          const pct = total ? Math.round(cnt / total * 100) : 0;
          const color = COLORS[ci % COLORS.length];
          // Each visible number is a click target: count → count of catVar=c;
          // percent → proportion catVar=c. "Other" has no clean target.
          const colTrackable = trackable && c !== OTHER_CAT;
          const base = { variable:catVar, target:String(c) };
          return (
            <div key={c} style={{ flex:"1 1 0", minWidth:48, maxWidth:180, borderLeft: ci ? "1px solid #f0f0f0" : "none",
              display:"flex", flexDirection:"column", alignItems:"center", padding:"0 6px", boxSizing:"border-box" }}>
              {hasLabel && (
                <div style={{ fontSize:12, fontWeight:600, minHeight:16, display:"flex", gap:4 }}>
                  {showCount && <CatNum text={cnt} dim={cnt === 0} spec={colTrackable ? { ...base, fn:"countVal" } : null} trackable={trackable} trackedLabels={trackedLabels} onTrackStat={onTrackStat} />}
                  {showPct && <CatNum text={`(${pct}%)`} dim={cnt === 0} spec={colTrackable ? { ...base, fn:"proportion" } : null} trackable={trackable} trackedLabels={trackedLabels} onTrackStat={onTrackStat} />}
                </div>
              )}
              {/* bottom-anchored dot grid: fills a row left→right, then stacks
                  rows upward, so column height reflects the count */}
              <div style={{ height: DOT_AREA_H, width:"100%", display:"flex", flexDirection:"row",
                flexWrap:"wrap-reverse", alignContent:"flex-start", justifyContent:"flex-start", gap:2, overflow:"hidden" }}>
                {Array.from({ length: cnt }, (_, i) => (
                  <div key={i} style={{ width:dotR * 2, height:dotR * 2, borderRadius:"50%", background:color, flexShrink:0 }} />
                ))}
              </div>
              <div style={{ borderTop:"1px solid #ccc", width:"100%", marginTop:2 }} />
              <div style={{ fontSize:11, color:"#444", fontWeight:600, paddingTop:4, textAlign:"center",
                overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:"100%" }}>{c}</div>
            </div>
          );
        })}
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:10, marginTop:4 }}>
        <span style={{ fontSize:11, color:"#666", fontWeight:700 }}>{catVar}</span>
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

function CatCatGrid({ rows, xVar, yVar, R, width, showCount = true, showPct = false, expanded, onToggleExpand, trackable, trackedLabels, onTrackStat }) {
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

  // Build counts grid[yc][xc], folding overflow categories into "Other"
  const grid = {};
  yCats.forEach(yc => { grid[yc] = {}; xCats.forEach(xc => grid[yc][xc] = 0); });
  rows.forEach(r => {
    let xc = r[xVar], yc = r[yVar];
    if (xc === "" || xc === undefined || yc === "" || yc === undefined) return;
    xc = xSet.has(xc) ? xc : OTHER_CAT;
    yc = ySet.has(yc) ? yc : OTHER_CAT;
    if (grid[yc] && grid[yc][xc] !== undefined) grid[yc][xc]++;
  });

  // Row totals for row-conditional % (each Y-category row sums to 100%): P(X | Y)
  const rowTotals = {};
  yCats.forEach(yc => { rowTotals[yc] = xCats.reduce((a, xc) => a + grid[yc][xc], 0); });

  const LABEL_W = 96, CELL_MIN = 54, CELL_MAX = 150;
  const CELL_H = clamp(Math.round(250 / Math.max(yCats.length, 1)), 56, 110);
  const hasLabel = showCount || showPct;
  // Size dots uniformly so the densest cell's dots all fit (no clipping)
  let maxCell = 0;
  yCats.forEach(yc => xCats.forEach(xc => { if (grid[yc][xc] > maxCell) maxCell = grid[yc][xc]; }));
  const estCellW = clamp(((width || 520) - LABEL_W) / Math.max(xCats.length, 1), CELL_MIN, CELL_MAX);
  const dotAreaH = CELL_H - (hasLabel ? 18 : 0) - 8;
  const dotR = fitDotR(maxCell, estCellW - 12, dotAreaH, 2, Math.min(R + 2, 8));

  return (
    <div style={{ width: width ? width : "100%" }}>
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
              const c = grid[yc][xc];
              const rowTot = rowTotals[yc] || 0;
              const pct = rowTot ? Math.round(c / rowTot * 100) : 0;
              // Each visible number is a click target: count → count of X=xc given
              // Y=yc; percent → that row-conditional proportion P(X=xc | Y=yc).
              // OTHER buckets can't form a clean target, so they stay non-clickable.
              const cellTrackable = trackable && xc !== OTHER_CAT && yc !== OTHER_CAT;
              const base = { variable:xVar, target:String(xc), condVar:yVar, condVal:String(yc) };
              return (
                <div key={xc} style={{ flex:"1 1 0", minWidth:CELL_MIN, maxWidth:CELL_MAX, height:CELL_H,
                  borderLeft:"1px solid #eee", padding:"4px 6px", boxSizing:"border-box",
                  display:"flex", flexDirection:"column" }}>
                  {hasLabel && (
                    <div style={{ fontSize:12, fontWeight:600, display:"flex", gap:4, flexWrap:"wrap" }}>
                      {showCount && <CatNum text={c} dim={c === 0} spec={cellTrackable ? { ...base, fn:"countVal" } : null} trackable={trackable} trackedLabels={trackedLabels} onTrackStat={onTrackStat} />}
                      {showPct && <CatNum text={`(${pct}%)`} dim={c === 0} spec={cellTrackable ? { ...base, fn:"proportion" } : null} trackable={trackable} trackedLabels={trackedLabels} onTrackStat={onTrackStat} />}
                    </div>
                  )}
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
            <div key={xc} style={{ flex:"1 1 0", minWidth:CELL_MIN, maxWidth:CELL_MAX, textAlign:"center", paddingTop:5,
              fontSize:12, color:"#444", fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{xc}</div>
          ))}
        </div>
        {/* Axis titles */}
        <div style={{ textAlign:"center", marginTop:4, fontSize:11, color:"#666", fontWeight:700,
          marginLeft:LABEL_W }}>{xVar}</div>
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:10, fontSize:10, color:"#aaa", marginTop:4, marginLeft:LABEL_W - 10 }}>
        <span>Rows = {yVar} · row-conditional %: P({xVar} | {yVar})</span>
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

function SplitDotPlots({ rows, catVar, numVar, R, width, isTime, orientation = "h", showBox, showMean, showSD, showValues, expanded, onToggleExpand, trackable, trackedLabels, onTrackStat }) {
  // Per-group tracking spec: a numeric stat conditioned on this group (null for the
  // "Other" bucket or when the plot isn't trackable).
  const grpSpec = (cat, fn) => (trackable && cat !== OTHER_CAT) ? { fn, variable:numVar, condVar:catVar, condVal:String(cat) } : null;
  const tp = { trackable, trackedLabels, onTrackStat };
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
            const groupNums = rows.map(r => groupOf(r[catVar]) === cat ? toNum(r[numVar]) : NaN).filter(v => !isNaN(v));
            const summary = numericSummary(groupNums);
            const binOf = v => Math.round(sy(v) / (dotR * 2 + 1));
            const binCounts = {};
            groupNums.forEach(v => { const k = binOf(v); binCounts[k] = (binCounts[k] || 0) + 1; });
            const widest = Math.max(1, ...Object.values(binCounts));
            const xData = x0 + colW * 0.46;        // data baseline; dots to the right, overlays to the left
            const dotAreaW = (x0 + colW) - xData - 4;
            const hsp = Math.min(dotR * 2 + 1, (dotAreaW - dotR) / widest);
            const stacks = {};
            const groupDots = groupNums.map(v => {
              const key = binOf(v); stacks[key] = (stacks[key] || 0) + 1;
              return { x: xData + dotR + 3 + (stacks[key] - 1) * hsp, y: sy(v) };
            });
            const color = COLORS[gi % COLORS.length];
            const bx = xData - 32;                  // vertical boxplot, just left of the mean/SD cluster
            const sdMidX = xData - 5;               // ±SD runs vertically through the mean triangle
            return (
              <g key={cat}>
                {gi > 0 && <line x1={x0} y1={PT} x2={x0} y2={PT + iH} stroke="#f0f0f0" strokeWidth={1} />}
                {/* per-category baseline the mean tip touches */}
                <line x1={xData} y1={PT} x2={xData} y2={PT + iH} stroke="#f3f4f6" strokeWidth={1} />
                {groupDots.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r={dotR} fill={color}
                  fillOpacity={Math.min(0.85, Math.max(0.3, 60 / Math.sqrt(groupDots.length + 1)))} />)}
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
          <text x={PL + iW / 2} y={H - 4} textAnchor="middle" fontSize={11} fill="#666" fontWeight={600}>{catVar}</text>
          <text x={14} y={PT + iH / 2} textAnchor="middle" fontSize={11} fill="#666" fontWeight={600} transform={"rotate(-90,14," + (PT + iH / 2) + ")"}>{numVar}</text>
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

  return (
    <div style={{ width: width ? width : "100%" }}>
      <svg width={W} height={H} style={{ display:"block", overflow:"visible", maxWidth:"100%" }}>
        {/* vertical gridlines */}
        {ticks.map((t, i) => <line key={"g"+i} x1={sx(t)} y1={PT} x2={sx(t)} y2={H - PB} stroke="#f5f5f5" strokeWidth={1} />)}

        {cats.map((cat, gi) => {
          const top = PT + gi * GROUP_H;
          const baseY = top + GROUP_H - 52; // dots stack upward from here; mean/SD/box below
          const groupNums = rows.map(r => groupOf(r[catVar]) === cat ? toNum(r[numVar]) : NaN).filter(v => !isNaN(v));
          const summary = numericSummary(groupNums);
          // First pass: bin counts to find the tallest stack, so dots fit the band
          const binOf = v => Math.round(sx(v) / (dotR * 2 + 1));
          const binCounts = {};
          groupNums.forEach(v => { const k = binOf(v); binCounts[k] = (binCounts[k] || 0) + 1; });
          const tallest = Math.max(1, ...Object.values(binCounts));
          const avail = baseY - top - 4;
          const spacing = Math.min(dotR * 2 + 1, avail / tallest);
          const stacks = {};
          const groupDots = groupNums.map(v => {
            const x = sx(v); const key = binOf(v);
            stacks[key] = (stacks[key] || 0) + 1;
            return { x, y: baseY - (stacks[key] - 1) * spacing };
          });
          const color = COLORS[gi % COLORS.length];
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
              {/* dots */}
              {groupDots.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r={dotR} fill={color}
                fillOpacity={Math.min(0.85, Math.max(0.3, 60 / Math.sqrt(groupDots.length + 1)))} />)}
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
        <text x={PL + iW / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="#666" fontWeight={600}>{numVar} (by {catVar})</text>
      </svg>
      {allCats.length > 10 && (
        <button onClick={onToggleExpand} style={{ ...btnNav, fontSize:10, marginTop:4 }}>
          {expanded ? "Collapse to top 10 groups" : `Show all ${allCats.length} groups`}
        </button>
      )}
    </div>
  );
}


export { Plot, SampleResults, StatDefiner, DistributionPlot, EDAPlot, DataTable, CollectTable, UniCatPlot, CatCatGrid, SplitDotPlots };
