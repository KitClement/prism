import { uid, sleep, parseTimeToMinutes } from "./util";

// Classify a sampler variable num/cat from its device's DECLARED outcomes (not from
// drawn rows). A device's var is **numeric only if every declared outcome parses as a
// number or time** — any non-numeric label makes it categorical, because a rare outcome
// is still a possible draw (a stricter rule than colKind's 80%, which would let a rare
// non-numeric outcome silently break a plot set up as numeric). Mirrors colKind's shape
// and time flag so plots can consume either interchangeably.
function deviceVarKind(dev) {
  const labels =
    dev.type === "stacks"  ? dev.items.map(it => it.label)
    : dev.type === "mixer"   ? dev.balls.map(b => b.label)
    : dev.type === "spinner" ? dev.slices.map(s => s.label)
    : [];
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

// Draw one complete sample (sampleSize rows) through the pipeline, non-animated.
// Single source of truth for the batch/collect path: both Collect loops must call
// this so with/without-replacement counting can never diverge from the animation
// loop (which shares makeDrawState/drawStacks/drawMixer above).
function drawSample(pipeline, sampleSize) {
  const state = makeDrawState(pipeline);
  const rows = [];
  for (let s = 0; s < sampleSize; s++) {
    const row = { _sample: s + 1 };
    pipeline.forEach(dev => {
      if (dev.type === "spinner") {
        row[dev.varName] = sampleSpinner(dev.slices);
      } else if (dev.type === "stacks") {
        const drawn = drawStacks(dev, state);
        row[dev.varName] = drawn ? drawn.label : "";
      } else if (dev.type === "mixer") {
        const drawn = drawMixer(dev, state);
        row[dev.varName] = drawn ? drawn.label : "";
      }
    });
    rows.push(row);
  }
  return rows;
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

export { sampleSpinner, makeDrawState, drawStacks, drawMixer, drawSample, deviceVarKind, mkSpinner, mkStacks, mkMixer, runAnimatedSample };
