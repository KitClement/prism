# Roadmap — Sample Results & Collect Statistics Overhaul

A staged plan to rework the bottom two stages of TinkerSim so they reuse the EDA
plotting primitives and shift Collect Statistics from a formula-builder to a
"pick the statistic you can already see" workflow.

## Vision

1. **Sample Results** should look and behave like the EDA window: **data table on
   the left, interactive plot on the right**. New draws append to the **bottom** of
   the table (chronological), not the top.
2. **Collect Statistics** should let students build a sampling distribution by
   **selecting statistics that are already visible in the Sample Results plot**
   (mean, median, SD, Q1/Q3, proportion, slope, …) rather than encoding a formula in
   dropdown pseudocode. Each selected statistic becomes a **column** in a Collect
   Statistics data table; every sampler run appends the statistic values for that
   sample as a new row. A **plotting window** on the right shows the sampling
   distribution of a chosen column, with a new **divider tool** for reading off
   proportions in a range.

Pedagogical intent: students explore and play with a sample first, decide which
statistic matters by seeing it on the plot, and only then promote it to a tracked
sampling distribution — no need to know formula syntax up front.

## Guiding constraints (from CLAUDE.md — do not regress)

- **Shared draw logic.** Both the per-run accumulation and the batch "collect N"
  shortcut must draw through `makeDrawState` / `drawStacks` / `drawMixer`. Never
  reimplement the draw loop (this previously caused a without-replacement bug).
- **Reuse, don't duplicate, plotting primitives.** This overhaul is the moment to
  extract the EDA plot's scales + dot-stacking so `EDAPlot`, Sample Results, and the
  sampling-distribution plot share one implementation (currently split across
  `EDAPlot`, `DotPlot`, `StatDistPlot`).
- **Quantiles** stay on the interpolating `quantile()` in both `computeStat` and
  `numericSummary`.
- **Plots fit vertically** — keep the "tallest column first, then shrink
  `dotSpacing`" pattern.
- Named React hook imports only; no `<foreignObject>`/`xmlns=` in SVG; shared style
  consts stay near the top.
- Stay dependency-light (no chart lib, no state lib).

## Current state (baseline)

| Concern | Where | Notes |
|---|---|---|
| Sample Results layout | `App.jsx` ~2371–2402 | Plot **left** (`DotPlot`, flex 2), table **right** (flex 1). Table uses `sampleData.slice(-60).reverse()` → newest on **top**. |
| Sample plot | `DotPlot` ~1010 | X/Y/Color/dot-size selectors, dot-stacking, **no** stat overlays. |
| EDA plot | `EDAPlot` ~1400 | Rich: numeric/time/categorical scales, box/mean/SD/LS overlays, responsive width, value labels. The target primitive to reuse. |
| EDA data table | `DataTable` ~1678 | Left-aligned table, sticky header, column highlight — the layout to mirror. |
| Collect UI | `App.jsx` ~2404–2449 | `StatDefiner` dropdown rows → `computeStat` → `distributions[id]` arrays → `StatDistPlot` per stat. |
| Stat engine | `computeStat` ~1120, `statLabel` ~1146, `FN_OPTS` ~1152 | Supports count/countVal/proportion/mean/median/min/max/q1/q3/slope/intercept with optional conditional filter. **Keep the engine; replace the UI that builds the stat spec.** |
| Collect loop | `doCollect` ~2226 | Chunked `requestAnimationFrame` loop; already uses the shared draw helpers. Good template for the batch path. |
| Dist plot | `StatDistPlot` ~1183 | Small dot plot + mean line. To be replaced by the shared plot + divider. |

## Target design

### Sample Results
- Two-column flex: `DataTable`-style table **left**, plot **right** (mirror EDA).
- Table appends newest rows at the **bottom**; auto-scroll to bottom on new draw.
- Plot is the unified EDA plot component with overlay toggles (mean/median/SD/
  box/LS/values), driven by the sample's variables — **univariate and bivariate**.
- Each overlay that resolves to a scalar statistic exposes an **"＋ track"**
  affordance (chip or click target) that promotes it into Collect Statistics. The
  plot's variable selection is what determines whether the stat is unconditional or
  conditional:
  - **Univariate numeric** → mean / median / SD / Q1 / Q3 / min / max of that var.
  - **cat × cat** → **conditional proportion** of one outcome given the other
    (`proportion` + `condVar`/`condVal`), promoted from a clicked cell.
  - **num × cat** → a numeric stat **for a specific group** (e.g. group mean =
    `mean` + `condVar`/`condVal`), promoted from a clicked group's overlay.
  - **num × num** → **LS line**, with separate "＋ track slope" / "＋ track
    intercept" affordances on the fitted line.

### Collect Statistics
- **Tracked-statistic columns** replace `StatDefiner` rows. A tracked column is a
  `{ id, fn, variable, variable2?, target?, condVar?, condVal? }` spec — the same
  shape `computeStat` already consumes, just authored by selection instead of
  dropdowns. `statLabel` still names the column.
- A **Collect Statistics data table** (left): one column per tracked statistic, one
  row per repetition. Persistent/accumulating across runs.
- **Accumulation paths (both via shared draw helpers):**
  1. *Per-run (always on)*: **every** "Draw Sample" auto-appends one row = each
     tracked stat computed on that sample.
  2. *Batch*: "Collect 500" appends 500 rows at once via the internal draw loop
     (the `doCollect` pattern). Default batch size 500.
- **Persistence & invalidation warnings.** The accumulated rows ("results") are
  distinct from the tracked-stat **columns** ("variables"):
  - **Sample-size change** → warn that it **clears the results** (accumulated rows)
    but **keeps the tracked columns**. A distribution at n=10 must not be mixed with
    one at n=20.
  - **Sampler/pipeline change** (editing or removing a device) → warn that it
    **deletes existing statistics in the table** (results), and any tracked column
    referencing a removed variable is dropped along with it.
- **Sampling-distribution plot** (right): the unified plot over one selected stat
  column, with the **divider tool**.

### Divider tool (new)
- Lives on the **shared `Plot` primitive**, so it is available anywhere a numeric
  distribution is shown — EDA, Sample Results, and the Collect Statistics
  distribution plot — not just Collect Statistics. Off by default; toggled on.
- **Availability gate (only where a continuous numeric axis exists):**
  - ✅ univariate numeric (dot plot along an x-axis);
  - ✅ num × cat side-by-side distributions (`SplitDotPlots`) — see multi-group note;
  - ❌ cat × cat grid and univariate categorical (`UniCatPlot`) — no continuous axis;
  - ❌ num × num scatter — **deferred** (a vertical divider reads as a statement
    about x alone, which is more confusing than useful here).
  - The Collect Statistics distribution plot is univariate numeric by construction,
    so the tool always applies there.
- Overlay on the plot's x-axis. Draggable handles (pointer events) **and** numeric
  inputs for exact values.
- **Single mode:** one divider → shades two regions, shows P(< v) and P(≥ v).
- **Range mode:** two dividers → shows P(< lo), P(lo–hi), P(> hi).
- Proportions computed from the plotted values (count on each side ÷ n).
- **num × cat multi-group:** one shared divider line across all groups, with
  **per-group** proportion read-outs at the same cutoff (compare "% above v" between
  groups) plus an overall read-out.

## Phased task breakdown

Each phase is independently shippable; verify with `npm run dev` after each.

### Phase 0 — Module split + extract the shared plot primitive (enabler)
Do the `components/` + `lib/` split now, as part of this phase.
- [x] Stand up `src/lib/` and `src/components/`. Keep named-hook React imports and
      shared style consts; export the style consts (`iSm`, `btnX`, `Sel`, …) from a
      shared module so import order can't reintroduce the "const not hoisted" bug.
      → `src/lib/styles.js`.
- [x] Move pure helpers to `src/lib/`: `parseCSV`, `isNumericColumn`/`colKind`,
      `quantile`, `numericSummary`, `lsFit`, `computeStat`/`statLabel`, and the shared
      draw helpers `makeDrawState`/`drawStacks`/`drawMixer`/`sampleSpinner`.
      → `lib/util.js`, `lib/stats.js`, `lib/sampling.js`, `lib/hooks.js`.
- [x] Move components to `src/components/` (`EDAPlot`, `CatCatGrid`, `SplitDotPlots`,
      `DotPlot`, `StatDistPlot`, `DeviceCard` + device cards, `DataTable`, …).
      → `components/ui.jsx`, `components/devices.jsx`, `components/plots.jsx`.
- [x] Extract the EDA plot's scale builder (`makeScale`) and dot-stacking
      (tallest-column → `dotSpacing`) into `src/lib/` so all plots share them.
      → `lib/scale.js`; `DotPlot`, `StatDistPlot`, `EDAPlot` all re-pointed at it,
      verified pixel-identical (univariate, scatter+LS, sample dot plot).
- [→] Factor a `Plot` component that takes `{ rows, headers, xVar, yVar, overlays,
      width, onTrackStat? }` so EDA, Sample Results, and the distribution plot can all
      mount it; re-point `EDAPlot` at it. **Deferred to the start of Phase 1** so the
      prop boundary is designed against a real second consumer (Sample Results)
      instead of guessed against EDA alone.
- [x] **Module split + shared primitives done:** production build passes; app mounts
      with no console errors; the scale/dot-stacking duplication is gone. The unified
      `Plot` component is the one remaining Phase 0 item, folded into Phase 1 below.

### Phase 1 — Sample Results layout flip (+ extract the `Plot` component)
- [ ] **Factor the `Plot` component** (controls + plot body, no bundled data table)
      out of `EDAPlot`, designed against both EDA and Sample Results as consumers.
      Re-point `EDAPlot` at it; the data table stays composed alongside by each
      context. (This is the carried-over second half of Phase 0.)
- [ ] Swap the flex order: table left, plot right.
- [ ] Append new rows to the **bottom**; drop the `.reverse()`; auto-scroll table to
      bottom as draws stream in.
- [ ] Replace `DotPlot` usage with the shared plot component (overlay toggles
      available).
- [ ] **Done when:** Drawing a sample fills the table top→bottom and the plot
      matches EDA styling.

### Phase 2 — Tracked-statistic data model
- [ ] Add `trackedStats` state (array of stat specs) + a `collectRows` accumulator
      (array of rows keyed by stat id).
- [ ] Implement "＋ track" from a Sample Results overlay → push a stat spec
      (dedupe by `statLabel`). Cover all authoring modes:
      - univariate numeric overlay → unconditional stat;
      - cat × cat cell → conditional proportion (`condVar`/`condVal`);
      - num × cat group → conditional numeric stat (`condVar`/`condVal`);
      - num × num LS line → slope / intercept (`variable2`).
- [ ] Render the **Collect Statistics data table** from `collectRows` (mirror
      `DataTable`): one column per tracked stat, remove-column control.
- [ ] **Done when:** Selecting any overlay/cell/line adds the correctly-scoped
      column; removing it drops the column.

### Phase 3 — Accumulation wiring + invalidation guards
- [ ] Per-run (always on): on each "Draw Sample" completion, compute every tracked
      stat on the finished sample (`computeStat`) and append one row to
      `collectRows`.
- [ ] Batch: "Collect N" (default 500) runs the internal draw loop (reuse the
      `doCollect` chunked-rAF pattern + shared draw helpers) and appends N rows.
- [ ] **Sample-size change guard:** intercept `setSampleSize`; if `collectRows` is
      non-empty, confirm "this clears collected results (columns kept)" → clear rows,
      keep `trackedStats`.
- [ ] **Pipeline change guard:** intercept device edit/remove; if it changes/removes
      a variable any tracked stat depends on, confirm "this deletes existing
      statistics in the table" → clear rows and drop now-invalid columns.
- [ ] Manual clear/reset control for the accumulator.
- [ ] **Done when:** Both paths grow the same table, the two guards fire correctly,
      and behavior never diverges in with/without-replacement counting.

### Phase 4 — Sampling-distribution plot
- [ ] Column selector → render the shared plot over that stat column.
- [ ] Reuse overlay toggles (mean/SD/etc.) on the distribution.
- [ ] Retire `StatDistPlot` once parity is reached.
- [ ] **Done when:** Each tracked column can be plotted with EDA-grade styling.

### Phase 5 — Divider tool (shared-plot feature, gated to numeric axes)
- [ ] Add the divider as an opt-in feature of the shared `Plot`, with the
      availability gate (univariate numeric and num × cat only; hidden otherwise).
- [ ] Single-divider overlay: draggable vertical line + numeric input; shade two
      regions; display P(< v) / P(≥ v).
- [ ] Range mode toggle: second handle; display P(< lo) / P(lo–hi) / P(> hi).
- [ ] Pointer-event drag with snap-to-value and clamping to the axis domain; keep
      input and handle in sync.
- [ ] num × cat case: one shared divider across groups → per-group + overall
      proportion read-outs.
- [ ] **Done when:** the tool appears only on numeric-axis plots, and dragging or
      typing a value updates the shaded regions and proportion read-outs live
      (including per-group on side-by-side distributions).

### Phase 6 — Cleanup & retirement
- [ ] Remove `StatDefiner`, `FN_OPTS`-driven dropdown UI, and `DotPlot`/
      `StatDistPlot` if fully superseded (keep `computeStat`/`statLabel`).
- [ ] Update CLAUDE.md architecture notes + "next steps".
- [ ] Final pass: verify every device (Stacks w/ & w/o replacement, Mixer, Spinner)
      feeds both accumulation paths correctly.

## Resolved decisions

1. **Conditional filters & bivariate stats — keep, authored by plotting two
   variables.** A conditional stat is created by selecting a two-variable plot, not a
   filter dropdown: cat × cat → conditional proportion of one outcome given the
   other; num × cat → a numeric stat for a specific group. The **LS line stays**,
   with separate affordances to track its **slope** or **intercept**. (Maps onto the
   existing `computeStat` spec: `condVar`/`condVal` for conditioning, `variable2` for
   LS.)
2. **Accumulator invalidation, with warnings.** Sample-size change → warn and
   **clear results, keep the tracked columns**. Sampler/device change (incl. removing
   a device) → warn and **delete the table's statistics**; columns referencing a
   removed variable are dropped.
3. **Per-run auto-tracking is always on.** Every "Draw Sample" auto-appends a row to
   the Collect Statistics table.
4. **Do the `components/` + `lib/` split now**, as part of Phase 0 (see updated
   Phase 0 tasks).
