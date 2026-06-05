# TinkerSim — Quality-of-Life Roadmap

A backlog of small-to-medium improvements gathered after the Phase 0–7 work in
`plan.md` shipped. These are independent of each other; the phases below group them
by theme and rough effort, not by hard dependency. Each item notes the **symptom**,
the **root cause** (where known), the **files** involved, and a **proposed approach**.

Priority key: **P1** = correctness / data-loss bug, **P2** = clear UX friction,
**P3** = nice-to-have feature.

---

## Phase A — Device naming & identity (P1)

These three are related: they all stem from devices being identified by their
mutable `varName` rather than a stable id.

### A1. Default `stk1` breaks the auto-increment succession  ·  P2
- **Symptom.** The pipeline boots with one Stacks device named `stk1`
  (`[mkStacks(1)]`). Adding a second Stacks also produces `stk1`, because the
  add-counter never counted the seed device. Mixer/Spinner increment correctly
  (`mix1` → `mix2`) only because they have no seed device.
- **Root cause.** `devCounts` starts at `{}` (`src/App.jsx:26`); `addDevice`
  increments from 0, so the first added Stacks lands on 1 — colliding with the seed.
- **Files.** `src/App.jsx:26` (`devCounts` ref), `src/App.jsx:249-253` (`addDevice`),
  `src/lib/sampling.js:106` (`mkStacks` seeds `stk1`).
- **Approach.** Seed the counter to reflect the initial pipeline:
  `const devCounts = useRef({ stacks: 1 });` — or, more robustly, derive the next
  number from the current pipeline so manual renames can't desync it: scan
  `pipeline` for `^stk(\d+)$` (and `mix`, `spin`) and take `max + 1`. The
  pipeline-scan version is preferred because it also dodges collisions after a
  device is removed and re-added.

### A2. No protection against duplicate device names  ·  P1  ·  ✅ DONE
- **Symptom.** Two devices can share a `varName`. Because sample rows are keyed by
  name (see A3), two same-named devices collapse into one column and silently
  overwrite each other's draw — producing wrong variables with no warning.
- **Proposed behavior (from request).** When two or more devices share a name:
  1. Turn the offending name text-boxes' borders **red** to flag the collision.
  2. **Disable the "▶ Draw Sample" button** while any duplicate exists, so a
     malformed sample can't be drawn.
- **Files.** Name editing lives in `src/components/devices.jsx` (the `InlineEdit`
  on each device's `varName`, via `src/components/ui.jsx`). The Draw button and
  `doSample` are `src/App.jsx:410-412` / `:324`.
- **Approach.** Compute a `dupNames` set in `App` from
  `pipeline.map(d => d.varName)` (case-insensitive; trim). Pass a
  `isDuplicate` flag down to each `DeviceCard`/name input to drive the red border,
  and compute `const hasDupNames = dupNames.size > 0` to set `disabled` on the
  Draw button (mirror the existing `sampling` disable styling). Add a small inline
  hint ("rename — two devices share this name") near the button when blocked.
- **Note.** Empty/whitespace names should arguably be treated the same way
  (they'd key an unnamed column). Decide whether to fold that into this guard.
- **Pairs with A3.** The chosen id-keyed refactor (A3) already prevents two
  same-named devices from overwriting each other's column; this guard is the
  *user-facing* half (visibly flag the collision and block the draw). Do both in
  one branch.

### A3. Renaming a sampled device blanks its column in Sample Results  ·  P1  ·  ✅ DONE
- **Symptom.** Rename `mix1` → `mix10` after sampling: the Sample Results table
  header updates to `mix10`, but the cells go empty. The *tracked-stat* columns
  (Collect Statistics) follow the rename correctly; the **raw draw data** does not.
- **Root cause.** Raw sample rows are keyed by the device's `varName`
  (`row[dev.varName] = result` in `runAnimatedSample`, `src/lib/sampling.js:228`;
  same in the batch `drawSample`). `sampleData` / `currentSample.rows` therefore
  hold keys under the *old* name. `updDevice` calls `propagateRenames` only over
  `trackedStats` (`src/App.jsx:273, 294-296`); it never re-keys the existing
  `sampleData` rows, so the table reads the new name and finds nothing.
- **Files.** `src/lib/sampling.js:228` (row keying), `src/App.jsx:264-298`
  (`updDevice` / rename propagation), the Sample Results table/plot in
  `src/components/plots.jsx`.
- **Decision: key rows by stable device `id` (the durable refactor).** Devices
  already carry an immutable `id` (`uid()` in the `mk*` factories). Store draws as
  `row[dev.id] = result` and resolve the *display* name from `pipeline` at render
  time. This makes renames a pure presentation concern and **structurally prevents
  A2's silent-overwrite bug** (two same-named devices keep distinct id-keyed
  columns), so this item and A2 are best done together.
- **The invariant.** A drawn variable is identified by the device's stable `id`
  everywhere; `varName` becomes **display-only**, resolved through a single
  `nameOf = id → varName` map built from the current pipeline
  (`Object.fromEntries(pipeline.map(d => [d.id, d.varName]))`). A rename then mutates
  only that map — no stored data or spec changes.

#### Collect Statistics pipeline — full trace
The raw Sample Results table is the *easy* half. Tracked stats are harder because
the spec objects **store variable references**, and `statLabel` is overloaded as an
identity key. Walking the pipeline end to end:

- **Already id-safe — leave alone.** `collectRows` are keyed by **stat** id
  (`computeStatRow` does `row[s.id]`, `src/lib/expr.js:171`); derived-column tokens
  `{k:"col", id}` reference **stat** ids (`src/lib/expr.js:55`); every tracked stat
  already carries a stable `id`. None of this touches device identity, so it stays.
- **Draw rows → device id.** `row[dev.varName]` → `row[dev.id]` in
  `runAnimatedSample` (`src/lib/sampling.js:228`) and the batch `drawSample`.
- **Spec fields hold device ids, not names.** `stat.variable`, `stat.variable2`,
  `stat.condVar` must store the device **id**. Note the deliberate distinction:
  `stat.condVal` and `stat.target` are **outcome data values** (compared via
  `String(r[...])`), *not* device refs — they stay as-is.
- **`computeStat` is unaffected** once both sides agree: it reads `r[stat.variable]`
  / `r[stat.condVar]` / `r[stat.variable2]` (`src/lib/stats.js:55-75`); if the spec
  field and the row key are both device ids, the lookups just work.
- **Every spec-creation site must emit ids.** These all build `variable`/`condVar`/
  `variable2` from the plot's `xVar`/`yVar`/`catVar`/`numVar`, so those must become
  **ids** (the X/Y selectors operate on ids, display names): slope/intercept specs
  (`src/components/plots.jsx:868,871`), `DistributionPlot` base (`:149-150`),
  `CatCatGrid` base (`:1466`), `SplitDotPlots` `grpSpec`/ruler candidates/base
  (`:1523,1689-1693,1755`), and `StatDefiner`'s selectors (`:967-972` — show name,
  store id; its `allVals`/`condVals` at `:951-952` then read the row by id, which is
  correct).
- **`varNames` / `varKinds` re-key by id.** `varNames` (`src/App.jsx:228`) must
  carry id+name pairs (or a parallel name map); `varKinds` (`src/App.jsx:232-235`)
  keys by `d.id` instead of `d.varName`.
- **The `statLabel` overload — split identity from display (most important).**
  `statLabel` is used as a *key* for dedup and membership, not just for rendering:
  `addTrackedStat` dedup (`src/App.jsx:51`), `trackStat`/`untrackStatByLabel`
  (`:71-75`), `trackDifference` operand match (`:100-101`), the `trackedLabels` Set
  that greys already-tracked numbers on the plot (`src/components/plots.jsx:1158`),
  plot candidate matching (`:240,678-699`), and `data-mkey` measure snapping
  (`:44`). If `statLabel` starts resolving id→name, the label *string* changes on a
  rename, and any of these comparisons that straddle a rename gets fragile — and two
  devices momentarily sharing a name (the A2 case) would collide outright.
  **Fix:** introduce a stable `statKey(s)` serialized over **ids** (fn +
  variable-id + variable2-id + condVar-id + condVal + target + region bounds) and
  use it for *all* dedup/toggle/membership/`data-mkey` comparisons. Keep
  `statLabel(s, nameOf)` purely for display.
- **`statLabel` gains a `nameOf` arg.** `statLabel(s)` → `statLabel(s, nameOf)`
  (`src/lib/stats.js:100-106`); because `exprLabel`/`colLabel` call it
  (`src/lib/expr.js:154-164`), they thread `nameOf` too. Call sites: `labelFor`/
  `exprFor`/`operandCols` (`src/App.jsx:239,242,247`) and the plot label spots.
- **Validation guards switch to ids.** `statDependsOn` (`src/App.jsx:141-142`),
  `statVarsValid`/`dropInvalid` (`:146-150,174-177`), and `statKindInvalid`
  (`:155-158`) compare against `varName`; they compare device **ids** and check the
  live-id set / id-keyed `kinds` instead.
- **`propagateRenames` shrinks, doesn't vanish.** Its device-rename half
  (`src/App.jsx:211-214`) disappears — ids don't change on rename. Its
  **outcome-relabel half** (`:208-209`, remapping `target`/`condVal` when an outcome
  *label* changes) **must stay**, since those are data values stored in specs. Don't
  delete the whole function.
- **CSV export resolves ids → names.** `exportCSV` (`src/App.jsx:379`) serializes
  sample rows whose keys are now ids; map them through `nameOf` for the header line
  so downstream files stay human-readable.

- **Rollout.** This is the largest Phase-A item; give it its own short plan and do
  it in one branch so A2's protection rides along with it. Suggested commit order:
  (1) add `nameOf` + `statKey`, migrate identity comparisons off `statLabel` with
  *no* behavior change; (2) flip draw rows + spec fields + selectors to ids;
  (3) shrink `propagateRenames` and re-key the guards; (4) fix CSV export. Test the
  full Collect Statistics flow (click-to-track, manual `StatDefiner`, derived
  columns, batch "Collect N") across a device rename at each step.

---

## Phase B — Sampler interaction (P2)

### B1. Mixer paste appends; should replace (match Stacks)  ·  P2
- **Symptom.** Pasting a column into a **Mixer** keeps the existing balls and adds
  the pasted values on top; pasting into **Stacks** replaces all categories. The
  append behavior is surprising and bug-prone (stale balls linger in the data).
- **Root cause.** Stacks paste rebuilds `items` from the pasted values only
  (`src/components/devices.jsx:398-402`). Mixer paste spreads
  `[...device.balls, ...vals.map(...)]` (`src/components/devices.jsx:603-606`); the
  `… range` add (`:608-612`) appends by design and is separate.
- **Approach.** Change the Mixer's `PasteButton.onApply` to replace `balls`
  outright: `onChange({ ...device, balls: vals.map(...) })`. Leave the `… range`
  builder as an additive tool. Confirm the color-map logic still assigns one color
  per distinct label.

### B2. Speed slider should take effect live during a run  ·  P2
- **Symptom.** Animation speed is locked for the whole sample. With a large `n`
  you often want to watch a few draws, then jump to fast/instant — currently you
  must stop and restart.
- **Root cause.** `runAnimatedSample` reads `speed` once and derives a constant
  `delay` (`src/lib/sampling.js:124-126`); the per-draw loop closes over it.
  `doSample` passes `speed: animSpeed` at call time (`src/App.jsx:332`).
- **Approach.** Pass a **ref** instead of a value. Add a `speedRef`
  (`useRef(animSpeed)` kept in sync via an effect or in the slider's `onChange`),
  hand it to `runAnimatedSample`, and recompute `delay` (and the spinner `spinMs`)
  at the top of **each draw iteration** from `speedRef.current` rather than once up
  front. Devices already receive `speed` in their anim state each `set()`, so the
  per-device visuals will follow. Verify the spinner's in-flight animation handles
  a mid-run speed change gracefully (it keys off the state it was given when the
  spin started — likely fine, but exercise it).

### B3. Relocate sampler controls into the sampler tool's upper-right  ·  P2
- **Symptom.** Since the EDA toolbar landed, the global header still owns the
  speed slider, `n =`, "▶ Draw Sample", and "⬇ CSV". They read as app-level chrome
  and feel disconnected from the Sampler Pipeline they actually drive.
- **Files.** Controls currently live in the top header
  (`src/App.jsx:397-416`); the Sampler Pipeline card header is `src/App.jsx:463-469`.
- **Approach.** Move the controls cluster into the Pipeline card's header row,
  right-aligned (`marginLeft:"auto"`) next to the "Sampler Pipeline" label and the
  `+ Stacks / + Mixer / + Spinner` buttons. Keep the same widgets/handlers; this is
  a layout move, not a logic change. Watch wrap behavior at narrow widths — the
  add-device buttons and the controls may need to wrap onto two lines.

---

## Phase C — Wording consistency (P3)

### C1. Standardize on "percentage" over "proportion"  ·  P3
- **Symptom.** Plot/measurement tools mix "proportion" and "percentage" though the
  UI displays percentages throughout. Inconsistent vocabulary confuses students.
- **Files.** `proportion`/`prop(` wording appears in `src/components/plots.jsx`,
  `src/lib/measure.js`, `src/lib/stats.js`, `src/components/devices.jsx`, and
  `src/App.jsx`. (Also referenced in `CLAUDE.md`/`plan.md` — docs can stay as-is or
  follow.)
- **Approach.** Audit every user-**visible** string and the `# / %` toggles; rename
  "proportion" → "percentage" where the displayed value is in fact a percent.
  **Caution:** keep internal identifiers/stat keys (`propBetween`,
  `proportion` stat ids, expression aliases) unless you also migrate every
  reference — a rename there risks breaking tracked-column expressions and the
  click-to-track plumbing. Prefer changing **labels only**, leaving keys intact.
  Double-check the actual values are percent-scaled (×100) and not 0–1 proportions
  before relabeling.

---

## Phase D — EDA data tooling (P3, larger)

### D1. Linked highlighting between dots and table rows  ·  P3
- **Goal (TinkerPlots parity).** Clicking a dot in a plot highlights the
  corresponding row in the data table, and clicking a table row/value highlights
  its dot(s) in the plot — bidirectional.
- **Sub-point.** Stop truncating large datasets in table/preview windows, so every
  dot has a reachable table row (and vice-versa) for the highlight pairing. Today
  large data is capped in the preview.
- **Files.** Plots and tables in `src/components/plots.jsx` (`EDAPlot`,
  `DataTable`/`CollectTable`, the dot-rendering paths); dot geometry comes from
  `src/lib/scale.js` (`stackDots`).
- **Approach.** Introduce a shared `selectedRowIds` (or hovered-index) state owned
  by the host (EDA / Sample Results) and threaded into both the table and the
  `Plot`. Give each rendered dot a back-reference to its source row index so a
  click can resolve dot → row and a row click can resolve row → dot(s). Highlight
  via fill/stroke on the dot and a row background in the table. Consider hover vs.
  click (TP uses click-select; hover-preview is a possible enhancement).
  **Performance.** Removing preview truncation means rendering every row — verify
  table virtualization or at least that large CSVs stay responsive. This is the
  bigger lift in the doc; may warrant its own mini-plan.

### D2. Manual data entry in the EDA section  ·  P3
- **Goal.** Let students who collect their own small samples type data directly:
  add columns, add rows, edit cell values — without authoring a CSV.
- **Files.** EDA stage in `src/App.jsx:419-460` (currently CSV-upload only) and
  `EDAPlot` / table components in `src/components/plots.jsx`. The dataset shape is
  `{ headers, rows, name }` (see `parseCSV` in `src/lib/util.js`).
- **Approach.** Add an "enter data manually" path that creates an empty dataset
  (or seeds a couple of columns) and renders an **editable** grid: add/rename/
  remove column, add/remove row, edit cells. On edit, rebuild the same
  `{ headers, rows }` object EDA already consumes so plotting/`colKind` detection
  works unchanged. Reuse existing inline-edit widgets (`src/components/ui.jsx`).
  Decide whether manual data and uploaded CSVs share one dataset slot (simplest)
  or coexist. Keep numeric/categorical/time auto-detection (`colKind`) live as the
  user types.

---

## Suggested ordering

1. ~~**A1** (one-line fix) and **B1** (small, isolated) — quick wins.~~ ✅ DONE
2. ~~**A3 + A2 together** — the id-keyed rows refactor (A3) plus its user-facing
   duplicate-name guard (A2), in one branch with a short dedicated plan.~~ ✅ DONE
   (devices now identified by stable `id`; `varName` is display-only via `nameOf`.)
3. **B2**, **B3** — sampler interaction polish.
4. **C1** — wording sweep (mechanical, low risk if labels-only).
5. **D1**, **D2** — feature work; size each with its own short plan before starting.

## Conventions reminder
Per `CLAUDE.md`: keep the app dependency-light, never reimplement the shared draw
loop, and validate each change with `npm run dev` against the affected device/plot.
The hard-won constraints in `CLAUDE.md` (shared sampling logic, no default React
import, no `<foreignObject>`, const-before-use, interpolating quantiles, vertical
fit) still apply to everything above.
