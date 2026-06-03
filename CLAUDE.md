# TinkerSim — Project Guide for Claude Code

A browser-based probability **sampler & simulation** tool for undergraduate statistics
education, modeled on TinkerPlots. Single-page React app.

## Stack & commands
- **Vite + React 18** (no TypeScript, no Tailwind build step).
- `npm run dev` — start the dev server (hot reload).
- `npm run build` — production build to `dist/`.
- `npm run preview` — serve the production build locally.

All the app code currently lives in **`src/App.jsx`** (~2,000 lines, one default-exported
`App` component plus many helper components). It was developed iteratively in the Claude
artifact environment, so it is intentionally dependency-light and self-contained.

## Architecture (current)
The app has three workflow stages, top to bottom:
1. **Data & Exploratory Analysis (EDA)** — upload a CSV, auto-detect numeric vs.
   categorical columns, plot with toggleable stat overlays (boxplot, mean triangle,
   ±1 SD, LS line; cat×cat grid; cat×numeric split dot plots). Copy a column to paste
   into a sampler device.
2. **Sampler Pipeline** — chain of devices (Stacks, Mixer, Spinner), each producing one
   variable per draw. Animated sampling.
3. **Sample Results** (raw draws) → **Collect Statistics** (sampling distribution over
   many repetitions).

Key components in `App.jsx`: `EDAPlot`, `CatCatGrid`, `SplitDotPlots`, `DotPlot`,
`StatDistPlot`, `StatDefiner`, `SpinnerDevice`, `StacksDevice`, `MixerDevice`,
`DeviceCard`, plus helpers `parseCSV`, `isNumericColumn`, `quantile`, `numericSummary`,
`lsFit`, `computeStat`, `sampleSpinner`, and the shared draw helpers
`makeDrawState` / `drawStacks` / `drawMixer`.

## Hard-won constraints — DO NOT REGRESS THESE
These were the source of real bugs during development. Preserve them.

1. **Sampling logic is shared.** `makeDrawState`, `drawStacks`, and `drawMixer` are the
   single source of truth for "draw one value." Both the animation loop
   (`runAnimatedSample`) and the collect loop (`doCollect`) must use them, or their
   behavior will silently diverge (this caused a without-replacement counting bug).
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

## Suggested next steps (per the project owner)
- Split `App.jsx` into modules (components/, lib/) now that it's under version control.
- Overhaul Sample Results and Collect Statistics to reuse the EDA plotting primitives
  (scales, dot-stacking) — these are currently duplicated across `DotPlot`,
  `StatDistPlot`, and `EDAPlot` and are the right thing to extract next.

## Conventions
- Keep the app dependency-light. Don't add a UI framework or state library without reason.
- Validate any change by running `npm run dev` and exercising the affected device/plot.
