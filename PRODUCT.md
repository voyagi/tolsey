# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Shift lead** at an independent US restaurant, cafe or food truck. Owns the day's food safety record: opening and closing checks, what is due now, corrective actions, the handover to the next shift. The primary user.
- **Cook** on the line or at the walk-in. Takes the readings mid-service with gloved hands, often a few steps from the device, in noise and steam. Speaks; glances at the screen; never types.
- **Health inspector** (and the owner-operator). Reads the output: the day sheet, printed or on screen, looking for gaps, out-of-range readings and whether each was dealt with in time.
- **Hackathon judge** (Amazon Developer Hackathon, Alexa+ track). Has nothing installed and under a minute. Must see a spoken reading become a record line, a vague check refused, and a corrective action closed on time. May judge from the description, images and video alone.

## Product Purpose

Replace the paper temperature log and the opening and closing clipboard in a small kitchen with a record taken by voice, judged against the food code rule as it is taken, and readable by an inspector. Success: every check in the day has a number, a time, a rule and a verdict, and every out-of-range reading has a corrective action that closed on time or is visibly overdue.

## Positioning

- Takes the checks a fridge sensor cannot: hot holding on the line, cooling stages, receiving, taken by a person with gloved hands in the middle of service, on a device already on the counter.
- Refuses a check with no number. "The fridge is fine" stays open. A check without a number is the pencil-whipped clipboard the record exists to replace.
- Incumbents (Jolt/SmartSense, FoodDocs, Operandio, Xenia, Restoke) are screen apps or wireless fridge sensors. None takes these checks by voice.

## Operating Context

- A small commercial kitchen during service: heat, steam, noise, bright or uneven light, wet or gloved hands, attention split with cooking.
- The device is an Alexa+ screen (Echo Show class) on a kitchen wall or counter, read from a few steps away. Amazon lists the Alexa+ MCP Toolkit as available in the United States. A judge has nothing installed and the hackathon allows a simulated experience, so the entry ships a simulated Alexa+ surface in the browser; the MCP server behind it is real.
- Artifacts that exist today in this world: the clipboard temperature log on the walk-in door, opening and closing checklists, the shift handover conversation, the inspector's visit.
- The judge's path: a launch page, a zero-install replay of the demo shift, a video under three minutes. The replay is scripted from the demo kitchen's record and is labelled as such until a real run is captured and its licence settled.

## Capabilities and Constraints

- Surfaces: (1) the simulated Alexa+ surface showing the spoken exchange and MCP Apps cards (what is due now, the reading just logged, an open corrective action with time left, the shift handover); (2) the record: today's log and the printable inspector day sheet, read from storage; (3) the judge launch page with the zero-install replay.
- MCP tools: log a reading (cold holding, hot holding, cooling stages, receiving); opening and closing checklists; open and close corrective actions with time limits; what is due now; shift handover summary; the day sheet.
- Rule values default to the FDA Food Code 2022 and live as data with their source named. State and county codes vary. Values are verified against the Food Code in phase 1 before any reaches code.
- Temperatures in °F, stored with the unit.
- The simulated surface uses a deterministic intent layer. No live model spend by default.
- MCP Apps cards render inside a host iframe the product does not control (the real Alexa+ host's styling and CSP are unknown).
- Staff initials tied to shifts are personal data; the demo kitchen uses invented initials. No customer data of any kind.
- Out of scope: sensor or probe hardware, POS, multi-site dashboards, scheduling or payroll, a real Alexa device, an EU HACCP variant.
- Stack (existing): TypeScript, React 19, Vite 8, Cloudflare Workers with static assets, MCP 2025-11-25 over Streamable HTTP, MCP Apps 2.x.

## Brand Commitments

- Name: Tolsey. A tolsey was the building in an English market town where tolls were paid and the market's court sat, the place a market's dealings went on the record.
- Look and feel (owner, 2026-09-16, binding): it must look better than the other food safety tools out there. Modern and fun, but still useful, functional and serious enough for a business. A restrained, mostly grey first attempt ("The Posted Grade Card" mockups) was judged boring.
- Voice: plain kitchen language, the words a line cook uses. Never SaaS copy. Active verbs.
- No em dashes or en dashes anywhere. No real names. No Amazon or Alexa trademarks as branding (the surface is described as simulated).
- Draft lines from the judged ledger: tagline "Say the reading. Tolsey keeps the record, and refuses a check with no number."; memorable line "A check without a number is not a check."

## Evidence on Hand

- None yet beyond the build spec (kept outside the repo) and local research notes.
- No captured runs, no measured time-per-check, no users, no testimonials. Every number shown to a judge is measured before it is printed; nothing is fabricated.

## Product Principles

1. A number or it did not happen: the product never records a check without a value.
2. The record is the product: every surface reads the stored record, never a tool's reply.
3. Readable at a glance from across a kitchen, readable line by line by an inspector.
4. Kitchen words, not software words.
5. Show the limits plainly: simulated Alexa+, default FDA values, no sensors.

## Accessibility & Inclusion

- WCAG 2.2 AA (2.1 AA the legal floor).
- The use scene is itself a disability-like context: gloved or wet hands, glare, distance, noise, divided attention. Large targets, high contrast, glanceable status that never relies on color alone.
- Voice is the primary input; every action also works by touch and keyboard for the simulated surface.
- The day sheet must print legibly in black and white.
