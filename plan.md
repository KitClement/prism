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
- [x] Factor a `Plot` component (controls + plot body, no bundled table) so EDA,
      Sample Results, and the distribution plot can all mount it; re-pointed `EDAPlot`
      at it. Final boundary: `{ rows, headers, xVar, yVar, setXVar, setYVar, width? }`
      — X/Y are *controlled* so a sibling data table can highlight the selected
      columns; dot size + overlay toggles are Plot-local state. Done as part of Phase 1
      against the real second consumer (Sample Results).
- [x] **Module split + shared primitives done:** production build passes; app mounts
      with no console errors; the scale/dot-stacking duplication is gone. The unified
      `Plot` component is the one remaining Phase 0 item, folded into Phase 1 below.

### Phase 1 — Sample Results layout flip (+ extract the `Plot` component) ✅
- [x] **Factor the `Plot` component** (controls + plot body, no bundled data table)
      out of `EDAPlot`, designed against both EDA and Sample Results as consumers.
      Re-pointed `EDAPlot` at it; the data table stays composed alongside by each
      context. (This is the carried-over second half of Phase 0.) → `Plot` in
      `components/plots.jsx`.
- [x] Swap the flex order: table left, plot right. New `SampleResults` component
      mirrors the EDA layout (table left, `Plot` right).
- [x] Append new rows to the **bottom**; dropped the `.reverse()`; the table scroll
      view auto-follows to the bottom as draws stream in (caps the rendered rows at
      the last 200 for perf).
- [x] Replaced `DotPlot` usage with the shared `Plot` (overlay toggles available);
      removed the now-dead `DotPlot`.
- [x] **Done:** verified in `npm run dev` — a draw fills the table top→bottom
      (# ascending, newest at bottom, auto-scrolled), table sits left of the plot,
      EDA still renders (table left + SVG plot right, Mean overlay works), production
      build passes, no console errors.

### Phase 2 — Tracked-statistic data model ✅
- [x] Add `trackedStats` state (array of stat specs) + a `collectRows` accumulator
      (array of rows keyed by stat id). → `App.jsx`; `trackStat` dedupes by
      `statLabel`, `untrackStat` drops a column. `collectRows` stays empty until
      Phase 3 wires accumulation.
- [x] Implement tracking from a Sample Results plot → toggle a stat spec (add, or
      remove if the same `statLabel` is already tracked). **Interaction (revised):
      click the number that shows the statistic on the plot** — no chips. Principle:
      *only a statistic whose number is currently visible can be collected* ("why
      track a number the student hasn't seen?"). Gated on the optional `onTrackStat`
      prop, so EDA shows no track UI and renders identically. Helpers `TrackText`
      (SVG) / `CatNum` (HTML) turn a value into a click-to-toggle button. Modes:
      - univariate numeric → click the mean / median / SD value labels (overlay
        values are force-shown in Sample Results, so the "Show values" toggle is
        hidden there);
      - cat × cat → click a cell's **count** (→ `countVal`) or **percent**
        (→ `proportion`) number, each conditioned on the cell (`condVar`/`condVal`);
        gated by the Count/Percent toggles (neither on ⇒ nothing collectable);
      - uni-cat → click a section's count/percent number (unconditional);
      - num × cat group → click a group's mean / median / SD value
        (`condVar`/`condVal`);
      - num × num LS line → click the slope / intercept value (`variable2`).
      - OTHER/collapsed buckets stay non-clickable (no clean target).
      - Added an `sd` case to `computeStat`/`statLabel`/`FN_OPTS` (population SD,
        matching `numericSummary`) so SD is trackable. Q1/Q3/min/max are not
        click-trackable (not shown as standalone numbers).
- [x] Render the **Collect Statistics data table** from `collectRows` (mirror
      `DataTable`): `CollectTable` — one column per tracked stat (named by
      `statLabel`), per-column remove (×) control. Legacy `StatDefiner` UI kept
      below for now (retired in Phase 7).
- [x] **Done when:** Clicking any plot number adds the correctly-scoped column;
      clicking it again (or the table's × ) drops it. **Verified** in `npm run dev`
      across uni-cat, cat × cat, univariate numeric, num × cat, and num × num: each
      number adds the right `statLabel` column, clicking a tracked number toggles it
      off, the no-stats-enabled gate hides all targets, OTHER buckets are inert, no
      console errors; production build passes.

### Phase 3 — Accumulation wiring + invalidation guards ✅
- [x] Per-run (always on): `doSample`'s `onDone` computes every tracked stat on the
      finished sample (`computeStat`) and appends one row to `collectRows` (skipped
      if the run was cancelled). `trackedStats` added to the `useCallback` deps so the
      closure stays fresh.
- [x] **Seed the current sample immediately.** A finished draw is stashed as
      `currentSample = { id, rows }` and its `collectRows` row is tagged with that id.
      Clicking **track** then seeds the value from the *already-drawn* sample at once
      (its number is on the plot now) instead of waiting for the next run: tracking
      updates the current sample's row in place, or creates it if nothing was tracked
      when the sample was drawn. Batch/guard clears also reset `currentSample`.
- [x] Batch: "Collect N" (default 500, `batchSize`) → `doCollectTracked` runs the
      chunked-rAF loop and appends N rows. Extracted a shared, non-animated
      `drawSample(pipeline, sampleSize)` into `lib/sampling.js` (built on
      `makeDrawState`/`drawStacks`/`drawMixer`) and re-pointed **both** `doCollect`
      (legacy) and `doCollectTracked` at it, so the with/without-replacement counting
      cannot diverge between paths.
- [x] **Sample-size change guard:** `changeSampleSize` intercepts the `n=` input; if
      `collectRows` is non-empty, confirms → clears rows, keeps `trackedStats`.
- [x] **Pipeline change guard:** `updDevice`/`remDevice` intercept edit/remove. The
      edit guard fires only on a *distribution-structure* change — `samplingShape`
      fingerprints by stable outcome **id** + count/pct/with-replacement, so it ignores
      pure relabelings and colors — to a device a tracked stat depends on; remove fires
      when a dependent column exists. On confirm → clear rows and drop columns whose
      referenced vars no longer exist (`statVarsValid`).
- [x] **Seamless rename propagation (no warning).** `propagateRenames` rewrites tracked
      specs when an edit only renames things: a device's `varName` → updates every
      `variable`/`variable2`/`condVar` that referenced it; an outcome **label** (matched
      by stable id, scoped to that device's own var) → updates `target`/`condVal`. The
      column header (`statLabel`) and future draws follow the new names while collected
      rows stay (a count is the same number whatever the label is called). Runs on every
      edit, so renames never warn; only real distribution changes do.
- [x] Declined guards call `rejectEdit` (bumps a tick) to force a re-render so the
      controlled input (n box / device fields) snaps back to its unchanged value.
- [x] Manual clear/reset control: "✕ Clear" button next to the batch controls
      (confirms, then `clearCollected`); "⬇ CSV" exports `collectRows`.
- [x] **Done:** verified in `npm run dev` (instant speed, default Stacks): tracking a
      stat seeds the just-drawn sample's value as row 1 immediately, and a second stat
      from the same sample fills the same row; per-run appends one row per later draw;
      "Collect 500" appends 500 (table caps shown at 200, mean count ≈ expected);
      renaming the device var (`stk1`→`coin`) and an outcome (`a`→`heads`) update the
      column headers with **no** warning and keep the rows, and subsequent draws compute
      correctly under the new names; a count edit still warns; sample-size guard cancel
      keeps rows + snaps n back, accept clears rows + keeps the column; device-edit guard
      same; device-remove accept clears rows + drops the dependent column; no console
      errors (incl. the now-empty pipeline); production build passes.

### Phase 4 — Sampling-distribution plot ✅
- [x] Column selector → render the shared plot over that stat column. New
      `DistributionPlot` ({ columns:[{ label, values }], width? }) transforms the
      collected per-column values into the shared `Plot`'s `{ rows, headers }` shape;
      the Plot's **X selector doubles as the column selector** (and Y enables a scatter
      of two collected stats for free). Non-finite values (e.g. an empty group in a
      small/without-replacement sample) become blank so the plot skips them; repeated
      labels are disambiguated into distinct headers. → `components/plots.jsx`.
- [x] Reuse overlay toggles (mean/SD/etc.) on the distribution — they come from the
      shared `Plot` unchanged (box/mean/±SD/values for the univariate numeric column).
- [x] Retire `StatDistPlot`: removed the small-multiples component and re-pointed **both**
      consumers at `DistributionPlot` — the tracked-stat section (table left, plot right)
      and the legacy "define statistics manually" section. Dropped the now-unused
      `StatDistPlot` import + `STAT_COLORS`.
- [x] **Done:** verified in `npm run dev` (instant speed, default Stacks): tracking
      `count(stk1="a")` seeds row 1 and the distribution plot appears with the stat as the
      selectable X column; further draws append rows and the plot's dot count tracks them;
      toggling **△ Mean** draws the mean triangle on the distribution with the column as the
      axis title; the legacy manual path collects 500 reps and renders the same
      `DistributionPlot` (`prop(stk1="a")`, 500 dots); production build passes, no console
      errors.

### Phase 5 — Derived-statistic calculator (build statistics from collected columns) ✅
Goal: let students **assemble new statistics from the columns they have already
collected**, rather than shipping canned formulas. A difference in means/proportions is
a short formula; an informal ANOVA-style total-variation statistic is a longer one the
student builds themselves (collect each group mean + the overall mean, then
`(mean(x|g="a") − m)^2 + (mean(x|g="b") − m)^2 + …`). No pre-built between/within button.
Depends only on Phase 4 (so a derived column inherits the distribution plot); the divider
tool (now Phase 6) then applies to derived columns for free, in either build order.
**Phase 6 depends on this phase:** the ruler tool's trackable difference-in-means is a
derived column authored by this model, so Phase 5 lands first.

- [x] **Derived column model.** A new tracked-column kind
      `{ id, kind:"derived", tokens, inputs:[statId…] }` lives in the same `trackedStats`
      array (so it is a column in `CollectTable` + `DistributionPlot` for free). Plain
      tracked stats stay `kind:"stat"` (or absent). `computeStat` is unchanged; derived
      values come from the new `evalExpr` token evaluator. (Used a *token array* rather
      than an `expr` string — the click-to-insert UI builds tokens directly, so there is
      no lexing/ambiguity against verbose labels.)
- [x] **Backfill for free.** `addDerivedStat` maps `evalExpr` over every existing
      `collectRows` row the instant the column is defined — no re-sampling. Both
      accumulation paths compute derived columns alongside plain ones via the shared
      `computeStatRow` (two-pass: plain stats, then derived over those values).
- [x] **Expression engine (dependency-light, ~120 lines).** `lib/expr.js` — a hand-rolled
      recursive-descent evaluator over a token array: column refs, operators `+ − × ÷ ^`
      (right-assoc `^`) and unary minus, parentheses, and `sqrt`/`abs`. Pure, no library.
      A missing operand propagates NaN. `validateExpr` gates the Add button on structural
      validity (balanced, no missing operands, no trailing tokens).
- [x] **Typed expression field with alias chips (revised from chips-only).** The
      authoring surface is an editable text input the student types into freely
      (`(A − M)^2 + (B − M)^2`), using short uppercase **aliases** for columns; `lexExpr`
      tokenises it (normalising unicode `− × ÷`, case-insensitive aliases, `sqrt`/`abs`).
      Column chips now **insert their alias at the caret** as a shortcut, with the full
      `statLabel` shown beside each. Live preview + a parse-error message gate the Add
      button. *Why the change:* only column references are hard to type (verbose labels
      with parens/quotes); aliases make them a single safe token, so operators and
      especially numeric constants are far easier typed than clicked.
- [x] **Optional column name (added on request).** The builder has an optional **Name**
      field; a derived spec carries `name?` and `colLabel` shows it when set, otherwise the
      formula (`exprLabel`). The name flows to the table header, distribution-plot column
      selector, and CSV export; the table header keeps the full formula as a `title`
      tooltip so a short name never hides what the column computes. Tokens/ids still drive
      everything else, so evaluation/backfill/invalidation are unchanged.
- [x] **Partial-sample honesty.** `evalExpr` returns NaN when any referenced operand is
      missing/blank in a row; `CollectTable` renders NaN as `—` (and the distribution
      plot skips it) rather than coercing to 0.
- [x] **Dependency invalidation.** `dropDependents` cascade-removes any derived column
      whose `inputs` reference a removed stat id; wired into `untrackStat` (manual remove)
      and `dropInvalid` (the Phase 3 sampler-change/remove guards) so a derived column dies
      with its operands.
- [x] **Done:** verified in `npm run dev` (instant speed, default Stacks). Engine +
      lexer unit-tested against the live bundled module (difference, nested ANOVA
      `(A−M)^2+(B−M)^2`, right-assoc `^`, unary minus, `sqrt`/`abs`, precedence, NaN
      propagation, validation/lex-error gates, unicode operators, case-insensitive
      aliases, `aliasFor` rollover A→Z→AA, `colLabel`, `computeStatRow`). E2E: tracked two
      counts → **typed** `(A + B) / 2` (live preview 5) and `(A − B)^2` → derived column
      labelled with full expressions and backfilled (rows `(4−6)²=4`, `(7−3)²=16`,
      including per-run accumulation on a later draw); chips insert aliases at the caret;
      invalid input shows "incomplete"/"unrecognised symbol" and disables Add; the derived
      column is selectable in the distribution plot; removing operand `count(stk1="a")`
      cascade-dropped the derived column; no fresh console errors; production build passes.

### Phase 6 — Plot measurement tools (divider + ruler)
Two **independent user-facing tools** built on **one shared measurement-overlay
foundation** in the shared `Plot`. Stays **after Phase 5**: a trackable ruler
*difference* (`mean(A) − mean(B)`) is representable only as a Phase 5 **derived column**
(`computeStat` returns a single scalar and cannot express a difference), so the ruler's
"＋ track" affordance reuses the Phase 5 model + evaluator rather than a second mechanism.
The ruler's residual case also fills the num × num gap the divider deliberately defers.

**6a — Shared measurement-overlay foundation (build once).** ✅ (divider scope)
- [x] Draggable handle primitive (pointer events + capture, clamp to axis domain) on the
      shared `Plot`. → `DividerLines` in `components/plots.jsx`, mounted inside each host's
      `<svg>`; the host supplies the value↔pixel pair (`sx` from `xS.scale` / a linear
      `inv`). clientX→svg-attribute px corrected by `W / rect.width` for the
      `maxWidth:100%` down-scaling. → `lib/measure.js#clampVal`.
- [x] Snap helper: snaps to data dots + currently-visible measures (mean when △ on;
      median/Q1/Q3 when 📦 on; per-group means in `SplitDotPlots`), free otherwise,
      within an ~8 px radius. → `lib/measure.js#snapValue`. No stats-engine changes.
      (lsFit-line snapping is deferred with the ruler's residual case.)
- [x] Numeric input bound to each handle (typed value ⇄ handle stay in sync via shared
      `divCuts`). → `Plot`'s divider control row.
- [x] Read-out box component. → `MeasureReadout` (region rows + optional per-group table).
- [x] Availability gate: continuous numeric **X** axis ⇒ tool offered (univariate numeric;
      num × cat with numeric on X). Hidden on cat × cat, uni-cat, num × num **scatter**
      (deferred), and num × cat with numeric on **Y** (vertical, one-geometry deferral).
      → `Plot#dividerAvailable`. num × num for the ruler is part of 6c (next PR).

**6b — Divider tool** (opt-in, gated to numeric axes). ✅
- [x] Single-divider overlay: draggable vertical line + numeric input; shades the two
      regions; displays P(< v) / P(≥ v). → `lib/measure.js#regions`.
- [x] Range mode toggle: second handle; shades the middle band; displays
      P(< lo) / P(lo–hi) / P(> hi) (boundaries inclusive in the middle band).
- [x] num × cat case: one shared divider across all group bands → per-group proportion
      read-outs, rendered **on each group's band** (not a side box).
- [x] **On-plot read-outs (UX revision).** The read-out box was dropped: instead the cut
      **value** sits directly above the handle, and each region's **count / proportion**
      renders at the top of the plot, centered in that region's span — toggled by divider
      **# Count / % Proportion** checkboxes (off by default, like the categorical # / %).
- [x] **Collectable region read-outs (Sample Results).** Each on-plot count / proportion
      is a click-to-track target there (plain text in EDA / the distribution plot). Added
      `countBetween` / `propBetween` to `computeStat` + `statLabel` (a numeric region with
      per-side open/closed bounds, optional `condVar` for num × cat groups), authored by
      `regionSpec` from a `measure.js` region. They flow through the existing
      per-run/batch/derived/CSV machinery unchanged; **not** added to `FN_OPTS` (only the
      divider authors them).
- [x] **Done:** verified in `npm run dev` against EDA data (no sampling needed): univariate
      readout P(<8.01)=0.500·60/120 matches an independent recompute; typing 5 → 21/120;
      range mode three regions (29+63+28=120); num × cat per-group P(<5) = a 0.500 / b 0.025
      / c 0.000 all match; drag grabs (line thickens), tracks the pointer, snaps to dots,
      correct direction; gates hide the toggle on cat × cat / uni-cat / scatter and show it
      on univariate numeric; the **distribution plot** (headline) offers the divider on its
      stat column; `measure.js` unit-tested 18/18; production build passes; no console
      errors. Batch "Collect N" couldn't be exercised (background-tab rAF throttling, a
      harness artifact — path unchanged from Phase 3/4).
- [x] **On-plot/collectable revision verified** in `npm run dev`: value label sits above
      the handle (8.01); count/proportion render centered in each region (x = exact region
      midpoints 156/356) and are off until toggled; range mode shows three centered labels;
      num × cat shows per-group region labels on each band; `countBetween`/`propBetween`
      unit-tested 11/11. Sample Results E2E: clicking `prop(stk1 < 5)` adds the column,
      seeds the current sample (0.4 = the on-plot 40%), marks the number tracked, and a
      further draw appends a row (0.4, 0.5); production build passes. (The transient
      `cx=NaN` dot warnings seen during testing were a pre-existing dot-plot issue with a
      mixed-type column — a Mixer whose paste appended numbers to its default `a` ball —
      not from the divider, which renders only lines/rects/text.)

**6c — Ruler tool** (opt-in, three mechanics).
- [ ] **Axis distance** — univariate numeric & num × cat groups: two endpoints, each
      snappable to a constant / dot / measure; read-out shows the signed distance.
      Difference-in-group-means is the headline num × cat case (endpoints snap to each
      group mean).
- [ ] **Residual to LS line** — num × num scatter: one endpoint snaps to a data point,
      the other to its vertical foot on the `ls` line; read-out shows `y − ŷ`.
- [ ] **Difference of two measures** — cat × cat percentages (and any two clicked scalar
      measures): not an axis measurement; select two computed numbers (reuse the `CatNum`
      cell-number targets) and show their difference.
- [ ] **Trackable read-out (ruler only).** A "＋ track" affordance reuses
      `onTrackStat`/`addTrackedStat`: it auto-creates the two operand stat specs (if not
      already tracked) plus a Phase 5 derived column `expr = A − B` (or `A − constant`),
      which backfills existing rows and plots via `DistributionPlot`. The residual case
      is visual-only at first (the measured point has no stable cross-repetition
      identity) — defer its trackability.
- [ ] **Done when:** both tools appear only on gated plots and operate independently; the
      ruler measures all three cases live (drag + typed value stay in sync); a tracked
      difference-in-means backfills as a derived column and plots on the distribution plot.

### Phase 7 — Cleanup & retirement
- [x] **Consolidated to one workflow (done early, post-Phase 4).** Removed the separate
      "define statistics manually" pipeline (`doCollect`, `distributions`, `repetitions`,
      and its own Collect button / distribution render). `StatDefiner` is kept but
      repurposed: it lives behind a **"Define a statistic manually" toggle** (hidden by
      default, off the typical click-a-number path) and its **＋ Add to table** button
      calls the shared `addTrackedStat` so a manually-built spec becomes a tracked column
      in the same Collect Statistics table (per-run + batch accumulation, shared
      `DistributionPlot`). Extracted `addTrackedStat` (add + seed current sample) out of
      `trackStat` so both entry points share it. `StatDistPlot` already retired in Phase 4.
- [ ] Optionally retire `StatDefiner` + `FN_OPTS` dropdowns entirely if the
      click-to-track path fully covers authoring (keep `computeStat`/`statLabel`).
- [ ] Update CLAUDE.md architecture notes + "next steps" (incl. documenting the divider
      and ruler as the two plot measurement tools in the plot section).
- [ ] Final pass: verify every device (Stacks w/ & w/o replacement, Mixer, Spinner)
      feeds both accumulation paths correctly.

## Known issues / next focus

### Numeric-vs-categorical detection for sampler variables (BUG + design change)
**Status:** open, to be tackled in a fresh chat. Surfaced while verifying the Phase 6
divider; **not** caused by it.

**Symptom.** A column that is *mostly* numeric but has some non-numeric values renders
dots at NaN positions in the shared `Plot` — React warns `Received NaN for the `cx`
attribute` and the offending dots are invisible. Repro: a Mixer whose `📋 paste` **appends**
numeric balls to its default `a` ball (see `MixerCard`'s `onApply` in
`src/components/devices.jsx` ~line 610), then plot that variable; or an EDA CSV with a
stray text cell in a numeric column.

**Root cause.** `colKind` in `src/lib/util.js` classifies a column **numeric when ≥80% of
values parse as numbers** (`numCount / vals.length >= 0.8`). When numeric, `Plot`
(`src/components/plots.jsx`, MODE 4 / scatter) maps every dot via `xS.scale(r[xVar])`,
but the `valid` filter only drops **empty** xVar cells, not non-numeric ones — so the up
to 20% non-numeric values become `toNum(...) → NaN → scale → NaN → <circle cx={NaN}>`.

**Two layers to fix:**
1. *Immediate (tracked separately, low-risk):* when building dot positions for a numeric
   axis, also skip rows whose value isn't a finite number via `toNum` (so a stray
   non-numeric cell is omitted, not drawn at NaN). Applies to `Plot` MODE 4 and the
   `SplitDotPlots` numeric filtering.
2. *Design change (the real ask):* a sampler variable should be **classified num/cat from
   the sampler's possible outcomes up front**, before any sample is plotted — not
   re-inferred per sample. Otherwise a first all-numeric sample sets up numeric plots +
   tracked stats, and a later draw of a rare non-numeric outcome silently breaks them.
   - Preferred direction: derive each device's variable kind from its **declared
     outcomes** (Stacks `items[].label`, Mixer `balls[].label`, Spinner `slices[].label`)
     — e.g. a device's var is categorical if *any* declared outcome is non-numeric — and
     thread that kind through Sample Results / Collect plots instead of calling `colKind`
     on the drawn rows. The relevant constructors live in `src/lib/sampling.js`
     (`mkStacks`/`mkMixer`/`mkSpinner`); plots currently call `colKind(rows, col)`.
   - **EDA is exempt:** its data is a static user upload with no "future draws," so
     inferring kind from the rows there is fine — keep `colKind` for EDA, switch only the
     sampler-fed plots to outcome-based kinds.
   - Open questions for the new chat: where the kind is computed/stored (per-device on the
     pipeline? a `varKinds` map in `App`?); how a `Plot` consumer receives an authoritative
     kind vs. inferring it; whether a divider/stat already tracked on a now-categorical var
     should be dropped (reuse the Phase 3 invalidation guards).

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
