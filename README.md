# Org Chart Viewer — Front-End Case Study

_Userscript version: **1.2.1**._

A small vanilla-JavaScript tool that turns a sprawling, hard-to-read org chart into a
compact, single-screen view scoped to one location. Built to run on a large wall-mounted
touchscreen with no horizontal scrolling, at both 1080p and 4K.

> **All data in this demo is synthetic.** The people, titles, sites, and the fictional
> company "Northwind Logistics" are invented for the portfolio. There is nothing
> proprietary, confidential, or personally identifiable here, and the page makes no network
> calls — avatars are generated inline as SVG monograms.

## The problem

A standard org-chart view optimizes for the whole organization, not for one team watching a
shared display. On a big screen that creates three practical issues:

- **Manual expansion.** Each level has to be opened by hand, one node at a time, from the top
  all the way down.
- **Horizontal sprawl.** Every level is drawn as one straight row, so a wide organization runs
  far past the edge of the screen and forces left/right scrolling.
- **Irrelevant people.** A location's staff can be split across more than one manager, so the
  "team" you want is scattered among branches that belong to other locations.

## The approach

The tool is split into one authoritative engine (`orgchart.core.js`) consumed by a demo page
(`index.html`) and a userscript (`orgchart.portfolio.user.js`). The engine keeps all pure
logic free of the DOM so it can be unit-tested headlessly in Node; only two functions touch
the DOM. The pipeline has four stages:

1. **Anchor rooting.** The chart is rooted at the **anchor** — the person at the top of the
   crawled tree. There is no automatic climb to a shared ancestor; the anchor is the single
   control for how wide the chart goes, so you decide where the "top" sits by choosing it.
2. **Pruning.** From the anchor down, keep a person only if they belong to the selected site
   or have someone from that site somewhere below them. Everyone irrelevant to the location
   drops out, and memberless branches disappear. If no one at the selected site reports under
   the anchor, the view shows a short "no one from this site under this anchor" notice instead
   of a blank or single-node chart.
3. **Compact brick-lay layout.** A tidy-tree pass places the chart to fill **both** screen
   dimensions so the chips come out as large as possible. A **wide** level of siblings is
   **brick-laid** into two or more vertically-offset lanes (sub-rows) just below the parent —
   odd lanes shifted half a slot so people sit between, not directly under, the row above —
   which cuts the chart's width and lets the whole thing scale up instead of shrinking to a
   tiny strip. The engine only stacks a level into lanes when doing so actually makes the
   chips bigger (it hill-climbs the fit-scale for the current screen), so **narrow or deep**
   levels stay **flat**: one aligned row per depth, siblings side by side, no one offset onto
   an extra row — three top-level managers still read as a clean row, never a chain. When a
   chart is still **narrower** than the viewport the nodes are **spread horizontally to fill
   most of the width**; a per-node slot cap keeps a two- or three-person chart from stretching
   absurdly. Parents stay centered over their children, and the fit-scale is capped at natural
   size so there is never a horizontal scrollbar, at 1080p or 4K.
4. **Render.** Compact chips with large, legible text are positioned absolutely on a single
   scaled stage. Connectors are drawn as **orthogonal routes that go around the chips, never
   behind them**: aligned children get a flat elbow (down from the parent's bottom, across the
   gap between rows, down into each child's top), while brick-laid lanes are reached through a
   clear **left gutter spine** that drops down the reserved column and runs in across the empty
   channel above each lane. Either way a parent's fan-out to all of its children stays obvious
   (siblings never look like a chain). Any node
   with reports can be expanded or collapsed. Collapsing a node discards its descendants'
   expansion, so **re-expanding a node shows only its immediate children (each collapsed
   again)** rather than restoring whatever was open before.

## Before / after

Open `index.html` and use the toolbar (it sits along the **bottom** of the screen, mirroring
the production build, which places it low to stay reachable on a wall-mounted TV):

- **Before** reproduces the look of a native top-down org chart: a light theme, the top
  person at the top center with each level of reports in a row beneath, square avatars with
  the alias/login underneath and a **+ / −** toggle on any node with reports, connector lines
  between a parent and its children, and a right-side **Management Chain** sidebar listing the
  (synthetic) leaders above the top of the chart. It starts **collapsed** to the top person
  and their immediate reports; each **+ / −** toggle opens or closes exactly one level. You can
  **click-and-drag** the chart freely to any corner — there are no scrollbars, and even a
  single visible node can be dragged anywhere.
- **Enhance ▶** runs the pipeline above for the selected site and swaps in the compact,
  fill-to-width, fit-to-screen result. The compact view opens fit-to-viewport and supports
  **free drag** to pan, **mouse-wheel zoom** toward the cursor, and **pinch zoom** on a
  touchscreen. You can press and drag **anywhere** on the chart — including over a photo or a
  person's text — to pan it: the avatar never ghost-drags and no text gets selected.
- **Cursor hints** — hovering a **node** shows the **pointer hand** so it reads as clickable,
  while the empty chart background shows the **grab** hand (pannable). Press and hold on a node
  and it switches to **grab**, and once you actually drag it becomes **grabbing** everywhere
  (including over nodes); releasing returns to the pointer-over-node / grab-over-background
  defaults.
- **Expand / collapse** a node (the **+ / −** toggle) now re-lays out the chart **in place**
  while keeping your current pan and zoom — it no longer snaps back to fit the screen, and the
  **node you clicked stays put** so its children just appear or disappear around it instead of
  the whole chart jumping. A re-fit happens only when you click **Fit**, **Reload**, pick a
  different **Site**, or on the first render.
- **Click a node** to open a larger detail popup with the full, untruncated details (name,
  title, department, building, login). The popup is a **speech bubble anchored to the clicked
  node**: it points at the node with a small **caret/tail**, sitting just above it by default
  and flipping below when there's no room above, and it shifts sideways as needed to stay fully
  on-screen. It includes the person's **avatar photo**, and the name links to that person's
  profile and opens in a **new tab** (a placeholder host in this demo; a grafted associate links
  to a distinct associate placeholder). A node opens the same popup even when it was added by a
  later re-render — a grafted associate revealed with **+N**, a different **Site**, or an
  in-place re-root. The bubble uses the
  normal arrow cursor, its **text is selectable** (I-beam cursor) so you can copy details, and
  the link and **×** show the pointer hand. Dismiss the popup with the **×** button, the
  **Esc** key, or by clicking outside it.
  - **Make top of chart** — shown only on a person who **has reports** and isn't already the top
    of the chart; **leaves (an associate or any childless node) never show it**. It
    **re-roots the chart on that person in place**, showing
    only their subtree. It is a pure in-memory re-root of the loaded tree (no re-crawl / no network)
    and the **Site** dropdown is repopulated from the subtree. Use **Reset to top** to go back.
- **Reset to top** (toolbar, next to **Site**) restores the chart to the full-tree root after a
  **Make top of chart** re-root.
- **Reset** restores the before view.
- **Fit** re-centers and re-fits the current chart to the screen. It lives in the bottom
  toolbar alongside Enhance / Reset (not as an on-chart corner button), so it stays reachable
  on a wall-mounted touchscreen.
- **＋ / −** (Zoom in / Zoom out) step the zoom toward the center of the chart, right next to
  **Fit** in the toolbar — handy on a touchscreen where pinch-to-zoom can be awkward. They
  compose with wheel, pinch, and drag, and stay within the same ~0.1×–5× range.
- **Expand All** re-expands every node you've manually collapsed, so the whole tree is shown
  again — the inverse of collapsing nodes one at a time. It still **respects Hide levels**: any
  title tiers you've hidden stay hidden. After expanding it re-renders and lets the usual
  auto-fit rule apply. It sits in the middle of the toolbar, in the slot **Fullscreen** used to
  occupy.
- **Hide levels** opens a small panel listing one checkbox per **tier**, where tiers are
  **grouped by reporting relationship** (each title's dominant parent), not raw tree depth.
  Functionally-equal titles that sit at the same level share one row, labeled with the titles
  joined by ` / ` (e.g. `Area Manager I / Area Manager II / Area Manager`). The list is ordered
  **most senior at the top → deepest/most-junior at the bottom**. **Checking a box hides that
  tier**; everything is unchecked (visible) by default. Hiding works from the bottom up, so
  checking a tier **auto-checks every tier below it** (more junior); unchecking a tier unchecks
  the tiers above the remaining hidden run while **leaving the lower tiers checked** — the
  hidden set is always a contiguous run from the bottom and you can't hide a middle tier without
  its reports. Because tiers follow the dominant reporting relationship, **one outlier edge does
  not move a title's tier** (a lone manager reporting to the wrong level still groups with its
  peers). Hiding is **by job title, not by tree position**: checking a tier hides **everyone
  whose title is in that tier wherever they sit in the chart**, regardless of who manages them —
  so an off-pattern report (e.g. a Process Assistant reporting to an Operations Manager, or a
  plain `Area Manager` reporting straight to the General Manager) is hidden at its own tier's
  checkbox. Hiding never removes anyone from the data; it's a reversible render filter, so
  unchecking restores everyone and the on-node **+ / −** toggles still work afterward (a node
  whose only reports are hidden simply shows no toggle). The top tier is disabled since hiding
  it would hide everyone.
  - **The checkboxes persist.** The hidden-tier state is remembered, so closing the panel and
    reopening it shows the same boxes still checked (ready to uncheck). Switching sites keeps
    any still-present hidden titles checked and drops ones that aren't in the new chart.
  - **Click outside to close.** With the panel open, a click or tap anywhere outside it (on the
    chart or elsewhere) closes it; clicking a checkbox inside keeps it open, the **Hide levels**
    button still toggles it, and **Esc** closes it too.
  - **Per-manager +N local reveal.** Hide a title globally, then pop open just **one** manager's
    hidden reports: any manager with hidden direct reports shows a small, distinct **+N** control
    (N = how many of its direct reports are hidden), separate from the **+ / −** toggle. Tapping
    **+N** reveals only *that* manager's hidden directs and flips to a **−N** re-hide state;
    everyone else's stay hidden. It's independent of the checkboxes and of manual collapse —
    collapsing then expanding a manager never un-hides title-hidden people; only **+N** does.
  - **Smart auto-Fit on hide/show.** When you're viewing the **whole chart** (just fit, or
    right after **Fit** / **Reload** / a **Site** change), hiding or revealing people **re-fits**
    so the new, smaller or larger chart still fills the screen. The same happens when you're
    **zoomed out** past the fit (looking at the chart plus empty margin): a hide/show auto-**Fits**
    to re-frame it. But once you've **zoomed in** on a subsection, a hide/show **stays put** so
    small tweaks don't throw off where you're looking — no auto-Fit while zoomed in, no matter how
    much of the chart is off-screen.
- The on-node **+ / −** toggle is a **large, touch-friendly ~38 px button** so it's easy to tap
  on a wall-mounted touchscreen.
- **Include associates** demonstrates grafting front-line associates onto the chart. In the
  production build this data comes from a separate roster system; here it is a small **synthetic
  associate list** (in `fake-data.js`) handed to the **same** generic engine helper
  (`graftAssociates`). Checking the box appends each associate under its manager — matched first
  by the manager's **login**, otherwise by a normalized **name match** (`Last,First` ⇄
  `First Last`), with **no/ambiguous match dropped** — so the demo shows both a login match and a
  name match landing under their managers and one unmatchable associate being dropped. The
  grafted associates carry an **"Associate"** title, so they appear as their **own Hide-levels
  tier**, kept **distinct** from the manager tiers above them. Because a real building has so
  many front-line people, that associate tier is **hidden by default** the moment you include
  them — its checkbox is pre-checked and the chart doesn't balloon. Each manager with hidden
  associates shows a **+N** control to reveal just that manager's associates locally;
  **unchecking** the associate tier in **Hide levels** shows them all. A grafted associate opens
  the **same detail card** as everyone else (name links to a distinct associate placeholder
  host, Title/Building/Login populated). Each associate's record carries only a **bare site
  code** (e.g. `NDC1`); the engine resolves it to the **full building name** (e.g.
  `NDC1-Central DC(Lincoln,NE,US)`) by looking the associate's **own site code** up in a map
  built from the people already in the chart — so the detail card shows the full building, and
  a cross-site manager never supplies the wrong one. **Toggling Include associates on or off
  keeps your current view** (zoom and pan, anchored on the node nearest the center of the
  screen) instead of snapping back to Fit. **Unchecking Include associates** removes just those
  associates and clears their hidden tier (no empty checkbox is left behind).
- **Compact People** is a toolbar checkbox (default **off**) that renders every person in a
  compact, **photo-dominant** form — a large avatar tile with the name beneath it and nothing
  else on the face; title, department, building and login stay in the click popup. The smaller
  footprint packs the chart tighter so auto-fit zooms in more. Toggling it live re-renders in
  place and **keeps your current zoom and pan** (anchored on the node nearest the center). The
  demo's avatars are colored initial tiles (no real photos), so the tile becomes the dominant
  element.
- **Color by role** is a toolbar checkbox (default **on**) that tints each person's card
  **border** by their title tier, using the same relationship-grouped tiers as **Hide levels**.
  Colors run **top-down through a fixed palette** assigned by tier index — root tier `#D11A2A`
  (red, always), then `#F57C00` (orange), `#FFD60A` (yellow), `#43A047` (green), `#4DD0E1`
  (cyan), `#3F51B5` (indigo-blue), `#DD3CDD` (purple/pink), then an 8th tier with **no role
  color** (default border); it cycles every 8 (a rare 9th tier wraps back to red). The palette
  is not stretched to the tier count, so everyone in the same role shares a border color.
  Unchecking restores the default border. Toggling live preserves zoom/pan.
- **Remembered across visits** — the selected **Site**, **Compact People** and **Color by role**
  are saved in `localStorage` (not cookies) and restored next time. The saved Site is
  pre-selected without auto-starting a load (the load gate still waits for a click); the saved
  toggles apply once the chart renders.
- **Fullscreen** toggles the browser in and out of fullscreen (no need for the F11 shortcut). It
  sits at the **far right** of the toolbar.
- The **Site** dropdown is populated from the data itself; switching sites re-scopes the chart,
  keeping the anchor as the top and pruning to the people at the chosen building.

## Running it

- **Demo page:** open `portfolio/index.html` directly in any modern browser. No server, no
  build step, no dependencies.
- **Userscript variant:** `orgchart.portfolio.user.js` performs the same transform from a
  Tampermonkey-style userscript instead of the page's own button. Install it, point its
  `@match` at wherever you open `index.html`, and it renders the compact view on load (or from
  its menu entry). It delegates to the same engine, so the two stay in sync.

## Tech notes

- Vanilla JS / HTML / CSS. No frameworks, no build step, no runtime dependencies.
- The engine is Node-requireable; a small headless harness exercises the extract, anchor-root
  prune, and layout-bounds logic (including the no-horizontal-scroll guarantee at 1080p and
  4K).
- The shared crawl engine walks an org by fetching one page per manager, with all requests
  funneled through a **single global semaphore** that defaults to **10 parallel requests** —
  bounding total in-flight work no matter how deep the tree, so it stays fast without
  overwhelming a backend. The production build layers a per-request timeout and retry on top of
  this, using a **fixed default of 10 parallel requests** (there is no longer a user-facing
  setting for it). This demo ships only synthetic data and makes **no network
  calls** — the engine's crawl path is driven directly by the headless tests.
- Avatars are deterministic inline SVG monograms (color derived from the name), so the view is
  fully offline and reliable on a kiosk display.

## Files

| File | Role |
| --- | --- |
| `orgchart.core.js` | Authoritative engine: extract, parse, anchor-root prune, layout, render. |
| `fake-data.js` | Synthetic "Northwind Logistics" org tree (and the synthetic associate list for the Include-associates demo) used by the demo and tests. |
| `index.html` | Self-contained before → enhance → after demo page. |
| `orgchart.portfolio.user.js` | Userscript that runs the same transform on the demo page. |
