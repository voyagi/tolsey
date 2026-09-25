---
name: Tolsey
description: A hands-free food safety log for small kitchens, drawn as a gate board ranked by due time and the pass torn off it.
colors:
  ground: "#e3e6e9"
  stock: "#ffffff"
  pass-stock: "#f4f5f7"
  row-alt: "#f3f4f6"
  ink: "#0b0d10"
  steel: "#5f666d"
  hair: "rgb(11 13 16 / 0.18)"
  alert: "#ffd400"
  on-alert: "#0b0d10"
  alert-edge: "#0b0d10"
  verdict: "#0b0d10"
  on-verdict: "#ffffff"
  verdict-edge: "#0b0d10"
  verdict-hinge: "#f4f5f7"
  alert-hinge: "#0b0d10"
  verdict-flap-top: "rgb(255 255 255 / 0.16)"
  alert-flap-bottom: "rgb(11 13 16 / 0.14)"
  focus: "#0b0d10"
  ground-dark: "#0b0d10"
  stock-dark: "#15191e"
  pass-stock-dark: "#1c2127"
  row-alt-dark: "#1b2026"
  ink-dark: "#f4f6f8"
  steel-dark: "#a6adb5"
  hair-dark: "rgb(244 246 248 / 0.16)"
  alert-edge-dark: "#ffd400"
  verdict-dark: "transparent"
  on-verdict-dark: "#f4f6f8"
  verdict-edge-dark: "#f4f6f8"
  verdict-hinge-dark: "#f4f6f8"
  verdict-flap-top-dark: "rgb(244 246 248 / 0.12)"
  focus-dark: "#ffd400"
  print-paper: "#ffffff"
  print-ink: "#000000"
  print-steel: "#333333"
  print-hair: "#999999"
typography:
  display:
    fontFamily: "'Mona Sans', sans-serif"
    fontSize: "clamp(2.5rem, 5.4vw, 4.5rem)"
    fontWeight: 900
    lineHeight: 1.3
    letterSpacing: "0.005em"
    fontVariation: "'wdth' 75"
  reading:
    fontFamily: "'JetBrains Mono', monospace"
    fontSize: "9.25rem"
    fontWeight: 800
    lineHeight: 0.9
    letterSpacing: "-0.04em"
  reading-count:
    fontFamily: "'JetBrains Mono', monospace"
    fontSize: "6.75rem"
    fontWeight: 800
    lineHeight: 0.9
    letterSpacing: "-0.04em"
  reading-words:
    fontFamily: "'JetBrains Mono', monospace"
    fontSize: "3.25rem"
    fontWeight: 800
    lineHeight: 1.3
    letterSpacing: "-0.03em"
  verdict:
    fontFamily: "'JetBrains Mono', monospace"
    fontSize: "2.5rem"
    fontWeight: 800
    letterSpacing: "0.04em"
  headline-sheet:
    fontFamily: "'Mona Sans', sans-serif"
    fontSize: "2.75rem"
    fontWeight: 900
    lineHeight: 1.3
    letterSpacing: "0.01em"
    fontVariation: "'wdth' 80"
  headline:
    fontFamily: "'Mona Sans', sans-serif"
    fontSize: "2.25rem"
    fontWeight: 900
    lineHeight: 1.3
    letterSpacing: "0.02em"
    fontVariation: "'wdth' 80"
  title:
    fontFamily: "'Mona Sans', sans-serif"
    fontSize: "2rem"
    fontWeight: 800
    lineHeight: 1.3
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 90"
  row:
    fontFamily: "'Mona Sans', sans-serif"
    fontSize: "1.375rem"
    fontWeight: 800
    lineHeight: 1.3
    letterSpacing: "-0.01em"
    fontVariation: "'wdth' 80"
  row-second:
    fontFamily: "'Mona Sans', sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 500
  said:
    fontFamily: "'Mona Sans', sans-serif"
    fontSize: "1.375rem"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "'Mona Sans', sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.35
  lede:
    fontFamily: "'Mona Sans', sans-serif"
    fontSize: "1.1875rem"
    fontWeight: 500
    lineHeight: 1.45
  fine:
    fontFamily: "'Mona Sans', sans-serif"
    fontSize: "0.875rem"
  figure:
    fontFamily: "'JetBrains Mono', monospace"
    fontSize: "1.375rem"
    fontWeight: 800
    fontFeature: "'tnum'"
  status:
    fontFamily: "'JetBrains Mono', monospace"
    fontSize: "0.9375rem"
    fontWeight: 800
    letterSpacing: "0.06em"
  label:
    fontFamily: "'JetBrains Mono', monospace"
    fontSize: "0.75rem"
    fontWeight: 700
    letterSpacing: "0.08em"
  pen:
    fontFamily: "'NanumPen', 'Mona Sans', sans-serif"
    fontSize: "2rem"
    fontWeight: 400
    lineHeight: 1
rounded:
  none: "0px"
spacing:
  pin: "3px"
  hair-gap: "4px"
  cell-y: "7px"
  cell-x: "12px"
  seg-y: "12px"
  stacked-x: "16px"
  row-gap: "18px"
  page-top: "20px"
  seg-x: "22px"
  column-gap: "22px"
  page-x: "24px"
components:
  status-verdict:
    backgroundColor: "{colors.verdict}"
    textColor: "{colors.on-verdict}"
    typography: "{typography.status}"
    rounded: "{rounded.none}"
    padding: "0.3em 0.6em"
  status-verdict-dark:
    backgroundColor: "{colors.verdict-dark}"
    textColor: "{colors.on-verdict-dark}"
    rounded: "{rounded.none}"
  status-alert:
    backgroundColor: "{colors.alert}"
    textColor: "{colors.on-alert}"
    typography: "{typography.status}"
    rounded: "{rounded.none}"
    padding: "0.3em 0.6em"
  status-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.status}"
    rounded: "{rounded.none}"
    padding: "0.3em 0.6em"
  status-word:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.status}"
    padding: "0.3em 0.6em"
  status-on-lit-row:
    backgroundColor: "{colors.on-alert}"
    textColor: "{colors.alert}"
    typography: "{typography.status}"
    rounded: "{rounded.none}"
  pass-verdict:
    backgroundColor: "{colors.verdict}"
    textColor: "{colors.on-verdict}"
    typography: "{typography.verdict}"
    rounded: "{rounded.none}"
    padding: "0.1em 0.4em"
  row-lit:
    backgroundColor: "{colors.alert}"
    textColor: "{colors.on-alert}"
  row-change:
    backgroundColor: "{colors.row-alt}"
    textColor: "{colors.ink}"
  control:
    backgroundColor: "{colors.verdict}"
    textColor: "{colors.on-verdict}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0 1.1rem"
    height: "44px"
  control-hover:
    backgroundColor: "{colors.row-alt}"
    textColor: "{colors.ink}"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0 1.1rem"
    height: "48px"
  theme-switch-button:
    backgroundColor: "transparent"
    textColor: "{colors.steel}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0 0.8rem"
    height: "38px"
  theme-switch-button-pressed:
    backgroundColor: "{colors.row-alt}"
    textColor: "{colors.ink}"
  pass:
    backgroundColor: "{colors.pass-stock}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "12px 22px"
    width: "420px"
  board:
    backgroundColor: "{colors.stock}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "18px 24px 8px"
---

# Design System: Tolsey

## Overview

**Creative North Star: "The Gate Board"**

Tolsey is drawn as the live departures board above a gate and the boarding pass in the passenger's hand. The board ranks the shift's checks by due time, reflows a change in place and holds its one alert colour on the changed row until someone logs a number. Every logged check leaves the board as a pass: ticket stock divided into labelled segments, the reading huge in mono, its verdict block, the rule and its source, the time and initials, and a scan band. The printed day sheet is the same board laid flat as a document an inspector signs.

The surface is high contrast and dense on purpose. It is read from about six feet by a cook with gloves on, under fluorescent light, so the reading and its verdict are the largest things on any screen, and colour is a code for "this needs a hand", never decoration. Personality comes from width and weight in one grotesque (Mona Sans, condensed and heavy) and from a monospace that carries every figure, not from a display face, an illustration or a brand colour.

The world refuses the compliance dashboard of equal rounded cards, completion rings, green ticks, pills, a bottom tab bar and a round plus button.

**Key Characteristics:**
- Cool neutral panels (light stock and near-black ink by day, a black board with white letters in dark) and exactly one alert yellow, reserved for change.
- Mona Sans at 75 to 90 percent width and weights 800 to 900 for headings and check names; JetBrains Mono for every time, temperature, count, status and record code, always tabular.
- Square everywhere: no corner radius on any box.
- Status tiles on a live board are split-flap tiles: two flat halves and a square hinge pin at each end of the split.
- The pass is its own ticket stock with a punched tear line on the edge that faces the board.
- Motion shows a change and nothing else; reduced motion changes values in place.
- Three themes: Light, Dark and Device (follows the OS, the default).

## Colors

Cool greys and near-black ink plus a single saturated yellow that only ever means "a change that needs a hand".

### Primary
- **Held Alert Yellow** (`alert`): the one colour. Overdue, out of range, refused, a fix open, a late line on the day sheet, a lit tally cell. Always with near-black text (`on-alert`). In light it always carries a 2px ink edge (`alert-edge`) so it keeps its shape on white; in dark its edge is the yellow itself (`alert-edge-dark`). Also the text selection colour in both themes, and the focus ring in dark.

### Neutral (Light, the default under bright kitchen light)
- **Panel Wall** (`ground`): the page behind everything; shows through the pass's punched tear line.
- **Board Stock** (`stock`): the board, the day sheet, the launch page's panels, the theme switch.
- **Ticket Stock** (`pass-stock`): the pass only, one step off both the ground and the board so it reads as a torn ticket, not a second panel. Also the hinge pin colour on a black verdict tile (`verdict-hinge`).
- **Change Tint** (`row-alt`): a row holding a change that is not overdue, a corrective action line, the pressed theme button, the current replay step, the hover fill of filled controls.
- **Ink** (`ink`): text, the 3px heading rules, the filled verdict block (`verdict`) and its edge, the scan band, the focus ring in light.
- **Steel** (`steel`): labels, second lines, rules on a row, fine print, the outline of a due tile and of outline buttons, the theme switch frame, the scrollbar thumb.
- **Hairline** (`hair`): 1px row rules, 2px dashed segment rules, chart grid.

### Neutral (Dark, the close and dim bar kitchens)
- **Night Wall** (`ground-dark`), **Night Board** (`stock-dark`), **Night Ticket** (`pass-stock-dark`), **Night Change Tint** (`row-alt-dark`), **White Letters** (`ink-dark`), **Night Steel** (`steel-dark`), **Night Hairline** (`hair-dark`). Same roles as light.
- The verdict is not a filled white block in dark: `verdict-dark` is transparent and the tile is a 3px white frame (`verdict-edge-dark`) with white text, because a filled white block glares at the close.

### Device theme
Device is not a third palette. It resolves to Light or Dark from `prefers-color-scheme`, is the first-run default, and follows an OS change live. The stylesheet only knows `data-theme="dark"` on the root; `theme.js` sets it before first paint, stores the choice under `tolsey-theme`, and accepts a `?theme=` query that overrides the stored choice.

### Print (the day sheet)
Printing overrides the tokens to black on white: `print-paper` for ground, stock and change tint, `print-ink` for ink, `print-steel` for steel, `print-hair` for rules, and the alert becomes white with a black edge, so an exception prints as an outlined block. The lifted shadow is removed. The day sheet must read in black and white.

### Named Rules
**The Held Colour Rule.** Yellow appears only where something needs a hand, and it stays until a number is logged or the fix closes. Never on a heading, a button, a brand mark or an illustration.

**The Quiet Pass Rule.** In range is the quietest state: a black block (a white frame in dark) on the pass, its word alone on the board and the day sheet. Only the pass's verdict is filled.

**The Never Colour Alone Rule.** Every status carries its word (IN RANGE, OUT OF RANGE, REFUSED, NO NUMBER, DUE, OVERDUE 14 MIN, LATE 20 MIN, COOLING, FIX OPEN, FIX OVERDUE 5 MIN, CLOSED ON TIME). A tile's colour never says anything its word does not.

## Typography

**Display and word font:** Mona Sans (variable, self-hosted `fonts/mona-sans-vf.woff2`, weight 200 to 900, width 75 to 125 percent, optical size set by the browser from the text size), fallback `sans-serif`.
**Figure font:** JetBrains Mono (self-hosted `fonts/jetbrains-mono-latin.woff2`, weight 400 to 800), fallback `monospace`.
**Pen font:** NanumPen (self-hosted `fonts/NanumPen.woff`, 400), only for the launch page's typed reconstruction of a paper clipboard log, requested after the first screen's faces load.

All three are SIL Open Font License; the two families that reserve their names are served as their authors' own unmodified files (`fonts/OFL.txt`). No font CDN. All faces use `font-display: swap`. The root sets `font-variant-numeric: tabular-nums`. Width is set with `font-stretch`, not `font-variation-settings`.

**Character:** a condensed, heavy grotesque doing the work a gate board's letters do, beside a mono that reads as measurement because on this board the data is the surface.

### Hierarchy (as built on the 1280 by 800 wall unless named)
- **Display** (Mona Sans 900 at 75 percent width, `clamp(2.5rem, 5.4vw, 4.5rem)`, line height 1.3, uppercase): the launch page's one-line title. The launch page's argument line uses the same face at `clamp(2rem, 4.2vw, 3.5rem)`.
- **Reading** (JetBrains Mono 800, 148px, line height 0.9, tracking -0.04em): the temperature on a pass, always the largest figure. The unit sits at 0.3em, raised 1.4em. A countdown or count steps down to 108px; a reading in words (NO NUMBER) is 52px uppercase. On a phone 104px, 76px and 40px; in a pass narrower than 16.25em, 84px.
- **Verdict** (JetBrains Mono 800, 40px, tracking 0.04em, uppercase): the pass's verdict tile. 32px on a phone.
- **Headline** (Mona Sans 900 at 80 percent width, uppercase, line height 1.3): board titles 36px (DUE NOW), second board heads 26px, the day sheet title 44px, the launch page's board heads and the day sheet's cooling head 28px.
- **Title** (Mona Sans 800 at 90 percent width, 32px, tracking -0.02em): the check point on a pass.
- **Row** (Mona Sans 800 at 80 percent width, 22px, line height 1.3): a check name on a board row, with a 15px second line at weight 500 and normal width in steel. The day sheet's rows are 18px, the launch replay's step 19px, a boarded row 18px; the newest boarded row goes to 900.
- **Said** (Mona Sans 700, 22px on the wall and 24px on the launch pass): what the cook said. Tolsey's answer is 18px at 600.
- **Body and lede** (Mona Sans 500 to 700, 16 to 19px, line height 1.35 to 1.45): notes, to-do lines (20px at 700), the launch lede (19px at 500). Fine print is 14px in steel.
- **Figure** (JetBrains Mono 800): board times 22px, pass cells 16px, day sheet readings 22px, tallies 22px. Rules on a row are mono 15px at 600 in steel.
- **Status** (JetBrains Mono 800, 15px, tracking 0.06em, uppercase): every status tile. 13px on a phone and on the day sheet.
- **Label** (JetBrains Mono 700, 12px, tracking 0.08em, uppercase, steel): column heads and every field name on a pass. Nav links, controls and the kitchen line use the same treatment at 13px.

### Named Rules
**The Width Not Face Rule.** Personality is bought with Mona Sans's width (75 to 90 percent) and weight (800 to 900). There is no separate display face.

**The Every Figure Is Mono Rule.** Times, temperatures, counts, statuses and record codes are JetBrains Mono, tabular. Words are Mona Sans.

**The Reading Is Largest Rule.** On a pass the temperature is always the largest figure; a count or countdown sits one step under it.

## Layout

**Wall screen (Operate).** A 1280 wide frame with an 800px minimum height (larger browser text grows it rather than cutting it off), padding 20px 24px 24px. Two columns: the pass at a fixed 420px on the left, the board filling the rest; 18px row gap, 22px column gap. A top bar spans both: wordmark, kitchen and shift, the spoken hint, the theme switch at the right. The clock and Log by hand sit at the right end of the DUE NOW header. The pass leads the markup, so the columns read left to right in the order they are heard.

**Record and day sheet (Read).** One sheet, max width 1180px, padding 26px 30px 24px on board stock. The day is one table in time order (time, check, reading, rule, verdict, by), grouped under mono group labels (Opening, Lunch, Afternoon, Closing) with a 2px ink rule starting each group. A corrective action hangs off the line that opened it on the change tint behind a dashed rule. The tally sits right of the title.

**Launch page (Persuade).** A 12 column grid, max width 1280px, gap 18px 22px. The pass takes columns 1 to 5 and the replay board columns 6 to 12 in the first screen; the paper log and the day sheet take the same five and seven split below; Try it and Limits repeat it and end on one bottom edge. The replay leads the markup.

**Breakpoints.** Under 1280 the wall stacks: the pass first, then the board. Under 1100 the launch pass and replay each take a full row, replay first. Under 900 every page goes to one column, padding 14px 16px 24px, and tables restack each row as a grid (the header row is clipped, not removed, so column names stay in the accessibility tree). The day sheet's tally goes two to a row under 22.4375em (an em width, so it follows the browser's text size). A pass narrower than 16.25em steps its reading down.

**Rhythm.** Board cells 7px by 12px (boarded rows 6px), pass segments 12px by 22px (14px on the launch pass), board padding 18px 24px 8px. Controls and nav links are 44px tall, outline buttons 48px, replay steps 56px (44px on a phone); theme buttons are 38px inside a 3px padded frame.

## Elevation & Depth

The stock to ground step is small (the art direction record measures 1.25 in light and 1.10 in dark), so every raised panel, the board, the pass, the day sheet and the launch page's panels, carries one soft lifted shadow instead of a border. Nothing else is raised; there is no hover lift and no layered stack. Printing removes the shadow.

### Shadow Vocabulary
- **Panel lift, light** (`box-shadow: 0 8px 24px rgb(11 13 16 / 0.14)`): every board, pass and sheet.
- **Panel lift, dark** (`box-shadow: 0 8px 24px rgb(0 0 0 / 0.55)`): the same panels in dark.

Every other `box-shadow` in the system is an inset edge drawn inside a tile, button or row (the 2px and 3px frames, the 3px underline of a pressed or current item), not depth.

### Named Rules
**The One Lift Rule.** A panel is lifted by `--lift` or not at all. Borders do not separate panels from the wall.

## Shapes

Square everywhere: no box in the system has a corner radius. Structure is drawn with rules, the board's own column lines: a 3px ink rule under every board heading, 1px hairlines between rows, 2px dashed hairlines between the segments of a pass and before a fix line, a 2px ink rule opening each group on the day sheet. Frames are inset edges (2px on alert and due tiles, 3px on the verdict and filled controls), so a framed tile keeps the same outer size as a filled one.

The only round forms are functional: the punched half circles of the pass's tear line and the points on the day sheet's cooling chart.

### The pass's tear line
A 6px strip on the pass's edge that faces its board, a column of half circle punches (3.5px radius, 16px repeat) cut in the ground colour so the wall shows through. On the wall it runs down the right edge; when the wall stacks it moves to the bottom edge; on a stacked launch page, where the replay stands above the pass, it moves to the top edge. The rule: the tear is always on the side the pass came off the board by.

## Components

### Status tiles
Mono 800 uppercase words in a square tile, padding 0.3em 0.6em, no wrapping by default (they wrap between words on a phone, at large text and on a pass).
- **Verdict** (filled): ink block, white text, 3px ink inset edge. In dark, a transparent tile with a 3px white frame and white text. Used for the pass's verdict.
- **Alert** (held change): yellow, near-black text, 2px ink inset edge in light (yellow edge in dark). Overdue, out of range, refused, fix open, late.
- **Quiet** (due): transparent with a 2px steel inset frame, ink text. Due, cooling, a refusal that was retaken.
- **Word** (settled): the word alone, no frame. In range and closed on time on the board and the day sheet.
- **On a lit row**: the row turns yellow edge to edge and its tile inverts to a near-black block with a yellow word, so it still reads as a block.

### Split-flap tiles (live boards only)
On a board, a pass and the launch replay, every filled or alert tile (not the quiet or word tiles) is drawn as two flaps on one hinge, with no line across the word, because a line through OVERDUE reads as struck out.
- **Two flat halves.** The tile's fill is split at 50 percent with a hard stop, never a blend. On the verdict the upper half is lighter (`verdict-flap-top`, white at 16 percent; in dark white at 12 percent inside the frame). On alert the lower half is darker (`alert-flap-bottom`, ink at 14 percent). On a lit row's inverted tile the upper half is white at 16 percent.
- **Square hinge pins.** A pin at each end of the split, `max(3px, 0.07em)` tall. Each pin starts at the tile's own edge line (`--hinge-inset`: 3px on the verdict, 2px on alert, 0 on a lit row's tile) and extends `max(3px, 0.1em)` past it, so only its square shows beyond the edge. Pin colours: ticket stock on the black verdict, white on the dark verdict frame, ink on yellow, yellow on a lit row's tile. Pins are at least 3 to 1 against their tile.
- **Where it does not apply.** The day sheet is a printed record, not a board: its tiles stay whole, on screen and on paper. The split is scoped to `.board`, `.pass` and `.replay` only.

### The pass
Ticket stock (`pass-stock`) with the panel lift and the tear line on its board side. Four segments divided by 2px dashed hairlines: what was said and Tolsey's answer (with a lit note, a yellow block with a 2px ink edge, for an overdue check it carries); the check point, its kind label, the reading and the verdict tile; a two column grid of labelled cells (rule, source, time, by) in mono 800; the scan band, a crisp-edged ink SVG drawn deterministically from the record id, running the full width, 26px tall (24px on a phone), with the record id under it.

### Board rows
Time in mono 800 with a relative time label under it, the check in condensed heavy Mona Sans with a steel second line, the rule in steel mono, the status tile right aligned. A row holding a change sits on the change tint; a row that needs a hand now is lit yellow edge to edge.

### Controls
- **Filled control** (Log by hand, Print day sheet, the launch page's main action and a pressed toggle): the verdict treatment, ink fill with a 3px ink inset edge (a white frame in dark), label type at 13 to 14px, 44 to 48px tall, square. Hover swaps to the change tint with ink text and a 3px ink inset edge.
- **Outline button** (replay Back, Play, Next): transparent, ink text, 2px steel inset frame; hover thickens it to 3px ink.
- **Theme switch**: a group of three buttons (Light, Dark, Device) in a 2px steel frame on board stock with 3px padding and gaps, quieter than any status. Buttons are steel label type; hover turns them ink; the pressed one sits on the change tint with a 3px ink underline bar. It wraps inside its frame on a narrow screen.
- **Navigation**: steel label links, 44px tall; hover turns them ink; the current page carries a 3px ink underline bar. Hidden on the launch page under 900.

### Focus, selection and forced colours
- **Focus**: every focusable element gets `outline: 3px solid var(--focus)` with a 3px offset: ink in light, alert yellow in dark.
- **Selection**: selected text is near-black on alert yellow in both themes.
- **Links**: inherit their colour, 2px underline at a 0.2em offset.
- **Forced colours** (Windows contrast themes drop fills and box shadows, the only marks on a tile or a pressed button): every tile except a plain word gets a 2px `CanvasText` border; filled controls and outline buttons get a 2px `ButtonText` border; the pressed theme button and the current nav link get a 3px underline at a 0.35em offset (longhands, because Safari drops a shorthand carrying a thickness); the current replay step gets 3px `Highlight` rules above and below.

### Motion
Five moves, shared by the wall and the launch replay, each starting from what is already on screen. Arrivals use `cubic-bezier(0.16, 1, 0.3, 1)` (also `--ease-out` in the tokens); departures use `cubic-bezier(0.7, 0, 0.84, 0)`.
- **Flap**: a tile folds away to -90 degrees about its horizontal axis (perspective 400px) in 120ms on the departure curve, holds edge-on while the word changes, then folds in from 90 degrees over 200ms on the arrival curve. The newest flap on a tile cancels one in flight.
- **Close up**: rows that keep their identity slide from where they stood to where the new ranking puts them, 320ms.
- **Lift off**: a logged row moves 40px toward the pass (16px up when stacked) and fades out, 220ms, departure curve.
- **Tear over**: a new pass is revealed from its tear line by a clip path over the old one, which stays underneath until covered, with a 28px shift (20px when stacked), 420ms.
- **Nudge**: a pass whose content changed in place slides 18px in from its board's side (14px when stacked), 260ms, never from invisible.

Pages post still and visible; there is no entrance animation. The wall plays its one landing change once, about 1.1s after it is visible and its faces have loaded (four seconds at most). Values snap; nothing counts up. Under `prefers-reduced-motion: reduce` every move is skipped and the value changes in place, and the stylesheet forces animation durations to 0.01ms and transition durations and delays to 0s.

## Do's and Don'ts

### Do:
- **Do** keep yellow (`alert`) for change only, with near-black text, and give it a 2px ink edge in light.
- **Do** make the reading and its verdict the largest things on a pass (reading 148px, verdict 40px on the wall), and keep a count one step under the reading.
- **Do** set every figure, time, status and code in JetBrains Mono, and set headings and check names in Mona Sans at 75 to 90 percent width.
- **Do** draw filled and alert tiles on a live board, pass or replay as two flat halves with a square hinge pin at each end of the split, starting at the tile's edge line.
- **Do** keep day sheet tiles whole, and let an exception print as an outlined block in black and white.
- **Do** put the pass's tear line on the edge that faces its board, and move it when the layout stacks.
- **Do** lift panels with `--lift` and separate structure with the board's own rules (3px ink under headings, 1px hairlines, 2px dashed segments).
- **Do** ship Light, Dark and Device on every screen, with Device the default.
- **Do** give every focusable element the 3px focus outline and every marked state a forced-colours border or underline.

### Don't:
- **Don't** round a corner on any box.
- **Don't** draw a line across a tile's word; the flap is shown by its halves and pins.
- **Don't** blend colours: CSS gradients appear only as hard-stop drawing (the flap halves, the pins, the tear punches).
- **Don't** use completion rings, green ticks, pills, a bottom tab bar or a round plus button.
- **Don't** fill the dark verdict with white; it is a 3px white frame.
- **Don't** let colour carry a state without its word.
- **Don't** animate an entrance or count a value up; motion only shows a change, and reduced motion shows none.
- **Don't** load fonts from a CDN or subset the two families that reserve their names.
