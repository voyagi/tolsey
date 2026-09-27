# 0002: Storage

Date: 2026-09-27. Status: accepted.

## Context

Every reading a cook gives becomes a line in an append-only food safety record, numbered on its
business day, judged against the rule in force when it was written, and never edited afterwards.
A correction is a new line pointing at the one it supersedes. The public endpoint is
unauthenticated, runs on the Workers free plan, and must not let one visitor's writes reach
another's record. This record fixes where that record lives, its schema, and the write model,
before any tool writes to it.

## D1 over Durable Objects

D1 is the store. The store suite runs in Node Vitest 5 against a real local D1 from wrangler's
`getPlatformProxy`, and the built Worker runs against the same binding in workerd, so every
guarantee below is tested on the engine that ships. A day's record is a join and a date filter, which
is what a relational store is for. The free plan allows 5 million rows read and 100,000 rows
written per day, reset at 00:00 UTC (Cloudflare's D1 pricing page).

Durable Objects with SQLite storage were considered and not chosen. Their main addition is alarms,
and alarms buy nothing here: there is no push channel to a kitchen, so a deadline only matters when
someone reads the record, and overdue is computed at read time. Testing Durable Object internals
also needs the Workers Vitest integration, which still declared a peer of `vitest ^4.1.0` on
2026-09-25, while this repository runs Vitest 5.

Workers KV was rejected: it is eventually consistent, so a line written and read back at once can
be missing, and it has no queries.

## Write model

The bare `/mcp` serves the demo kitchen, which is read-only: it is the seeded `kitchens` row of kind
`demo`, and in phase 2 its day becomes an overlay computed at read time. A visitor's writes land in
a scratch kitchen minted by `POST /api/kitchens`, which generates a 128-bit id on the server. A
scratch kitchen is addressed only through the path `/mcp/k/<id>` and never through a tool
argument. A named kitchen is a scratch kitchen minted with a label from the closed list `capture`
or `conformance`; the label gives it no special rights.

A scratch kitchen accepts writes until 23 hours less the 120-second retry window after it was minted
(`writeWindowMs` in `src/server/kitchens.ts`, reported to the visitor as `closesAt`). An hourly Cron
Trigger deletes each kitchen aged 23 hours or more together with all its lines, so nothing a visitor
wrote outlives 24 hours. Writes close one retry window early so that a retry of the last accepted
write still finds its kitchen and gets its stored result before the sweep may take it; closing at the
full 23 hours would let such a retry answer "not found" instead.

The sweep lives in `src/server/retention.ts`, outside the store adapter, and holds the only DELETE
statements in the codebase. A round reads expired kitchens through the `kitchens_expiry` index, at most
`sweepBatchLimit` of them on a mint and `cronSweepBatchLimit` on the hourly run, then deletes those
kitchens and their lines with two statements over one bound JSON array of ids, so a round is at most
four statements whatever its size. The hourly run repeats rounds up to `maxSweepRounds`, which keeps it
under the free plan's 50 queries per Worker invocation while still clearing every kitchen the daily
budget can mint. A mint reads the budget first and is refused at once when the day is full, with no
sweep; an admitted mint runs one round before its guarded insert. A round that deletes nothing writes
no budget row.

A per-kitchen line cap of 200 and a daily budget of 40,000 rows written refuse further writes with a
spoken reason, and the kitchen insert is guarded by the same budget. The caps and the sweep sizes are
held in `data/store/limits.json`. The line cap is 200 because a demo shift holds a few dozen lines, and
200 lines at the measured rows per event keeps many visitors inside the 100,000-row daily allowance.

The free allowance belongs to the account, not to this database. Cloudflare's D1 pricing page says
that once the account reaches its daily limits no query runs against D1 until the 00:00 UTC reset
(read 2026-09-26). The 40,000 cap therefore assumes every other D1 database on the account writes
fewer than the remaining 60,000 rows a day, and past the account limit every tool call answers with
the fixed server-fault sentence.

## Events table

One append-only `events` table holds every line. `business_day` and `time_zone` are stored at write
time, lines are read through the index `events_day` on `(kitchen_id, business_day, seq)`, and lines
are ordered by `seq`, never by a timestamp. Each column exists from the first line because none of
them can be filled in faithfully later:

- `seq`: the insertion order; the order in which lines committed cannot be reconstructed afterwards.
- `id`: the opaque id other lines point at through `supersedes_id`, `answers_id` and `ref_id`.
- `kitchen_id`: which kitchen wrote the line; the only scope of every read and every retention delete.
- `kind`: reading, refusal, held, wrong_number or receipt; it decides whether the line takes a day line.
- `occurred_at`: the single clock read of the command, in UTC milliseconds.
- `business_day`, `time_zone`: the kitchen's day as computed at write time; recomputing later under a
  changed zone or day start would move lines between days.
- `day_line`: the line number in the record code; allocated inside the INSERT, never renumbered.
- `screen_id`: which surface the call came from.
- `request_id`: the host's id for the utterance; the idempotency key.
- `origin`: `person` or `seed`, so a seeded demo line never reads as a cook's.
- `check_point_id`, `measured`: where the reading was taken and what was measured.
- `initials`: who took it.
- `words`: what was said, within the intent vocabulary.
- `value_tenths`, `unit`: the number exactly as given, in integer tenths of a degree Fahrenheit.
- `outcome`, `verdict`: the judgment made at write time.
- `rule_id`, `rule_snapshot`, `rules_version`: the rule the line was judged against, so a later edit
  of the rule table never re-judges an old line.
- `supersedes_id`, `root_id`: the correction chain.
- `ref_id`, `answers_id`, `prompt_kind`, `expires_at`: the questions the record asks and the lines
  that answer them.
- `due_slot_id`, `due_at`: nullable snapshot of the due slot a reading satisfied, filled from phase 2.
- `result_json`, `args_hash`: the stored tool result and the hash of the call's arguments, for
  idempotency.

## Due slot rule

A reading satisfies the earliest open slot of its check point whose window contains it (SCHED-03,
applied in phase 2). The slot it satisfied is written into `due_slot_id` and `due_at` when the line
is appended, so a later change of the schedule never moves an old reading to another slot.

## Key shape

- `seq INTEGER PRIMARY KEY AUTOINCREMENT` orders the record, and `id` is a unique opaque id.
- `UNIQUE (kitchen_id, request_id)` is the idempotency key. A repeat of the same arguments inside the
  retry window (120 seconds, `data/store/limits.json`) returns the stored `result_json` byte for byte
  and writes nothing. A reused id with different arguments is refused, and a same-arguments repeat
  past the window is refused as expired. The two are told apart by `args_hash` and the stored
  `occurred_at`, and the stored event decides before any cap, window or budget refusal, so a retry
  still gets its answer after the write window has closed.
- The retry window exists because the host that chooses `request_id` is often a model, which can
  restart an id counter in a fresh conversation: without it, a new reading with the same arguments
  as an old one would be answered with the old result and never stored. Idempotency still rests on
  the host sending a new random id per utterance, which the `request_id` description asks for.
- Every call answered with `isError` false stores exactly one event. A reply that records no line and
  asks no new question stores a `receipt`, so the request id index covers every accepted call and a
  retry never re-decides against state its first run changed.
- The partial `UNIQUE (kitchen_id, business_day, day_line) WHERE day_line IS NOT NULL` holds the
  record code. The day line is allocated inside the INSERT for readings and refusals only, so a day's
  record codes never skip a number for a held question, a wrong_number marker or a receipt.
- Partial unique indexes on `supersedes_id` and on `answers_id` make supersede-once and answer-once
  database invariants, never a read before the write.
- The record code, the business day as `YYMMDD`, a hyphen and the day line padded to three digits
  (for example `261020-014`), is written into the stored result by `json_set` inside the same INSERT,
  so the stored result is complete when it lands and never needs an UPDATE.

## Rows written per write

Measured on local D1 through `getPlatformProxy` on this schema (migrations 0001 and 0002) by the test
"measures rows written per write kind equal to data/store/rows-per-write.json" in
`src/store/d1-features.test.ts`, run with `npx vitest run --project store`, and, for `budget_add`, by
"measures the rows the sweep budget add writes as the first write of a UTC date equal to budget_add"
in `src/server/budget.test.ts`:

| Write kind | Rows written |
|------------|--------------|
| `kitchen_create` | 5 |
| `event_first_of_day` | 8 |
| `event` | 7 |
| `event_superseding` | 8 |
| `event_answering` | 8 |
| `budget_add` | 2 |

`kitchen_create` is a mint as the first write of its UTC date: the kitchen row with its two index rows,
plus the budget row's insert, the safe direction. `budget_add` is the retention sweep's own bookkeeping,
the budget row's insert as the first write of a date; later adds of the same date write one row.

`event_first_of_day` is an event plus the first budget upsert of its UTC date, and `event` a later
event of the same date; the difference of one is the budget row's insert against its update. Every
measured event is a reading, which also writes the day-line index row.

The adapter cannot know before the batch runs whether the date's budget row exists or which partial
indexes the event fills, so every event append reserves `expectedRowsFor(event)` from
`src/store/port.ts`: the `event_first_of_day` figure, plus `event_superseding - event` when the event
supersedes a line, plus `event_answering - event` when it answers a prompt. A matrix test in the same
file measures every event kind (reading, refusal, held, wrong_number, receipt), with no partial index
key, a `supersedes_id` only, an `answers_id` only and both, as the first event of a UTC date and as a
later one, and holds the measured rows at or below the reserve in all 40 cells. The reserve runs high
only by the budget insert on later events of a date and by the day-line index row a held,
wrong_number or receipt event skips, which is the safe direction.

Retention deletes count against the same daily allowance. A round adds the summed `meta.rows_written`
of its delete batch, which counts index rows as well as table rows, plus `budget_add`, with no cap
check: retention is never refused. All numbers are measured again on remote D1 at the first deploy.

## Append-only guard

Migration `0002_append_only_guard.sql` holds three triggers: an UPDATE of any events row aborts with
"events are append-only", a DELETE of an events row aborts while its kitchen row exists (retention
deletes the kitchen row first and then its lines, in one batch), and an UPDATE of a kitchens row
aborts with "kitchens are fixed once created", because a kitchen's time zone and day start decide
every business day already written. Local D1 accepts and enforces all three through
`getPlatformProxy`, through the built Worker in workerd, and through
`wrangler d1 migrations apply DB --local`, which applied 0001 and 0002 on its first run and reported
no migrations to apply on its second.

Remote D1's verdict arrives with the owner's first `wrangler d1 migrations apply DB --remote`. The
guard sits alone in 0002 so a remote refusal can never block the schema in 0001, and the phase 1
test that reads the adapter's SQL for any UPDATE or DELETE against the record holds either way.

The deploy preflight cannot see a remote refusal, and the deploy script runs the remote apply before
`wrangler deploy`, chained with `&&`, so a refusal of 0002 stops the deploy after 0001 has applied,
and every rerun meets the same refusal. The recovery is a code change the owner then deploys: 0002 keeps its
number and file name, its body becomes a statement that changes nothing, this record gains the
refusal text and its date, and append-only rests on the port and the SQL-text test alone.
`wrangler d1 migrations apply` applies the unapplied migrations and rolls back one that fails
(Wrangler's D1 command reference, read 2026-09-26), so the refused 0002 stays unapplied and the
rewritten one applies on the next run.

## ui:// naming

The card resources are `ui://tolsey/reading.html`, `ui://tolsey/due-now.html`,
`ui://tolsey/open-action.html` and `ui://tolsey/handover.html`. They are fixed as constants in
`src/contract` from the first tool on and attached to the tool definitions when the cards arrive in
phase 2. The drift test for captured runs (DEMO-03) validates tool presence, `outputSchema` and
`structuredContent`, not `_meta`, so attaching the URI later does not break a capture.

## Location and jurisdiction

The owner creates the database with `wrangler d1 create tolsey --jurisdiction=eu`. The jurisdiction
is set only at creation, cannot be changed afterwards, and takes precedence over any location hint.
EU is chosen because data stays in EU regions wherever a service offers one. The trade-off is added
round-trip latency for requests from the US, which is I/O wait and not Worker CPU time. The owner
confirms the jurisdiction at creation. Until then `wrangler.jsonc` carries the `DB` binding with no
`database_id`: local D1, `getPlatformProxy`, `createTestHarness` and `wrangler d1 migrations apply
--local` all accept the entry without one, and no test can reach a remote database.

## Test harness

- The store suite runs in Node Vitest 5 with D1 from `getPlatformProxy({ persist: false,
  remoteBindings: false })`. Migrations are split with wrangler's own SQL splitter and applied in
  `beforeAll`, and the suite throws, never skips, when the `DB` binding is missing.
- `npm run test:e2e` builds the Worker with `vite build` and runs the built `dist/tolsey/wrangler.json`
  in workerd through `createTestHarness`, with the ASSETS and DB bindings, applying the migrations
  with `applyD1Migrations`. This refines the earlier plan to spawn `wrangler dev`: it is the same
  workerd runtime with no port polling.
- The reference MCP client, `@modelcontextprotocol/client`, drives every conformance target: in
  process, in workerd and against the deployed Worker.
- The fallback, Vitest 4.1.11 with the Workers Vitest plugin, was not needed.

## Consequences

- Later work keeps the record append-only: no UPDATE or DELETE of a line anywhere, and retention's
  whole-kitchen delete is the only removal.
- One clock read per command, passed down; nothing below the tool adapter reads the time itself.
- Invariants stay constraints in the database (unique and partial unique indexes, triggers, the
  guarded INSERT), never a read followed by a write.
- A change to the schema that alters rows written turns the store suite red until
  `data/store/rows-per-write.json` and this record are measured again.
- Owner steps before the first deploy: create the database with its jurisdiction, add the
  `database_id`, run the first remote migration and record its verdict here, and confirm Cron Trigger
  headroom on the account, which allows 5 on the free plan.
