# WCAG 2.1 AA Conformance — Gap Analysis & Remediation Plan

## 1. Purpose & scope

The ADA **Title II** rule (28 CFR Part 35) requires state/local government web content and
mobile apps to conform to **WCAG 2.1 Level AA**. If PRISM is used by a public institution
(e.g. a public university or K–12 district) it falls under that obligation.

This document is a **gap analysis**, not a conformance claim. It inventories the current
accessibility posture of the app and outlines the concrete changes required to reach WCAG 2.1
**Level AA** (which subsumes Level A). It is organized **by change area**; each area cites the
relevant success criteria (SC), points at the concrete `file:line` locations, and states the
required change and a priority.

**What was audited:** the React single-page app under `src/` — an inline-style + `theme.css`
token codebase with hand-rolled SVG plots and sampling devices (no component/UI framework, no
charting library). Levels referenced: **A** and **AA** only. Level AAA criteria are explicitly
out of scope and flagged where they could otherwise be mistaken for requirements.

**Status legend:** ✅ Pass · ⚠️ Partial · ❌ Fail (work required) · ➖ N/A or AAA (no AA work).

---

## 2. Summary

| # | Change area | Key SC | Status |
|---|-------------|--------|--------|
| 1 | Keyboard operability | 2.1.1, 2.1.2 (A) | ❌ Fail — Upload CSV, label editing & click-to-track unreachable by keyboard |
| 2 | Visible focus & focus order | 2.4.7 (AA), 2.4.3 (A) | ❌ Fail — `outline:none`, no replacement ring |
| 3 | Names, roles, states & form labels | 4.1.2 (A), 1.3.1 (A), 3.3.2 (AA) | ❌ Fail — icon buttons, color inputs, speed slider & run selects unnamed |
| 4 | SVG / chart non-text content | 1.1.1 (A), 1.3.1 (A) | ✅ Done — every SVG plot named; `role=img` only when non-interactive |
| 5 | Tables — caption, scope, selection | 1.3.1 (A), 4.1.2 (A) | ⚠️ Partial — semantic tables, missing scope/caption/`aria-selected` |
| 6 | Color contrast | 1.4.3 (AA), 1.4.11 (AA) | ❌ Fail — muted/faint text below 4.5:1 in light mode |
| 7 | Use of color / CVD palette | 1.4.1 (A) | ✅ Done — labels already met 1.4.1; CVD-safe plot palette added to the toggle |
| 8 | Motion | 2.2.2, 2.3.1 (A) | ✅ Pass (A) · ➖ `prefers-reduced-motion` is AAA |
| 9 | Resize, reflow, text spacing | 1.4.4, 1.4.10, 1.4.12 (AA) | ✅ Verified — reflows to 1 column at 360px, 0 page overflow |
| 10 | Page structure & language | 3.1.1 (A), 2.4.1/2/6 | ⚠️ Partial — `lang`/`title` set; landmarks/skip-link/headings missing |
| 11 | Status messages / live regions | 4.1.3 (AA) | ❌ Fail — dynamic results not announced |

Several things are **already correct** and should not be re-done: `<html lang="en">` and a
document `<title>` are present (`index.html:2,6`); data tables are real semantic `<table>`s;
many controls are native `<input>`/`<select>`/`<button>` with associated `<label>`s; drag-based
device/divider/ruler controls already have a typed numeric equivalent; dark mode lifts muted
text to passing contrast; the Level A motion criteria pass.

### Implementation status (2026-06-13)

The P1/P2 remediations have been **implemented and verified** in the running app:

- ✅ **Focus visible (§3.2)** — global `:focus`/`:focus-visible` model in `theme.css`; inline
  `outline:none` removed from `iSm`/`InlineEdit`/formula input.
- ✅ **Names & form labels (§3.3)** — `aria-label` on every icon-only button, color input, the
  speed slider (+ `aria-valuetext`), and the four run-control selects; `aria-expanded` on the
  collapse toggles. Verified: **0 unlabeled buttons**.
- ✅ **Core-workflow keyboard (§3.1)** — Upload CSV is now a real `<button>` driving a hidden
  input via ref; `InlineEdit` display state is a `<button>`; click-to-track numbers
  (`TrackText`/`CatNum`) are `role="button"` + `tabindex=0` + Enter/Space. Verified end-to-end:
  focusing a statistic and pressing Enter promotes it to a tracked column.
- ✅ **Contrast (§3.6)** — `--text-3`→`#6a6a6a`, `--text-faint`→`#6e6e6e` (light mode); measured
  4.8–5.4:1.
- ✅ **Tables (§3.5)** — `<caption>` + `scope="col"` + `aria-selected` on all three tables.
- ✅ **Landmarks & headings (§3.10)** — `<main id="main-content">`, `<h1>` (logo), `<h2>` per
  stage, and a "Skip to main content" link.
- ✅ **Status messages (§3.11)** — a polite `aria-live` region announces draw/collection completion.
- ✅ **SVG charts (§3.4)** — every SVG plot now has a descriptive name: scatter, univariate dot,
  both split-dot orientations, the distribution plot, and the spinner. To avoid hiding the
  keyboard-trackable numbers, `role="img"` is applied **only when the plot is non-interactive**
  (EDA / distribution); interactive plots get an `aria-label` without `role="img"` so the
  focusable track controls stay in the accessibility tree. Categorical HTML plots are left as
  accessible structured content (their numbers are already screen-reader text and track targets).
- ✅ **Use of color / CVD palette (§3.7)** — the existing "Color-blind" toggle now also switches
  plot category colors to a CVD-safe palette (`COLORS_CB` in `lib/util.js`, 12 hues each verified
  ≥3:1 on white). Plots recolor live; selection already pairs color with stroke + size, so 1.4.1
  was already met — this is the enhancement on top.
- ✅ **Resize / reflow (§3.9)** — verified: the layout reflows to a single column at 360 px with
  **zero** page-level horizontal overflow (existing `flexWrap`); only code blocks and data tables
  scroll locally, both legitimate (data tables are explicitly exempt from 1.4.10). No code change.
- ➖ **Motion (§3.8)** — already AA-conformant; `prefers-reduced-motion` (AAA) left optional.
- ⏭ **Deferred (P3):** the residual / cat-ruler keyboard paths remain — mitigated by the
  keyboard-accessible DerivedBuilder alternative (§3.1).

---

## 3. Change areas

### 3.1 Keyboard operability — 2.1.1, 2.1.2 (A) — ❌ Fail

A manual keyboard-only tab-through (more reliable than a static scan for this SC) found that,
beyond the drag handles, several **core-workflow** controls cannot be reached or operated by
keyboard.

**Already OK — typed keyboard equivalent exists.** These "drag" interactions are *not* failures
because the same value is settable by keyboard:
- Spinner slice % — `PctInput` per slice (`src/components/devices.jsx:268`).
- Stacks counts — `NumInput` per category (`src/components/devices.jsx:556`).
- Divider cut(s) + linked tail/middle proportion — `NumInput` (`src/components/plots.jsx:881–896`).
- Ruler axis-distance endpoints A/B — `NumInput` (`src/components/plots.jsx:906–913`).

The drag handles themselves (`devices.jsx:250,509,523`; `plots.jsx` `DividerLines` ~80,
`RulerOverlay` ~230) are pointer-only and not focusable — acceptable for 2.1.1 given the typed
alternative, but a mouse/keyboard **parity** gap.

**Core-workflow failures (found by tab-through — these drive the ❌).**
- **Upload CSV is unreachable.** A `<label>` wraps a `display:none` `<input type="file">`
  (`src/App.jsx:692–696`). `display:none` removes the input from the tab order, and a `<label>`
  is not itself focusable, so there is no keyboard path to the file picker — the app's primary
  data-entry route. *Required change:* keep the input in the tab order — replace `display:none`
  with a visually-hidden-but-focusable input (clip-rect technique), or make the visible trigger a
  real `<button>` that opens the hidden input via a ref.
- **Outcome-name boxes in all three devices can't be edited.** `InlineEdit`'s display state is a
  `<span onClick>` (`src/components/ui.jsx:28–32`) — not focusable, no keyboard activation — so
  slice / category / ball labels can't be renamed by keyboard. *Required change:* render the
  display state as a real `<button>` that swaps to the (already keyboard-friendly) `<input>` on
  activation. This is the **same fix** called for under §3.3 and resolves both 2.1.1 and 4.1.2.
- **Click-to-track statistics on the Sample Results plot are mouse-only.** The on-plot numbers are
  SVG `<g>` / `<span>` elements with `onClick` + `cursor:pointer` and **no** `tabindex`, `role`,
  or key handler (`src/components/plots.jsx` — `TrackText` ~32, `CatNum` ~62, `onTrackDiff` ~309).
  This blocks the **entire click-to-track Collect Statistics workflow** by keyboard. A *partial*
  alternative exists — `StatDefiner` ("Define a statistic manually") feeds the same
  `addTrackedStat` through native inputs — but it only authors basic univariate stats (mean /
  median / SD / Q1 / Q3 / min / max), **not** divider count/proportion, cat-cell conditional
  proportions, or slope/intercept, so it is not a full substitute. *Required change:* make each
  trackable number a focusable control (`role="button"`, `tabindex="0"`, Enter/Space handler)
  that calls the existing `onTrackStat`.

**Remaining niche failures (no typed equivalent, low traffic).**
- **Residual ruler** on scatter — "click or drag to a point", read-only readout
  (`src/components/plots.jsx:918–924`).
- **Cat–cat ruler** — user clicks two proportion values on the plot (`MeasureConnector`); no
  keyboard path to the two cells.

**Ruler — the DerivedBuilder is an acceptable conforming alternative (2.1.1).** The ruler's
*trackable* output is an A−B difference, and `DerivedBuilder` (Collect Statistics) builds the same
A−B from collected columns entirely by keyboard. SC 2.1.1 requires the **function** to be
keyboard-operable, not the specific widget, so this conforming alternative satisfies the criterion
for the difference feature — **provided** click-to-track is keyboard-accessible first (the builder
differences two *already-tracked* columns). Therefore: don't invest in keyboardifying the ruler
drag; fix click-to-track (above) and **document** the DerivedBuilder path. The residual read-out
has no equivalent — for full conformance, surface its value (`y − ŷ`) in accessible text near the
plot; minor, since it is exploratory rather than core functionality.

**Also (2.1.2 No Keyboard Trap).** Confirm the floating `RangeInput` editor (`src/components/ui.jsx`)
can be dismissed by keyboard (Escape) and returns focus to its opener.

**Priority:** P1 for Upload CSV, `InlineEdit`, and click-to-track (core workflow); P3 for the
residual / cat–cat ruler (mitigated by the DerivedBuilder alternative).

---

### 3.2 Visible focus & focus order — 2.4.7 (AA), 2.4.3 (A) — ❌ Fail

**Current state.** Shared button/input styles set `outline:"none"` with **no replacement
focus ring**, and there is no `:focus-visible` rule anywhere:
- `iSm`, `btnX` and peers — `src/lib/styles.js:4–5`.
- Inline-edit input — `src/components/ui.jsx:26`.
- Formula/derived input — `src/components/plots.jsx:1597`.

A keyboard user tabbing through the app sees no indication of where focus is — a direct 2.4.7
failure that affects essentially every interactive element.

**Required change.** Remove blanket `outline:none`, or pair it with a visible
`:focus-visible` ring (e.g. a 2px outline/box-shadow using an existing token such as
`--accent-ink`, with sufficient contrast against adjacent colors per 1.4.11). Apply globally
via `theme.css` (e.g. `:focus-visible { outline: 2px solid var(--accent-ink); outline-offset: 2px }`)
rather than per-component, so nothing is missed. Verify logical tab order through the
three workflow stages (2.4.3); the DOM order in `App.jsx` appears to already match the visual
order — confirm during testing.

**Priority:** P1 (broad, affects all keyboard/AT users).

---

### 3.3 Names, roles, states & form labels — 4.1.2 (A), 1.3.1 (A), 3.3.2 (AA) — ❌ Fail

**Current state.** Only **one** ARIA attribute exists in the codebase — `aria-pressed` on the
color-blind toggle (`src/components/code.jsx:154`). Gaps:

- **Icon-only buttons** with no accessible name: `×` remove (`devices.jsx:272,559,999`),
  `−`/`+` ball type (`devices.jsx:757–758`), device reorder/remove `←`/`→`/`✕`
  (`devices.jsx:830–832`), stage reorder/remove (`devices.jsx:977–979`). A screen reader
  announces these as "button" with no purpose.
- **Color inputs** with no label: `<input type="color">` (`devices.jsx:261,549,747`).
- **Animation-speed range slider** (`src/App.jsx:747`) — a bare `<input type="range">` with no
  `<label>`, `aria-label`, or `title`. The visible "slow / fast / instant" scale beneath it
  (`App.jsx:750–752`) is decorative text, not programmatically associated. *(axe: "Form elements
  must have labels".)*
- **Run-control `<select>`s** with no accessible name — `runMode` (`App.jsx:754`) and the three
  `stopRule` selects (`App.jsx:766,770,777`). These apply `style={iSm}` directly and **bypass
  the label-wrapping `Sel` helper** (`src/components/ui.jsx`) that the app's other selects use,
  so they have no associated label. *(axe: "Select element must have an accessible name".)*
- **`InlineEdit`** renders a clickable `<span>` (no role, no name, not focusable) in its
  display state (`src/components/ui.jsx:29`); becomes an unlabeled `<input>` when editing. This is
  also a **keyboard failure** (§3.1) — the outcome-name boxes in all three devices can't be reached
  or activated by keyboard. The `<button>` conversion below fixes both at once.
- **Collapse/expand buttons** (EDA section, derived/manual stat panels — `App.jsx:686,891,910`)
  lack `aria-expanded`.

**Required change.**
- Add `aria-label` (or visually-hidden text) to every icon-only button describing its action,
  e.g. `aria-label="Remove slice"`, `aria-label="Move device left"`.
- Associate each color input with a `<label>` or `aria-label` (e.g. "Color for {label}").
- Give the range slider an `aria-label` (e.g. "Animation speed") — or associate the visible
  scale via `aria-labelledby` and expose the current value (`aria-valuetext` "Slow/Fast/Instant").
- Label the run-control selects — either route them through the existing `Sel` helper (which
  wraps a `<label>`) or add an `aria-label` ("Run mode", "Stop when variable", "Stop condition",
  "Stop value"). Routing through `Sel` is preferred so they match the rest of the app.
- Convert `InlineEdit`'s display state to a real `<button>` (focusable, named) that swaps to the
  labeled `<input>` on activation; give the editing `<input>` an `aria-label`.
- Add `aria-expanded`/`aria-controls` to the collapse toggles.

**Priority:** P1 (broad — every AT user hits unnamed controls; multiple instances confirmed by axe).

---

### 3.4 SVG / chart non-text content & text alternatives — 1.1.1 (A), 1.3.1 (A) — ❌ Fail

**Current state.** The chart `<svg>` (`src/components/plots.jsx:974`) and the device SVGs
(spinner `devices.jsx` ~214; stacks/mixer animation layers) have no `role`, `<title>`,
`aria-label`, or text equivalent. Slice/axis labels are SVG `<text>` (not exposed as an
accessible name for the figure). The plot is the *only* representation of the visualized data
— there is no text/table fallback for the distribution being shown.

**Required change.**
- Give each chart SVG `role="img"` plus an `aria-label` (or `<title>`/`<desc>` referenced via
  `aria-labelledby`) that summarizes the plot: type, variables, and key read-outs (e.g. "Dot
  plot of 200 sample means; mean 4.98, SD 0.71"). Build the label from the values already
  computed for the overlays so it can't drift.
- Mark purely decorative animation layers `aria-hidden="true"`.
- Because the Sample Results and Collect tables already present the underlying numbers in
  semantic tables, link the chart to its data table (e.g. `aria-describedby`) so the text
  equivalent is discoverable rather than building a parallel one.

**Priority:** P2.

---

### 3.5 Tables — caption, scope, selection state — 1.3.1 (A), 4.1.2 (A) — ⚠️ Partial

**Current state.** `DataTable`, `SampleResults`, and `CollectTable` are real
`<table>`/`<thead>`/`<th>`/`<tbody>` structures (`src/components/plots.jsx` ~1425, ~1493, ~1584)
— good. Missing: no `<caption>`, no explicit `scope="col"` on `<th>`, and selectable rows
(`data-rowid`, amber highlight — `plots.jsx:1518,1619`) carry no `aria-selected`, so selection
state is not announced.

**Required change.** Add a `<caption>` (or `aria-label`) per table; add `scope="col"` to header
cells; reflect row selection with `aria-selected` (and make the selectable row/cell a real
button or `role`-bearing focusable element so it can be toggled by keyboard — ties into 3.1/3.3).

**Priority:** P2.

---

### 3.6 Color contrast — 1.4.3 (AA), 1.4.11 (AA) — ❌ Fail (light mode)

**Current state.** Two muted text tokens fall below the 4.5:1 ratio for normal-size text
(`src/theme.css:24–25`), and they are used for real (if secondary) text content:
- `--text-3: #999999` ≈ **2.85:1** on `--surface` `#ffffff`, and **2.54:1** on `--bg` `#f1f2f5`
  — the latter was the exact figure axe reported for the logo tagline (`App.jsx:668`).
- `--text-faint: #bbbbbb` ≈ **1.9:1** on white.

These drive the tagline (`App.jsx:668`), help text (`App.jsx:706,827`), dataset/sample counts
(`App.jsx:691,846`), the `#` row column, placeholders, and axis/legend labels in plots — often
at 9–11px (so the relaxed 3:1 "large text" threshold does **not** apply). **Dark mode** lifts
these to `#aab1bc`/`#9097a2` which pass, so the failure is light-mode-specific. Also confirm UI
component / graphical-object contrast (1.4.11): axis lines `--axis:#cccccc` and grid `#f5f5f5`
are decorative, but focus rings and control borders that convey state must reach 3:1.

**Required change.** Darken `--text-3` and `--text-faint` in the light `:root` block until they
reach ≥ 4.5:1 against the surfaces they appear on (e.g. `--text-3` → ~`#717171`, `--text-faint`
→ ~`#767676`; confirm with a contrast checker). Because these are tokens, the fix is a small,
centralized `theme.css` edit. Audit any remaining hardcoded light-gray hex literals in
components against this same bar.

**Priority:** P1 (small, centralized fix; broad readability impact).

---

### 3.7 Use of color / color-vision-deficiency palette — 1.4.1 (A) — ⚠️ Partial

**Current state.** Color is mostly **not** the sole channel: boxplot/mean/SD overlays use
distinct shapes, categorical plots print count/proportion labels, and divider/ruler lines are
dashed. Remaining color-only cues: scatter dot **selection** is conveyed by blue→orange with no
shape/size/label change (`src/components/plots.jsx:1013`), and the 12-hue data palette
(`src/lib/util.js:6`) contains CVD-ambiguous neighbors (red/orange/pink, green/lime). The
existing color-blind toggle remaps **only** the code-panel section colors
(`src/lib/styles.js` `CODE_SECTIONS`), not the plot data palette.

**Required change.** For scatter selection, add a non-color cue (ring/outline or larger radius
with a shape change). Strictly for 1.4.1, the labeled categorical plots already pass; as an
enhancement (not required), consider extending the color-blind toggle to a CVD-safe data palette
or adding direct labels/patterns to grouped marks.

**Priority:** P3 (selection cue) / enhancement (palette).

---

### 3.8 Motion — 2.2.2, 2.3.1 (A) — ✅ Pass · `prefers-reduced-motion` is AAA ➖

**Current state.** The Level A motion criteria pass: animations are **user-triggered** (clicking
"Draw Sample"), each draw completes well under 5 s, and the Slow/Fast/**Instant** speed slider
(`App.jsx` ~748) lets users stop motion entirely — satisfying **2.2.2 Pause/Stop/Hide**. The
highlight flash (`tkFlash 0.3s alternate` ≈ 1.7 Hz, `src/components/devices.jsx:530`) is below
the 3-flashes-per-second limit — satisfying **2.3.1**.

**Note (not required).** Honoring the OS `prefers-reduced-motion` setting to auto-select Instant
maps to **2.3.3 Animation from Interactions (Level AAA)**, which Title II's AA target does not
require. Recommended as a low-cost enhancement only; **not** a conformance gap.

**Priority:** ➖ none for AA.

---

### 3.9 Resize, reflow & text spacing — 1.4.4, 1.4.10, 1.4.12 (AA) — ⚠️ Partial

**Current state.** All sizing is fixed `px` (font sizes, widths, gaps); no `rem`/`em`. Browser
zoom still scales px text, so **1.4.4 (resize to 200%)** is largely met, but fixed-width inputs
(48–72px, e.g. `PctInput`/`NumInput`) and small gutters (e.g. the integrated-code line gutter)
risk clipping or overflow at 200% / with user text-spacing overrides (1.4.12). No single
breakpoint reflow strategy for 320px-equivalent width (1.4.10).

**Required change.** Verify at 200% zoom and with a text-spacing bookmarklet that no content is
clipped or overlapping; where it is, allow the affected containers to grow (min-width instead of
fixed width, `overflow` visible, wrap). Consider relative units for the most zoom-sensitive
controls. Full 1.4.10 reflow is likely already acceptable given the responsive `flexWrap`
layout — confirm rather than assume.

**Priority:** P3 (verify-then-patch; likely small).

---

### 3.10 Page structure & language — 3.1.1 (A), 2.4.1 (A), 2.4.2 (A), 2.4.6 (AA) — ⚠️ Partial

**Current state.** `<html lang="en">` and a descriptive `<title>` are present
(`index.html:2,6`) — **3.1.1 and 2.4.2 pass.** The single-page layout in `App.jsx` uses styled
`<div>`s for its section headers; there are no landmark elements (`<main>`/`<nav>`/`<header>`),
no skip link (2.4.1), and section titles are not marked up as a heading hierarchy
(`<h1>`…`<h3>`) — so screen-reader users get no structural navigation (2.4.6). An axe run
confirmed all three: "all page content should be contained by landmarks", "document should have
one main landmark", and "page should contain a level-one heading".

**Required change.** Wrap the app body in `<main>`; mark the three workflow stages and their
titles as headings (`<h1>` for the app title, `<h2>`/`<h3>` for "Data & EDA", "Sampler",
"Sample Results"/"Collect Statistics"); add a "Skip to content" link as the first focusable
element. These are markup-only changes to `App.jsx` (and a small `theme.css` rule for the skip
link).

**Priority:** P2.

---

### 3.11 Status messages / live regions — 4.1.3 (AA) — ❌ Fail

**Current state.** Dynamic outcomes — the spinner result badge, sample draw progress, "Collect
N" completion, error/validation text — update visually with no programmatic announcement, so AT
users aren't told a result arrived without moving focus.

**Required change.** Add an `aria-live` region (`polite` for results/progress, `assertive` for
errors) that mirrors the key status text (current draw result, "Collected N samples", validation
errors). One shared live-region node updated from `App.jsx` state is sufficient.

**Priority:** P3 (after the P1/P2 structural work that makes the app navigable).

---

## 4. Prioritized roadmap

**P1 — broad blockers (do first).** These affect every keyboard / assistive-technology user:
1. **Visible focus** — remove `outline:none`, add a global `:focus-visible` ring (§3.2).
2. **Accessible names / form labels** — `aria-label` on all icon-only buttons + color inputs,
   the animation-speed slider, and the run-control selects (or route the latter through `Sel`);
   fix `InlineEdit` (§3.3).
3. **Core-workflow keyboard access** (§3.1) — make Upload CSV reachable; convert `InlineEdit` to a
   `<button>` (shared with #2) so outcome names are editable; make the click-to-track plot numbers
   focusable controls so Collect Statistics is operable by keyboard.
4. **Text contrast** — darken `--text-3` / `--text-faint` in light mode (§3.6).

**P2 — substantial, scoped.**
5. SVG chart names + link to data table (§3.4).
6. Table caption / `scope` / `aria-selected` (§3.5).
7. Landmarks, headings, skip link (§3.10).

**P3 — narrower / verify-then-patch.**
8. Scatter-selection non-color cue (§3.7); `aria-live` status region (§3.11); 200%/reflow
   verification and clipping fixes (§3.9); keyboard path for the residual and cat–cat ruler
   modes — or simply document the DerivedBuilder difference as the conforming alternative once
   click-to-track is keyboard-accessible (§3.1).

**Enhancements (beyond AA, optional):** `prefers-reduced-motion` → Instant (§3.8, AAA);
CVD-safe data palette / patterned marks (§3.7).

---

## 5. Testing approach

- **Automated baseline:** run `npx @axe-core/cli http://localhost:5173` (or a Lighthouse
  accessibility pass) against `npm run dev`. Catches missing names, contrast, and ARIA misuse;
  will not catch keyboard-operability or meaningful-alt gaps. *An initial axe run has already
  been done:* it flagged the unlabeled speed slider and run-control selects (§3.3), the
  2.54:1 tagline contrast (§3.6), and the missing landmarks / `<main>` / level-one heading
  (§3.10) — all reflected above. Re-run after the P1/P2 fixes to confirm zero violations.
- **Keyboard-only walkthrough:** unplug the mouse and complete each workflow stage — upload a CSV,
  build a sampler, draw, track a statistic, set a divider. Every control must be reachable,
  operable, and show a visible focus ring (§3.2), with logical tab order.
- **Screen-reader spot checks:** NVDA (Windows) and/or VoiceOver (macOS) — confirm buttons
  announce their purpose, charts announce a summary (§3.4), tables expose headers/selection, and
  status updates are spoken (§3.11).
- **Contrast:** check the `theme.css` light-mode tokens (and any hardcoded grays) against a
  contrast tool at 4.5:1 (text) / 3:1 (UI components & focus rings).
- **Zoom / reflow:** browser at 200% zoom and a text-spacing override; confirm no clipping or
  overlap (§3.9).
- **Project caveats (from prior work):** screenshots aren't a reliable validation channel here —
  prefer the text-based DOM/console preview tools or manual checks; and batch "Collect N" relies
  on `requestAnimationFrame`, which a background tab throttles, so exercise it in a foreground
  tab (or via the EDA/CSV path) when verifying.
