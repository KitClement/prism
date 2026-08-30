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

1. **`Plot` already violates the Rules of Hooks.** `plots.jsx:622-623` early-returns
   (`if (!rows.length)` / `if (!xVar)`), but the `onDivider` and `onOverlays` effects sit at
   **~854** and **~865** — after the returns. This works only because every host unmounts `Plot`
   before its rows can empty (App gates the Collect plot on
   `trackedStats.length > 0 && collectRows.length > 0` at App.jsx:999). **The new view-reporting
   effect must go above line 622**, or it silently won't fire for an empty plot and will throw
   *"Rendered more hooks than during the previous render"* the day a host stops guarding.
   Pre-existing hazard; not fixed here, but do not extend it.

2. **`onDivider` reports derived state, not raw state.** `divCuts` is not authoritative —
   `effCuts` is recomputed every render from the live data (`plots.jsx:779-806`) and that is what
   `onDivider` sends (856). A save file must persist the **raw** `divCuts`/`divBy`/`divPct`.
   Happy consequence: the view blob is a pure function of the `useState` values at 560-601, so it
   needs no scales, no `divDomain`, no data — and re-seeding can't feedback-loop, because nothing
   ever writes `effCuts` back into `divCuts` (only `onDivDrag`/`setCut` at 809/814 do).

3. **`migratePipeline` preserves ids for already-staged pipelines** (`sampling.js:100`:
   `idMap[el.id] = el.id; return el;`). Since we always serialize live state, a well-formed file
   round-trips with an identity `idMap`, so `collectRows` (keyed by stat id) and `sampleData`
   (keyed by column id) stay valid. A *legacy flat* pipeline mints fresh ids — which orphans
   every result key. That case must be detected, not repaired (see Trap B).

**The view-state approach:** `Plot` keeps its own `useState` and stays uncontrolled. It gains an
`initialView` prop that seeds those hooks (block at **560-601**) and one deduped `onViewChange`
that reports the blob up — exactly mirroring the proven `onDivider`/`onOverlays` pattern. App
holds a `viewState` map keyed by slot and bumps a `sessionKey` on Open to remount the plots so
they re-seed. No controlled-props refactor.

---

## The `.prism` envelope

```jsonc
{
  "prism": "PRISM-session",   // magic: cheap "is this even our file" check
  "version": 1,               // PRISM_FILE_VERSION — independent of share.js VERSION
  "savedAt": "2026-07-16T10:32:11.004Z",

  // Plain vs hidden, loosely analogous to share.js's P/H split (but self-defined plain JSON).
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
  "showDensity": false, "showCount": false, "showPct": false, "expandCats": false,
  "divOn": false, "divRange": false, "divCuts": [], "divShowCount": false,
  "divShowPct": false, "divDir": "none", "divBy": "value", "divPct": 0.05,
  "divBand": "middle", "rulerOn": false }
```

### `xVar` is not the same kind of thing in all three slots

| Slot | `xVar` domain | Persist as | Why |
|---|---|---|---|
| `eda` | real CSV header | verbatim | stable with the persisted dataset |
| `sample` | **column id** (`stageId` / `stageId::k`) | verbatim | ids survive renames |
| `collect` | **display label** — `columns` built from `labelFor(s)` (App.jsx:1002) | **stat id** | a label changes on `renameStat` (App.jsx:203) and gets a ` (2)` collision suffix |

So `DistributionPlot` translates label↔id both ways, reusing the idiom already at
**plots.jsx:1511-1512** (`headers.indexOf(d.variable)` → `columns[k].id`); the seed direction is
its mirror.

### Deliberate omissions

- **`dividerState` / `overlayState`** — derived, and `undefined` whenever `codeLang === "off"`
  (App.jsx:1004-1005). Persisting them would bake in a stale value. They regenerate from
  `view.*.plot` via the existing effects at ~854/865.
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

`share.js:58-67` (`stripSource`) drops `device.source` and `device.rowSample`. A **plain** save
file wants both — the `source:{dataset,var}` link is meaningful again because the dataset travels
with it, and `rowSample` is the entire point of a case-resampling sampler. **`persist.js`
serializes the plain `pipeline` verbatim**, and Save is **not** gated on `hasRowSample` (unlike
Share). (A *hidden* sampler is the exception — its config rides through `veilConfig`→`encCompact`,
which strips source; correct, since a concealed population sampler never carries `rowSample` and
its internals are the secret. See "Hidden samplers".)

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
`encodeConfig`/`decodeConfig` (262-311, the compact **v2** codec) are rewritten to call them, so
exactly one XOR/PEPPER implementation survives. **DONE** — see Phase 1 below.

```js
// share.js v2: compress-first, veil-second (xorAlpha shifts within lz-string's URI-safe ALPHA).
export function veilConfig(state, salt): string   // xorAlpha(compressToEncodedURIComponent(encCompact(state)), deriveKey(PEPPER, salt), 1)
export function unveilConfig(data, salt): object|null // decCompact(decompressFromEncodedURIComponent(xorAlpha(data, deriveKey(PEPPER, salt), -1)))
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

### Phase 1 — `src/lib/persist.js` ✅ *(complete; carried the correctness weight)*

The whole schema both directions, plus validation. **One new file** + the small `share.js`
refactor exposing `veilConfig`/`unveilConfig`. For a **plain** sampler `buildSaveFile` stores the
`pipeline` **verbatim** (keeps `source`/`rowSample`) plus everything Share excludes; a **hidden**
sampler stores `veilConfig(state, hiddenData.salt)` (the same field set `encCompact` reads —
`share.js:174-189`) and copies the stored `pw` verifier forward. `coerceSession` unveils a hidden
file (importing `unveilConfig` from `share.js`) so validation is uniform in both cases.

**Done ✅:** `parseSaveFile(JSON.stringify(buildSaveFile(fixture)))` deep-equals the fixture (modulo
the `Set`→array→`Set` hop). `parseSaveFile` returns `{ok:false, error}` — never throws — for
`""`, `"{"`, `"[]"`, `"null"`, `{}`, `version: 99`, `pipeline: "nope"`, a non-PRISM magic, a
missing version, and a valid file with every optional section deleted. Hidden veil round-trips
with no device-label leak; `trackedStats` filter drops malformed entries; `share.js` links still
round-trip (plain + hidden) after the refactor.

**Verified:** bare-Node ESM round-trip (`node --input-type=module`), the same cheap check CLAUDE.md
prescribes for `codegen.js` — 55/55 assertions green. No browser needed.

**Exports:** `PRISM_FILE_VERSION`, `PRISM_EXT`, `buildSaveFile(state)`, `parseSaveFile(text)`,
`coerceSession(raw)`, `suggestFilename(state)`, `downloadJSON(obj, filename)`.

---

### Phase 2 — Save button ✅ *(complete)*

A `⬇ Save` button in the page-header cluster at **App.jsx:729-734**, beside Dark/Light and
`CodeControls`.

**Do not copy `exportCSV` (App.jsx:675, `a.href = "data:text/csv,…"` at 679).** It builds a
`data:` URI, which silently no-ops past Chrome's ~2 MB ceiling. Use `downloadJSON`'s Blob path
(already implemented in `persist.js`). Style: inline `borderRadius:7, padding:"4px 10px"` to match
the Dark button (729-733) — the header idiom — *not* `btnNav` (the section-control idiom).

**Near-free bonus:** switch `exportCSV` to `Blob` in the same PR. Same three lines; fixes a latent
bug for a 999-row collect export.

**Done ✅:** `saveSession` (App.jsx) assembles the flat state bag and calls
`downloadJSON(buildSaveFile(state), suggestFilename(state))`. `⬇ Save` button sits in the
header cluster beside Dark, header idiom (inline style, not `btnNav`); tooltip names the dataset
when one is loaded. Not gated on `hasRowSample`. `exportCSV` switched to the same Blob path
(near-free bonus — fixes the latent >2 MB `data:` no-op). `view` is left absent → stored as `{}`
until Phase 4 wires `viewState`. Save announces to the `liveMsg` a11y region (visible toast is P7).

**Verified:** `npm run dev`; intercepted the Save click in-page and parsed the emitted Blob —
`application/json`, correct magic/version, every section wired to live state, round-trips the
default pipeline. No console errors.

---

### Phase 3 — `Plot` self-reports its view ✅ *(complete)*

App untouched → no conflict with P1/P2.

1. `Plot` (signature at **555**) gains `initialView` and `onViewChange`. Seed each `useState` in
   the **560-601** block with a lazy initializer: `useState(() => initialView?.dotSize ?? 5)`.
   Defaults preserved exactly. **Note `showDensity` (567)** — the ∿ Density overlay added since the
   plan; it joins the seeded list and the effect below.
2. **One** effect immediately after the useState block (~**601**) — above `plotRef`, and critically
   **above the 622/623 early returns** (Finding 1):

```js
useEffect(() => {
  if (!onViewChange) return;
  onViewChange({ dotSize, showBox, showMean, showSD, showLS, showDensity, showCount, showPct,
    expandCats, divOn, divRange, divCuts, divShowCount, divShowPct,
    divDir, divBy, divPct, divBand, rulerOn });
}, [onViewChange, dotSize, showBox, showMean, showSD, showLS, showDensity, showCount, showPct,
    expandCats, divOn, divRange, divCuts.join(","), divShowCount, divShowPct,
    divDir, divBy, divPct, divBand, rulerOn]);
```

It reports `divCuts`, **not** `effCuts` (Finding 2). Both props optional and default-absent, so
the three hosts are unchanged and every existing behavior stays byte-identical. Keep it separate
from `onDivider` — different purpose, different data.

**Done ✅:** `Plot` (signature at plots.jsx:555) gains `initialView`/`onViewChange`, both optional
and default-absent → the three hosts are unchanged and every existing behavior stays byte-identical.
Each view `useState` (560-603 block) now takes a lazy `() => iv?.<field> ?? <default>` initializer
(via a local `iv = initialView` alias), preserving every default exactly, `showDensity` included.
One report effect sits immediately after the useState block, **above the 622/623 early returns**
(Finding 1) — it reports the raw `divCuts`, not `effCuts` (Finding 2), and stays separate from
`onDivider`. `divCuts.join(",")` is used as the dep to compare by value.

**Verified:** `npx vite build` compiles clean (no errors). App code untouched (no host passes the new
props yet), so behavior is unchanged; browser exercise of the toggles is deferred to Phase 4 when a
host actually wires `onViewChange`.

---

### Phase 4 — hosts + App `viewState` ✅ *(complete)*

- Each host gains `initialView`/`onViewChange` and splits them: `{xVar, yVar, selectedIds}` are
  consumed by the **host**, `.plot` forwards to `Plot`. Host seeds (file order is
  DistributionPlot, EDAPlot, SampleResults): EDAPlot `xVar`/`yVar` **1535-1536** + `selectedIds`
  Set **1541**; SampleResults **1579-1580** + `selectedIds` Set **1586**; DistributionPlot
  **1485-1486** (`selectedIds` is a *prop* from App — no local Set).
- `DistributionPlot` translates `xVar` label↔id both ways (schema table above; idiom at 1511-1512).
- App adds `viewState` — a `{eda, sample, collect}` map of **JSON strings**, so dedup is a
  `JSON.stringify` compare rather than the hand-written field-by-field compare at App.jsx:127-134
  (which does not scale to ~20 fields), and `buildSaveFile` just `JSON.parse`s:

```js
const onViewChange = useCallback((slot, v) => {
  setViewState(prev => {
    const s = JSON.stringify(v);
    return prev[slot] === s ? prev : { ...prev, [slot]: s };
  });
}, []);
```

- **Pass `onViewChange` unconditionally.** Do **not** copy the `codeLang === "off"` gate from
  App.jsx:1004-1005 — that gate is exactly why `dividerState` is stale with the code panel off.
- App adds `const [sessionKey, setSessionKey] = useState(0)` and puts `key={sessionKey}` on
  `EDAPlot` (756), `SampleResults` (912), `DistributionPlot` (1002). P5 bumps it.

**Done ✅:** Each host (EDAPlot, SampleResults, DistributionPlot) gained `initialView`/`onViewChange`,
split as documented: `{xVar, yVar, selectedIds}` are seeded/consumed by the host (lazy `useState`
initializers preserving every default via `??`), and `.plot` forwards to the inner `Plot`. Each host
keeps the raw plot blob in a `plotView` state (fed by the child `Plot`'s `onViewChange`) and one effect
reports the combined `{xVar, yVar, selectedIds, plot}` up. `DistributionPlot` translates `xVar`
label↔id both ways (seed: stat id → `headers[k]`; report: `headers.indexOf(xVar)` → `columns[k].id`),
reusing the `handleDivider` idiom. App added `viewState` (a `{eda,sample,collect}` map of **JSON
strings**, deduped by `JSON.stringify` compare), the three slot-bound `useCallback` reporters
(`onEdaView`/`onSampleView`/`onCollectView`), and `sessionKey` (`key=` on all three plots) with
`initialViews` memoized on `sessionKey` **only** (viewState omitted from deps → the seed is a one-shot
at mount, so re-reporting can't loop). `onViewChange` is passed **unconditionally** — NOT under the
`codeLang === "off"` gate that keeps `dividerState`/`overlayState` stale. `saveSession` now `JSON.parse`s
each slot into `view`.

**Verified:** `npx vite build` clean. In a live dev server, intercepted the Save Blob at three points:
(1) EDA — set `xVar:"mpg"` + toggled △ Mean → `view.eda.plot.showMean:true`; (2) all three slots present
after a draw + tracked proportion; (3) **the regression check** — toggled the Collect plot's divider
with the **code panel off** → `view.collect.divOn:true`, and `view.collect.xVar` equalled the tracked
**stat id** (`"g3riicv"`), not the label `prop(stk1="a")` — proving both the unconditional wiring and
the label→id translation. No console errors.

---

### Phase 5 — Open ✅ *(complete)*

A `📂 Open` button beside Save driving a hidden `<input type="file" accept=".prism,application/json">`
via a ref — copying the a11y pattern at **App.jsx:746-748** verbatim (a real `<button>` +
`ref.current.click()`, plus the `e.target.value = ""` reset that lets the same file be re-picked)
and the `FileReader.readAsText` pattern from `handleCSVFile` (**439-445**). Unlike that handler,
report errors rather than silently no-opping (use `parseSaveFile`'s `{ok:false, error}`).

**This is the one real refactor in the roadmap. Do not call `applyConfig` (78-86) from Open.**
It is a *partial* reset by design: it writes `pipeline`/`sampleSize`/`runMode`/`stopRule`/
`trackedStats`/`codeLang` and leaves `collectRows`, `dataset`, `sampleData`, `currentSample`,
`collectSelectedIds`, `hidden`/`revealed`/`hiddenData`, `dividerState`, `overlayState` untouched.
Correct for its only caller — the mount effect at 95-112, where those slots are still at initial
values. Called mid-session it silently welds the new sampler onto the old results.

1. **`applyConfig` returns its `idMap`** (one line). The URL caller at 107 ignores it → backward
   compatible.
2. **Add `applySession(session)`** beside it: calls `applyConfig(session.sampler.config)`, then
   **exhaustively writes every remaining slot**, including ones whose saved value is empty. One
   write, not "reset then apply", so there is no partially-open intermediate state:

```
setDataset(…)          setSampleData(…)        setCurrentSample(…)
setCollectRows(…)      setCollectSelectedIds(new Set(…))
setCollectScroll(null) setBatchSize(…)         setBatchProgress(0)
setDividerState(null)  setOverlayState(null)   // re-reported by the ~854/865 effects
setCbMode(…)           setAnimSpeed(…)         setDark(…)
setHidden(…)           setRevealed(!hidden)    setHiddenData(…)
setViewState(…)        setSessionKey(k => k + 1)   // last — makes initialView take effect
```

**Guard:** if `collectRows.length || dataset || sampleData.length`, confirm first — using
**`safeConfirm` (App.jsx:21)**, which currently has *zero* callers while all five real sites (484,
515, 546, 555, 933) call raw `window.confirm`. Open is exactly the mount-adjacent action the safe
wrappers exist for. Retrofitting the other five is a follow-up, not this scope.

**Done ✅:** `applyConfig` now returns `{ idMap, stages }` (the mount-time URL importer ignores it →
backward compatible). New `applySession(session)` calls `applyConfig`, then writes **every remaining
slot exhaustively** in one pass (no reset-then-apply, so no half-open intermediate): dataset,
sampleData, currentSample, collectRows, collectSelectedIds (→ `new Set`), collectScroll(null),
batchSize, batchProgress(0), dividerState/overlayState(null — re-reported by the ~854/865 effects),
cbMode, animSpeed, dark, hidden, revealed(`!hidden`), hiddenData, viewState (the `session.view`
plain object re-stringified per slot), and `sessionKey → k+1` **last** so the plots remount and
re-seed from `initialView`. **Trap B:** a non-identity `idMap` (a legacy flat pipeline) drops
`sampleData`/`currentSample`/`collectRows` and `safeAlert`s that results couldn't be restored —
authoring + rekeyed `trackedStats` are kept. Tracked stats are additionally run through the app's
own `dropInvalid` against the restored pipeline's `pipelineColumns` (Trap E self-heal). `📂 Open`
button sits beside Save (header idiom), driving a hidden `<input accept=".prism,application/json">`
via `prismInputRef` with the `e.target.value=""` re-pick reset. `handleOpenFile` uses
`parseSaveFile` (never throws → `safeAlert(res.error)` on failure) and a `safeConfirm` guard before
discarding in-session work.

**Verified (the definitive test, live dev server):** captured a real Save file, injected a dataset +
a `prop(stk1="a")` tracked stat keyed to the live stage id + 3 collected rows (0.3/0.5/0.7) + a
collect view with `divOn`/`dotSize`, and fed it to the Open input. After Open: EDA header shows
`cars.csv · 2 rows`, the Collect table renders the tracked column with **values not blanks** (proving
ids survived — Trap B), and **only** the Collect plot's Divider+Proportion toggles are checked
(per-slot view seeding via `sessionKey` remount). Then **Draw once → row 4 (0.6) appended** to the
restored rows with the column populated. No React hook errors (no *"Rendered more hooks"*).

---

### Phase 6 — Veiled samplers ✅ *(complete)*

`sampler.hidden === true` → the file carries `{hidden, salt, pw, data}` instead of
`{hidden, config}`. See "Hidden samplers" below.

**Done ✅:** The mechanism landed in earlier phases and Phase 6 confirmed it end to end.
`buildSaveFile` (persist.js:39-40) writes `{hidden:true, salt, pw, data:veilConfig(s, salt)}` for a
hidden sampler — **reusing the stored `hiddenData.salt`** (a fresh salt would break Reveal forever)
and **copying the existing `pw` verifier forward** (App never holds the plaintext). It veils
**regardless of `revealed`** (the saver's in-session unlock is never serialized), and `results` stay
plaintext (the draws are on screen for anyone running it — only device internals were the secret).
`coerceSession` (persist.js:103-109) `unveilConfig`s with the code-known PEPPER so the file opens and
runs for anyone; `applySession` sets `hidden`/`revealed:false`/`hiddenData`, so `revealSampler`'s
`checkHiddenPassword` still gates viewing. Save tooltip on a hidden sampler names the concealment
without implying crypto-grade (App.jsx:851-853).

**Verified:** bare-Node ESM round-trip (`p6-veil.mjs`, 19/19 green) — a hidden save produced a file
where none of the device labels appear anywhere in the JSON and no plaintext `config` exists; the
salt was reused and the verifier copied forward; `parseSaveFile` recovered the pipeline + labels
(runs concealed with no password); `checkHiddenPassword` accepted the original password and rejected
a wrong one; a corrupted veil was rejected cleanly (never thrown). `npx vite build` clean.

---

### Phase 7 — Polish ✅ *(complete)*

`beforeunload` unsaved-changes prompt; a "Saved / Opened *name*" toast reusing the `shareMsg`
idiom (App.jsx:59, 790); a `liveMsg` announcement (App.jsx:28) for a11y parity; confirm that
opening a file with `dark:true` persisting to `localStorage` (via 48-50) is wanted; the `version`
migration chain gets its first real entry.

**Done ✅:**
- **`beforeunload` guard.** A `dirtyRef` (ref, not state — the handler reads it live with no dep
  churn) flips true on any edit to persistable state and back to false on Save/Open. The
  dirty-marking effect compares **references** against a `dirtyDeps` snapshot rather than counting
  runs, so StrictMode's double-invoked mount effect (identical refs) never falsely marks a fresh
  app dirty. `suppressDirtyRef` swallows the batched state writes that an Open — and the mount-time
  shared-link import — trigger, so a just-opened/just-loaded session starts clean. One
  `window.addEventListener("beforeunload", …)` effect (registered once) calls `preventDefault()` +
  `returnValue=""` only when `dirtyRef.current` is set.
- **Toast.** A dedicated `fileMsg`/`flashFileMsg` (2.6 s auto-clear) kept **separate** from
  `shareMsg` so a file action and a Share action don't clobber each other, rendered green in the
  page-header cluster beside Open: `⬇ Saved <filename>` / `📂 Opened <name|dataset|"hidden
  sampler">`. `liveMsg` announcements were already wired in P2/P5 (kept, save message now names the
  file).
- **`dark:true` decision.** Confirmed **intentional**: opening a session adopts its theme (and
  persists it to `localStorage` via the ~48-50 effect) exactly as the Dark toggle does — a
  low-stakes, easily reversed preference. A comment at the `setDark` site in `applySession` records
  this so it isn't "fixed" later.
- **Migration chain.** The **runner** is now wired (`runMigrations` walks `MIGRATIONS[version..]`
  applying each `n→n+1` envelope upgrader before any section is read; a gap in the chain refuses the
  file rather than mis-restoring). `MIGRATIONS` stays **empty at v1** — there is no older format to
  migrate *from* yet, so fabricating an entry would be dishonest — but the infrastructure is real
  and exercised: a `version:0` file is now cleanly refused ("from an older version that can't be
  upgraded") instead of silently proceeding. The first real `MIGRATIONS[1]` step is a one-line
  drop-in the day v2 ships.

**Verified:** `npx vite build` clean; a bare-Node ESM round-trip (`p7-mig.mjs`, 5/5 green) covering
the current-version round-trip, future-version rejection, unmigratable-older-version refusal, and
missing-version rejection. In a live dev server: fresh app → beforeunload guard **does not** block
(`defaultPrevented:false`); add a stage → guard **blocks** (`true`); **Save** → guard clears
(`false`) and the `⬇ Saved prism-session-….prism` toast shows; edit again → re-armed (`true`);
**Open** the captured file → cleared (`false`) and `📂 Opened session` toast shows. No console
errors on the final module.

---

## Correctness traps

**A. The `applyConfig` partial reset** *(P5)* — covered above. The reviewer's checklist is
mechanical: **every `useState` in the App state block (App.jsx ~25-272) must appear in
`applySession` or on the documented ephemeral/derived list.** That's a diff a junior can be held to.

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

**C. `Set` serialization** *(P1 — done)* — `collectSelectedIds` (App.jsx:121) and the two host
`selectedIds` (plots.jsx:1541 EDAPlot, 1586 SampleResults) are `Set`s. `JSON.stringify(new Set())`
yields `{}` — silent loss, not a throw. `buildSaveFile` spreads to an array; `coerceSession`
rebuilds with `new Set(Array.isArray(x) ? x : [])`. P1's fixture includes a non-empty selection;
P5 must set a `Set`, never the raw array — `toggleCollectId` (146-154) and `isSel` call `.has()`.

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
- The pipeline (plain `sampler.config.pipeline`, or the unveiled hidden config's) must be a
  non-empty array → else reject the file (matching `decCompact`'s array check at share.js:192).
- **Every other section is individually optional and individually recoverable**: bad `dataset` →
  `null`; bad `results` → empty; bad `view.collect` → `{}` (Plot falls back to defaults). A student
  who hand-edits the JSON and breaks one section still gets their sampler back.
- `trackedStats` filtered to a string `id` plus either `kind === "derived"` with array
  `tokens`/`inputs`, or an `fn` — the authoritative field list is `statKey` (**stats.js:132**).
  Then, in P5, run the **existing** `dropInvalid(stats, liveIds)` (App.jsx:315) against the
  restored pipeline's `pipelineColumns` — reusing the app's own invalidation logic rather than a
  parallel validator, so a file referencing a deleted stage self-heals exactly as an in-session
  edit does.
- `collectRows` filtered to objects with an `_id`; unknown stat-id keys are harmless.
- `runMode` coerced with the same `=== "until" ? "until" : "fixed"` idiom at App.jsx:82.
- **Never throw.** `parseSaveFile` returns `{ok:false, error}`; App surfaces it via `safeAlert`.

---

## Hidden samplers

Plaintext would defeat the veil, and a `.prism` file is *more* leak-prone than a URL — a static
artifact anyone can open in Notepad, no decompression step. Saving a 🔒 sampler as readable JSON
would be strictly worse than the thing the feature exists to prevent.

**But App never holds the plaintext password.** `hiddenData` is `{salt, pw}` where `pw` is a
*verifier* (share.js `pwVerifier`, 255); `revealSampler` (App.jsx:659-663) only ever compares. So
`encodeConfig(state, {password})` is unusable for Save.

**The veil doesn't need it.** Per share.js the XOR key comes from `deriveKey(PEPPER, salt)` (216) —
**not** the password, which only ever gated *revealing*. So Save re-veils with the **stored salt**
and copies the **existing verifier** forward (this is what `buildSaveFile` already does):

```js
sampler = { hidden: true, salt: hiddenData.salt, pw: hiddenData.pw,
            data: veilConfig(state, hiddenData.salt) };  // veilConfig runs encCompact(state) internally
```

Open mirrors it: `coerceSession` already `unveilConfig(data, salt)`s → config, so `applySession`
just reads `session.pipeline`/etc. and `session.hiddenData`, then
`setHidden(true); setRevealed(false); setHiddenData({salt, pw})` — identical to the URL path at
108-109. The file inherits exactly the share link's threat model: **it opens and runs for anyone,
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

- **P1 ✅** — bare-Node ESM round-trip of `buildSaveFile`/`parseSaveFile`, plus the corrupt-input
  table and the hidden veil round-trip (55/55 green). The one phase verifiable without a browser.
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

- `src/lib/persist.js` *(new — ✅ done)* — schema, coercion, download
- `src/lib/share.js` — `veilConfig`/`unveilConfig` extracted from the v2 codec (262-311) ✅
- `src/components/plots.jsx` — `Plot` 555-601 + report effect above 622; hosts EDAPlot 1535,
  SampleResults 1579, DistributionPlot 1485 (label↔id at 1511-1512)
- `src/App.jsx` — `applyConfig` 78-86 returns `idMap`; new `applySession`; header cluster 729-734;
  `sessionKey` on 756/912/1002; `codeLang==="off"` gate 1004-1005
- `src/lib/sampling.js` — `migratePipeline` 97 (idMap 100), read-only reference for the identity check
