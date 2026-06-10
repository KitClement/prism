# TinkerSim — Project Guide for Claude Code

A browser-based probability **sampler & simulation** tool for undergraduate statistics
education, modeled on TinkerPlots. Single-page React app.

## Stack & commands
- **Vite + React 18** (no TypeScript, no Tailwind build step).
- `npm run dev` — start the dev server (hot reload).
- `npm run build` — production build to `dist/`.
- `npm run preview` — serve the production build locally.

The code was split out of the original monolithic `App.jsx` into `src/lib/` (pure helpers)
and `src/components/` (React components) during the Phase 0 module split. `App.jsx` (~580
lines) is now just the top-level `App` component: state, the sampler pipeline, the two
accumulation paths, and the layout that mounts the components below. It stays intentionally
dependency-light and self-contained (no chart lib, no state lib).

### Module map
- **`src/lib/`** (pure, no React)
  - `util.js` — `parseCSV`, `colKind` (num/cat/time detection), `toNum`,
    `parseTimeToMinutes`, `collapseCats`, `COLORS`, `uid`, …
  - `stats.js` — `quantile` (interpolating), `numericSummary`, `lsFit`, `computeStat`,
    `statLabel`, `FN_OPTS`, `NUMERIC_FNS`.
  - `sampling.js` — the **stage** model (`mkStage`/`toStages`/`migratePipeline`+`rekeyStats`/
    `rekeyStopRule`, `selectBranch`, `stageVarKind`/`stageOutcomes`), the shared draw helpers
    `makeDrawState` / `drawStacks` / `drawMixer` / `sampleSpinner` / `drawStageValue`, the
    run-until predicate `stopReached`, the non-animated `drawSample(pipeline, n, opts)` (batch
    path), the animated `runAnimatedSample` (per-run path), device factories
    `mkStacks`/`mkMixer`/`mkSpinner`, and `deviceVarKind` (classify a sampler var from its
    **declared outcomes**).
  - `share.js` — URL sharing (Task C/D): `encodeConfig`/`decodeConfig`/`decodeHidden`/
    `shareURL`, lz-string compression, and the XOR password-veil helpers (not crypto-grade).
  - `codegen.js` — parallel R/Python code generation (Task E): `generateCode(config, lang)`
    returns `{sampler, single, collect, inference, integrated}`, each an array of
    `{text, section}` lines. Reads the **same** specs the UI uses (stage outcomes, the
    `computeStat` fn semantics, `stopReached`) so code and tool never diverge.
  - `scale.js` — `makeScale` (axis scale builder) + `stackDots` (tallest-column dot
    stacking). Shared by every plot.
  - `expr.js` — derived-statistic engine: `lexExpr`/`evalExpr`/`validateExpr`,
    `computeStatRow` (two-pass: plain stats then derived), `colLabel`/`exprLabel`,
    `aliasFor`.
  - `measure.js` — measurement-tool math: `clampVal`, `snapValue`/`snapMeasure` (snap a
    handle to dots/visible measures), `regions` (divider proportions).
  - `styles.js` — shared style consts (`iSm`, `btnX`, `Sel`, …) plus the code-panel palette
    `CODE_SECTIONS` / `sectionColor` / `SHAPE_PATH` (Task E); `hooks.js` — `useContainerWidth`.
- **`src/components/`**
  - `plots.jsx` — `Plot` (the unified controls+body primitive), `EDAPlot`,
    `SampleResults`, `DistributionPlot`, `DataTable`/`CollectTable`, `CatCatGrid`,
    `SplitDotPlots`, `UniCatPlot`, the measurement overlays `DividerLines` / `RulerOverlay`
    / `ResidualOverlay` / `MeasureConnector`, plus the manual authoring UIs `StatDefiner`
    and `DerivedBuilder`.
  - `devices.jsx` — `StageCard` (wraps a stage; renders forked branch sub-cards +
    `BranchConditionEditor`), `SpinnerDevice`, `StacksDevice`, `MixerDevice`, `DeviceCard`.
  - `code.jsx` — `CodePanels` (Task E): the language toggle (off/R/Python) + color-blind
    toggle, the four `CodeBox` panels (gradient header with the section shape cut out in
    white), and the integrated panel whose gutter color-codes each line by its section.
  - `ui.jsx` — small shared widgets (`Sel`, `InlineEdit`, `ReplacementToggle`, …).

## Architecture (current)
The app has three workflow stages, top to bottom:
1. **Data & Exploratory Analysis (EDA)** — upload a CSV, auto-detect numeric vs.
   categorical columns, plot with toggleable stat overlays (boxplot, mean triangle,
   ±1 SD, LS line; cat×cat grid; cat×numeric split dot plots). Copy a column to paste
   into a sampler device.
2. **Sampler Pipeline** — a linear list of **stages**, each owning one output column and
   producing one variable per draw. A stage can be **forked** (conditional/branched on an
   upstream draw — see the stage model below). Animated sampling; "Repeat n" or "Run until"
   a stopping rule (variable n). A **Share** button encodes the whole sampler into a URL
   (optionally password-veiled), and a **Code** panel mirrors the simulation in R/Python.
3. **Sample Results** (raw draws) → **Collect Statistics** (sampling distribution over
   many repetitions). Sample Results mirrors the EDA layout (data table left, `Plot`
   right). Collect Statistics is **click-to-track**: any statistic whose number is
   *visible* on the Sample Results plot can be clicked to promote it into a tracked
   **column**; every draw appends a row. See "Sample Results & Collect Statistics" below.

### The stage model (forked / conditional sampler)
`pipeline` is a `Stage[]`. Each **stage** `{ id, type:"stage", varName, branches }` owns one
output column (the **stage id** is the column identity that rows, `varKinds`, tracked-stat
specs, and plots key on). A stage holds 1+ **branches** `{ id, condVar, condVal, device }`:
- `condVar===null` is the **default** branch (exactly one). It fires when no conditional
  branch matches, so an unconditional stage always runs (**convergence**).
- A conditional branch's `condVar` references an **upstream** stage id and `condVal` an
  outcome label; it may key off an already-forked stage (**nesting**). The upstream-only
  invariant is enforced in `movStage`/`remStage`/the branch editor.
- The inner `device` keeps the existing spinner/stacks/mixer shape verbatim — `mkSpinner`/
  `mkStacks`/`mkMixer` are reused, and each **branch device** keeps its own id (the
  without-replacement draw-state key, so per-branch pools never bleed — constraint #2).

Both draw paths resolve a stage through the **shared** `selectBranch(stage, row)` →
`drawStageValue` (first matching `(condVar,condVal)`, else default), building `row`
incrementally so a downstream branch sees upstream values in one pass (constraint #1 holds —
no third loop). `runAnimatedSample` animates only the selected branch and dims the others via
an `inactive` flag. `stageVarKind`/`stageOutcomes` classify a fork by the **union** of its
branch devices' declared outcomes.

### Run-until, sharing, hidden, and code (the latest wave)
- **Run until a condition** (`runMode` `"fixed"|"until"`, `stopRule {kind,stageId,value,n}`):
  only the **outer** per-sample loop changes — `until` keeps drawing rows until `stopReached`
  holds, with `sampleSize` reused as the mandatory safety cap (max draws). Switching mode or
  editing the rule clears `collectRows` (an until distribution must not mix with a fixed-n one).
- **URL sharing** (`lib/share.js`, the one new dependency **lz-string**): `encodeConfig`
  serializes the minimal config (`pipeline`, `sampleSize`, `runMode`/`stopRule`,
  `trackedStats`, `codeLang`) → a `?s=` blob; a one-time mount `useEffect` in `App.jsx`
  imports it, runs `migratePipeline` + `rekeyStats`/`rekeyStopRule`, then cleans the URL.
- **Hidden samplers** (Task D): a hidden link **opens and runs for anyone — no password
  needed**; the password gates only *revealing* the device internals. The config is XOR-
  obfuscated with a code-known `PEPPER` (so a casual URL decompress shows garbage, but the app
  always decodes it to run concealed); the blob also carries a salted password *verifier*
  (`checkHiddenPassword`), never the plaintext. **Not** crypto-grade. A hidden sampler renders
  opaque placeholders + a "Reveal" button until the password is entered. Browser dialogs are
  wrapped in module-level `safePrompt`/`safeAlert`/`safeConfirm` (they throw in embedded/
  headless contexts).
- **Code panels** (`components/code.jsx`, `lib/codegen.js`): off by default; the toggle reveals
  four runnable R/Python sections + an integrated program. See "Hard-won constraints" #7.

### The unified `Plot` primitive
`Plot` (in `plots.jsx`) is the single plotting component behind EDA, Sample Results, and
the Collect Statistics distribution plot. It owns the X/Y selectors (controlled by the
host so a sibling table can highlight columns), dot-size + overlay toggles (mean/median/
SD/box/LS/values), and the four plot modes (univariate numeric, univariate categorical,
cat×cat grid, num×cat split, num×num scatter). It builds scales/stacking from
`lib/scale.js`. EDA passes no `varKinds` and renders identically; sampler-fed hosts pass
`varKinds` (from `deviceVarKind`) so a var's num/cat kind comes from the device's declared
outcomes, not re-inferred per sample.

### Sample Results & Collect Statistics (the overhaul)
- **Click-to-track.** Only a statistic whose number is currently on the plot is
  collectable (gated on the `onTrackStat` prop, so EDA shows no track UI). Clicking a value
  toggles a tracked-stat column. The plot's variable selection scopes the stat: univariate
  numeric → mean/median/SD; cat×cat cell → conditional `proportion`/`countVal`; num×cat
  group → a group stat (`condVar`/`condVal`); num×num line → slope/intercept.
- **Two accumulation paths, both through the shared draw helpers** (see constraint #1):
  *per-run* (`doSample`→`runAnimatedSample`, appends one row on every draw) and *batch*
  (`doCollectTracked`→`drawSample`, "Collect N", default 500). Both compute every tracked
  column via `computeStatRow`.
- **Derived columns.** `DerivedBuilder` lets students assemble a new column from collected
  ones (e.g. `(A − B)` difference of means) via `lib/expr.js`; it backfills existing rows.
- **Manual authoring (kept).** `StatDefiner` lives behind a "Define a statistic manually"
  toggle and feeds the same tracked-stat table — the only way to author Q1/Q3/min/max,
  which aren't click-trackable. Its **＋ Add to table** calls the shared `addTrackedStat`.
- **Invalidation guards.** Sample-size change clears the accumulated rows but keeps the
  columns; a distribution-structure device change clears rows and drops columns whose vars
  vanished; pure relabels propagate seamlessly (`propagateRenames`). See Resolved
  decision #2 in `plan.md`.

### Plot measurement tools (divider + ruler)
Two opt-in tools share one measurement-overlay foundation on `Plot` (`lib/measure.js`).
Both are off by default and gated to plots where they make sense.
- **Divider** — draggable vertical line(s) on a continuous numeric **X** axis. Single mode
  shows P(<v)/P(≥v); range mode adds a second handle for P(<lo)/P(lo–hi)/P(>hi). num×cat
  shows one shared cut with per-group read-outs. On-plot count/proportion labels (toggled
  by the Count / Proportion checkboxes; proportions render to 3 decimals, e.g. `0.500`)
  are **click-to-track** in Sample Results (`countBetween`/`propBetween`).
  Gated to univariate numeric and num×cat-with-numeric-X; hidden on cat×cat, uni-cat, and
  num×num scatter.
- **Ruler** — three mechanics, each gated to its plot type: *axis distance* (two snappable
  endpoints on a numeric axis; difference-in-group-means is the num×cat headline),
  *residual to LS line* (num×num scatter, `y − ŷ`), and *difference of two measures*
  (cat×cat proportions via `MeasureConnector`). A "＋ track" affordance authors a Phase-5
  derived column (`A − B`) that backfills and plots. Endpoints anchored to a measure
  recompute live from the current data.

## Hard-won constraints — DO NOT REGRESS THESE
These were the source of real bugs during development. Preserve them.

1. **Sampling logic is shared.** `makeDrawState`, `drawStacks`, and `drawMixer`
   (`lib/sampling.js`) are the single source of truth for "draw one value." The animation
   loop (`runAnimatedSample`, per-run path) shares `makeDrawState` and mirrors the counting
   inline; the batch loop (`drawSample`, called by `doCollectTracked`) calls the helpers
   directly. Never reimplement the draw loop a third time, or behavior will silently
   diverge (this caused a without-replacement counting bug).
   - Stacks without-replacement: track remaining **counts per item** (decrement on draw).
     Do NOT track "drawn item indices" — all units of one category share an index, so a
     Set of indices removes the whole category at once.
   - Mixer: each ball is an individual item; track drawn **ball indices** in a Set.
2. **No `import React` default import.** Use named hooks only
   (`import { useState, ... } from "react"`). In the original artifact sandbox a default
   React import collided with the bundler's auto-injected one. (Under Vite this is less
   fragile, but keep it consistent unless you deliberately migrate.)
3. **No `<foreignObject>` / `xmlns=` inside SVG** — it broke the JSX transform. Use plain
   SVG `<text>` for spinner labels, etc.
4. **Shared style constants and helper components must be defined before use** — `const`
   is not hoisted. Keep `iSm`, `btnX`, `btnPlus`, `btnArr`, `btnNav`, `ctrlLbl`, and `Sel`
   near the top of the file.
5. **Quantiles** use the interpolating `quantile()` everywhere (median, Q1, Q3) — both in
   `computeStat` and `numericSummary`. Keep them consistent.
6. **Plots must fit vertically.** Dot-stacking computes the tallest column first, then
   `dotSpacing = min(normalSpacing, availableHeight / tallest)` so stacks never overflow.
7. **Generated code reads the live specs, never a parallel copy.** `lib/codegen.js` mirrors
   the *same* sources the UI computes from (stage outcomes, the `computeStat` fn semantics,
   `stopReached`) so the R/Python can't drift from the tool. Scope of v1: row-by-row **with
   replacement** (a without-replacement device is flagged in a comment, not reproduced);
   population SD; type-7 quantiles (R `type=7`, a hand-written interpolator in Python) to
   match `quantile()`; the headline statistic is the first plain tracked stat (derived
   columns aren't emitted). Verify a change by copying the integrated program into a real
   REPL — `npm`-free Node round-trips of `generateCode` plus an actual `python` run are the
   cheap check (R isn't installed here). Keep the four section colors/symbols in `styles.js`'
   `CODE_SECTIONS` as the single palette source; color-blind mode remaps **only** red→black
   and green→gray.

## Device behavior reference
- **Spinner**: always with replacement (toggle is disabled). Arrow lands at a random
  position within the winning slice; always spins ≥1.5 rotations so consecutive same-slice
  picks still visibly move. Result badge only appears after the spin finishes
  (`onSpinReady`).
- **Stacks**: with/without replacement. Animation merges the per-category bars into one
  shuffled deck (cards fly together), highlights the top card, then draws it. Uses
  individual cards when ≤80 total units, proportional interleaved stripes above that.
- **Mixer**: with/without replacement. All balls visible (radius shrinks to fit); picked
  ball rises to a notch at top-center while others settle.
- Devices are locked (non-editable, transparent overlay) during sampling.

## Animation speed
Slider: 0 = Slow (default, left), 1 = Fast, 2 = Instant (right).

## Suggested next steps
Both roadmaps are complete: the Phase 0–7 plan (module split, shared `Plot`, the Sample
Results / Collect Statistics overhaul, divider + ruler) and the next feature wave Tasks A–F
in `.claude/plans/` (forked/conditional stages, run-until, URL sharing, hidden samplers,
R/Python code panels, serialization polish) all shipped. Possible follow-ons:
- **Without-replacement fidelity in generated code** (currently flagged-but-with-replacement).
- **Per-tool placement of the code panels** (today they live in one bottom "Code" card; the
  plan's ideal is each section beside its tool — sampler / Sample Results / Collect / divider).
- **Multi-condition stop rules** (run-until is single-condition v1; no AND/OR yet) and a
  divider state lifted into `App` so `genInference` can mirror the actual cut.
- Trackability for the ruler's **residual** case; the divider on num×num scatter (both
  deferred earlier). More device types or pipeline composition, if the curriculum needs them.

## Conventions
- Keep the app dependency-light. Don't add a UI framework or state library without reason.
- Validate any change by running `npm run dev` and exercising the affected device/plot.
