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
  - `sampling.js` — the shared draw helpers `makeDrawState` / `drawStacks` / `drawMixer` /
    `sampleSpinner`, the non-animated `drawSample(pipeline, n)` (batch path), the animated
    `runAnimatedSample` (per-run path), device factories `mkStacks`/`mkMixer`/`mkSpinner`,
    and `deviceVarKind` (classify a sampler var from its **declared outcomes**).
  - `scale.js` — `makeScale` (axis scale builder) + `stackDots` (tallest-column dot
    stacking). Shared by every plot.
  - `expr.js` — derived-statistic engine: `lexExpr`/`evalExpr`/`validateExpr`,
    `computeStatRow` (two-pass: plain stats then derived), `colLabel`/`exprLabel`,
    `aliasFor`.
  - `measure.js` — measurement-tool math: `clampVal`, `snapValue`/`snapMeasure` (snap a
    handle to dots/visible measures), `regions` (divider proportions).
  - `styles.js` — shared style consts (`iSm`, `btnX`, `Sel`, …); `hooks.js` —
    `useContainerWidth`.
- **`src/components/`**
  - `plots.jsx` — `Plot` (the unified controls+body primitive), `EDAPlot`,
    `SampleResults`, `DistributionPlot`, `DataTable`/`CollectTable`, `CatCatGrid`,
    `SplitDotPlots`, `UniCatPlot`, the measurement overlays `DividerLines` / `RulerOverlay`
    / `ResidualOverlay` / `MeasureConnector`, plus the manual authoring UIs `StatDefiner`
    and `DerivedBuilder`.
  - `devices.jsx` — `SpinnerDevice`, `StacksDevice`, `MixerDevice`, `DeviceCard`.
  - `ui.jsx` — small shared widgets (`Sel`, `InlineEdit`, `ReplacementToggle`, …).

## Architecture (current)
The app has three workflow stages, top to bottom:
1. **Data & Exploratory Analysis (EDA)** — upload a CSV, auto-detect numeric vs.
   categorical columns, plot with toggleable stat overlays (boxplot, mean triangle,
   ±1 SD, LS line; cat×cat grid; cat×numeric split dot plots). Copy a column to paste
   into a sampler device.
2. **Sampler Pipeline** — chain of devices (Stacks, Mixer, Spinner), each producing one
   variable per draw. Animated sampling.
3. **Sample Results** (raw draws) → **Collect Statistics** (sampling distribution over
   many repetitions). Sample Results mirrors the EDA layout (data table left, `Plot`
   right). Collect Statistics is **click-to-track**: any statistic whose number is
   *visible* on the Sample Results plot can be clicked to promote it into a tracked
   **column**; every draw appends a row. See "Sample Results & Collect Statistics" below.

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
  by # / %) are **click-to-track** in Sample Results (`countBetween`/`propBetween`).
  Gated to univariate numeric and num×cat-with-numeric-X; hidden on cat×cat, uni-cat, and
  num×num scatter.
- **Ruler** — three mechanics, each gated to its plot type: *axis distance* (two snappable
  endpoints on a numeric axis; difference-in-group-means is the num×cat headline),
  *residual to LS line* (num×num scatter, `y − ŷ`), and *difference of two measures*
  (cat×cat percentages via `MeasureConnector`). A "＋ track" affordance authors a Phase-5
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
The Phase 0–7 roadmap in `plan.md` is complete: the module split, the shared `Plot`
primitive, the Sample Results / Collect Statistics overhaul (click-to-track, derived
columns), and the divider + ruler measurement tools all shipped. Possible follow-ons:
- Trackability for the ruler's **residual** case (deferred — a measured scatter point has
  no stable cross-repetition identity).
- The divider on num×num scatter (deferred — a vertical cut reads as a statement about
  x alone).
- More device types or sampler-pipeline composition, if the curriculum needs them.

## Conventions
- Keep the app dependency-light. Don't add a UI framework or state library without reason.
- Validate any change by running `npm run dev` and exercising the affected device/plot.
