# Save / Open a PRISM session to a `.prism` file

## Context

PRISM's Share button (`src/lib/share.js`) encodes only *sampler authoring* into a URL —
pipeline, sample size, run mode, stop rule, code language — and **deliberately** excludes
everything a student actually produces: the uploaded dataset, the drawn samples, the tracked
statistics, and the collected sampling distribution. That is the right call for a link (results
regenerate by re-running; a CSV would blow the URL budget), but it means there is no way to put
work down and pick it up later. A student who spends a class period building a sampler and
collecting 5,000 repetitions loses all of it on refresh.

This adds a real document model: **Save** writes the whole session to a `.prism` file on the
local drive; **Open** restores it exactly, including what was on screen. Share is unchanged and
keeps its own format and version.

**Decisions already made:** plain JSON (inspectable, debuggable, no compression); `Blob` +
`<a download>` for Save and a hidden file input + `FileReader` for Open (no File System Access
API, no new dependencies); full scope including plot view state, phased.

---

## Findings that shape the design

Three things were verified directly in the source and drive the phase boundaries:

1. **`Plot` already violates the Rules of Hooks.** `plots.jsx:599-600` early-returns
   (`if (!rows.length)` / `if (!xVar)`), but the `onDivider` and `onOverlays` effects sit at
   **825** and **836** — after the returns. This works only because every host unmounts `Plot`
   before its rows can empty (`SampleResults` 1567, `DistributionPlot` 1483, App gates on
   `collectRows.length > 0` at 988). **The new view-reporting effect must go above line 599**,
   or it silently won't fire for an empty plot and will throw *"Rendered more hooks than during
   the previous render"* the day a host stops guarding. Pre-existing hazard; not fixed here, but
   do not extend it.

2. **`onDivider` reports derived state, not raw state.** `divCuts` is not authoritative —
   `effCuts` is recomputed every render from the live data (`plots.jsx:769-777`) and that is what
   `onDivider` sends (828). A save file must persist the **raw** `divCuts`/`divBy`/`divPct`.
   Happy consequence: the view blob is a pure function of the `useState` values at 538-578, so it
   needs no scales, no `divDomain`, no data — and re-seeding can't feedback-loop, because nothing
   ever writes `effCuts` back into `divCuts` (only `onDivDrag`/`setCut` at 781-786 do).

3. **`migratePipeline` preserves ids for already-staged pipelines** (`sampling.js:100`:
   `idMap[el.id] = el.id; return el;`). Since we always serialize live state, a well-formed file
   round-trips with an identity `idMap`, so `collectRows` (keyed by stat id) and `sampleData`
   (keyed by column id) stay valid. A *legacy flat* pipeline mints fresh ids — which orphans
   every result key. That case must be detected, not repaired (see Trap B).

**The view-state approach:** `Plot` keeps its own `useState` and stays uncontrolled. It gains an
`initialView` prop that seeds those hooks and one deduped `onViewChange` that reports the blob
up — exactly mirroring the proven `onDivider`/`onOverlays` pattern. App holds a `viewState` map
keyed by slot and bumps a `sessionKey` on Open to remount the plots so they re-seed. No
controlled-props refactor.

---

## The `.prism` envelope

```jsonc
{
  "prism": "PRISM-session",   // magic: cheap "is this even our file" check
  "version": 1,               // PRISM_FILE_VERSION — independent of share.js VERSION
  "savedAt": "2026-07-16T10:32:11.004Z",

  // Mirrors share.js's two-variant envelope on purpose.
  "sampler": {
    "hidden": false,
    "config": {               // present iff hidden === false
      "pipeline": [ /* Stage[] VERBATIM — incl. device.source AND device.rowSample */ ],
      "sampleSize": 10, "runMode": "fixed", "stopRule": null
    }
  },
  // hidden variant: { "hidden": true, "salt": "ab12cd34", "pw": "<verifier>", "data": "<veiled>" }

  "dataset": { "name": "cars.csv", "headers": ["mpg"], "rows": [{ "_id": "k3", "mpg": "21" }] },
  //         | null

  "results": {
    "sampleData":    [ { "_id": "r1", "_sample": 1, "stg_a": "H" } ],
    "currentSample": { "id": "s7", "rows": [ /* same row shape */ ] }   // | null
  },

  "collect": {
    "trackedStats": [ /* plain {id,fn,variable,…} and {id,kind:"derived",tokens,inputs} */ ],
    "rows":         [ { "_id": "c1", "st_9": 0.52 } ],
    "selectedIds":  ["c1"],        // Set → array
    "batchSize":    999
  },

  "ui": { "codeLang": "off", "cbMode": false, "animSpeed": 0, "dark": false },

  "view": {
    "eda":     { "xVar": "mpg",   "yVar": "none", "selectedIds": [], "plot": { /* ↓ */ } },
    "sample":  { "xVar": "stg_a", "yVar": "none", "selectedIds": [], "plot": { /* ↓ */ } },
    "collect": { "xVar": "st_9",  "yVar": "none", "plot": { /* ↓ */ } }
  }
}
```

The `Plot` blob — one shape for all three slots, **raw** `useState` values only:

```jsonc
{ "dotSize": 5,
  "showBox": false, "showMean": false, "showSD": false, "showLS": false,
  "showCount": false, "showPct": false, "expandCats": false,
  "divOn": false, "divRange": false, "divCuts": [], "divShowCount": false,
  "divShowPct": false, "divDir": "none", "divBy": "value", "divPct": 0.05,
  "divBand": "middle", "rulerOn": false }
```

### `xVar` is not the same kind of thing in all three slots

| Slot | `xVar` domain | Persist as | Why |
|---|---|---|---|
| `eda` | real CSV header | verbatim | stable with the persisted dataset |
| `sample` | **column id** (`stageId` / `stageId::k`) | verbatim | ids survive renames |
| `collect` | **display label** — `headers` built from `columns[k].label` (plots.jsx:1436-1443) | **stat id** | a label changes on `renameStat` (App.jsx:192) and gets a ` (2)` collision suffix |

So `DistributionPlot` translates label↔id both ways, reusing the idiom already at
**plots.jsx:1468-1473** (`headers.indexOf(d.variable)` → `columns[k].id`); the seed direction is
its mirror.

### Deliberate omissions

- **`dividerState` / `overlayState`** — derived, and `undefined` whenever `codeLang === "off"`
  (App.jsx:993-994). Persisting them would bake in a stale value. They regenerate from
  `view.*.plot` via the existing effects at 825/836.
- **`revealed`** — an in-session unlock by construction (App.jsx:56). A veiled file always opens
  concealed.
- **`rulerPts` / `residSel` / `catSel`** — transient measurement selections; low value, high
  surface. Omitted from v1; additive `view` fields need no version bump (Trap D).
- **`scrollTarget`** — a one-shot nudge. Never.
- **`columns` / `nameMap` / `varKinds` / `hasRowSample` / `invalidNameIds` / `code`** — `useMemo`
  derivations. Never.
- **`sampling` / `animStates` / `batchCollecting` / `batchProgress` / all refs** — ephemeral.

`dataset.rows` keep their `_id`s so `view.eda.selectedIds` still resolves after Open.

### `stripSource` is *not* reused

`share.js:28-37` drops `device.source` and `device.rowSample`. A save file wants both — the
`source:{dataset,var}` link is meaningful again because the dataset travels with it, and
`rowSample` is the entire point of a case-resampling sampler. **`persist.js` serializes
`pipeline` verbatim**, and Save is **not** gated on `hasRowSample` (unlike Share at
App.jsx:780-785).

---

## New module: `src/lib/persist.js`

Pure, no React. Sits alongside `share.js`; follows the `codegen.js` discipline of being
exercisable in a bare-Node ESM round-trip.

```js
export const PRISM_FILE_VERSION = 1;
export const PRISM_EXT = ".prism";

// state → plain JSON object (never a string). Pure.
export function buildSaveFile(state): object

// text → { ok:true, session } | { ok:false, error:"<user-facing sentence>" }. Never throws.
export function parseSaveFile(text): Result

export function suggestFilename(state): string   // "prism-session-2026-07-16.prism"
export function downloadJSON(obj, filename): void // Blob + createObjectURL + revokeObjectURL
export function coerceSession(raw): Result        // exported for direct unit exercise
```

Plus **two new exports from `share.js`** — a *refactor*, not a reimplementation:
`encodeConfig`/`decodeConfig` (87-133) are rewritten to call them, so exactly one XOR/PEPPER
implementation survives.

```js
export function veilConfig(config, salt): string      // xorCipher(compressToBase64(json), deriveKey(PEPPER, salt))
export function unveilConfig(data, salt): object|null
```

---

## Phases

```
P1 persist.js ──┬─ P2 Save ─┐
                │           ├─ P5 Open ─┬─ P6 hidden ─ P7 polish
P3 Plot view ─ P4 App wiring ┘          │
```

P1, P2, and P3 are parallel from day one (disjoint files). P4 needs P3. P5 needs P1+P2+P4.

---

### Phase 1 — `src/lib/persist.js` *(dev A; parallel; carries the correctness weight)*

The whole schema both directions, plus validation. **One new file** + the small `share.js`
refactor exposing `veilConfig`/`unveilConfig`. `buildSaveFile` is the mirror of `pickConfig`
(share.js:38-46), minus `stripSource`, plus everything Share excludes.

**Done:** `parseSaveFile(JSON.stringify(buildSaveFile(fixture)))` deep-equals the fixture (modulo
the `Set`→array→`Set` hop). `parseSaveFile` returns `{ok:false, error}` — never throws — for
`""`, `"{"`, `"[]"`, `"null"`, `{}`, `version: 99`, `pipeline: "nope"`, and a valid file with
every optional section deleted.

**Verify:** bare-Node ESM round-trip (`node --input-type=module`), the same cheap check CLAUDE.md
prescribes for `codegen.js`. No browser needed. This is the phase a junior can be held hardest
to, because it's fully testable in isolation.

---

### Phase 2 — Save button *(dev B; parallel once the P1 signature is agreed)*

A `⬇ Save` button in the page-header cluster at **App.jsx:717-725**, beside Dark/Light and
`CodeControls`.

**Do not copy `exportCSV` (App.jsx:664-670).** It builds `a.href = "data:text/csv," + encodeURIComponent(csv)`,
which silently no-ops past Chrome's ~2 MB `data:` URI ceiling. Use `downloadJSON`'s Blob path.
Style: inline `borderRadius:7, padding:"4px 10px"` to match the Dark button (718-722) — the
header idiom — *not* `btnNav` (that's the section-control idiom at 738-740).

**Near-free bonus:** switch `exportCSV` to `Blob` in the same PR. Same three lines; fixes a latent
bug for a 999-row collect export.

**Done:** Save with a dataset + a run + collected rows downloads a `.prism` that reads legibly in
a text editor. `hasRowSample` does not disable it; the tooltip says the dataset is included.

**Verify:** `npm run dev`; load a CSV, draw, collect 20, save, eyeball the JSON against the schema.

---

### Phase 3 — `Plot` self-reports its view *(dev C; parallel; `plots.jsx` only)*

App untouched → no conflict with P1/P2.

1. `Plot` (signature at **533**) gains `initialView` and `onViewChange`. Seed each `useState` in
   the **538-578** block with a lazy initializer: `useState(() => initialView?.dotSize ?? 5)`.
   Defaults preserved exactly.
2. **One** effect immediately after line **578** — above `plotRef`, and critically **above the
   599/600 early returns** (Finding 1):

```js
useEffect(() => {
  if (!onViewChange) return;
  onViewChange({ dotSize, showBox, showMean, showSD, showLS, showCount, showPct,
    expandCats, divOn, divRange, divCuts, divShowCount, divShowPct,
    divDir, divBy, divPct, divBand, rulerOn });
}, [onViewChange, dotSize, showBox, showMean, showSD, showLS, showCount, showPct,
    expandCats, divOn, divRange, divCuts.join(","), divShowCount, divShowPct,
    divDir, divBy, divPct, divBand, rulerOn]);
```

It reports `divCuts`, **not** `effCuts` (Finding 2). Both props optional and default-absent, so
the three hosts are unchanged and every existing behavior stays byte-identical. Keep it separate
from `onDivider` — different purpose, different data.

**Done:** no behavior change anywhere. A throwaway `onViewChange={console.log}` on one host prints
on every toggle and stops when nothing changes.

**Verify:** `npm run dev`; exercise divider, ruler, dot size, and overlay toggles on all three
plots. Confirm no console loop, and no *"Rendered more hooks"* error when Sample Results goes
empty → populated → empty (Draw, then edit the pipeline to clear).

---

### Phase 4 — hosts + App `viewState` *(dev C; after P3)*

- Each host gains `initialView`/`onViewChange` and splits them: `{xVar, yVar, selectedIds}` are
  consumed by the **host** (seeding 1445/1495/1539 and the Sets at 1501/1546); `.plot` forwards
  to `Plot`.
- `DistributionPlot` translates `xVar` label↔id both ways (schema table above).
- App adds `viewState` — a `{eda, sample, collect}` map of **JSON strings**, so dedup is a
  `JSON.stringify` compare rather than the hand-written 8-field compare at App.jsx:116-123 (which
  does not scale to ~20 fields), and `buildSaveFile` just `JSON.parse`s:

```js
const onViewChange = useCallback((slot, v) => {
  setViewState(prev => {
    const s = JSON.stringify(v);
    return prev[slot] === s ? prev : { ...prev, [slot]: s };
  });
}, []);
```

- **Pass `onViewChange` unconditionally.** Do **not** copy the `codeLang === "off"` gate from
  App.jsx:993-994 — that gate is exactly why `dividerState` is stale with the code panel off.
- App adds `const [sessionKey, setSessionKey] = useState(0)` and puts `key={sessionKey}` on
  `EDAPlot` (745), `SampleResults` (901), `DistributionPlot` (991). P5 bumps it.

**Done:** `viewState` tracks every plot toggle in DevTools; an unchanged `sessionKey` causes no
remounts in normal use.

**Verify:** toggle a divider on Collect with the code panel **off** and confirm `viewState.collect`
updates (the regression 993-994 would otherwise cause). Turn the panel on; confirm `dividerState`
still drives codegen unchanged.

---

### Phase 5 — Open *(dev D; after P1+P2+P4; needs the most senior review)*

A `📂 Open` button beside Save driving a hidden `<input type="file" accept=".prism,application/json">`
via a ref — copying the a11y pattern at **App.jsx:735-738** verbatim (a real `<button>` +
`ref.current.click()`, plus the `e.target.value = ""` reset that lets the same file be re-picked)
and the `FileReader.readAsText` pattern from `handleCSVFile` (**428-435**). Unlike that handler,
report errors rather than silently no-opping.

**This is the one real refactor in the roadmap. Do not call `applyConfig` (75-83) from Open.**
It is a *partial* reset by design: it writes `pipeline`/`sampleSize`/`runMode`/`stopRule`/
`trackedStats`/`codeLang` and leaves `collectRows`, `dataset`, `sampleData`, `currentSample`,
`collectSelectedIds`, `hidden`/`revealed`/`hiddenData`, `dividerState`, `overlayState` untouched.
Correct for its only caller — the mount effect at 90-101, where those slots are still at initial
values. Called mid-session it silently welds the new sampler onto the old results.

1. **`applyConfig` returns its `idMap`** (one line). The URL caller at 96 ignores it → backward
   compatible.
2. **Add `applySession(session)`** beside it: calls `applyConfig(session.sampler.config)`, then
   **exhaustively writes every remaining slot**, including ones whose saved value is empty. One
   write, not "reset then apply", so there is no partially-open intermediate state:

```
setDataset(…)          setSampleData(…)        setCurrentSample(…)
setCollectRows(…)      setCollectSelectedIds(new Set(…))
setCollectScroll(null) setBatchSize(…)         setBatchProgress(0)
setDividerState(null)  setOverlayState(null)   // re-reported by the 825/836 effects
setCbMode(…)           setAnimSpeed(…)         setDark(…)
setHidden(…)           setRevealed(!hidden)    setHiddenData(…)
setViewState(…)        setSessionKey(k => k + 1)   // last — makes initialView take effect
```

**Guard:** if `collectRows.length || dataset || sampleData.length`, confirm first — using
**`safeConfirm` (App.jsx:21)**, which currently has *zero* callers while all five real sites (473,
504, 535, 544, 922) call raw `window.confirm`. Open is exactly the mount-adjacent action the safe
wrappers exist for. Retrofitting the other five is a follow-up, not this scope.

**Done:** save a full session → reload → Open → sampler, dataset, draws, tracked columns,
collected rows, highlighted rows, and plot view all return. Draw appends to the restored
`collectRows`. Opening a second file over the first leaves nothing of the first.

**Verify (the definitive test):** save with 3 tracked stats and 50 collected rows; open in a fresh
tab; confirm the Collect table renders **values, not blanks** — that proves ids survived (Trap B) —
then Draw once and confirm row 51 appends with all 3 columns populated.

---

### Phase 6 — Veiled samplers *(small; after P5)*

`sampler.hidden === true` → the file carries `{hidden, salt, pw, data}` instead of
`{hidden, config}`. See "Hidden samplers" below.

**Done:** saving a session opened from a 🔒 Share Locked link produces a file where `grep` finds no
device labels. Opening it yields a concealed sampler that runs, and whose Reveal still accepts the
original password.

---

### Phase 7 — Polish *(last)*

`beforeunload` unsaved-changes prompt; a "Saved / Opened *name*" toast reusing the `shareMsg`
idiom (App.jsx:59, 790); a `liveMsg` announcement (App.jsx:28) for a11y parity; confirm that
opening a file with `dark:true` persisting to `localStorage` (via 48-50) is wanted; the `version`
migration chain gets its first real entry.

---

## Correctness traps

**A. The `applyConfig` partial reset** *(P5)* — covered above. The reviewer's checklist is
mechanical: **every `useState` in App.jsx 25-152 must appear in `applySession` or on the
documented ephemeral/derived list.** That's a diff a junior can be held to.

**B. Id preservation through `migratePipeline`** *(P1 detects, P5 acts)* — a well-formed file
round-trips with an identity `idMap` (Finding 3), so `rekeyStats`/`rekeyStopRule` are no-ops and
all result keys stay valid. The hazard is a **hand-authored legacy flat pipeline**: `mkStage(el)`
mints fresh ids, `idMap` goes non-identity, and every `sampleData` key orphans. (`collectRows`
keys are stat ids, which `rekeyStats` doesn't touch — so the *columns* would survive while the
*draws* don't. Worse than useless.)

> **Rule:** `applySession` checks `Object.keys(idMap).every(k => idMap[k] === k)`. If
> non-identity → **drop `sampleData`, `currentSample`, `collectRows`**, keep authoring +
> `trackedStats`, and `safeAlert` that results couldn't be restored from an older-format file.
> Do not attempt a rekey — silently-wrong results are worse than none. This is why `applyConfig`
> must return `idMap`.

**C. `Set` serialization** *(P1)* — `collectSelectedIds` (App.jsx:110) and the two host
`selectedIds` (plots.jsx:1501, 1546) are `Set`s. `JSON.stringify(new Set())` yields `{}` — silent
loss, not a throw. `buildSaveFile` spreads to an array; `coerceSession` rebuilds with
`new Set(Array.isArray(x) ? x : [])`. P1's fixture must include a non-empty selection; P5 must set
a `Set`, never the raw array — `toggleCollectId` (135-143) and `isSel` call `.has()`.

**D. Version compat** *(P1)* — strict integer gate, independent of `share.js`'s `VERSION = 1`
(which drifts on its own schedule).
- `version > PRISM_FILE_VERSION` → reject: *"This file was saved by a newer version of PRISM."*
  No partial loads — that's how you get half-restored sessions.
- `version < PRISM_FILE_VERSION` → a `MIGRATIONS[n]` chain of pure `session → session` functions.
  Empty at v1; its existence is what forces the next dev to think.
- **Unknown keys are ignored, not rejected** — this is what lets `view.*.plot` grow (`rulerPts`,
  `residSel`, new toggles) with **no version bump**, since `Plot` reads each field with a `??`
  default. Additive `view` fields are free; anything else bumps.

**E. Hand-edited / corrupt files** *(P1)* — `coerceSession` is defensive per field, never
parse-and-trust:
- Magic + version gate first.
- `sampler.config.pipeline` must be a non-empty array → else reject the file (matching
  `decodeConfig`'s check at share.js:127/131).
- **Every other section is individually optional and individually recoverable**: bad `dataset` →
  `null`; bad `results` → empty; bad `view.collect` → `{}` (Plot falls back to defaults). A student
  who hand-edits the JSON and breaks one section still gets their sampler back.
- `trackedStats` filtered to a string `id` plus either `kind === "derived"` with array
  `tokens`/`inputs`, or an `fn` — the authoritative field list is `statKey` (**stats.js:105-113**).
  Then, in P5, run the **existing** `dropInvalid(stats, liveIds)` (App.jsx:304-307) against the
  restored pipeline's `pipelineColumns` — reusing the app's own invalidation logic rather than a
  parallel validator, so a file referencing a deleted stage self-heals exactly as an in-session
  edit does.
- `collectRows` filtered to objects with an `_id`; unknown stat-id keys are harmless.
- `runMode` coerced with the same `=== "until" ? "until" : "fixed"` idiom at App.jsx:79.
- **Never throw.** `parseSaveFile` returns `{ok:false, error}`; App surfaces it via `safeAlert`.

---

## Hidden samplers

Plaintext would defeat the veil, and a `.prism` file is *more* leak-prone than a URL — a static
artifact anyone can open in Notepad, no decompression step. Saving a 🔒 sampler as readable JSON
would be strictly worse than the thing the feature exists to prevent.

**But App never holds the plaintext password.** `hiddenData` is `{salt, pw}` where `pw` is a
*verifier* (share.js:80-82); `revealSampler` (648-654) only ever compares. So
`encodeConfig(state, {password})` is unusable for Save.

**The veil doesn't need it.** Per share.js:92-97 the XOR key comes from `deriveKey(PEPPER, salt)` —
**not** the password, which only ever gated *revealing*. So Save re-veils with the **stored salt**
and copies the **existing verifier** forward:

```js
sampler = { hidden: true, salt: hiddenData.salt, pw: hiddenData.pw,
            data: veilConfig({ pipeline, sampleSize, runMode, stopRule }, hiddenData.salt) };
```

Open mirrors it: `unveilConfig(data, salt)` → config → `applySession`, then
`setHidden(true); setRevealed(false); setHiddenData({salt, pw})` — identical to the URL path at
97-99. The file inherits exactly the share link's threat model: **it opens and runs for anyone,
and the password still gates Reveal.** Nothing weakened, nothing invented.

Three things to write in as comments:
- **Reuse the existing salt.** A fresh salt changes `deriveKey(PEPPER, salt)` *and* invalidates
  `pwVerifier(password, salt)` — the file would open but Reveal would reject the correct password
  forever. The single easiest way to get this phase wrong.
- **Veil even when `revealed === true`.** The saver unlocked it; the recipient shouldn't inherit
  that. `revealed` is in-session (App.jsx:56) and is never serialized.
- **`results` stay plaintext.** The draws are on screen for anyone running the sampler; veiling
  them protects nothing. Only device internals were ever the secret.

Unchanged caveat from CLAUDE.md: **not crypto-grade.** It deters casual peeking. The Save tooltip
on a hidden sampler must not imply otherwise.

---

## Verification

Per CLAUDE.md: validate by running `npm run dev` and exercising the affected device/plot. There is
no test runner in this project (`package.json` has `dev`/`build`/`preview` only).

- **P1** — bare-Node ESM round-trip of `buildSaveFile`/`parseSaveFile`, plus the corrupt-input
  table. The one phase verifiable without a browser.
- **P3** — no console loop; no *"Rendered more hooks"* on the empty → populated → empty transition.
- **P4** — divider toggle on Collect with the code panel **off** updates `viewState.collect`.
- **P5, end to end** — CSV → build a forked sampler → draw → track 3 stats → collect 50 → set a
  divider and dot size → **Save** → reload → **Open**. Every one of those returns, the Collect
  table shows values not blanks, and Draw appends row 51 with all 3 columns filled.
- **P6** — `grep` a saved veiled file for device labels (expect none); Open → runs concealed →
  Reveal accepts the original password.

Note: batch collect can't be verified in a background preview tab (rAF throttling) — use a
foreground window or verify via the EDA/CSV path.

## Critical files

- `src/lib/persist.js` *(new)* — schema, coercion, download
- `src/lib/share.js` — extract `veilConfig`/`unveilConfig` from 87-133
- `src/components/plots.jsx` — `Plot` 533-578 + report effect above 599; hosts 1445, 1495, 1539
- `src/App.jsx` — `applyConfig` 75-83 returns `idMap`; new `applySession`; header cluster 717-725;
  `sessionKey` on 745/901/991
- `src/lib/sampling.js` — `migratePipeline` 97-122, read-only reference for the identity check
