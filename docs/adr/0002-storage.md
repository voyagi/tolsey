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

A scratch kitchen accepts writes until 22 hours 45 minutes less the 120-second retry window after it
was minted (`writeWindowMs` in `src/server/kitchens.ts`, reported to the visitor as `closesAt`). An
hourly Cron Trigger deletes each kitchen aged 22 hours 45 minutes or more together with all its lines,
so while the hourly runs succeed and each starts within 15 minutes of the hour it was scheduled for,
nothing a visitor wrote outlives 24 hours. The 15 minutes are an allowance, not a measurement: a run
is handed the instant it was scheduled for (`scheduledTime`, which decides what the sweep deletes) and
Cloudflare documents no guarantee of how soon after it the run starts. The budget is charged by the
Worker's own clock, read after each round's deletes, so a late run that starts after 00:00 UTC counts
its deletes on the day they were written. A test in
`src/server/budget.test.ts` holds the retention age, the hourly cadence and that allowance inside 24
hours (PRIV-03), and the mint reports the same bound to the visitor as `expiresAt`
(`deletionBoundMs` in `src/server/kitchens.ts`). A run that fails is recorded as failed in the Cron
Trigger's past events, and the Worker logs `[retention]` with the error's name and code. Cloudflare
documents no retry of a failed run (the runtime's `controller.noRetry()` suggests one can happen, and
the Worker never calls it), so the bound counts on none: the kitchens a failed run left are deleted by
the next hourly run or the next mint's sweep, and each failed run can stretch that bound by an hour. A mint's own round that fails logs `[mint-sweep]`
the same way, and the mint goes ahead. Both sweeps run the same round, so a fault in its queries fails
the hourly run too and shows in the Cron Trigger's past events; a fault that hits only mint rounds
(a busy database under load) moves no deletion bound while the hourly runs succeed, and shows only as
`[mint-sweep]` lines. Those lines are kept because `wrangler.jsonc` turns Workers Logs on (3 days on
the free plan) with its per-request logs off, so a request that succeeds leaves no log line; the
deploy preflight refuses a config without both, or one that turns the Worker's own lines off or
samples them, turns traces on (a trace records each request's full URL), sends logs or traces to an
outside destination, turns Logpush on or attaches a Tail Worker (each receives every request's URL and
metadata), or carries a `previews` block that could turn any of these back on for preview
deployments. Workers Logs lists the Worker's own logs apart from the per-request ones, which is what
that switch turns off. It stores each of the Worker's own lines with metadata about the invocation
that wrote it. One `[mcp]` line, which a text/plain POST to a scratch kitchen writes on demand ("logs a
text/plain POST through onerror" in `src/server/logging.test.ts`), was read in the Workers Logs
dashboard after the first deploy (2026-10-16, Worker version `3312102a`). Beside the line's own name,
message and level it holds the request's method, URL and path, a trigger made of the method and path,
request, ray, trace and span ids, the Worker's name and version, the account id, a timestamp and the
event size. It holds no IP address, no request header and no body. The kitchen id in the URL, the path
and the trigger reads `REDACTED`, which matches Cloudflare's documented URL redaction of any run of 32
or more hex digits (TailRequest in the Workers documentation, read 2026-10-16). Kitchen ids are 32 hex
characters, but Cloudflare calls the redaction a heuristic subject to false positives and negatives,
so a fault line may still hold a kitchen id. Whether a request that succeeds leaves no per-request log
in the dashboard has not been read yet. Writes close one retry window early so that a retry of the last accepted
write still finds its kitchen and gets its stored result before the sweep may take it; closing at the
full retention age would let such a retry answer "not found" instead.

The sweep lives in `src/server/retention.ts`, outside the store adapter, and holds the only DELETE
statements in the codebase. A round reads expired kitchens through the `kitchens_expiry` index, at most
`sweepBatchLimit` of them on a mint and `cronSweepBatchLimit` on the hourly run, then deletes those
kitchens, their lines and their line counters with three statements over one bound JSON array of ids,
so a round is at most five statements whatever its size. The hourly run repeats rounds up to
`maxSweepRounds`, which keeps it within the free plan's 50 queries per Worker invocation while still clearing every kitchen the daily
budget can mint. It stops early only on a round that reads less than a full page: a round that read a
full page but deleted less lost part of it to a mint's round running at the same moment, and older
kitchens can still be waiting behind it. A mint reads the budget first and is refused at once when the day is full, with no
sweep; an admitted mint runs one round before its guarded insert. A round that deletes nothing writes
no budget row.

A per-kitchen line cap of 200 and a daily budget of 40,000 rows written refuse further writes with a
spoken reason, and the kitchen insert is guarded by the same budget. The caps and the sweep sizes are
held in `data/store/limits.json`. The line cap is 200 because a demo shift holds a few dozen lines, and
200 lines at the measured rows per event keeps many visitors inside the 100,000-row daily allowance.

The budget protects the account's write allowance, not the demo from one visitor: a single client that keeps minting
can spend the day's 40,000 rows, and every visitor after it is told the demo is full until 00:00 UTC.
Phase 1 has no per-client limit. Cloudflare's rate limiting binding counts per location over 10 or
60 seconds and its documentation advises against IP keys, so it cannot cap one client's day, and a
daily per-client count would need its own store. The zero-install replay is the fallback, and the
pass that attacks the running service measures a mint flood against the deployed Worker.

No edge rate limit sits in front of the Worker either (2026-10-16). Its host is on a zone on
Cloudflare's Free plan, which allows one rate limiting rule per zone, and another site on the same
zone already uses it. One rule for both would share one per-IP counter, so its threshold would either
refuse this demo's own traffic or loosen the other site's limit, and a paid plan breaks the free-tier
constraint. A Free plan rule also matches on path only, never host, and counts by IP over a 10 second
period with a 10 second block (Cloudflare's rate limiting availability by plan, read 2026-10-16). So a
request flood on the routes that invoke the Worker, `/mcp`, `/mcp/*` and `/api/*` (the
`run_worker_first` list in `wrangler.jsonc`), can still spend the account's 100,000 daily Workers
requests, which stops every Worker on the account for the rest of that day whatever this code does.
Every other request is served from static assets without invoking the Worker, which Cloudflare bills as
free and unlimited, so the page keeps loading while those routes answer 429 (Static Assets billing and
limitations in the Workers documentation, read 2026-10-16). That is accepted for the judging window.

The free allowance belongs to the account, not to this database. Cloudflare's D1 pricing page says
that once the account reaches its daily limits no query runs against D1 until the 00:00 UTC reset
(read 2026-09-26). The cap refuses writes, never retention, so a day can also spend deletions on top
of it. A delete counts one row per kitchen, one for its line counter and one per line (local D1, pinned
by "counts one row per deleted kitchen, its line counter and per deleted reading" in
`src/server/budget.test.ts`). The costliest mixes to delete are kitchens holding one line each and
empty kitchens: the mint reserves 5 rows and the line at least 10, and the kitchen, its counter and its
line delete as 3, which is 3 rows deleted for every 15 spent, the same rate as an empty kitchen's 1 for
5 and more than any kitchen with more lines. One day's budget mints about 2,667 such kitchens, or 8,000
empty ones, which delete as 8,000 rows either way. The retention age is 22 hours 45 minutes, so the
hourly runs of one UTC day delete what was minted from 00:15 of the previous day to 00:15 of that day,
which reaches into two budget days: a day can spend up to about 16,000 rows of deletion on top of its
cap, plus a budget row per round. The cap therefore assumes every other D1 database on the account
writes fewer than about 43,000 rows a day. Past the account limit a request to a scratch kitchen never
reaches its tool: the kitchen lookup in `resolveScope` fails first and the Worker answers HTTP 500 with a
`[worker]` line, as it does for a mint.

Reads are not budgeted, so the line cap never walks the kitchen's lines. Each kitchen's line count is
kept in its own row of `kitchen_lines` (migration 0003, which backfilled it from the lines already
stored), read by key in the guarded insert and in the follow-up read. The backfill is exact only
because 0003 reaches the remote database with the first deploy, which applies every migration before
any Worker has served it; a later migration that seeds bookkeeping while an older Worker still appends
would miss those appends and needs a recount after the new Worker is live. The append raises it in the same
batch as the event, under the same `changes() > 0` guard as the budget, so it counts exactly the events
stored, and retention deletes it with its kitchen. It is bookkeeping like `budget`, not the record, so
the append-only triggers do not cover it. Counting the kitchen's events instead read every line on
every call, refused ones included: 408 rows for a call refused at the 200-line cap (2026-09-27), and
about 12,000 such calls against one full kitchen would have spent the account's 5 million daily reads.
Measured on local D1 by counting `meta.rows_read` over one append (2026-10-08): an accepted reading
reads 8 rows in an empty kitchen and 10 at 150 and at 199 lines, and a call refused at the cap reads 8.
The next line number is served by the `events_day_line` index and adds no walk. The insert's guards
sit inside its derived table: on the outer SELECT, SQLite also pushed them down into it and checked
them twice. The tests "reads a handful of rows for an append refused at the line cap, however many
lines the kitchen holds" in `src/store/d1-features.test.ts` and "reads a handful of rows for an
accepted reading, however many lines the kitchen holds" in `src/server/budget.test.ts` hold both
figures.

Every other read a call makes is a handful of rows too, whatever the kitchen holds (local D1,
`meta.rows_read`, 2026-10-10, held by the "reads a handful" and "reads a bounded handful" tests in
`src/server/budget.test.ts`). Migration 0004 adds the three indexes this takes: `events_screen` on
`(kitchen_id, screen_id, seq)` over every kind but receipts, `events_ref` on `(ref_id, kind)` and
`events_root` on `root_id`. "Wrong number" seeks the screen's newest event through `events_screen` and
reads 2 rows with 199 readings on the screen beside a busier kitchen, and 2 when every event on the
screen is older than the window. It used to count the corrections of every candidate before it picked
the newest, a read that grew with the square of the screen's readings: 40 rows at 10 readings, 2,600 at
50 and 39,999 at 199. Now the newest event the screen wrote, receipts left out, is picked first and the
window is applied to it after, so a call stored later with a clock behind an earlier one is the newest
even when it falls outside the window, and then leaves nothing to correct. A reading's corrections are
counted through `events_root` and `events_ref`: 6 rows when the newest reading closes a chain corrected
twice, the most READ-05 allows. An answer counts its digit-repeat chain's misses with one count of
holds and one of refusals through `events_ref`, so the receipts naming the chain's head are never
read: 5 rows for a head 150 receipts name and 9 for a refusal on its chain, where the count walked the
kitchen before (153 rows at 150 lines). The walk back to the wrong_number event that started a
correction follows at most 8 links (`SUPERSEDE_WALK_LINKS` in `src/store/port.ts`, which both stores
read), at about two rows a link: 16 rows with the event at the last link, and 18 for the last prompt
of a 150-link chain of numberless answers, which before the bound walked all 150. A chain longer than 8 links means a host
answered "what is the number" with no number more than a handful of times, and past the bound the
number finally given is logged as a fresh line, while the wrong_number event still marks the line it
said wrong.

A tool call therefore reads at most about 30 rows: 1 for the kitchen, 0 or 1 for its request id, up to
18 for the prompt it answers or 2 to 6 for the screen's newest event, and about 10 for the append, the
read that names a refusal's reason included (held to a handful by "reads a handful of rows for an append
refused at the line cap" in `src/store/d1-features.test.ts`). At
the 100,000 Workers requests a day the account allows, that is at most about 3 million rows read, under
D1's 5 million. The costliest call is an answer that loses a race. A loser on the same prompt reads it
once more and appends its receipt. Two numbers for two questions about one line, each question at the
walk bound, make the loser read its prompt three times and append twice: 66 rows on local D1
(2026-10-11, held by "reads its prompt three times and appends twice when it loses two numbers racing at
the walk bound" in `src/server/corrections.test.ts`), plus the kitchen and whatever the batch that fails
on the unique index read before failing, for which D1 returns no figure. With about 10 for that batch,
as an accepted append reads, a day made only of such pairs would average about 53 rows a request and
pass 5 million at 100,000 requests. Such pairs cannot fill a day: the loser meets the unique index only
while the write budget has room, since an insert the budget refuses writes nothing and conflicts with
nothing, and each pair spends at least 23 rows of it, 13 for the winner's correcting line and 10 for the
loser's receipt. The 40,000 rows admit fewer than 1,800 pairs a day, under 200,000 rows read, and every
call after the budget is spent is refused at its insert within the 30 rows above. No read flood can
then stop the account's queries before its requests run out. The mint flood stays bounded by the write
budget, with the replay as its fallback, so no per-client limit is needed. A mint refused at the budget
reads its budget row and nothing else, and an admitted one runs one sweep round, whose search reads
only kitchens past their age and whose deletes read the rows they delete, as the hourly run's do, so
those reads grow with what was stored, never with the number of requests. D1 keeps no table
statistics until ANALYZE runs, and its docs recommend `PRAGMA optimize`, which runs it, after an index
is created; both plans and their handful of rows hold on a busy table that has statistics ("keeps both
plans and their handful of rows once ANALYZE has gathered statistics on a busy table" in
`src/server/budget.test.ts`).

Remote D1 after the first deploy (2026-10-16, `wrangler d1 insights tolsey --time-period 1h --sort-by
writes --json` over two `npm run test:deployed` runs; the insights group by statement text): the events
insert read 316 rows over 41 runs, about 8 each, the local figure for an accepted reading in an empty
kitchen. The kitchen lookup read 1 row on each of its 162 runs, the budget read and the sweep's search
read 1 row a run, and the request id lookup read none.

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
- `screen_id`: which surface the call came from, an opaque id the surface generates.
- `request_id`: the host's id for the utterance; the idempotency key. Both ids are held to letters,
  digits, dot, underscore, colon and hyphen, so no sentence or markup sent as an id is stored.
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
- The first delivery of every call answered with `isError` false stores exactly one event, and a retry
  answered from it stores none. A reply that records no line and
  asks no new question stores a `receipt`, so the request id index covers every accepted call and a
  retry never re-decides against state its first run changed. A receipt never moves a check, so a
  "wrong number" is never one: even the third about one chain, answered "Log it by hand" with no
  question, stores a `wrong_number` marker on the line, which keeps the check open until a new number
  is logged.
- The partial `UNIQUE (kitchen_id, business_day, day_line) WHERE day_line IS NOT NULL` holds the
  record code. The day line is allocated inside the INSERT for readings and refusals only, so a day's
  record codes never skip a number for a held question, a wrong_number marker or a receipt.
- Partial unique indexes on `supersedes_id` and on `answers_id` make supersede-once and answer-once
  database invariants, never a read before the write.
- The record code, the business day as `YYMMDD`, a hyphen and the day line padded to three digits
  (for example `261020-014`), is written into the stored result by `json_set` inside the same INSERT,
  so the stored result is complete when it lands and never needs an UPDATE.

## Rows written per write

Measured on local D1 through `getPlatformProxy` on this schema (migrations 0001 to 0004, 2026-10-10) by the test
"measures rows written per write kind equal to data/store/rows-per-write.json" in
`src/store/d1-features.test.ts`, run with `npx vitest run --project store`, and, for `budget_add`, by
"measures the rows the sweep budget add writes as the first write of a UTC date equal to budget_add"
in `src/server/budget.test.ts`:

| Write kind | Rows written |
|------------|--------------|
| `kitchen_create` | 5 |
| `event_first_of_day` | 10 |
| `event` | 9 |
| `event_superseding` | 11 |
| `event_answering` | 10 |
| `event_referencing` | 10 |
| `budget_add` | 2 |

`kitchen_create` is a mint as the first write of its UTC date: the kitchen row with its two index rows,
plus the budget row's insert, the safe direction. `budget_add` is the retention sweep's own bookkeeping,
the budget row's insert as the first write of a date; later adds of the same date write one row.

`event_first_of_day` is an event plus the first budget upsert of its UTC date and its kitchen's first
line-counter upsert, and `event` a later event of the same date and kitchen; the difference of one is
the budget row's insert against its update. The counter table is `WITHOUT ROWID`, so its key is the
table itself and the counter row's insert writes one row, as its update does. Every measured event is
a reading, which also writes the day-line index row and the `events_screen` row. The superseding one
names its chain's root as well, as the domain writes a correcting line, so `event_superseding` covers
both `events_supersedes` and `events_root`, and the referencing one carries a `ref_id`, which fills
`events_ref`.

The adapter cannot know before the batch runs whether the date's budget row or the kitchen's counter
row exists or which partial indexes the event fills, so every event append reserves `expectedRowsFor(event)` from
`src/store/port.ts`: the `event_first_of_day` figure, plus `event_superseding - event` when the event
supersedes a line or names a chain's root (a `root_id` alone fills `events_root`, so it reserves both
rows and errs high by one), plus `event_answering - event` when it answers a prompt, plus
`event_referencing - event` when it names a line or a prompt in `ref_id`. A matrix test in the same
file measures every event kind (reading, refusal, held, wrong_number, receipt) with every combination
of the partial index keys, none of them included: a `supersedes_id` with its chain's root, an
`answers_id` and a `ref_id`, plus a `root_id` alone, which no shipped path writes. Each runs as the
first event of a UTC date and as a later one, and the measured rows stay at or below the reserve in
all 90 cells. A second test does the
same for every shape of event the domain stores, with the links it stores them with: a reading, an
answer, a correcting reading, a wrong_number marker, a hold and a refusal on a digit-repeat chain, a
receipt naming a prompt and a receipt ending a chain. The reserve runs high
only by the budget insert on later events, by the day-line index row a held,
wrong_number or receipt event skips and by the `events_screen` row a receipt skips, which is the safe
direction.

Retention deletes count against the same daily allowance. A round adds the summed `meta.rows_written`
of its delete batch, plus `budget_add`, with no cap check: retention is never refused. Unlike an
insert, a delete counts one row per kitchen, one per line counter and one per line on local D1, with
no index rows (the pinned test named in the write model).

Remote D1 after the first deploy (2026-10-16, the same insights command over the same two runs): the
events insert wrote 287 rows over 41 runs, 7 on average, the kitchens insert 126 over 42, 3 each, and
the budget and line-counter upserts 1 row on each of their 34 and 26 runs. Each is at or under the
local figure it belongs to: 7 with one budget row and one counter row is the local `event` figure of 9,
and 3 with one budget row is 4 against the 5 reserved for a mint. The insights group by statement
text, so every event kind shares one INSERT and the 7 is an average over the kinds the suite sent, not
a figure per kind. The reserve stays the local measurement. No kitchen reached its retention age
within that hour, so remote deletes are not measured yet.

## Append-only guard

Migration `0002_append_only_guard.sql` holds three triggers: an UPDATE of any events row aborts with
"events are append-only", a DELETE of an events row aborts while its kitchen row exists (retention
deletes the kitchen row first and then its lines, in one batch), and an UPDATE of a kitchens row
aborts with "kitchens are fixed once created", because a kitchen's time zone and day start decide
every business day already written. Local D1 accepts and enforces all three through
`getPlatformProxy`, through the built Worker in workerd, and through
`wrangler d1 migrations apply DB --local`, which applied 0001 and 0002 on its first run and reported
no migrations to apply on its second.

Remote D1 accepted 0002 at the owner's first deploy (2026-10-16, Worker version `3312102a`): `wrangler
d1 migrations apply DB --remote` applied 0001 to 0004 with status ok for each and no refusal. No
UPDATE or DELETE has been tried against the remote record, so remote enforcement rests on D1 running
the triggers it accepted. The guard sits alone in 0002 so a remote refusal could never block the
schema in 0001, and the phase 1 test that reads the adapter's SQL for any UPDATE or DELETE against the
record holds either way.

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

The owner creates the database with `wrangler d1 create tolsey --jurisdiction=eu --binding DB`
(`--binding DB` writes the id into the existing `DB` entry rather than a second one). The jurisdiction
is set only at creation, cannot be changed afterwards, and takes precedence over any location hint.
EU is chosen because data stays in EU regions wherever a service offers one. The trade-off is added
round-trip latency for requests from the US, which is I/O wait and not Worker CPU time. The owner
confirms the jurisdiction at creation. The database was created on 2026-09-27 with jurisdiction
`eu` (read back with `wrangler d1 list` on 2026-10-16), and `wrangler.jsonc` carries its id on the
`DB` binding since 2026-10-16. Local D1, `getPlatformProxy`, `createTestHarness` and `wrangler d1
migrations apply --local` never reach it, so no test can reach a remote database. The id, not the
name, is what pins the Worker to the EU database: wrangler 4.131 deploys a binding with no id by binding a
database named `tolsey` found on the account, or by creating one under that name with no jurisdiction.
The deploy preflight refuses a config without the id for that reason. It checks that an id is set, not
which database it names, so the id copied in has to be the EU database's own.

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
- Owner steps before the first deploy, all done by 2026-10-16: the database created with its
  jurisdiction, the `database_id` added, the first remote migration run with its verdict recorded
  here, and the hourly Cron Trigger registered by the deploy, one of the 5 the free plan allows.
