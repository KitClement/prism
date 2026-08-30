import { veilConfig, unveilConfig } from "./share.js";

// ─── Save / Open a full PRISM session to a `.prism` file ──────────────────────
// Share (lib/share.js) encodes only sampler AUTHORING into a URL and deliberately drops
// everything a student produces. This module is the other document model: the whole session
// — dataset, drawn samples, tracked statistics, the collected sampling distribution, and the
// on-screen plot view — round-tripped through a plain-JSON `.prism` file on the local drive.
//
// DESIGN: plain, inspectable JSON (no compression, no size budget — a file isn't a URL); a
// self-defined envelope with its OWN version, independent of share.js's link VERSION. Pure and
// dependency-light in the codegen.js discipline: buildSaveFile/parseSaveFile/coerceSession are
// exercisable in a bare-Node ESM round-trip, no browser. Only downloadJSON touches the DOM.
//
// A HIDDEN (password-veiled) sampler is the one place this leans on share.js: it reuses the
// SAME veil (veilConfig/unveilConfig, keyed by the code-known PEPPER + the stored salt) so a
// saved population sampler conceals its device internals exactly as a 🔒 Share link does —
// it opens and runs for anyone, and the password still gates Reveal. Not crypto-grade.

export const PRISM_FILE_VERSION = 1;
export const PRISM_EXT = ".prism";
const MAGIC = "PRISM-session";

// version n → n+1 pure envelope upgraders (raw parsed object in, raw parsed object out). Empty
// at v1 — there is no older format yet — but the RUNNER below is wired, so the first real step
// is a one-line drop-in (MIGRATIONS[1] = env => ({...env, version:2, ...})) the day v2 ships,
// and its existence forces the next dev who bumps PRISM_FILE_VERSION to write the step instead
// of silently breaking old files.
const MIGRATIONS = {};

// Walk an older envelope up to the current version, applying each MIGRATIONS[n] in turn. Pure.
// A gap in the chain (no step for some intermediate version) returns null → the file is refused
// rather than silently mis-restored. A no-op today (fromVersion is always PRISM_FILE_VERSION at
// v1), but exercised the moment a v2 lands.
function runMigrations(env, fromVersion) {
  let out = env;
  for (let v = fromVersion; v < PRISM_FILE_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (typeof step !== "function") return null;
    out = step(out);
    if (!isObj(out)) return null;
  }
  return out;
}

const isObj = x => x != null && typeof x === "object" && !Array.isArray(x);
const asArr = x => (Array.isArray(x) ? x : []);
const asNum = (x, d) => (typeof x === "number" && Number.isFinite(x) ? x : d);

// ─── Build ────────────────────────────────────────────────────────────────────
// Full app state → a plain JSON object (never a string). Pure apart from the savedAt stamp.
// `state` is the flat App-state bag assembled by the Save handler (Phase 4). A plain sampler
// stores its pipeline VERBATIM (keeps device.source / rowSample — the dataset travels with the
// file, unlike a link); a hidden sampler stores the veiled compact blob instead, reusing the
// salt + verifier already in hiddenData (never recompute — a fresh salt would break Reveal).
export function buildSaveFile(state) {
  const s = state || {};
  const sampler = s.hidden && s.hiddenData
    ? { hidden: true, salt: s.hiddenData.salt, pw: s.hiddenData.pw, data: veilConfig(s, s.hiddenData.salt) }
    : { hidden: false, config: {
        pipeline: asArr(s.pipeline),
        sampleSize: asNum(s.sampleSize, 10),
        runMode: s.runMode === "until" ? "until" : "fixed",
        stopRule: s.stopRule || null,
      } };
  return {
    prism: MAGIC,
    version: PRISM_FILE_VERSION,
    savedAt: new Date().toISOString(),
    sampler,
    dataset: s.dataset || null,
    results: {
      sampleData: asArr(s.sampleData),
      currentSample: s.currentSample || null,
    },
    collect: {
      trackedStats: asArr(s.trackedStats),
      rows: asArr(s.collectRows),
      selectedIds: [...(s.collectSelectedIds || [])], // Set → array (Trap C)
      batchSize: asNum(s.batchSize, 999),
    },
    ui: {
      codeLang: s.codeLang || "off",
      cbMode: !!s.cbMode,
      animSpeed: asNum(s.animSpeed, 0),
      dark: !!s.dark,
    },
    view: isObj(s.view) ? s.view : {},
  };
}

// ─── Parse ──────────────────────────────────────────────────────────────────
// text → { ok:true, session } | { ok:false, error:"<user-facing sentence>" }. NEVER throws.
// `session` is the flat App-state bag applySession consumes (Phase 5): the exact inverse of
// buildSaveFile's input, so a well-formed file round-trips to deep-equality (modulo Set↔array).
export function parseSaveFile(text) {
  let raw;
  try { raw = JSON.parse(text); }
  catch { return { ok: false, error: "This file isn't valid JSON — it may be corrupted or not a PRISM file." }; }
  return coerceSession(raw);
}

// Defensive, per-field coercion (Trap E). The magic/version gate and the sampler pipeline are
// hard requirements — a file with no sampler is unusable. EVERYTHING else is individually
// optional and individually recoverable, so a student who hand-edits the JSON and breaks one
// section still gets their sampler back. Exported for direct unit exercise.
export function coerceSession(raw) {
  if (!isObj(raw)) return { ok: false, error: "This file isn't a PRISM session." };
  if (raw.prism !== MAGIC) return { ok: false, error: "This file isn't a PRISM session." };

  // Version gate — strict integer, independent of share.js's VERSION (Trap D).
  const version = raw.version;
  if (!Number.isInteger(version)) return { ok: false, error: "This PRISM file has no valid version and can't be opened." };
  if (version > PRISM_FILE_VERSION) return { ok: false, error: "This file was saved by a newer version of PRISM. Please update PRISM to open it." };
  // Upgrade an older file through the MIGRATIONS chain before reading any section, so the rest of
  // coerceSession only ever sees a current-version envelope. No-op at v1; a broken/incomplete
  // chain refuses rather than mis-restoring.
  if (version < PRISM_FILE_VERSION) {
    raw = runMigrations(raw, version);
    if (!isObj(raw)) return { ok: false, error: "This PRISM file is from an older version that can't be upgraded." };
  }

  // Sampler — the one hard requirement. A hidden sampler is unveiled with the SAME PEPPER as a
  // 🔒 link (no password needed to open), so validation is uniform: config.pipeline must exist.
  const smp = isObj(raw.sampler) ? raw.sampler : {};
  const hidden = !!smp.hidden;
  let config, hiddenData = null;
  if (hidden) {
    if (typeof smp.salt !== "string" || typeof smp.data !== "string") {
      return { ok: false, error: "This PRISM file's concealed sampler is corrupted and can't be opened." };
    }
    config = unveilConfig(smp.data, smp.salt);
    if (!config) return { ok: false, error: "This PRISM file's concealed sampler couldn't be read." };
    hiddenData = { salt: smp.salt, pw: typeof smp.pw === "string" ? smp.pw : "" };
  } else {
    config = isObj(smp.config) ? smp.config : {};
  }
  if (!Array.isArray(config.pipeline) || config.pipeline.length === 0) {
    return { ok: false, error: "This PRISM file has no sampler and can't be opened." };
  }

  // Everything below is best-effort — a bad section degrades to a safe empty, never a rejection.
  const results = isObj(raw.results) ? raw.results : {};
  const collect = isObj(raw.collect) ? raw.collect : {};
  const ui = isObj(raw.ui) ? raw.ui : {};

  const session = {
    version,
    savedAt: typeof raw.savedAt === "string" ? raw.savedAt : null,

    pipeline: config.pipeline,
    sampleSize: asNum(config.sampleSize, 10),
    runMode: config.runMode === "until" ? "until" : "fixed", // same idiom as App/applyConfig
    stopRule: isObj(config.stopRule) ? config.stopRule : null,
    codeLang: typeof config.codeLang === "string" ? config.codeLang : (typeof ui.codeLang === "string" ? ui.codeLang : "off"),

    hidden,
    hiddenData,

    dataset: coerceDataset(raw.dataset),

    sampleData: asArr(results.sampleData).filter(isObj),
    currentSample: coerceCurrentSample(results.currentSample),

    trackedStats: asArr(collect.trackedStats).filter(isTrackedStat),
    collectRows: asArr(collect.rows).filter(r => isObj(r) && "_id" in r),
    collectSelectedIds: new Set(asArr(collect.selectedIds)), // array → Set (Trap C)
    batchSize: asNum(collect.batchSize, 999),

    cbMode: !!ui.cbMode,
    animSpeed: asNum(ui.animSpeed, 0),
    dark: !!ui.dark,

    view: isObj(raw.view) ? raw.view : {},
  };
  return { ok: true, session };
}

function coerceDataset(d) {
  if (!isObj(d) || !Array.isArray(d.headers) || !Array.isArray(d.rows)) return null;
  return { name: typeof d.name === "string" ? d.name : "data.csv", headers: d.headers, rows: d.rows };
}

function coerceCurrentSample(cs) {
  if (!isObj(cs) || !Array.isArray(cs.rows)) return null;
  return { id: cs.id, rows: cs.rows };
}

// A tracked stat is either a derived column (kind:"derived" + token/input arrays) or a plain
// statistic (an fn). The full plain field set is stats.js `statKey`; we gate on the identifying
// fields and keep the object whole so added fields survive a round-trip (Trap D).
function isTrackedStat(t) {
  if (!isObj(t) || typeof t.id !== "string") return false;
  if (t.kind === "derived") return Array.isArray(t.tokens) && Array.isArray(t.inputs);
  return !!t.fn;
}

// ─── Filenames + download ─────────────────────────────────────────────────────
export function suggestFilename(state) {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const name = state && state.dataset && state.dataset.name;
  const base = typeof name === "string"
    ? name.replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "")
    : "";
  return (base ? `prism-${base}-${date}` : `prism-session-${date}`) + PRISM_EXT;
}

// Browser-only: stream a JSON object to a download via Blob (NOT a data: URI — those silently
// no-op past Chrome's ~2 MB ceiling, which a 999-row collect export can exceed).
export function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
