import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { iSm, btnNav, btnPlus, ctrlLbl } from "./lib/styles";
import { uid, parseCSV } from "./lib/util";
import { computeStat, statLabel } from "./lib/stats";
import { sampleSpinner, makeDrawState, drawStacks, drawMixer, mkSpinner, mkStacks, mkMixer, runAnimatedSample } from "./lib/sampling";
import { DeviceCard } from "./components/devices";
import { CopyColumnButton } from "./components/ui";
import { EDAPlot, DotPlot, StatDefiner, StatDistPlot } from "./components/plots";

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
