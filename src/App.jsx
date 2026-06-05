import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { iSm, btnNav, ctrlLbl } from "./lib/styles";
import { uid, parseCSV } from "./lib/util";
import { computeStat, statLabel, statKey, NUMERIC_FNS } from "./lib/stats";
import { colLabel, exprLabel, computeStatRow, evalExpr } from "./lib/expr";
import { drawSample, deviceVarKind, mkSpinner, mkStacks, mkMixer, runAnimatedSample } from "./lib/sampling";
import { DeviceCard } from "./components/devices";
import { CopyColumnButton } from "./components/ui";
import { EDAPlot, SampleResults, StatDefiner, DerivedBuilder, DistributionPlot, CollectTable } from "./components/plots";

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

  // Tracked-statistic data model (Phase 2): columns authored by selecting overlays
  // in Sample Results; `collectRows` is the accumulator (one row per collected
  // sample, keyed by stat id) that later phases will fill.
  const [trackedStats, setTrackedStats] = useState([]);
  const [collectRows, setCollectRows] = useState([]);
  // The most recently finished manual draw: { id, rows }. Tracking a stat seeds its
  // value for this sample immediately (its number is on the plot right now), and the
  // per-run accumulator tags that sample's row with this id so a later track fills the
  // same row instead of starting a new one.
  const [currentSample, setCurrentSample] = useState(null);
  // Bumped to force a re-render after a guard is declined, so controlled inputs
  // (sample-size box, device fields) snap back to their unchanged state instead of
  // showing the rejected edit.
  const [, setGuardTick] = useState(0);
  const rejectEdit = () => setGuardTick(t => t + 1);

  // Toggle tracking of a stat (clicking its number on the plot adds it, or removes
  // it if that exact statistic — same statLabel — is already tracked). Adding seeds
  // the current sample's value into the table at once (its number is visible now).
  // Add a stat spec as a tracked column (no toggle) and seed the current sample's
  // value for it immediately (its number is on the plot now). Dedupes by statLabel.
  // Shared by click-to-track and the manual stat builder.
  const addTrackedStat = spec => {
    if (trackedStats.some(s => statKey(s) === statKey(spec))) return;
    const newStat = { id:uid(), target:"", condVar:"", condVal:"", variable2:"", ...spec };
    setTrackedStats(ts => [...ts, newStat]);
    if (!currentSample) return;
    setCollectRows(rows => {
      const idx = rows.findIndex(r => r._id === currentSample.id);
      if (idx >= 0) {
        const copy = rows.slice();
        copy[idx] = { ...copy[idx], [newStat.id]: computeStat(newStat, currentSample.rows) };
        return copy;
      }
      // No row for this sample yet (nothing was tracked when it was drawn) — create it
      // now with every tracked stat (including the new one) computed on that sample.
      const row = { _id: currentSample.id, ...computeStatRow([...trackedStats, newStat], currentSample.rows, computeStat) };
      return [...rows, row];
    });
  };
  // Click-to-track: clicking a number on the plot adds it, or removes it if that exact
  // statistic (same statLabel) is already tracked.
  const trackStat = spec => {
    const key = statKey(spec);
    if (trackedStats.some(s => statKey(s) === key)) untrackStatByKey(key);
    else addTrackedStat(spec);
  };
  const untrackStatByKey = key => setTrackedStats(ts => dropDependents(ts, ts.filter(s => statKey(s) === key).map(s => s.id)));
  // Remove a column (by id) and cascade to any derived column that references it —
  // a derived statistic is meaningless once one of its operands is gone (Phase 5).
  const untrackStat = id => setTrackedStats(ts => dropDependents(ts, [id]));

  // Add a derived column { kind:"derived", tokens, inputs } and backfill its value
  // into every already-collected row at once (operands are existing columns, so no
  // re-sampling is needed). Both accumulation paths compute it for new rows too.
  const addDerivedStat = (tokens, inputs, name) => {
    const newStat = { id:uid(), kind:"derived", tokens, inputs };
    if (name) newStat.name = name;
    setTrackedStats(ts => [...ts, newStat]);
    setCollectRows(rows => rows.map(r => ({ ...r, [newStat.id]: evalExpr(tokens, sid => r[sid]) })));
  };

  // Track the ruler's A − B as a derived column (Phase 6c). Each operand is either a
  // measure (a stat spec) or a plain constant ({ value }); at least one is a measure.
  // Ensures both measure operands exist as tracked columns (deduped by statLabel, seeding
  // the current sample like addTrackedStat), then adds a derived `A − B` column that
  // backfills every collected row from the stored operand values (like addDerivedStat).
  const trackDifference = (opA, opB) => {
    const stats = trackedStats.slice();
    const newPlain = []; // operand columns created by this call
    const tokenFor = op => {
      if (!op.spec) return { k:"num", v: parseFloat(Number(op.value).toFixed(4)) };
      const key = statKey(op.spec);
      let col = stats.find(s => s.kind !== "derived" && statKey(s) === key);
      if (!col) {
        col = { id:uid(), target:"", condVar:"", condVal:"", variable2:"", ...op.spec };
        stats.push(col); newPlain.push(col);
      }
      return { k:"col", id: col.id };
    };
    const tokens = [tokenFor(opA), { k:"op", v:"-" }, tokenFor(opB)];
    // Skip if an identical difference is already a column.
    const sig = JSON.stringify(tokens);
    if (stats.some(s => s.kind === "derived" && JSON.stringify(s.tokens) === sig)) return;
    const inputs = [...new Set(tokens.filter(t => t.k === "col").map(t => t.id))];
    const derived = { id:uid(), kind:"derived", tokens, inputs };
    const nextStats = [...stats, derived];
    setTrackedStats(nextStats);
    setCollectRows(rows => {
      let out = rows.slice();
      if (currentSample && newPlain.length) {
        const idx = out.findIndex(r => r._id === currentSample.id);
        if (idx >= 0) {
          const patch = {};
          newPlain.forEach(s => { patch[s.id] = computeStat(s, currentSample.rows); });
          out[idx] = { ...out[idx], ...patch };
        } else {
          out = [...out, { _id: currentSample.id, ...computeStatRow(nextStats.filter(s => s.kind !== "derived"), currentSample.rows, computeStat) }];
        }
      }
      return out.map(r => ({ ...r, [derived.id]: evalExpr(tokens, sid => r[sid]) }));
    });
  };

  // Batch accumulation ("Collect N") for the tracked-stat table
  const [batchSize, setBatchSize] = useState(500);
  const [batchCollecting, setBatchCollecting] = useState(false);
  const [batchProgress, setBatchProgress] = useState(0);
  const batchCancelRef = useRef(false);

  // ── Invalidation helpers ──────────────────────────────────────────────────
  // Which pipeline devices a tracked stat references — by stable device id, the same
  // key a spec's variable/variable2/condVar fields now hold (so a sampler change can
  // tell whether it invalidates a column).
  const statDependsOn = (s, devId) =>
    s.variable === devId || s.variable2 === devId || s.condVar === devId;
  // A tracked stat stays valid only if every device it references still exists.
  // `ids` is the set of live device ids. Derived columns reference statistic columns
  // (not pipeline devices) so they are governed by `dropDependents`/`dropInvalid`.
  const statVarsValid = (s, ids) =>
    s.kind === "derived" ||
    ((!s.variable || ids.includes(s.variable)) &&
     (!s.variable2 || ids.includes(s.variable2)) &&
     (!s.condVar || ids.includes(s.condVar)));
  // A numeric-only stat (mean/SD/…) is invalidated when a device it averages over is
  // no longer numeric — e.g. relabeling or adding an outcome turns the device's variable
  // categorical. `kinds` is deviceId → {numeric,time} for the post-edit pipeline. Derived
  // columns and value-tallying stats (count/countVal/proportion) are kind-agnostic.
  const statKindInvalid = (s, kinds) => {
    if (s.kind === "derived" || !NUMERIC_FNS.has(s.fn)) return false;
    return [s.variable, s.variable2].some(v => v && kinds[v] && !kinds[v].numeric);
  };
  // Remove the given stat ids and cascade to any derived column whose operands
  // (`inputs`) reference a removed id — settling chains of derived-on-derived.
  const dropDependents = (stats, removeIds) => {
    const gone = new Set(removeIds);
    let changed = true;
    while (changed) {
      changed = false;
      stats.forEach(s => {
        if (s.kind === "derived" && !gone.has(s.id) && s.inputs.some(i => gone.has(i))) { gone.add(s.id); changed = true; }
      });
    }
    return stats.filter(s => !gone.has(s.id));
  };
  // Drop stat columns whose pipeline devices vanished, then cascade-drop any derived
  // column orphaned by that removal (Phase 5 analog of the variable-dependency guard).
  const dropInvalid = (stats, ids) => {
    const invalid = stats.filter(s => !statVarsValid(s, ids)).map(s => s.id);
    return dropDependents(stats, invalid);
  };
  // Distribution fingerprint of a device, keyed by stable outcome ids so it ignores
  // pure relabelings (a device or outcome rename) and cosmetic color edits. Only a
  // real change to what gets drawn — counts, probabilities, with/without replacement,
  // or adding/removing outcomes — changes this, so only those warn-and-clear.
  const samplingShape = d => {
    const base = { type:d.type, withReplacement:d.withReplacement };
    if (d.type === "stacks") base.items = d.items.map(it => ({ id:it.id, count:it.count }));
    if (d.type === "mixer") base.balls = d.balls.map(b => b.id);
    if (d.type === "spinner") base.slices = d.slices.map(s => ({ id:s.id, pct:s.pct }));
    return JSON.stringify(base);
  };
  // Seamless OUTCOME-relabel propagation: when an edit renames one of a device's outcome
  // labels (matched by stable outcome id), rewrite any tracked spec whose target/condVal
  // stored that label so its column and future draws follow the new label — no warning,
  // results kept. A device (variable) rename needs NO handling here: specs reference the
  // device's stable id, which never changes, and display names resolve through nameOf.
  const propagateRenames = (stats, oldDev, newDev) => {
    const coll = { stacks:"items", mixer:"balls", spinner:"slices" }[oldDev.type];
    const labelMap = {};
    if (coll) {
      const oldById = {};
      (oldDev[coll] || []).forEach(it => { oldById[it.id] = it.label; });
      (newDev[coll] || []).forEach(it => {
        if (oldById[it.id] !== undefined && oldById[it.id] !== it.label) labelMap[oldById[it.id]] = it.label;
      });
    }
    if (Object.keys(labelMap).length === 0) return stats; // no outcome relabeled
    const devId = oldDev.id; // === newDev.id (an edit never changes the id)
    return stats.map(s => {
      const ns = { ...s };
      // Outcome relabels apply only to specs over THIS device (its variable / condVar).
      if (ns.variable === devId && ns.target && labelMap[ns.target] !== undefined) ns.target = labelMap[ns.target];
      if (ns.condVar === devId && ns.condVal && labelMap[ns.condVal] !== undefined) ns.condVal = labelMap[ns.condVal];
      return ns;
    });
  };
  const clearCollected = () => { setCollectRows([]); setBatchProgress(0); setCurrentSample(null); };

  // Manual statistic builder (advanced, hidden by default): authors one stat spec
  // and adds it as a column to the same tracked-stat table — not a separate workflow.
  const [manualOpen, setManualOpen] = useState(false);
  const [derivedOpen, setDerivedOpen] = useState(false);
  const [manualStat, setManualStat] = useState({ fn:"mean", variable:"", target:"", condVar:"", condVal:"", variable2:"" });
  const addManualStat = () => { if (manualStat.variable) addTrackedStat(manualStat); };

  // Devices (and drawn rows / stat specs) are identified by stable id; varName is
  // display-only. `varIds` are the plot/table "headers"; `nameOf(id)` resolves the
  // current display name (falling back to the id itself for any stray key).
  const varIds = pipeline.map(d => d.id);
  const nameMap = useMemo(() => Object.fromEntries(pipeline.map(d => [d.id, d.varName])), [pipeline]);
  const nameOf = useCallback(id => (id in nameMap ? nameMap[id] : id), [nameMap]);
  // Authoritative num/cat kind for each sampler variable, derived from the device's
  // DECLARED outcomes (not the drawn rows), so a plot's type can't silently flip when a
  // rare non-numeric outcome first appears. Keyed by device id. Sampler plots use this;
  // EDA keeps colKind.
  const varKinds = useMemo(
    () => Object.fromEntries(pipeline.map(d => [d.id, deviceVarKind(d)])),
    [pipeline]
  );
  // A2 guard: a device name is invalid if it is blank/whitespace-only or exactly matches
  // another device's name. Invalid names flag red and block "Draw Sample". (Id-keying
  // already keeps same-named columns distinct; this is the user-facing warning so a
  // malformed, ambiguous sample isn't drawn in the first place.)
  const invalidNameIds = useMemo(() => {
    const trimmed = pipeline.map(d => (d.varName || "").trim());
    const counts = {};
    trimmed.forEach(n => { if (n) counts[n] = (counts[n] || 0) + 1; });
    return new Set(pipeline.filter((d, i) => trimmed[i] === "" || counts[trimmed[i]] > 1).map(d => d.id));
  }, [pipeline]);
  const hasNameError = invalidNameIds.size > 0;
  // Label any tracked column (plain stat → statLabel; derived → its expression
  // rendered with operands resolved). Built fresh each render so renames flow through.
  const statsById = Object.fromEntries(trackedStats.map(s => [s.id, s]));
  const labelFor = s => colLabel(s, statsById, nameOf);
  // The underlying formula, used as the header tooltip so a custom name never hides
  // what the column actually computes.
  const exprFor = s => exprLabel(s, statsById, nameOf);
  // Plain-stat columns available as operands in the derived calculator, each with its
  // value on the current sample for the live preview.
  const operandCols = trackedStats
    .filter(s => s.kind !== "derived")
    .map(s => ({ id:s.id, label:statLabel(s, nameOf), value: currentSample ? computeStat(s, currentSample.rows) : NaN }));

  const addDevice = type => {
    const m = { spinner:mkSpinner, stacks:mkStacks, mixer:mkMixer };
    const prefix = { spinner:"spin", stacks:"stk", mixer:"mix" }[type];
    setPipeline(p => {
      // Derive the next number by scanning the current pipeline for this type's
      // prefix and taking max+1. Robust to the seed device and to remove/re-add.
      const re = new RegExp(`^${prefix}(\\d+)$`);
      const max = p.reduce((mx, d) => {
        const mt = re.exec(d.varName);
        return mt ? Math.max(mx, +mt[1]) : mx;
      }, 0);
      return [...p, m[type](max + 1)];
    });
  };

  const handleCSVFile = file => {
    const reader = new FileReader();
    reader.onload = e => {
      const parsed = parseCSV(String(e.target.result));
      if (parsed.headers.length) setDataset({ ...parsed, name: file.name });
    };
    reader.readAsText(file);
  };

  const updDevice = (i, d) => {
    const old = pipeline[i];
    const structural = samplingShape(old) !== samplingShape(d);
    const dependent = trackedStats.some(s => statDependsOn(s, old.id));
    // Device ids never change on an edit, so the live-id set is just the current pipeline.
    const liveIds = pipeline.map(dev => dev.id);
    // Outcome edits can flip a variable's kind (numeric ↔ categorical) — even a pure
    // relabel ("5" → "x") that samplingShape ignores. Apply outcome-relabel propagation
    // first, then find numeric-only stats (mean/SD/…) orphaned because their variable is
    // no longer numeric, so they're dropped rather than silently computing over text.
    const renamed = propagateRenames(trackedStats, old, d);
    const newKinds = Object.fromEntries(pipeline.map((dev, j) => { const nd = j === i ? d : dev; return [nd.id, deviceVarKind(nd)]; }));
    const orphanIds = renamed.filter(s => statKindInvalid(s, newKinds)).map(s => s.id);
    // Distribution-structure guard: only a change to *what gets drawn* (counts,
    // probabilities, with/without replacement, adding/removing outcomes) clears collected
    // results. A kind flip additionally removes the now-meaningless numeric column(s).
    const clearsCollected = structural && dependent && collectRows.length > 0;
    const dropsColumns = orphanIds.length > 0;
    if (clearsCollected || dropsColumns) {
      const n = orphanIds.length;
      const msg = dropsColumns
        ? "This edit makes the variable categorical, so " + n + " tracked statistic column" +
          (n > 1 ? "s that need" : " that needs") + " a numeric variable (e.g. mean/SD) will be removed" +
          (clearsCollected ? ", and the statistics already collected will be cleared." : ".") + " Continue?"
        : "Editing this sampler deletes the statistics already collected in the table. (The tracked columns are kept.) Continue?";
      if (!window.confirm(msg)) { rejectEdit(); return; }
      let next = dropInvalid(renamed, liveIds);
      if (dropsColumns) next = dropDependents(next, orphanIds);
      setTrackedStats(next);
      if (clearsCollected) clearCollected();
    } else {
      // Seamless: propagate any outcome relabels into tracked specs, keep results.
      setTrackedStats(renamed);
    }
    setPipeline(p => { const a = [...p]; a[i] = d; return a; });
  };
  const remDevice = i => {
    const removed = pipeline[i];
    const dependent = trackedStats.some(s => statDependsOn(s, removed.id));
    if (collectRows.length && dependent) {
      if (!window.confirm("Removing this sampler deletes the statistics already collected in the table, and any tracked column that depends on it. Continue?")) { rejectEdit(); return; }
      clearCollected();
    }
    const liveIds = pipeline.filter((_, j) => j !== i).map(d => d.id);
    setTrackedStats(ts => dropInvalid(ts, liveIds));
    setPipeline(p => p.filter((_, j) => j !== i));
  };
  const movDevice = (i, dir) => setPipeline(p => { const a = [...p], j = i + dir; if (j < 0 || j >= a.length) return a; [a[i], a[j]] = [a[j], a[i]]; return a; });

  // Sample-size guard: a distribution at n=10 must not be mixed with one at n=20,
  // so changing n clears the collected results (but keeps the tracked columns).
  const changeSampleSize = v => {
    const n = Math.max(1, parseInt(v) || 1);
    if (n === sampleSize) return;
    if (collectRows.length) {
      if (!window.confirm("Changing the sample size clears the statistics already collected in the table. (The tracked columns are kept.) Continue?")) { rejectEdit(); return; }
      clearCollected();
    }
    setSampleSize(n);
  };

  const doSample = useCallback(async () => {
    if (sampling) { cancelRef.current = true; return; }
    if (hasNameError) return; // duplicate/blank device names — refuse to draw an ambiguous sample
    cancelRef.current = false;
    setSampling(true);
    setSampleData([]);
    setCurrentSample(null);
    const rows = [];
    await runAnimatedSample({
      pipeline, sampleSize, speed:animSpeed,
      setAnimStates,
      onRow: row => { rows.push(row); setSampleData([...rows]); },
      onDone: () => {
        setSampling(false);
        if (cancelRef.current) return; // cancelled run is partial — don't record it
        // Mark this finished sample as current so tracking a stat later seeds its row.
        const sample = { id: uid(), rows };
        setCurrentSample(sample);
        // Per-run accumulation (always on): append one row of every tracked stat
        // computed on the finished sample, tagged with this sample's id.
        if (trackedStats.length) {
          const statRow = { _id: sample.id, ...computeStatRow(trackedStats, rows, computeStat) };
          setCollectRows(cr => [...cr, statRow]);
        }
      },
      cancelRef,
    });
  }, [pipeline, sampleSize, animSpeed, sampling, trackedStats, hasNameError]);

  // Batch accumulation for the tracked-stat table: draw `batchSize` samples and
  // append one row per sample (each tracked stat computed on that sample). Same
  // shared draw path as doSample, so counting can't diverge.
  const doCollectTracked = () => {
    if (batchCollecting) { batchCancelRef.current = true; return; }
    if (!trackedStats.length) return;
    batchCancelRef.current = false;
    setBatchCollecting(true); setBatchProgress(0);
    const specs = trackedStats;
    const newRows = [];
    let rep = 0;
    const CHUNK = 200;
    const step = () => {
      let n = 0;
      while (n < CHUNK && rep < batchSize && !batchCancelRef.current) {
        const rows = drawSample(pipeline, sampleSize);
        const statRow = { _id: uid(), ...computeStatRow(specs, rows, computeStat) };
        newRows.push(statRow);
        rep++; n++;
      }
      setBatchProgress(Math.round(rep / batchSize * 100));
      if (rep < batchSize && !batchCancelRef.current) requestAnimationFrame(step);
      else { setCollectRows(cr => [...cr, ...newRows]); setBatchCollecting(false); }
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
              onChange={e => changeSampleSize(e.target.value)}
              style={{ ...iSm, width:60, marginLeft:4 }} />
          </label>
          <button onClick={doSample} disabled={hasNameError && !sampling}
            title={hasNameError && !sampling ? "Rename — device names must be unique and non-blank" : undefined}
            style={{ padding:"8px 18px", background:sampling ? "#ef4444" : (hasNameError ? "#c7c9d1" : "#6366f1"), color:"#fff", border:"none", borderRadius:8, fontWeight:700, fontSize:13, cursor:(hasNameError && !sampling) ? "not-allowed" : "pointer", minWidth:120 }}>
            {sampling ? "⏹ Stop" : "▶ Draw Sample"}
          </button>
          {hasNameError && !sampling && (
            <span style={{ fontSize:11, color:"#ef4444", fontWeight:600, maxWidth:160, lineHeight:1.2 }}>
              Rename — device names must be unique and non-blank
            </span>
          )}
          {sampleData.length > 0 && !sampling && (
            <button onClick={() => {
              // Draw rows are keyed by device id; resolve each to its display name so the
              // exported CSV header stays human-readable.
              const rows = sampleData.map(r => { const o = { _sample: r._sample }; varIds.forEach(id => { o[nameOf(id)] = r[id]; }); return o; });
              exportCSV(rows, "sample.csv");
            }} style={{ ...btnNav, fontSize:12 }}>⬇ CSV</button>
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
                animState={animStates[dev.id] || null} locked={sampling} nameError={invalidNameIds.has(dev.id)} />
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
        <SampleResults sampleData={sampleData} varNames={varIds} varKinds={varKinds} nameOf={nameOf} onTrackStat={trackStat} onTrackDiff={trackDifference} trackedStats={trackedStats} />
      </div>

      {/* Collect Statistics */}
      <div style={{ background:"#fff", borderRadius:14, padding:14, boxShadow:"0 1px 6px rgba(0,0,0,0.04)", border:"1px solid #eee", opacity:sampleData.length ? 1 : 0.35, pointerEvents:sampleData.length ? "auto" : "none", transition:"opacity 0.3s" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12, flexWrap:"wrap" }}>
          <span style={{ fontSize:14, fontWeight:700, color:"#2c3e50" }}>📈 Collect Statistics</span>
          <div style={{ marginLeft:"auto", display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
            <label style={ctrlLbl}>Collect
              <input type="number" value={batchSize} min={1} max={100000}
                onChange={e => setBatchSize(Math.max(1, parseInt(e.target.value) || 1))}
                style={{ ...iSm, width:70, marginLeft:4 }} />
              samples
            </label>
            <button onClick={doCollectTracked} disabled={!trackedStats.length}
              style={{ padding:"7px 16px", background:batchCollecting ? "#ef4444" : "#10b981", color:"#fff", border:"none", borderRadius:8, fontWeight:700, fontSize:13, cursor:trackedStats.length ? "pointer" : "not-allowed", opacity:trackedStats.length ? 1 : 0.5, minWidth:120 }}>
              {batchCollecting ? "⏹ " + batchProgress + "%" : "▶ Collect " + batchSize}
            </button>
            {collectRows.length > 0 && !batchCollecting && (
              <>
                <button onClick={() => { if (window.confirm("Clear all " + collectRows.length + " collected rows? (Tracked columns are kept.)")) clearCollected(); }} style={{ ...btnNav, fontSize:12 }}>✕ Clear</button>
                <button onClick={() => {
                  const rows = collectRows.map((r, i) => { const o = { _rep:i + 1 }; trackedStats.forEach(s => { o[labelFor(s)] = r[s.id] !== undefined ? r[s.id] : ""; }); return o; });
                  exportCSV(rows, "collected-statistics.csv");
                }} style={{ ...btnNav, fontSize:12 }}>⬇ CSV</button>
              </>
            )}
          </div>
        </div>
        {/* Stacked top-to-bottom: the tracked-statistic table, then the manual
            builder (a table-authoring tool), then the sampling-distribution plot. */}
        <div style={{ marginBottom:14 }}>
          <CollectTable trackedStats={trackedStats} collectRows={collectRows} onRemove={untrackStat} labelFor={labelFor} titleFor={exprFor} />
        </div>

        {/* Derived-statistic calculator — combine collected columns into a new column
            (e.g. a difference of two means, or an ANOVA-style total variation). */}
        {operandCols.length > 0 && (
          <div style={{ borderTop:"1px solid #f0f0f0", paddingTop:10, marginBottom:14 }}>
            <button onClick={() => setDerivedOpen(o => !o)}
              style={{ background:"none", border:"none", cursor:"pointer", fontSize:11, fontWeight:700, color:"#bbb", letterSpacing:1, textTransform:"uppercase", display:"flex", alignItems:"center", gap:6, padding:0 }}>
              <span style={{ transform: derivedOpen ? "rotate(90deg)" : "none", transition:"transform 0.15s", display:"inline-block" }}>▶</span>
              ƒ Build a derived statistic
            </button>
            {derivedOpen && (
              <div style={{ marginTop:8 }}>
                <div style={{ fontSize:11, color:"#aaa", marginBottom:8 }}>
                  Combine the statistics you've collected — click a column chip, then operators — to make a new column (e.g. <code>A − B</code> for a difference of means). It fills in for every collected row at once.
                </div>
                <DerivedBuilder columns={operandCols} onAdd={addDerivedStat} />
              </div>
            )}
          </div>
        )}

        {/* Manual statistic builder — advanced, hidden behind a toggle. Adds a column
            to the same tracked-stat table above instead of a separate workflow. */}
        <div style={{ borderTop:"1px solid #f0f0f0", paddingTop:10, marginBottom:14 }}>
          <button onClick={() => setManualOpen(o => !o)}
            style={{ background:"none", border:"none", cursor:"pointer", fontSize:11, fontWeight:700, color:"#bbb", letterSpacing:1, textTransform:"uppercase", display:"flex", alignItems:"center", gap:6, padding:0 }}>
            <span style={{ transform: manualOpen ? "rotate(90deg)" : "none", transition:"transform 0.15s", display:"inline-block" }}>▶</span>
            Define a statistic manually
          </button>
          {manualOpen && (
            <div style={{ marginTop:8 }}>
              <div style={{ fontSize:11, color:"#aaa", marginBottom:6 }}>
                Build a statistic from the sampler's variables and add it as a column. Most statistics are easier to add by clicking their value on the Sample Results plot above — this is for cases that aren't shown there.
              </div>
              <div style={{ display:"flex", gap:8, alignItems:"flex-start", flexWrap:"wrap" }}>
                <div style={{ flex:"1 1 360px", minWidth:300 }}>
                  <StatDefiner stat={manualStat} varNames={varIds} nameOf={nameOf} sampleData={sampleData}
                    onChange={setManualStat} onRemove={() => setManualOpen(false)} />
                </div>
                <button onClick={addManualStat} disabled={!manualStat.variable}
                  style={{ padding:"7px 16px", background:"#6366f1", color:"#fff", border:"none", borderRadius:8, fontWeight:700, fontSize:13, cursor:manualStat.variable ? "pointer" : "not-allowed", opacity:manualStat.variable ? 1 : 0.5 }}>
                  ＋ Add to table
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Sampling-distribution plot for a chosen tracked column. */}
        {trackedStats.length > 0 && collectRows.length > 0 && (
          <div style={{ borderTop:"1px solid #f0f0f0", paddingTop:12 }}>
            <DistributionPlot columns={trackedStats.map(s => ({ label: labelFor(s), values: collectRows.map(r => r[s.id]) }))} />
          </div>
        )}
      </div>
    </div>
  );
}
