import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { iSm, btnNav, ctrlLbl } from "./lib/styles";
import { uid, parseCSV } from "./lib/util";
import { computeStat, statLabel, statKey, NUMERIC_FNS } from "./lib/stats";
import { colLabel, exprLabel, computeStatRow, evalExpr } from "./lib/expr";
import { drawSample, stageVarKind, stageOutcomes, mkStage, migratePipeline, rekeyStats, rekeyStopRule, mkSpinner, mkStacks, mkMixer, runAnimatedSample } from "./lib/sampling";
import { encodeConfig, decodeConfig, checkHiddenPassword, shareURL } from "./lib/share";
import { StageCard } from "./components/devices";
import { CodeControls, CodeBeside, CodeIntegrated } from "./components/code";
import { generateCode } from "./lib/codegen";
import { NumInput } from "./components/ui";
import { EDAPlot, SampleResults, StatDefiner, DerivedBuilder, DistributionPlot, CollectTable } from "./components/plots";
import prismLogo from "./assets/prism-logo.svg";
import prismLogoCb from "./assets/prism-logo-cb.svg";

// Browser dialogs can be unavailable in sandboxed/embedded contexts (they throw, e.g.
// "prompt() is not supported"). Wrap them so a blocked dialog degrades gracefully —
// a thrown prompt inside a mount effect would otherwise unmount the whole app.
const safePrompt = (msg, def) => { try { return window.prompt(msg, def); } catch { return null; } };
const safeAlert = msg => { try { window.alert(msg); } catch { /* no-op */ } };
const safeConfirm = msg => { try { return window.confirm(msg); } catch { return true; } };

export default function App() {
  // CSV / EDA dataset
  const [dataset, setDataset] = useState(null); // { headers, rows, name }
  const [edaOpen, setEdaOpen] = useState(true);

  const [pipeline, setPipeline] = useState(() => [mkStage(mkStacks(1))]);
  const [sampleSize, setSampleSize] = useState(10);
  // Run mode: "fixed" draws exactly `sampleSize` rows; "until" keeps drawing until
  // `stopRule` holds (variable n), with `sampleSize` as the safety cap (max draws).
  const [runMode, setRunMode] = useState("fixed");
  const [stopRule, setStopRule] = useState(null); // { kind, stageId, value, n }
  const [animSpeed, setAnimSpeed] = useState(0); // default: slow
  // Parallel R/Python code panels (Task E): "off" | "r" | "python". Serialized in
  // shared links so a chosen language travels with the sampler.
  const [codeLang, setCodeLang] = useState("off");
  // Color-blind palette for the code-section symbols (Task E): red→black, green→gray.
  const [cbMode, setCbMode] = useState(false);
  // Hidden (password-veiled) sampler state (Task D). `hidden` marks a veiled sampler;
  // `revealed` is an in-session unlock; `hiddenData` keeps the {salt, pw-verifier} so a
  // Reveal can re-check the password without ever storing the plaintext. The config itself
  // loads and runs without the password — only revealing the internals is gated.
  const [hidden, setHidden] = useState(false);
  const [revealed, setRevealed] = useState(true);
  const [hiddenData, setHiddenData] = useState(null);
  // Brief "Copied!" confirmation after a Share click.
  const [shareMsg, setShareMsg] = useState("");
  const [sampleData, setSampleData] = useState([]);
  const [sampling, setSampling] = useState(false);
  const [animStates, setAnimStates] = useState({});
  const cancelRef = useRef(false);
  // Mirror animSpeed into a ref so an in-progress run reads the live value and a
  // mid-run slider change takes effect on the next draw (B2).
  const speedRef = useRef(animSpeed);
  useEffect(() => { speedRef.current = animSpeed; }, [animSpeed]);

  // Seed all authoring state from a decoded shared config (Task C). `migratePipeline`
  // returns the old-id → stage-id map; for a normal (already-staged) config it is identity,
  // so the tracked-stat / stop-rule rekey is a no-op, while a legacy flat pipeline gets its
  // device-id references rewritten to the wrapping stage ids in one place (Task F).
  const applyConfig = useCallback(config => {
    const { stages, idMap } = migratePipeline(config.pipeline || []);
    setPipeline(stages);
    if (typeof config.sampleSize === "number") setSampleSize(config.sampleSize);
    setRunMode(config.runMode === "until" ? "until" : "fixed");
    setStopRule(rekeyStopRule(config.stopRule || null, idMap));
    setTrackedStats(rekeyStats(Array.isArray(config.trackedStats) ? config.trackedStats : [], idMap));
    if (config.codeLang) setCodeLang(config.codeLang);
  }, []);

  // One-time URL import (Task C/D). Read ?s=<blob> on mount and load the config. A hidden
  // blob (Task D) loads and RUNS the same way — no password needed to open it — but starts
  // veiled (`revealed:false`); the stored salt+verifier gate a later Reveal. Garbled or
  // unsupported blobs fall back to today's defaults. The URL is then cleaned so editing and
  // reloading don't keep re-importing the original config.
  useEffect(() => {
    const blob = new URLSearchParams(window.location.search).get("s");
    if (!blob) return;
    const decoded = decodeConfig(blob);
    const cleanURL = () => window.history.replaceState(null, "", window.location.pathname);
    if (!decoded) { cleanURL(); return; }
    applyConfig(decoded.config);
    if (decoded.hidden) {
      setHidden(true); setRevealed(false); setHiddenData({ salt: decoded.salt, pw: decoded.pw });
    }
    cleanURL();
  }, [applyConfig]);

  // Tracked-statistic data model (Phase 2): columns authored by selecting overlays
  // in Sample Results; `collectRows` is the accumulator (one row per collected
  // sample, keyed by stat id) that later phases will fill.
  const [trackedStats, setTrackedStats] = useState([]);
  const [collectRows, setCollectRows] = useState([]);
  // Linked highlighting for Collect Statistics: a set of collected-row `_id`s shared
  // by the CollectTable (rows) and the DistributionPlot (dots), toggled from either.
  const [collectSelectedIds, setCollectSelectedIds] = useState(() => new Set());
  const [collectScroll, setCollectScroll] = useState(null); // { id } — reveal a just-selected row
  // The divider cut on the Collect (sampling-distribution) plot, lifted up so the generated
  // inference code mirrors the actual cutoff. `{ statId, cuts, range }` | null. The setter
  // dedupes (the plot re-reports each render) so an unchanged cut doesn't loop re-renders.
  const [dividerState, setDividerState] = useState(null);
  const onCollectDivider = useCallback(d => {
    setDividerState(prev => {
      const same = prev === d || (prev && d && prev.statId === d.statId && prev.range === d.range &&
        prev.dir === d.dir && prev.by === d.by && prev.pct === d.pct &&
        prev.cuts.length === d.cuts.length && prev.cuts.every((v, i) => v === d.cuts[i]));
      return same ? prev : d;
    });
  }, []);
  const toggleCollectId = id => {
    const adding = !collectSelectedIds.has(id);
    setCollectSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    if (adding) setCollectScroll({ id });
  };
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
  const [batchSize, setBatchSize] = useState(999);
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
  // Distribution fingerprint of a single device, keyed by stable outcome ids so it
  // ignores pure relabelings and cosmetic color edits. Only a real change to what gets
  // drawn — counts, probabilities, with/without replacement, adding/removing outcomes.
  const deviceShape = d => {
    const base = { type:d.type, withReplacement:d.withReplacement };
    if (d.type === "stacks") base.items = d.items.map(it => ({ id:it.id, count:it.count }));
    if (d.type === "mixer") base.balls = d.balls.map(b => b.id);
    if (d.type === "spinner") base.slices = d.slices.map(s => ({ id:s.id, pct:s.pct }));
    return base;
  };
  // A stage's fingerprint covers the union of its branches (each branch's condition and
  // its device shape), so adding/removing/re-conditioning a branch is structural and
  // warns-and-clears, while a pure relabel inside a branch device is still ignored.
  const samplingShape = stage => JSON.stringify(stage.branches.map(b => ({ condVar:b.condVar, condVal:b.condVal, dev: deviceShape(b.device) })));
  // Combined outcome-relabel map across a stage's branch devices (matched by branch id,
  // then outcome id). Drives both tracked-spec rewriting and downstream branch-condition
  // rewriting (a fork keyed on this stage must follow a renamed outcome).
  const stageLabelMap = (oldStage, newStage) => {
    const map = {};
    const oldB = Object.fromEntries(oldStage.branches.map(b => [b.id, b]));
    newStage.branches.forEach(nb => {
      const ob = oldB[nb.id];
      if (!ob || ob.device.type !== nb.device.type) return;
      const coll = { stacks:"items", mixer:"balls", spinner:"slices" }[ob.device.type];
      if (!coll) return;
      const oldById = {};
      (ob.device[coll] || []).forEach(it => { oldById[it.id] = it.label; });
      (nb.device[coll] || []).forEach(it => {
        if (oldById[it.id] !== undefined && oldById[it.id] !== it.label) map[oldById[it.id]] = it.label;
      });
    });
    return map;
  };
  // Seamless OUTCOME-relabel propagation: when an edit renames one of a stage's outcome
  // labels, rewrite any tracked spec whose target/condVal stored that label so its column
  // and future draws follow the new label — no warning, results kept. A stage (column)
  // rename needs NO handling: specs reference the stage's stable id, which never changes.
  const propagateRenames = (stats, oldStage, newStage) => {
    const labelMap = stageLabelMap(oldStage, newStage);
    if (Object.keys(labelMap).length === 0) return stats; // no outcome relabeled
    const sid = oldStage.id; // === newStage.id (an edit never changes the id)
    return stats.map(s => {
      const ns = { ...s };
      if (ns.variable === sid && ns.target && labelMap[ns.target] !== undefined) ns.target = labelMap[ns.target];
      if (ns.condVar === sid && ns.condVal && labelMap[ns.condVal] !== undefined) ns.condVal = labelMap[ns.condVal];
      return ns;
    });
  };
  const clearCollected = () => { setCollectRows([]); setBatchProgress(0); setCurrentSample(null); setCollectSelectedIds(new Set()); };

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
    () => Object.fromEntries(pipeline.map(d => [d.id, stageVarKind(d)])),
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
  // The stop rule's target stage + its outcomes (for the "run until" value dropdown).
  const stopStage = stopRule ? pipeline.find(s => s.id === stopRule.stageId) : null;
  const stopStageOutcomes = stopStage ? stageOutcomes(stopStage) : [];

  const addStage = type => {
    const m = { spinner:mkSpinner, stacks:mkStacks, mixer:mkMixer };
    const prefix = { spinner:"spin", stacks:"stk", mixer:"mix" }[type];
    setPipeline(p => {
      // Derive the next number by scanning the current pipeline for this type's
      // prefix and taking max+1. Robust to the seed stage and to remove/re-add.
      const re = new RegExp(`^${prefix}(\\d+)$`);
      const max = p.reduce((mx, s) => {
        const mt = re.exec(s.varName);
        return mt ? Math.max(mx, +mt[1]) : mx;
      }, 0);
      return [...p, mkStage(m[type](max + 1))];
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

  // Seed an empty editable dataset for manual entry (shares the single `dataset`
  // slot with uploads). Two starter columns, three blank rows; the EDA table is
  // editable so the student fills it in. `_id` keys each row for stable edits.
  const startManualData = () => {
    const headers = ["x", "y"];
    const rows = Array.from({ length: 3 }, () => ({ _id: uid(), x: "", y: "" }));
    setDataset({ headers, rows, name: "Manual data" });
  };

  const updStage = (i, st) => {
    const old = pipeline[i];
    const structural = samplingShape(old) !== samplingShape(st);
    const dependent = trackedStats.some(s => statDependsOn(s, old.id));
    // Stage ids never change on an edit, so the live-id set is just the current pipeline.
    const liveIds = pipeline.map(s => s.id);
    // Outcome edits can flip a variable's kind (numeric ↔ categorical) — even a pure
    // relabel ("5" → "x") that samplingShape ignores. Apply outcome-relabel propagation
    // first, then find numeric-only stats (mean/SD/…) orphaned because their variable is
    // no longer numeric, so they're dropped rather than silently computing over text.
    const renamed = propagateRenames(trackedStats, old, st);
    const newKinds = Object.fromEntries(pipeline.map((s, j) => { const ns = j === i ? st : s; return [ns.id, stageVarKind(ns)]; }));
    const orphanIds = renamed.filter(s => statKindInvalid(s, newKinds)).map(s => s.id);
    // Distribution-structure guard: only a change to *what gets drawn* (counts,
    // probabilities, with/without replacement, branches, adding/removing outcomes) clears
    // collected results. A kind flip additionally removes the now-meaningless numeric col.
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
    // Commit the edited stage, and follow any outcome relabel into DOWNSTREAM branches
    // keyed on this stage (condVar === old.id), so a fork doesn't silently stop matching.
    const labelMap = stageLabelMap(old, st);
    setPipeline(p => {
      const a = [...p]; a[i] = st;
      if (Object.keys(labelMap).length) {
        for (let j = 0; j < a.length; j++) {
          if (j === i) continue;
          a[j] = { ...a[j], branches: a[j].branches.map(b =>
            (b.condVar === old.id && b.condVal != null && labelMap[b.condVal] !== undefined)
              ? { ...b, condVal: labelMap[b.condVal] } : b) };
        }
      }
      return a;
    });
  };
  const remStage = i => {
    const removed = pipeline[i];
    const dependent = trackedStats.some(s => statDependsOn(s, removed.id));
    // Downstream branches that condition on the removed stage will be dropped too.
    const refsRemoved = pipeline.some((s, j) => j !== i && s.branches.some(b => b.condVar === removed.id));
    if (collectRows.length && (dependent || refsRemoved)) {
      if (!window.confirm("Removing this column deletes the statistics already collected in the table, and any tracked column or branch that depends on it. Continue?")) { rejectEdit(); return; }
      clearCollected();
    }
    const liveIds = pipeline.filter((_, j) => j !== i).map(s => s.id);
    setTrackedStats(ts => dropInvalid(ts, liveIds));
    setPipeline(p => p.filter((_, j) => j !== i).map(s => {
      // Drop any branch that conditioned on the removed stage; the default branch
      // (condVar === null) is always kept, so the stage collapses to unconditional.
      if (!s.branches.some(b => b.condVar === removed.id)) return s;
      return { ...s, branches: s.branches.filter(b => b.condVar !== removed.id) };
    }));
  };
  // A branch condition may only reference an UPSTREAM stage, so a move is rejected if it
  // would put a stage above one of its conditions' targets.
  const orderValid = stages => {
    const idx = {}; stages.forEach((s, k) => { idx[s.id] = k; });
    return stages.every((s, k) => s.branches.every(b => b.condVar === null || (idx[b.condVar] !== undefined && idx[b.condVar] < k)));
  };
  const movStage = (i, dir) => setPipeline(p => {
    const a = [...p], j = i + dir;
    if (j < 0 || j >= a.length) return a;
    [a[i], a[j]] = [a[j], a[i]];
    return orderValid(a) ? a : p;
  });

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
  // A distribution drawn at fixed n must not mix with one drawn under a stop rule (n
  // varies), so switching run mode — or editing the stop rule — clears collected results.
  const guardCollectedChange = apply => {
    if (collectRows.length) {
      if (!window.confirm("Changing how samples are drawn clears the statistics already collected in the table. (The tracked columns are kept.) Continue?")) { rejectEdit(); return; }
      clearCollected();
    }
    apply();
  };
  const changeRunMode = mode => {
    if (mode === runMode) return;
    guardCollectedChange(() => {
      setRunMode(mode);
      // Seed a sensible default rule the first time "until" is chosen.
      if (mode === "until" && !stopRule && pipeline.length) {
        const st = pipeline[0];
        setStopRule({ kind:"outcome", stageId: st.id, value: (stageOutcomes(st)[0] || ""), n: 1 });
      }
    });
  };
  const changeStopRule = patch => guardCollectedChange(() => setStopRule(r => ({ ...(r || {}), ...patch })));

  const doSample = useCallback(async () => {
    if (sampling) { cancelRef.current = true; return; }
    if (hasNameError) return; // duplicate/blank device names — refuse to draw an ambiguous sample
    cancelRef.current = false;
    setSampling(true);
    setSampleData([]);
    setCurrentSample(null);
    const rows = [];
    await runAnimatedSample({
      pipeline, sampleSize, runMode, stopRule, speedRef,
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
  }, [pipeline, sampleSize, runMode, stopRule, sampling, trackedStats, hasNameError]);

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
        const rows = drawSample(pipeline, sampleSize, { runMode, stopRule });
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

  // Build a shareable URL for the current sampler config and copy it (Task C). With a
  // password, the link is hidden (Task D): contents are veiled but it still runs.
  const doShare = password => {
    const blob = encodeConfig({ pipeline, sampleSize, runMode, stopRule, codeLang }, password ? { password } : undefined);
    const url = shareURL(blob);
    const announce = () => { setShareMsg(password ? "🔒 Hidden link copied!" : "🔗 Link copied!"); setTimeout(() => setShareMsg(""), 1900); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(announce).catch(() => safePrompt("Copy this link:", url));
    } else {
      safePrompt("Copy this link:", url);
    }
  };
  // A hidden sampler is concealed until revealed in this session (Task D). While
  // concealed the device internals are never rendered (so they can't be peeked at in
  // devtools), but the sampler still draws/collects from the in-memory pipeline.
  const concealed = hidden && !revealed;
  // Re-prompt for the password to unlock editing/inspection this session. Validates against
  // the stored verifier, so the plaintext password is never kept around.
  const revealSampler = () => {
    if (!hiddenData) { setRevealed(true); return; }
    const pw = safePrompt("Enter the password to reveal this sampler:");
    if (pw == null) return;
    if (!checkHiddenPassword(hiddenData.salt, hiddenData.pw, pw)) { safeAlert("Incorrect password."); return; }
    setRevealed(true);
  };

  // Share dialog: plain copy, or prompt for a password to produce a hidden link.
  const shareDialog = () => {
    const hide = safeConfirm("Share this sampler.\n\nOK = copy a normal link.\nCancel = hide it behind a password (the link still runs, but its contents are concealed).");
    if (hide) { doShare(); return; }
    const pw = safePrompt("Set a password to hide the sampler (sharers will need it to view the contents):");
    if (pw == null || pw === "") return; // cancelled or empty → no link
    doShare(pw);
  };

  const exportCSV = (data, name) => {
    const cols = Object.keys(data[0] || {});
    const csv = [cols.join(","), ...data.map(r => cols.map(c => r[c]).join(","))].join("\n");
    const a = document.createElement("a");
    a.href = "data:text/csv," + encodeURIComponent(csv);
    a.download = name; a.click();
  };

  // Generated R/Python code (Task E), recomputed from the live config. `null` when the code
  // toggle is off so each `CodeBeside` falls back to a no-layout-cost full-width tool. Each
  // section is placed next to the tool it mirrors (sampler / sample-results / collect-table /
  // collect-plot); the generators read the same specs the UI uses (see lib/codegen.js).
  const code = useMemo(
    () => (codeLang === "off" ? null : generateCode({ pipeline, sampleSize, runMode, stopRule, trackedStats, collectedCount: collectRows.length, divider: dividerState, hidden: concealed }, codeLang)),
    [codeLang, pipeline, sampleSize, runMode, stopRule, trackedStats, collectRows.length, dividerState, concealed]
  );

  return (
    <div style={{ fontFamily:"'IBM Plex Sans',system-ui,sans-serif", background:"#f1f2f5", minHeight:"100vh", padding:14, boxSizing:"border-box" }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:14, flexWrap:"wrap" }}>
        <div style={{ display:"inline-flex", flexDirection:"column", gap:2, width:"fit-content" }}>
          {/* PRISM logo (the color-blind variant swaps in with the code-panel cbMode). The
              tagline's nowrap width sizes the column; the logo fills that width via the
              width:0 / min-width:100% trick (so its large intrinsic size doesn't inflate the
              column) with height:auto keeping the aspect ratio — image matches the text below. */}
          <img src={cbMode ? prismLogoCb : prismLogo} alt="PRISM"
            style={{ width:0, minWidth:"100%", height:"auto", display:"block" }} />
          <p style={{ margin:0, fontSize:11, color:"#999", whiteSpace:"nowrap" }}>Python &amp; R Integrated Simulation Machine</p>
        </div>
        {/* Code-panel controls live at the top-right of the whole page; each section's code
            box then sits beside the tool it mirrors. */}
        <div style={{ marginLeft:"auto" }}>
          <CodeControls codeLang={codeLang} cbMode={cbMode}
            onSetLang={setCodeLang} onToggleCb={() => setCbMode(c => !c)} />
        </div>
      </div>

      {/* ── CSV / EDA STAGE ── */}
      <div style={{ background:"#fff", borderRadius:14, padding:14, marginBottom:14, boxShadow:"0 1px 6px rgba(0,0,0,0.04)", border:"1px solid #eee" }}>
        <div style={{ display:"flex", gap:10, alignItems:"center", flexWrap:"wrap", marginBottom: edaOpen ? 12 : 0 }}>
          <button onClick={() => setEdaOpen(o => !o)}
            style={{ background:"none", border:"none", cursor:"pointer", fontSize:13, fontWeight:700, color:"#2c3e50", display:"flex", alignItems:"center", gap:6 }}>
            <span style={{ transform: edaOpen ? "rotate(90deg)" : "none", transition:"transform 0.15s", display:"inline-block" }}>▶</span>
            Data &amp; Exploratory Analysis
          </button>
          {dataset && <span style={{ fontSize:11, color:"#aaa" }}>{dataset.name} · {dataset.rows.length} rows · {dataset.headers.length} cols</span>}
          <label style={{ marginLeft:"auto", ...btnNav, fontSize:12, cursor:"pointer", display:"inline-flex", alignItems:"center", gap:5 }}>
            Upload CSV
            <input type="file" accept=".csv,text/csv" style={{ display:"none" }}
              onChange={e => { const f = e.target.files && e.target.files[0]; if (f) handleCSVFile(f); }} />
          </label>
          <button onClick={startManualData} style={{ ...btnNav, fontSize:12 }}>Enter data manually</button>
          {dataset && <button onClick={() => setDataset(null)} style={{ ...btnNav, fontSize:12 }}>✕ Clear</button>}
        </div>

        {edaOpen && (
          dataset ? (
            <div>
              <EDAPlot rows={dataset.rows} headers={dataset.headers}
                onChange={(headers, rows) => setDataset({ ...dataset, headers, rows })} />
              <div style={{ fontSize:10, color:"#bbb", marginTop:8 }}>
                Build a Stacks or Mixer in the sampler below, then use its <strong>Fill from data</strong> control to load a column from this dataset.
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
       <CodeBeside sectionId="sampler" lines={concealed ? null : (code && code.sampler)} cbMode={cbMode}>
        <div style={{ display:"flex", gap:8, marginBottom:10, alignItems:"center", flexWrap:"wrap" }}>
          <span style={{ fontSize:14, fontWeight:700, color:"#2c3e50" }}>Sampler</span>
          {concealed ? (
            <>
              <span style={{ fontSize:12, color:"#7c3aed", fontWeight:700, display:"inline-flex", alignItems:"center", gap:5 }}>🔒 Hidden sampler — contents concealed</span>
              <button onClick={revealSampler}
                style={{ padding:"4px 10px", background:"#f3e8ff", border:"1.5px solid #e3d0ff", borderRadius:7, fontSize:12, cursor:"pointer", color:"#7c3aed", fontWeight:600 }}>Reveal</button>
            </>
          ) : (
            <>
              {[["stacks", "Stacks"], ["mixer", "Mixer"], ["spinner", "Spinner"]].map(([t, l]) => (
                <button key={t} onClick={() => addStage(t)} disabled={sampling}
                  style={{ padding:"4px 10px", background:"#f7f8fa", border:"1.5px dashed #ddd", borderRadius:7, fontSize:12, cursor:sampling?"not-allowed":"pointer", color:sampling?"#bbb":"#555", opacity:sampling?0.5:1 }}>+ {l}</button>
              ))}
              <button onClick={shareDialog} disabled={sampling} title="Copy a link that regenerates this sampler"
                style={{ padding:"4px 10px", background:"#eef0ff", border:"1.5px solid #d7dcff", borderRadius:7, fontSize:12, cursor:sampling?"not-allowed":"pointer", color:sampling?"#bbb":"#4f46e5", fontWeight:600, opacity:sampling?0.5:1 }}>🔗 Share</button>
            </>
          )}
          {shareMsg && <span style={{ fontSize:12, color:"#10b981", fontWeight:700 }}>{shareMsg}</span>}
          {sampling && <span style={{ fontSize:12, color:"#6366f1", fontWeight:600 }}>drawing {sampleData.length}{runMode === "until" ? "…" : "/" + sampleSize + "…"}</span>}
          {/* Sampler run controls — these drive the pipeline below, so they live in
              its header rather than the app-level top bar (B3). */}
          <div style={{ marginLeft:"auto", display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:1 }}>
              <input type="range" min={0} max={2} step={1} value={animSpeed} onChange={e => setAnimSpeed(+e.target.value)} style={{ width:80, accentColor:"#6366f1" }} />
              <div style={{ display:"flex", justifyContent:"space-between", fontSize:9, color:"#bbb", width:80 }}>
                <span>slow</span><span>fast</span><span>instant</span>
              </div>
            </div>
            <select value={runMode} onChange={e => changeRunMode(e.target.value)} disabled={sampling} style={iSm}>
              <option value="fixed">Repeat n</option>
              <option value="until">Run until…</option>
            </select>
            {runMode === "fixed" ? (
              <label style={ctrlLbl}>n =
                <NumInput value={sampleSize} min={1} max={10000} round={0}
                  onChange={v => changeSampleSize(v)}
                  style={{ ...iSm, width:60, marginLeft:4 }} />
              </label>
            ) : (
              <>
                <select value={stopRule ? stopRule.stageId : ""} disabled={sampling}
                  onChange={e => changeStopRule({ stageId: e.target.value })} style={iSm}>
                  {pipeline.map(s => <option key={s.id} value={s.id}>{nameOf(s.id)}</option>)}
                </select>
                <select value={stopRule ? stopRule.kind : "outcome"} disabled={sampling}
                  onChange={e => changeStopRule({ kind: e.target.value })} style={iSm}>
                  <option value="outcome">reaches</option>
                  <option value="count">reaches N times</option>
                  <option value="distinct">has N distinct</option>
                </select>
                {stopRule && stopRule.kind !== "distinct" && (
                  <select value={stopRule.value != null ? stopRule.value : ""} disabled={sampling}
                    onChange={e => changeStopRule({ value: e.target.value })} style={iSm}>
                    {stopStageOutcomes.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                )}
                {stopRule && (stopRule.kind === "count" || stopRule.kind === "distinct") && (
                  <label style={ctrlLbl}>N =
                    <NumInput min={1} value={stopRule.n || 1} disabled={sampling} round={0}
                      onChange={v => changeStopRule({ n: Math.max(1, Math.round(v) || 1) })}
                      style={{ ...iSm, width:48, marginLeft:4 }} />
                  </label>
                )}
                <label style={ctrlLbl} title="safety cap: stop after at most this many draws">max
                  <NumInput value={sampleSize} min={1} max={100000} round={0}
                    onChange={v => changeSampleSize(v)}
                    style={{ ...iSm, width:60, marginLeft:4 }} />
                </label>
              </>
            )}
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
        <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"flex-start" }}>
          {pipeline.map((stage, i) => (
            <div key={stage.id} style={{ display:"contents" }}>
              {concealed ? (
                // Opaque placeholder: the column name stays visible (it labels the
                // results), but the device mechanism is withheld until revealed.
                <div style={{ width:150, minHeight:150, borderRadius:12, border:"1.5px solid #e3d0ff",
                  background:"repeating-linear-gradient(45deg,#faf5ff,#faf5ff 10px,#f3e8ff 10px,#f3e8ff 20px)",
                  display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:8, flexShrink:0 }}>
                  <div style={{ fontSize:34 }}>🔒</div>
                  <div style={{ fontSize:13, fontWeight:700, color:"#7c3aed" }}>{nameOf(stage.id)}</div>
                  <div style={{ fontSize:10, color:"#a78bda" }}>hidden device</div>
                </div>
              ) : (
                <StageCard stage={stage} index={i} total={pipeline.length} upstreamStages={pipeline.slice(0, i)}
                  nameOf={nameOf} onChange={st => updStage(i, st)} onRemove={() => remStage(i)} onMove={movStage}
                  animStates={animStates} locked={sampling} nameError={invalidNameIds.has(stage.id)} dataset={dataset} />
              )}
              {i < pipeline.length - 1 && <div style={{ alignSelf:"center", color:"#ccc", fontSize:20, flexShrink:0 }}>→</div>}
            </div>
          ))}
        </div>
       </CodeBeside>
      </div>

      {/* Sample Results */}
      <div style={{ background:"#fff", borderRadius:14, padding:14, marginBottom:14, boxShadow:"0 1px 6px rgba(0,0,0,0.04)", border:"1px solid #eee", opacity:sampleData.length ? 1 : 0.4, transition:"opacity 0.3s" }}>
       <CodeBeside sectionId="single" lines={code && code.single} cbMode={cbMode}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12, flexWrap:"wrap" }}>
          <span style={{ fontSize:14, fontWeight:700, color:"#2c3e50" }}>Sample Results</span>
          {sampleData.length > 0 && <span style={{ fontSize:11, color:"#aaa" }}>n = {sampleData.length}</span>}
        </div>
        <SampleResults sampleData={sampleData} varNames={varIds} varKinds={varKinds} nameOf={nameOf} onTrackStat={trackStat} onTrackDiff={trackDifference} trackedStats={trackedStats} />
       </CodeBeside>
      </div>

      {/* Collect Statistics */}
      <div style={{ background:"#fff", borderRadius:14, padding:14, boxShadow:"0 1px 6px rgba(0,0,0,0.04)", border:"1px solid #eee", opacity:sampleData.length ? 1 : 0.35, pointerEvents:sampleData.length ? "auto" : "none", transition:"opacity 0.3s" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12, flexWrap:"wrap" }}>
          <span style={{ fontSize:14, fontWeight:700, color:"#2c3e50" }}>Collect Statistics</span>
          <div style={{ marginLeft:"auto", display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
            <label style={ctrlLbl}>Collect
              <NumInput value={batchSize} min={1} max={100000} round={0}
                onChange={v => setBatchSize(Math.max(1, Math.round(v) || 1))}
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
                }} style={{ ...btnNav, fontSize:12 }}>Export CSV</button>
              </>
            )}
          </div>
        </div>
        {/* Stacked top-to-bottom: the tracked-statistic table, then the manual
            builder (a table-authoring tool), then the sampling-distribution plot. */}
        <div style={{ marginBottom:14 }}>
          <CodeBeside sectionId="collect" lines={code && code.collect} cbMode={cbMode}>
            <CollectTable trackedStats={trackedStats} collectRows={collectRows} onRemove={untrackStat} labelFor={labelFor} titleFor={exprFor}
              selectedIds={collectSelectedIds} onToggleSelect={toggleCollectId} scrollTarget={collectScroll} />
          </CodeBeside>
        </div>

        {/* Derived-statistic calculator — combine collected columns into a new column
            (e.g. a difference of two means, or an ANOVA-style total variation). */}
        {operandCols.length > 0 && (
          <div style={{ borderTop:"1px solid #f0f0f0", paddingTop:10, marginBottom:14 }}>
            <button onClick={() => setDerivedOpen(o => !o)}
              style={{ background:"none", border:"none", cursor:"pointer", fontSize:11, fontWeight:700, color:"#bbb", letterSpacing:1, textTransform:"uppercase", display:"flex", alignItems:"center", gap:6, padding:0 }}>
              <span style={{ transform: derivedOpen ? "rotate(90deg)" : "none", transition:"transform 0.15s", display:"inline-block" }}>▶</span>
              Build a derived statistic
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
            <CodeBeside sectionId="inference" lines={code && code.inference} cbMode={cbMode}>
              <DistributionPlot columns={trackedStats.map(s => ({ id: s.id, label: labelFor(s), values: collectRows.map(r => r[s.id]) }))}
                rowIds={collectRows.map(r => r._id)} selectedIds={collectSelectedIds} onToggleSelect={toggleCollectId}
                onDivider={codeLang === "off" ? undefined : onCollectDivider} />
            </CodeBeside>
          </div>
        )}

        {/* Integrated program (Task E) — the whole simulation as one script, with the section
            symbol in the gutter (★ sampler / ● statistic / ▲ loop / ■ inference). */}
        {code && (
          <div style={{ borderTop:"1px solid #f0f0f0", paddingTop:12, marginTop:4 }}>
            <CodeIntegrated lines={code.integrated} cbMode={cbMode} />
          </div>
        )}
      </div>
    </div>
  );
}
