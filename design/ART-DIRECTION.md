# Art direction: the gate board

Locked 2026-09-16, the second direction for this product. The first, the posted grade card, was retired the same day at the owner's design checkpoint ("a bit boring"), and the owner's brief sharpened to: better than the other food safety tools, modern and fun, still useful, functional and serious enough for a business. Applies to every surface: the kitchen wall screen, the record and printable day sheet, and the judge launch page. All three are built to it as mockups in `design/mockups/`: the wall screen first, the record and launch pages the same day.

## 1. The audience, measured before choosing

**Who adopts it.** The owner-operator or shift lead of an independent US restaurant, cafe or food truck. The cook takes the readings. The health inspector reads the output.

**What they already use every week, read off the live sites on 2026-09-16** (fonts from served `@font-face` rules, colours by frequency in the served CSS):

| Product | Role in their week | Faces | Leading colours | Corners |
|---|---|---|---|---|
| Square for Restaurants | POS | Square Sans Text, Display, Mono | ink `#1a1a1a`, blue `#006aff`, greys | 4 to 6px |
| Toast (support and docs; the POS site refused the request with 403) | POS | Effra, Source Sans Pro | blue `#2b4fb9` `#558edd`, orange `#ff4c00`, red `#b4001e` | 2 to 8px |
| 7shifts | scheduling | Inter Tight, a pen script | off-white `#f1f0ec`, mint `#00feb2`, orange `#ff6808`, green `#244f47` | 20 to 40px |
| Homebase | scheduling, timeclock | Plus Jakarta Sans, JetBrains Mono | purple `#7e3dd4`, plum `#1e0b3a`, lime `#e0ff00` | pills |
| MarketMan | inventory | Poppins, Manrope | teal `#004445`, blue `#2979ff` | 7 to 10px |
| ThermoWorks | the thermometer on their belt | Rubik | red `#c42525`, yellow `#ffc72c`, green `#0d7544` | round |
| ServSafe | the food safety certificate every manager holds | Raleway, Open Sans | blue `#1677cb`, `#292929` | 0 to 6px |
| Alexa design pages | the device this runs on | Amazon Ember | squid ink `#232f3e`, cyan `#00caff` | 0 to 8px |

Jolt (Roboto, `#2ea3f2`) and Restaurant365 (Poppins, red `#d02027`) were read as well.

**What reads as quality.** The POS they trust with the money is plain: one neutral grotesque, near-black ink, one saturated blue, small corners (Square, Toast). The tools they tolerate are the playful ones (7shifts, Homebase) with pills, script faces and lime. The thermometer and the certificate speak in hard verdict colours: red, yellow, green, blue.

**What reads as a warning.** A compliance app that looks like a marketing site. Anything cute on a food safety record. Anything that needs reading glasses at the walk-in.

**Where to differ, where to match.** Match the POS in plainness and one grotesque, because trust on a record is borrowed from the tool that already handles money. Differ from every compliance app (Jolt, FoodDocs, Xenia) by refusing the dashboard of equal cards with green ticks.

**The scene.** A bright kitchen under fluorescent tubes, steam and noise, the screen on a wall about six feet from the cook. Light is the natural mode there. Dark is designed for the late close and dim bar kitchens, and it is also the departures board's own look.

### 1b. The competitors' product screens, read 2026-09-16

Method: App Store listing screenshots (apps.apple.com/us, ids 1440535681, 1487448481, 1515263737, 1605760701, 1561594249) downloaded and viewed at native size; the product images each vendor shows on its own homepage; faces and colours read from each homepage's served stylesheets by script (`@font-face` families, `font-family` declarations, hex values by frequency). Screens described are the ones seen, not the vendors' claims.

| Product | Faces (served CSS) | Brand colours (CSS, by frequency) | What the product screens look like | Dated, dull or cluttered |
|---|---|---|---|---|
| Jolt (SmartSense by Digi; jolt.com moves to smartsense.co on 2026-09-17) | Roboto (Divi theme icon fonts beside it) | `#2ea3f2` light blue, `#004676`, `#0077c8`, `#68ca48` green | White list screens with grey section bars ("Today", "No deadline"), a blue app bar, tabs, grey progress rings, a blue round plus button, a red DEADLINE sort footer; a timeclock table with red counts and green IN or grey OUT pills; the desktop report is a blue donut reading "87% Complete" on an iMac. The one strong moment is marketing only: a tablet showing "168.2°F STABILIZING" in blue. | Dated: the 2016 Material look on iOS, screenshots stamped December 2022. Dull: grey rows and one blue. Cluttered: a timeclock table with an A to Z rail on a phone. Type 14 to 17px for a phone in the hand, never a wall. |
| FoodDocs | Rubik | `#2e2d75` indigo, `#00c06d` green, `#3b66c9` blue | Marketing frames with an indigo headline over a phone on a green blob; in the app a big green tick ("You are all done for today"), grey rows with a green left bar, a bottom tab bar; corrective actions as a checkbox list under a full-width green Save; on the desktop a dark green sidebar and unit cards with percentage rings (100%, 80%, 42%). | The category default exactly: white cards, completion rings, green ticks, grey rows. Clean and anonymous: swap the logo and it is any SaaS. The blob background is the 2021 template. |
| Operandio | Figtree (Museo Sans and Proxima Nova declared) | `#1a1b43` navy, `#fb5b3a` coral, `#f63b3b` red, `#18ce99` mint, `#612eec` violet, `#fd9317` orange | Navy marketing frames with coral gradient blobs and feature pills; in the app white cards on light grey: "Audit details" with Pass and Fail buttons, Add photo, 1 to 5 rating buttons, a five-tab bar; a sensors list with a red-bordered card for an out-of-range fridge; the desktop home is an intranet portal: a photo banner, "9 items requiring your attention" in red, beige quick-link tiles, news posts, a contacts list. | Cluttered: the desktop is a company intranet with a food safety module somewhere inside it. Generic: navy plus coral is the 2023 startup pair. A form builder's look on the phone. |
| Xenia | Inter (86 declarations), Manrope (28) | `#6868fe` periwinkle, `#4a3aff` indigo, `#ffc400` and `#fce040` yellows, `#3898ec` blue | Lavender gradient blobs and purple bold headlines ("The Frontline Operations App"); a work-order list with purple Open pills, filter chips and a purple round plus; task detail with a green Mark as complete; chats; a dashboard with a green, orange and red donut, a pink area chart and tables; a checklist with PASS, FAIL and NA buttons and "26 of 45 items 57% Complete". | The most current of the five and still the template: purple and indigo on white with soft gradient blobs, pills, rounded cards, Inter. Cluttered filters. Playful in the way a scheduling app is, not a record an inspector signs. |
| Restoke | Neue Haas Grotesk Text (commercial) | `#0a0d12` near-black, `#ff642c` and `#fe4611` orange, `#ef2c07` red, `#717680` grey | A black app bar with the wordmark, orange count badges, white accordion cards ("Procedures 1", "Receiving 1", "Assigned 2"), an orange round plus; checklist items with large grey exclamation and tick circles, a dashed photo drop zone, an embedded video; an order screen in blue-grey text; the desktop "MyDay" is accordions with orange item pills and coloured tiles (stock count, todo procedure, order ready) beside a KPI dashboard with bar and scatter charts. | Cluttered and mixed: three corner radii, blue-grey text beside black bars, tiles in three colours. The phone screens read as a 2019 hybrid app with big empty cards. Dull on the phone, busy on the desktop. |

**What they share.** A white or light grey ground, cards with 8 to 16px corners, one saturated brand accent, grey list rows, a bottom tab bar and a round plus button, a completion ring and green ticks as the hero metric, pills for state, 14 to 17px type for a phone in the hand. None is designed to be read from six feet. None puts the reading itself first (Jolt's 168.2°F is a marketing frame). None has a verdict vocabulary beyond pass, fail and a percentage.

**"Better than them", checkable against this table.** The reading and its verdict word are the largest things on screen and legible at six feet. Colour is a code (a change that needs a hand), never a brand blob. No completion ring, no green tick, no bottom tab bar, no round plus. The state vocabulary has more than two words: in range, out of range, refused, due, overdue, fix open. The record reads as a document an inspector signs, not as a feed.

**Why the first Tolsey mockups read boring against this table.** They already differed on every structural point above, but they were greyer than any competitor: a cool grey wall, white cards with black borders, colour allowed inside one block. Beside Xenia's purple and FoodDocs' green they looked like a form. The direction below keeps the structural differences and commits to contrast, scale, density and one held colour.

## 2. Anchor

**A departures board and the boarding pass in your hand.** Two travel documents everyone in this audience has used: the live board above the gate that ranks flights by departure time, reflows a change in place and holds the alert colour on the changed row until you have noticed; and the pass, a document divided into labelled segments with a scannable block. Contemporary and in daily use, never a period piece.

What Tolsey takes is the grammar: checks ranked by due time; an overdue check moving up and holding the one alert colour until a number is logged; every logged check leaving the board as a pass, one record line with reading, rule, verdict, time, initials and a code. No airline, no airport, no logo lifted.

Process: chosen by the owner from a dealt hand of directions, as the competitive challenger over the assigned grounded direction (the posted grade card at full commitment) and the top-ranked grounded candidate (the signal word). The full process record is kept outside the repo.

## 3. Type

**Mona Sans** (variable, weight 200 to 900, width 75 to 125 percent) for words: the wordmark, board titles and check names at width 80 to 95 percent and weights 700 to 900, so the board reads condensed and heavy the way a gate board does. **JetBrains Mono** (400 to 800) for every figure: times, temperatures, counts, statuses and the record code. Both verified on the Google Fonts css2 endpoint on 2026-09-16 (variable latin files served), self-hosted as `mona-sans-latin.woff2` (98 kB) and `jetbrains-mono-latin.woff2` (31 kB). Nanum Pen Script stays for the launch page's paper log reconstruction only.

Why: the studio's measured font list (thirteen products' served stylesheets, read 2026-08-21) puts Mona Sans first and reserves the mono for data the audience notices. On this board the data is the surface, so the mono earns its place as measurement, not costume. Personality is bought with width and weight, never a display face. A lint warning that Mona Sans is overused is overruled by that measured list.

Scale on the wall screen (1280 by 800): the temperature reading 148px mono (a countdown or a count 108px, so a temperature is always the largest figure), the pass's verdict block 40px mono, the board title 36px, board rows 22px with a 15px second line, the pass's point 32px, board status blocks 15px mono uppercase, labels 12px mono. The cook reads the reading, its verdict and the lit row from six feet; the shift lead reads the rows from three. What the cook said sits at 22px, below the verdict, because the cook already knows what they said.

## 4. Palette

Colour strategy: high-contrast neutrals plus one alert colour reserved for change. In range is quiet: a black block on the pass, its word alone on the board and the day sheet. Anything that needs a hand (overdue, out of range, a fix open, a refusal) holds yellow until it is dealt with. Colour is never decoration and never a brand blob.

**Light** (day, the default under bright kitchen light)

| Token | Hex | Role |
|---|---|---|
| ground | `#E3E6E9` | the panel wall |
| stock | `#FFFFFF` | board and pass |
| row-alt | `#F3F4F6` | a row holding a change |
| ink | `#0B0D10` | text, rules, the verdict block |
| steel | `#5F666D` | labels and second lines |
| alert | `#FFD400` | the held change, black text |

**Dark** (the close, dim bar kitchens, and the departures board's native look)

| Token | Hex | Role |
|---|---|---|
| ground | `#0B0D10` | the wall |
| stock | `#15191E` | board and pass |
| row-alt | `#1B2026` | a row holding a change |
| ink | `#F4F6F8` | text, rules, the verdict frame |
| steel | `#A6ADB5` | labels and second lines |
| alert | `#FFD400` | the held change, black text |

Measured contrast (WCAG ratios, computed 2026-09-16 by a script over these hex values): light ink on stock 19.46, ink on ground 15.53, steel on stock 5.82, steel on row-alt 5.29, steel on ground 4.65, black on alert 13.59, white on the verdict block 19.46. Dark: ink on stock 16.29, ink on ground 17.96, steel on stock 7.79, steel on row-alt 7.23, black on alert 13.59, the verdict frame (ink on stock) 16.29. The stock to ground step is only 1.25 light and 1.10 dark, which is why every panel carries a soft lifted shadow instead of a border.

Colour is never the only signal. Every status block carries its word: IN RANGE, OUT OF RANGE, REFUSED, NO NUMBER, DUE, OVERDUE 14 MIN, LATE 20 MIN, COOLING, FIX OPEN, FIX OVERDUE 5 MIN, CLOSED ON TIME.

Weight follows need, measured after the critique of 2026-09-16: yellow alone is only 1.43 against white, the weakest block on a light board, while a filled black block is 19.46. So a yellow block always carries a 2px ink edge in light, a row that needs a hand now is lit yellow edge to edge with its status inverted (yellow word on a black block, 13.59), and a settled line on the board is its word alone. In dark the pass's verdict is a 3px white frame, not a filled white block, which glared at the close.

## 5. Structure

**The metaphor: a board ranked by due time, and a pass torn off it.**

**Skeleton, wall screen (landscape).** Right two thirds, the board: DUE NOW (due, check, rule, status) ranked by due time, then BOARDED THIS SHIFT, newest first. Left third, the newest pass in four segments divided by dashed rules: what was said and answered; the point, the reading huge, the verdict block; four labelled cells (rule, source, time, by); the record code. The clock and Log by hand sit in the top bar. An open fix shows its minutes left as the reading. A refused check shows NO NUMBER and holds yellow.

**Skeleton, record and day sheet.** The day as one board: every row a pass in a line with the same columns, printed black on white; a corrective action hangs off the line that opened it with its deadline and how it closed.

**Skeleton, judge launch page.** A one-line title and a one-sentence lede, then the pass beside the replay board in the same first screen at 1280 by 800: the product itself, never a hero banner. The replay opens on its out-of-range step and plays only when asked. Then the argument line, with the door clipboard beside the day sheet for the same shift. Then how to try it, beside the limits stated plainly.

**State vocabulary.** Due: a steel-framed block. Fix open, out of range, a refusal still open: a yellow block with an ink edge, held. Overdue, and a refused check with no number yet: the whole row lit yellow, its status a black block with a yellow word, until a number is logged. In range: the pass's verdict is a black block; on the board it is the word alone. A refusal that was retaken goes back to a steel frame. Overdue and late are two moments of one check: OVERDUE while it is still open past its time, LATE on the line once a number is logged after its time. A reading's verdict is about the reading (a reheat that closes a fix is IN RANGE), and the fix carries its own status (FIX OPEN, FIX OVERDUE, CLOSED ON TIME). A late check is the one exception on the day sheet: its line reads LATE 20 MIN in the verdict column, and the reading and rule beside it show it was in range (section 11 keeps the case where one line is both). A row holding a change that is not overdue sits on the row-alt tint. On a phone the board comes before the pass, so what is late is the first thing read. The day sheet is history, not a live board: a line that needed a hand (out of range, refused, late) keeps its yellow block after it is dealt with, because the inspector reads the exceptions first, and the fix line or the retaken reading after it shows how it was dealt with.

**Every time figure is worked out from the moment.** Printed due and logged times, relative times (14 min ago, in 18 min), overdue and countdown minutes on the board and on the pass, which checks are due and the boarded count all come from the clock of the moment shown, never typed in. Two things are still typed in the mockup and were checked against the board line by line: the handover pass's counts (readings, out of range, refused, overdue) and the clock times printed on a pass itself (when it was said, when a fix opened and when it is due). Phase 1 computes both from the record.

**Motion grammar.** Two authored moments. A new pass tears off the board (320ms, exponential ease-out, from the board side). Status cells flip in like a split-flap, top to bottom, 55ms apart. At phase 1 a row that changes rank moves in place, keeping its identity. Values snap, never count up. Reduced motion posts without movement.

## 6. Real media

- The product's own artifacts are the imagery: the board and the passes from a captured real run, the printed day sheet at full size, the record codes.
- The judge page's comparison: a photograph of a real pencilled temperature clipboard on a walk-in door, sourced with a verified licence or taken for the project, beside the day sheet of the same shift. Until it is sourced, the launch page shows a typed reconstruction in Nanum Pen Script, captioned as a reconstruction and never presented as a photograph.
- The demo kitchen's initials are invented and labelled as demo data.
- No stock kitchen photography, no illustrated chefs, no icons as decoration.

## 7. Themes

Light, Dark and Device, Device the first-run default and live on OS change, a visible switch in the top bar of the wall screen and in the footer of the record and launch pages, stored across reloads, applied before first paint by `theme.js`. Dark is designed, not derived: it is the departures board's own look.

## 8. Registry check

Against the studio's register of earlier directions, field by field:

- **Anchor family: travel documents in daily use** (a live departures board and a boarding pass). Nearest: Plainletter round one (retired), "Dutch public wayfinding and postal counters, 1968 to 1989", a period piece of transport signage copied from the client's own officialdom. Different in kind: this is the passenger's living document and the board they watch today. Also near: Tolsey's own retired first direction, a posted public verdict; a grade card judges once, a board ranks and reranks.
- **Palette shape: high-contrast neutrals plus one alert colour reserved for change.** Same family of recipe as Fothering (cool neutrals plus one safety red confined to the locked-out point) and Plainletter's second attempt (paper and ink plus one hue that may only touch words). One field matched, argued by name: here the hue marks CHANGE on a ranked board and is held until a person acts, a rule of the board rather than of a mark; the ground is a cool grey and pure white, not a warm paper, so it does not match the house palette entry either.
- **Structure metaphor: a board ranked by due time, and a pass torn off it.** Plainletter round one's metaphor was "a departure board that fills one cell at a time". One field of overlap (a board), argued: that board filled cells in sequence as a form; this one ranks by time, reflows a change in place, and pairs the board with the pass, which is the record. Against the retired recipe's third item (a physical panel, rack or board holding tokens): rows are lines in a ranked list, never tokens held in a rack, and the pass is a document, not a token.
- **Media: the product's own screens and passes, plus one real photograph.** Not flat two-colour SVG.

No single entry matches on two fields (Plainletter one overlaps on structure only; Fothering and Plainletter two on palette shape only). Rule 3 is met by its letter. By its spirit this direction sits closer to the registry than the retired first one did, and that is recorded here as a finding rather than hidden.

## 9. Rule 4, would it have suited the last products

- Throughline, an incident timeline: events, not obligations with due times and rules. Nothing boards, nothing leaves as a pass.
- Ringbolt, a live call queue: the closest, a queue by time. But a call is answered or missed, never judged against a public rule, and a handled call leaves no record line. The board half would have suited it; the pass half could not.
- bumpwarden, dependency risk: a continuous score on a shared axis, no due times.
- Plainletter, vernoemd, Fothering: no ranked obligations.

It fits because Tolsey's core is a set of checks each due at a time, judged against a rule, and kept as record lines. The board carries the first two, the pass the third. Weakest point, named: the board half is a generic queue grammar; the pass is what makes it Tolsey's.

## 10. Generic-look check

- An AI given this brief lands on the compliance dashboard (all five competitors) or the KDS ticket rail. This is neither: no cards, no rings, no ticks, no tab bar, no round plus.
- Banned looks checked: no cream and serif and terracotta; no near-black with one acid accent (dark mode is a white-on-black board with yellow reserved for change, not a neon accent on everything); no broadsheet hairlines as decoration (the rules here are the board's own columns); no warm paper and monospace (the ground is cool grey and white, the mono is data); no gradients, glass, orbs or emoji.
- Structural check: the launch page shows the working pass and replay board in its first screen, under a one-line title, not a hero then sections.
- The gut check: another model told "food safety log" does not reach a departures board; told "departures board" it reaches black-and-yellow LED type, which this is not (a printed, high-contrast document board).

## 11. Open

- Food Code values in the mockups are placeholders until phase 1 reads each one from the Food Code 2022. The four section numbers the day sheet cites were matched to their titles on 2026-09-17 through Washington's WAC 246-215, which adopts the Food Code: 3-202.11 receiving, 3-403.11 reheating for hot holding, 3-501.14 cooling, 3-501.16 hot and cold holding. Receiving has an exception phase 1 must model: a food whose distribution law sets another temperature, milk named among them, may be received at that temperature, so a flat 41°F rule on a dairy delivery can fail a legal one.
- The record code on a pass is a drawn stand-in; phase 1 decides what a record line's code encodes.
- The real Alexa+ host's styling and CSP for MCP Apps cards are unknown; cards must hold up inside a frame that is not ours.
- The clipboard photograph is not sourced yet.
- The wall screen now tells the cook to say "wrong number" to fix a misheard reading. Phase 1 decides how a correction lands on the record (a new line that points at the one it corrects, never an edit in place) or the line comes out.
- Range and timeliness are two facts about one line, and the day sheet has one verdict column: a reading logged late and out of range could show only one of them. Phase 1 stores both and the day sheet shows both.
- Readings in the mockups are whole degrees. Measured 2026-09-17: a reading with a tenth (168.2) is 95px wider than the wall's pass at the 148px reading size, and fits at the 108px count size. Phase 1 decides the precision a reading is stored and judged at, and never rounds a failing reading into a pass (41.4 is above 41).
- A record day in the mockups is a calendar day, 6:50 AM to 9:40 PM. Dim bar kitchens that close after midnight are named in section 1, so phase 1 decides where a kitchen's day starts and ends and how a time past midnight prints.
- Nothing names where a check's due time comes from (the 2:00 PM sandwich cooler, the lunch walk-in check): the rule values cite the Food Code, the schedule cites nothing. Phase 1 names that source, and whether a check gets a grace window before it reads OVERDUE.
- The one-hour reheat clock on a fix is a rule value, checked against the Food Code 2022 in phase 1 with the section numbers. Found 2026-09-16: section 3-403.11 (reheating for hot holding) gives 2 hours to reach 165°F, read through Washington's WAC 246-215-03440, which adopts it. The mockups' one hour is stricter than that default, so phase 1 either sources a one-hour house rule or moves the clock to two hours.
- `record.html` and `launch.html` were rebuilt to the gate board on 2026-09-16. The critique covered the wall screen only, so neither page has had a critique pass.
- The finish reviewer and the documenter have not run on this build yet. The critique ran on 2026-09-16 (25 of 40) and its findings are fixed in the wall screen.
