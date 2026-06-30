import { uid, sleep, parseTimeToMinutes, colKind } from "./util";

// ─── Outcome classification ─────────────────────────────────────────────────────
// Extract the declared outcome labels from a single device.
function deviceLabels(dev) {
  return dev.type === "stacks"  ? dev.items.map(it => it.label)
       : dev.type === "mixer"   ? dev.balls.map(b => b.label)
       : dev.type === "spinner" ? dev.slices.map(s => s.label)
       : [];
}
// Classify a set of outcome labels as numeric/time. A variable is **numeric only if
// every declared outcome parses as a number or time** — any non-numeric label makes it
// categorical, because a rare outcome is still a possible draw (a stricter rule than
// colKind's 80%, which would let a rare non-numeric outcome silently break a plot set up
// as numeric). Mirrors colKind's shape and time flag so plots can consume either.
function classifyLabels(labels) {
  const vals = labels.filter(v => v !== undefined && v !== null && String(v).trim() !== "");
  if (!vals.length) return { numeric: false, time: false };
  let plainNum = 0, timeCount = 0, nonNum = 0;
  vals.forEach(v => {
    if (!isNaN(Number(v))) plainNum++;
    else if (parseTimeToMinutes(v) !== null) timeCount++;
    else nonNum++;
  });
  const numeric = nonNum === 0;
  return { numeric, time: numeric && timeCount > plainNum };
}
// Classify a single device's var num/cat from its DECLARED outcomes (not drawn rows).
function deviceVarKind(dev) { return classifyLabels(deviceLabels(dev)); }
// A STAGE's kind comes from the UNION of all its branch devices' declared outcomes: a
// fork is numeric only if every outcome on every branch parses numeric/time.
function stageVarKind(stage) { return classifyLabels(stage.branches.flatMap(b => deviceLabels(b.device))); }
// Unique declared outcomes across all branch devices (for condition-value dropdowns).
function stageOutcomes(stage) {
  const out = [], seen = new Set();
  stage.branches.forEach(b => deviceLabels(b.device).forEach(l => {
    const s = String(l);
    if (!seen.has(s)) { seen.add(s); out.push(s); }
  }));
  return out;
}

// ─── Row-resampling (case resampling) ─────────────────────────────────────────
// A row-sample mixer carries `device.rowSample = { headers, rows, dataset }` — an embedded
// snapshot of an EDA dataset. Its balls are observation numbers; drawing a ball brings the
// WHOLE case (every CSV variable) into the sample, so one stage emits MANY columns. It's a
// standalone mode of the first/only mixer (no forks, never a condition variable).
function rowSampleDevice(stage) {
  if (!stage || !stage.branches) return null;
  const def = stage.branches.find(b => b.condVar === null) || stage.branches[0];
  const dev = def && def.device;
  return dev && dev.rowSample ? dev : null;
}
const isRowSampleStage = stage => !!rowSampleDevice(stage);

// The OUTPUT COLUMNS of a stage — the single source of truth for "what columns this stage
// produces". A normal stage owns one column (its stable stage id). A row-sample stage owns one
// column per CSV header, keyed by `${stage.id}::${headerIndex}` (stable across draws). Row-sample
// column kinds use colKind (the EDA 80% rule) since they describe real data, not declared outcomes.
function stageColumns(stage) {
  const dev = rowSampleDevice(stage);
  if (dev) {
    const { headers, rows } = dev.rowSample;
    return headers.map((h, idx) => ({ id: stage.id + "::" + idx, name: h, header: h, stageId: stage.id, kind: colKind(rows, h) }));
  }
  return [{ id: stage.id, name: stage.varName, stageId: stage.id, kind: stageVarKind(stage) }];
}
// Flatten every stage's output columns into the pipeline-wide column list (plot/table headers).
function pipelineColumns(pipeline) { return (pipeline || []).flatMap(stageColumns); }

// Write a row-sample stage's columns from a drawn ball index (the matching CSV case). A null/out-
// of-range index (empty pool) writes blanks. Shared by both draw paths so they can't diverge.
function writeRowSampleCols(row, stageId, dev, ballIdx) {
  const srcRow = (ballIdx != null && ballIdx >= 0) ? dev.rowSample.rows[ballIdx] : null;
  dev.rowSample.headers.forEach((h, ci) => { row[stageId + "::" + ci] = srcRow ? (srcRow[h] != null ? srcRow[h] : "") : ""; });
}

// ─── Stages & branches ──────────────────────────────────────────────────────────
// A stage owns one output column (stable id + varName) and holds 1+ branches. Each
// branch pairs a condition (condVar = an UPSTREAM stage id, condVal = an outcome label)
// with a device. condVar===null marks the DEFAULT branch (exactly one), which fires when
// no conditional branch matches — so an unconditional stage always runs (convergence)
// and a branch may key off any already-resolved upstream stage (nesting). The inner
// device keeps the existing spinner/stacks/mixer shape; its own varName is vestigial.
const mkStage = (device, varName) => ({
  id: uid(), type: "stage", varName: varName || device.varName,
  branches: [{ id: uid(), condVar: null, condVal: null, device }],
});
// Idempotent migration: wrap a legacy flat Device[] into Stage[]; pass Stage[] through.
const toStages = pipeline => (pipeline || []).map(el => (el && el.type === "stage" ? el : mkStage(el)));

// Same migration, but also return the old-id → stage-id map so references stored against
// the *pre-migration* ids (tracked-stat variable/variable2/condVar, stopRule.stageId) can
// be rekeyed in ONE place (Task F). For an already-staged pipeline the map is identity, so
// the rekey is a harmless no-op; for a legacy flat pipeline a tracked stat that referenced a
// device id is rewritten to the id of the stage now wrapping that device.
function migratePipeline(pipeline) {
  const idMap = {};
  const stages = (pipeline || []).map(el => {
    if (el && el.type === "stage") { idMap[el.id] = el.id; return el; }
    const stage = mkStage(el);
    if (el && el.id) idMap[el.id] = stage.id;
    return stage;
  });
  return { stages, idMap };
}
// Rewrite a tracked-stat list's id-valued reference fields through an id map. condVal/target
// are outcome LABELS (not ids) and stay put; derived columns reference other stat columns
// (not pipeline ids) so they pass through untouched.
function rekeyStats(stats, idMap) {
  const m = id => (id && idMap[id] !== undefined ? idMap[id] : id);
  return (stats || []).map(s => {
    if (!s || s.kind === "derived") return s;
    return { ...s, variable: m(s.variable), variable2: m(s.variable2), condVar: m(s.condVar) };
  });
}
// Rekey a stop rule's stageId through the same map (Task B field, Task F coverage).
function rekeyStopRule(rule, idMap) {
  if (!rule || !rule.stageId) return rule || null;
  const mapped = idMap[rule.stageId];
  return mapped !== undefined ? { ...rule, stageId: mapped } : rule;
}

// Pick the branch whose (condVar,condVal) matches the row's already-drawn upstream
// values; fall back to the default branch (condVar===null). First match wins.
function selectBranch(stage, row) {
  for (const b of stage.branches) {
    if (b.condVar === null) continue;
    if (row[b.condVar] === b.condVal) return b;
  }
  return stage.branches.find(b => b.condVar === null) || stage.branches[0];
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
// `state` carries per-repetition mutable tracking, keyed by BRANCH-DEVICE id (each
// branch device draws from its own pool, so without-replacement counting can't bleed
// across branches):
//   state.liveCounts[devId] = number[]  (remaining count per stacks item)
//   state.drawnBalls[devId] = Set       (drawn mixer ball indices)
// Initialize it for a fresh repetition with makeDrawState(pipeline).
function makeDrawState(pipeline) {
  const liveCounts = {}, drawnBalls = {};
  pipeline.forEach(stage => stage.branches.forEach(({ device: dev }) => {
    if (dev.type === "stacks") liveCounts[dev.id] = dev.items.map(it => it.count);
    if (dev.type === "mixer") drawnBalls[dev.id] = new Set();
  }));
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

// Draw one value from a device (shared by stage resolver below).
function drawValueFromDevice(dev, state) {
  if (dev.type === "spinner") return sampleSpinner(dev.slices);
  if (dev.type === "stacks") { const d = drawStacks(dev, state); return d ? d.label : ""; }
  if (dev.type === "mixer") { const d = drawMixer(dev, state); return d ? d.label : ""; }
  return "";
}
// Resolve a stage to one value given the row's already-drawn upstream values.
function drawStageValue(stage, row, state) {
  return drawValueFromDevice(selectBranch(stage, row).device, state);
}
// Draw one stage into `row`, writing one key (normal) or many (row-sample). Single source of
// truth for the batch path; the animation loop mirrors this inline (constraint #1).
function applyStageDraw(stage, row, state) {
  const rs = rowSampleDevice(stage);
  if (rs) {
    const d = drawMixer(rs, state); // { label, ballIdx } | null
    writeRowSampleCols(row, stage.id, rs, d ? d.ballIdx : null);
    return;
  }
  row[stage.id] = drawStageValue(stage, row, state);
}

// ─── Stop-until rule ────────────────────────────────────────────────────────────
// In "until" mode a sample keeps drawing rows until the rule holds (checked against the
// rows accumulated so far this sample). `rule` = { kind, stageId, value, n }.
function stopReached(rows, rule) {
  if (!rule || !rule.stageId) return false;
  const vals = rows.map(r => r[rule.stageId]);
  if (rule.kind === "outcome") return vals.includes(rule.value);
  if (rule.kind === "count") return vals.filter(v => v === rule.value).length >= (rule.n || 1);
  if (rule.kind === "distinct") return new Set(vals.filter(v => v !== "" && v != null)).size >= (rule.n || 1);
  return false;
}

// Draw one complete sample through the pipeline, non-animated. Single source of truth
// for the batch/collect path: both Collect loops must call this so with/without-
// replacement counting can never diverge from the animation loop (which shares
// makeDrawState/drawStacks/drawMixer above). `opts` = { runMode, stopRule }; in "until"
// mode `sampleSize` is the safety cap (max draws) so an unsatisfiable rule terminates.
function drawSample(pipeline, sampleSize, opts) {
  const runMode = opts && opts.runMode === "until" ? "until" : "fixed";
  const rule = opts && opts.stopRule;
  const cap = Math.max(1, sampleSize || 1);
  const state = makeDrawState(pipeline);
  const rows = [];
  let s = 0;
  while (true) {
    if (runMode === "fixed") { if (s >= sampleSize) break; }
    else if (stopReached(rows, rule) || s >= cap) break;
    const row = { _id: uid(), _sample: s + 1 };
    // Build the row incrementally so a downstream stage's branch sees upstream values.
    pipeline.forEach(stage => applyStageDraw(stage, row, state));
    rows.push(row);
    s++;
  }
  return rows;
}

// ─── Device factories ─────────────────────────────────────────────────────────
const mkSpinner = n => ({
  id:uid(), type:"spinner", varName:`spin${n}`, withReplacement:true,
  slices:[
    { id:uid(), label:"a", pct:100/3, color:"#e74c3c" },
    { id:uid(), label:"b", pct:100/3, color:"#3498db" },
    { id:uid(), label:"c", pct:100/3, color:"#2ecc71" },
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

async function runAnimatedSample({ pipeline, sampleSize, runMode, stopRule, speedRef, setAnimStates, onRow, onDone, cancelRef }) {
  // speed (0=slow, 1=fast, 2=instant) is read live from speedRef.current so a
  // mid-run slider change takes effect on the next draw. delay/spinMs are
  // recomputed at the top of each draw iteration; `set` stamps the current speed
  // so device visuals follow too.
  const mode = runMode === "until" ? "until" : "fixed";
  const cap = Math.max(1, sampleSize || 1);

  // Per-device without-replacement tracking (same shape as collect loop)
  const drawState = makeDrawState(pipeline);
  const liveCounts = drawState.liveCounts;
  const drawnSets = drawState.drawnBalls;

  const set = (devId, patch) => setAnimStates(prev => ({ ...prev, [devId]: { ...prev[devId], ...patch, speed: speedRef.current } }));
  const clearAll = () => setAnimStates(prev => {
    const next = { ...prev };
    Object.keys(next).forEach(k => { next[k] = { ...next[k], result:null, bouncing:false, surfaceIdx:null, highlightIdx:null, animating:false, inactive:false }; });
    return next;
  });

  const collected = []; // rows so far this sample (for the until-rule check)
  let s = 0;
  while (true) {
    if (cancelRef.current) break;
    if (mode === "fixed") { if (s >= sampleSize) break; }
    else if (stopReached(collected, stopRule) || s >= cap) break;
    // Recompute timing per draw so a live speed change is picked up next draw.
    const speed = speedRef.current;
    const delay = speed === 0 ? 1800 : speed === 1 ? 500 : 0;
    const row = { _id: uid(), _sample: s + 1 };

    for (const stage of pipeline) {
      if (cancelRef.current) break;
      // Resolve which branch fires from the upstream values already in `row`; animate
      // only that branch's device, dim the other branch devices of a forked stage.
      const branch = selectBranch(stage, row);
      const dev = branch.device;
      stage.branches.forEach(b => { if (b.device.id !== dev.id) set(b.device.id, { inactive:true, result:null, animating:false }); });
      set(dev.id, { inactive:false });
      let result = "";
      let pickedBallIdx = null; // row-sample: the drawn case index, written as many columns below

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
        if (!pool.length) { set(dev.id, { result:"—" }); row[stage.id] = ""; continue; }
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
        if (!avail.length) {
          set(dev.id, { result:"—" });
          if (dev.rowSample) writeRowSampleCols(row, stage.id, dev, null); else row[stage.id] = "";
          continue;
        }
        const pickedIdx = avail[Math.floor(Math.random() * avail.length)];
        pickedBallIdx = pickedIdx;
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
      // A row-sample stage writes one column per CSV variable from the drawn case; a normal
      // stage writes its single value keyed by the stage's stable id (see drawSample).
      if (dev.rowSample) writeRowSampleCols(row, stage.id, dev, pickedBallIdx);
      else row[stage.id] = result;
    }

    collected.push({ ...row });
    onRow({ ...row });
    s++;
    if (delay > 0) { await sleep(delay * 0.2); clearAll(); await sleep(60); }
  }

  // Reset live state across every branch device
  pipeline.forEach(stage => stage.branches.forEach(({ device: dev }) => {
    if (dev.type === "stacks") set(dev.id, { liveCounts:null, result:null, highlightIdx:null });
    if (dev.type === "mixer") set(dev.id, { removedSet:new Set(), result:null, bouncing:false });
  }));
  clearAll();
  onDone();
}

export {
  sampleSpinner, makeDrawState, drawStacks, drawMixer, drawSample, deviceVarKind,
  deviceLabels, stageVarKind, stageOutcomes, mkStage, toStages, migratePipeline, rekeyStats, rekeyStopRule, selectBranch, stopReached,
  mkSpinner, mkStacks, mkMixer, runAnimatedSample,
  rowSampleDevice, isRowSampleStage, stageColumns, pipelineColumns,
};
