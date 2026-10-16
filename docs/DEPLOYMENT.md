# Deployment

Tolsey deploys as one Cloudflare Worker with static assets, a D1 database bound as `DB`, an hourly
Cron Trigger and one custom domain. There is no deploy job in CI: a deploy is `npm run deploy`, run
by hand from a checkout, and that script refuses to reach `wrangler deploy` until the built config,
the deploy order and the remote database all check out.

For what each configuration key means, see [CONFIGURATION.md](CONFIGURATION.md). This page covers
how those keys reach production and what guards them on the way. Throughout, `<deployed hostname>`
stands for the production host.

## Deployment targets

| Target | Config | Notes |
|--------|--------|-------|
| Cloudflare Workers with static assets | `wrangler.jsonc` (`main`, `assets`) | The Worker code handles `/mcp`, `/mcp/*` and `/api/*` (`assets.run_worker_first`). Every other path is served from the built web app. Cloudflare Pages is not used. |
| Cloudflare D1 | `wrangler.jsonc` `d1_databases`, binding `DB` | Schema under `migrations/`, applied with `wrangler d1 migrations apply`. |
| Cron Trigger | `wrangler.jsonc` `triggers.crons` | `0 * * * *`: the hourly retention sweep. |
| Custom domain | `wrangler.jsonc` `routes` | One route, `{ "pattern": "<deployed hostname>", "custom_domain": true }`. `workers_dev` and `preview_urls` are both `false`, so there is no second public URL. |
| Workers Logs | `wrangler.jsonc` `observability` | The Worker's own fault lines are kept, per-request logs are off. |

There is no Dockerfile and no other hosting config in the repository.

## Before the first deploy

The first deploy needs these steps first. Steps 1 and 2 are done: the `tolsey` database exists under
the EU jurisdiction and `wrangler.jsonc` carries its id. A move to another Cloudflare account repeats
them.

### 1. Create the D1 database

`docs/adr/0002-storage.md` ("Location and jurisdiction") records the command. It creates the
database under the EU jurisdiction, which is set only at creation and cannot be changed afterwards:

```bash
npx wrangler d1 create tolsey --jurisdiction=eu --binding DB
```

Run it while Wrangler is logged in to the Cloudflare account that will own the Worker, the database
and the custom domain (`npx wrangler whoami` shows which account that is).

`--binding DB` makes Wrangler write the new id into the existing `DB` entry of `wrangler.jsonc`
without asking. Without it, Wrangler asks whether to add the database to the config and offers the
binding name `tolsey`; accepting that adds a second entry beside `DB`, which still has no id, and
the preflight refuses the deploy.

### 2. Check the database id in `wrangler.jsonc`

After step 1 the existing `DB` entry carries the id as `database_id`. If the database was created
another way, copy its id from `npx wrangler d1 list` onto that entry by hand:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "tolsey",
    "database_id": "<database id>",
    "migrations_dir": "migrations"
  }
]
```

Local development, the test harnesses and `wrangler d1 migrations apply DB --local` all accept the
entry without an id, so nothing local breaks while it is missing. The deploy preflight refuses the
deploy until it is set (see below).

Commit `wrangler.jsonc` with the id before the first deploy, so every commit that is ever deployed
carries it. The rollback procedure below checks out an earlier deployed commit: with the id kept as a
local edit, that checkout is refused when `wrangler.jsonc` changed in between, or loses the edit, and
then the preflight refuses the deploy.

### 3. Check the custom domain and `ALLOWED_HOSTNAMES`

The deployed hostname has to agree in every tracked place that names it:

- `wrangler.jsonc` `vars.ALLOWED_HOSTNAMES`: the deployed hostname and nothing else.
- `wrangler.jsonc` `routes`: the custom-domain route for that hostname.
- `DEPLOYED_HOST` in `scripts/deploy-preflight.mjs`: the hostname the preflight requires in both
  places above.
- The tests that pin the shipped list: `src/server/built-worker.e2e.test.ts` (the built allowlist),
  and the `DEPLOYED` constants in `src/server/worker.test.ts` and `src/server/hostile-input.test.ts`.
- The preflight's own `--selftest` cases that spell the hostname out instead of using `DEPLOYED_HOST`
  (`scripts/deploy-preflight.mjs`). `npm test` runs that selftest, so a missed one turns it red.

Moving to another hostname means changing all of them together.

`ALLOWED_HOSTNAMES` is checked by the Worker on every request to `/mcp`, `/mcp/*` and `/api/*`. A
missing or malformed list answers HTTP 503, and a `Host` or `Origin` outside the list is refused.
The parsing rules are in `parseAllowlist()` (`src/server/allowlist.ts`) and listed in
[CONFIGURATION.md](CONFIGURATION.md#required-vs-optional-settings). The deployed list must hold the
deployed hostname alone: the `Origin` check compares hostnames only, so a page served under any other
listed name (a loopback dev server, a LAN address) would pass it. The local dev server answers on
`localhost,127.0.0.1` through `DEV_ONLY_VARS` in `vite.config.ts`, which is applied for `vite serve`
only and never reaches a build.

The custom-domain route attaches the hostname to the Worker during the deploy. Cloudflare's Custom
Domains documentation lists what the hostname's zone needs beforehand. If the hostname already has
DNS records, or is the custom domain of another Worker on the account, `wrangler deploy` asks whether
to take it over, and answering no stops the deploy. Run the deploy from an interactive terminal:
without one, Wrangler skips both questions and takes over the existing records and the other
Worker's domain without asking.

### 4. Check Cron Trigger headroom

The hourly trigger counts against the account's Cron Trigger allowance. `docs/adr/0002-storage.md`
lists confirming that headroom as a step before the first deploy and records the free plan
allowance as 5.

## Build pipeline

### CI

`.github/workflows/ci-gates.yml` (workflow `gates`, job `gate`) runs on every pull request and on
pushes to `main` or `master`. It installs with `npm ci --ignore-scripts`, rebuilds only `esbuild` and
`workerd`, then runs `npm run build --if-present`, `npm run gate`, `npm test`,
`npm run test:coverage`, `npm run gate:test-count`, `node scripts/check-client-secrets.mjs` and a
Trivy vulnerability scan. It deploys nothing and holds no Cloudflare credentials.

`npm test` includes `src/server/deploy-gates.test.ts`, which runs the `--selftest` of both deploy
gates below, so a refusal that stops being reachable turns CI red.

### The deploy script

`package.json` defines:

```bash
npm run build && node scripts/deploy-preflight.mjs && wrangler d1 migrations apply DB --remote && node scripts/check-remote-migrations.mjs && wrangler deploy
```

Every step is joined by `&&`, so the first step that exits non-zero stops the chain. In order:

1. **`npm run build`** (`vite build`). Builds the web app and the Worker, and writes the config that
   ships to `dist/tolsey/wrangler.json`. The `@cloudflare/vite-plugin` rewrites the config at build
   time, so this file, not `wrangler.jsonc`, is what deploys.
2. **`node scripts/deploy-preflight.mjs`**. Reads `dist/tolsey/wrangler.json` and `package.json` and
   refuses the deploy on any of the problems listed in the next section. It only reads files: no
   writes, no child processes, no network.
3. **`wrangler d1 migrations apply DB --remote`**. Applies every unapplied file under `migrations/`
   to the remote database. Wrangler asks for confirmation first; answer yes.
4. **`node scripts/check-remote-migrations.mjs`**. Lists the remote migrations and stops the deploy
   unless none are left to apply (see below).
5. **`wrangler deploy`**. Ships the built Worker and assets.

To deploy, start from a clean checkout (`git status` lists no changes), install from the lockfile the
way CI does, then run the script with the commit as the version's message:

```bash
npm ci --ignore-scripts
npm rebuild esbuild workerd
npm run deploy '--' --message "$(git rev-parse HEAD)"
```

The same three lines work in Bash and in PowerShell. Arguments after `--` go to the last step,
`wrangler deploy`, which stores the message with the uploaded version. Wrangler records no commit on its
own, so this message is the only record of what was deployed, and the rollback procedure below reads
it. Keep the quotes around `--`: Windows PowerShell runs npm through its `.ps1` shim, which drops a
bare `--` and the message with it, and the deploy then goes ahead with no record.

A `node_modules` left by another branch or by `npm install` can hold versions CI never tested, and the
build ships whatever it finds there.

### What the preflight refuses

`scripts/deploy-preflight.mjs` exits `0` when the config clears, `1` when it refuses (listing every
problem at once, not only the first), and `2` when it cannot run, for example when
`dist/tolsey/wrangler.json` does not exist or does not parse. A refusal prints
`Nothing was deployed. Fix wrangler.jsonc or package.json, then npm run deploy again.`

| Check | Refused when | Why |
|-------|--------------|-----|
| `d1_databases` | There is no `DB` entry, or its `database_id` is absent, empty or the all-zero placeholder | The id pins the Worker to the one database it names, so it has to be the id of the database step 1 created under the EU jurisdiction: the preflight checks that an id is set, not which database it belongs to. Without it, `wrangler deploy` does not stop: it binds a database named `tolsey` if the account has one, and otherwise creates one under that name with no jurisdiction and none of the tables, so every scratch-kitchen request and every mint then answers HTTP 500. |
| `vars.ALLOWED_HOSTNAMES` | It fails `parseAllowlist()`, does not name the deployed hostname, or names any other host beside it | The Worker refuses the whole list over one bad entry (every request would get a 503), a missing deployed host makes the `Host` check refuse every real request, and any extra name would pass the `Origin` check. |
| `workers_dev`, `preview_urls` | Either is not exactly `false` (absent counts as not false) | `true` publishes a second public URL on the account's `workers.dev` subdomain. Absent leaves the choice elsewhere: Wrangler sets `workers_dev` from the routes (on only when there are none), and leaves Preview URLs to the platform's default. |
| `routes` | No `{ "pattern": "<deployed hostname>", "custom_domain": true }` route | The Worker would not be served on its custom domain. |
| `triggers.crons` | `0 * * * *` is missing | The hourly retention delete would never run. |
| `observability.enabled` | Not exactly `true` | None of the Worker's own fault lines would be kept, the `[retention]` and `[mint-sweep]` lines that show a failed sweep included. |
| `observability.logs.invocation_logs` | Not exactly `false` (absent counts as not false, since Wrangler fills it in as true) | Every request's URL, which carries the kitchen id, would be logged. |
| `observability.logs.enabled`, `observability.logs.persist` | Present and not `true` | The Worker's own fault lines would be dropped or kept out of the dashboard. |
| `head_sampling_rate` on `observability` or `observability.logs` | Present and not `1` | Only a sample of the fault lines would be kept. |
| `observability.traces.enabled` | Present and not `false` | A trace records each request's full URL. |
| `observability.logs.destinations`, `observability.traces.destinations` | Present and not empty | Lines would go to a service `docs/privacy-accountability.md` does not name. |
| `logpush` | Present and not `false` | A Logpush job receives every request's URL and metadata. |
| `tail_consumers`, `streaming_tail_consumers` | Present and not empty | A Tail Worker receives every request's URL. |
| `previews` | Present and not an empty object | A `previews` block can turn logging, traces, Logpush or Tail Workers back on for preview deployments, which this Worker never publishes. |
| `package.json` `scripts.deploy` | It is missing, lacks one of the five steps, runs them out of order, or joins any two with something other than `&&` | A `;` or `\|\|` lets the Worker deploy after a failed step, and a preflight without a fresh build would judge whatever the last build left. |

To see every refusal fire against generated fixtures, without touching the repository's own build:

```bash
node scripts/deploy-preflight.mjs --selftest
```

### What the migration check decides

`wrangler d1 migrations apply DB --remote` can return without an error when its confirmation prompt
is declined, and a migration that fails part way through a set leaves the same gap, so `&&` alone
would let the Worker deploy over a database missing its tables. `scripts/check-remote-migrations.mjs`
runs `wrangler d1 migrations list DB --remote` (from `node_modules/wrangler`) and decides from its
output, never its exit code:

| Exit | Meaning |
|------|---------|
| `0` | The output says there are no migrations to apply. `wrangler deploy` runs. |
| `1` | The output lists migrations to be applied. The script names them and stops the deploy: apply them (answer yes at the prompt) and deploy again. |
| `2` | Could not tell: wrangler is not installed, the list command failed, printed nothing, or printed something unrecognised. Nothing is deployed. |

`--local` and `--persist-to <dir>` exist only to probe the output shape against a local database;
`npm run deploy` passes neither. `node scripts/check-remote-migrations.mjs --selftest` runs the
script against a stub wrangler.

### Migrations

| File | Adds |
|------|------|
| `migrations/0001_record.sql` | The record schema: kitchens, events, the daily budget table and their indexes. |
| `migrations/0002_append_only_guard.sql` | Triggers that abort an UPDATE of an event, a DELETE of an event while its kitchen exists, and an UPDATE of a kitchen. |
| `migrations/0003_kitchen_lines.sql` | The `kitchen_lines` counter table, backfilled from the lines already stored. |
| `migrations/0004_bounded_reads.sql` | The `events_screen`, `events_ref` and `events_root` indexes. |

The same files feed the tests and the deployed database. Migrations run before `wrangler deploy`, so
the schema is in place before a new Worker serves it. Notes from `docs/adr/0002-storage.md` that
bear on deploying:

- The `0003` backfill is exact because it reaches the remote database before any Worker has served
  it. A later migration that seeds bookkeeping while an older Worker still appends would miss those
  appends and needs a recount after the new Worker is live.
- If remote D1 refuses `0002`, the chain stops after `0001` has applied, and every rerun meets the
  same refusal. The recovery recorded in the ADR is a code change: `0002` keeps its number and file
  name, its body becomes a statement that changes nothing, and the ADR records the refusal text and
  date. `wrangler d1 migrations apply` rolls back a migration that fails, so the rewritten `0002`
  applies on the next run. The database then no longer refuses an edit of a stored line: append-only
  rests on the store port, which has no method that edits or removes an event, and on the test that
  reads the adapter's SQL (ADR 0002, "Append-only guard").
- A schema change that alters the rows a write touches turns the store suite red until
  `data/store/rows-per-write.json` is measured again.

## Environment setup

The Worker reads no process environment and no secrets. Everything it needs in production comes from
`wrangler.jsonc`: the `DB` binding with its `database_id`, the `ASSETS` binding, and the
`ALLOWED_HOSTNAMES` variable. See [CONFIGURATION.md](CONFIGURATION.md) for each key and for the
per-environment differences (local dev, preview, tests, production).

After changing a binding, regenerate the binding types:

```bash
npm run types:worker
```

The only environment variable deploy work touches is `TOLSEY_MCP_URL`, used by the post-deploy check
below.

## Checking a deploy

The `deployed` Vitest project runs `src/server/conformance.test.ts` against a deployed Worker with the
reference MCP client. It needs the Worker's base URL:

```bash
TOLSEY_MCP_URL=https://<deployed hostname> npm run test:deployed
```

In PowerShell, set the variable first:

```powershell
$env:TOLSEY_MCP_URL = 'https://<deployed hostname>'
npm run test:deployed
```

Without `TOLSEY_MCP_URL` the project fails at once. The run mints a scratch kitchen through
`POST /api/kitchens` with the label `conformance` and writes lines to it, so it spends part of the
day's write budget (`dailyRowCap` in `data/store/limits.json`). The hourly sweep deletes that
kitchen like any other. The deployed target has no storage reader, so it asserts only what an
outside client can see.

`docs/adr/0002-storage.md` and `docs/privacy-accountability.md` also list checks that only the first
deploy can make:

- Record the verdict of the first `wrangler d1 migrations apply DB --remote` in the ADR, in
  particular whether remote D1 accepts the `0002` triggers.
- Confirm that a successful request leaves no per-request log line.
- Read the stored fields of one `[mcp]` fault line (a `text/plain` POST to a scratch kitchen writes
  one on demand, as "logs a text/plain POST through onerror" in `src/server/logging.test.ts` shows),
  and correct the privacy record to what it holds.
- Measure the rows-read and rows-written figures again on remote D1.

## Rollback procedure

The repository defines no rollback command or workflow. To return to an earlier version:

1. Find the commit to return to. `npx wrangler deployments list` prints each deployment with its
   versions, and each version's `Message` is the commit it was deployed from (see "The deploy script"
   above). Check that commit out.
2. Install that commit's locked dependencies, as CI does: `npm ci --ignore-scripts`, then
   `npm rebuild esbuild workerd`. A build from the newer tree's `node_modules` would ship a mix that
   was never tested.
3. Run `npm run deploy '--' --message "$(git rev-parse HEAD)"`. The preflight and the migration check
   run as usual.

`npx wrangler rollback` also makes an earlier uploaded version of the Worker active again, by default
the version uploaded before the latest one. It asks for a confirmation and a message, and it runs
neither the preflight nor the migration check, so it is only as safe as the version it picks, which
was checked when `npm run deploy` uploaded it. Routes, the custom domain and the Cron Trigger are not
part of a version, so a rollback leaves them as they are.

Migrations are not undone by a rollback: the remote schema stays where the last apply left it. The
migration files never edit or drop what an earlier file created, so an older Worker meets the tables
and indexes it expects. Keep in mind the `0003` note above: a Worker from before `0003` does not keep
`kitchen_lines` current, so rolling back past it and forward again leaves the counters short of the
lines stored in between.

## Monitoring

No monitoring or error-tracking library is a dependency. The deployed Worker is watched through
Cloudflare itself:

- **Workers Logs.** `observability.enabled` is `true` and per-request logs are off, so the only lines
  kept are the Worker's own fault lines. They are written by `logFault()` in `src/server/guards.ts`
  with the error's name and code only, never its message, under these prefixes:
  - `[worker]`: a fault outside the MCP handler while serving a request, such as the body read, the
    scope lookup or the mint, and a failed read of a body left unread (`src/server/worker.ts`).
  - `[mcp]`: a fault the MCP handler reports through `onerror` (`src/server/worker.ts`).
  - `[log_reading]`: a fault inside the `log_reading` tool call, such as a failed store read or
    write (`createServer()` in `src/server/mcp.ts`). The caller gets the fixed server-fault
    sentence, never the error's message.
  - `[due_now]`: a fault inside the `due_now` tool call, such as a failed store read
    (`createServer()` in `src/server/mcp.ts`). The caller gets that tool's fixed server-fault
    sentence, never the error's message.
  - `[retention]`: a failed hourly sweep (`scheduled()` in `src/server/worker.ts`).
  - `[mint-sweep]`: a failed sweep round run by a kitchen mint (`src/server/kitchens.ts`). The mint
    still goes ahead.

  `docs/privacy-accountability.md` records that these lines are kept for 3 days on the free plan.
- **Failed hourly runs.** A failed hourly run rethrows, so Cloudflare records it as failed.
  Cloudflare documents no retry of a failed run, so nothing here counts on one: the next hourly run
  or the next mint's sweep deletes what it left. Each failed run can push deletion back by an hour,
  and a run that starts more than 15 minutes late pushes it past 24 hours too
  (`docs/adr/0002-storage.md`).
- **The daily write budget.** Once `dailyRowCap` is spent, minting and writing are refused with
  "The demo is full for today. Try again tomorrow." until 00:00 UTC.
- **The account's D1 limits.** Past them no query runs until 00:00 UTC (`docs/adr/0002-storage.md`).
  A request to a scratch kitchen then fails at its kitchen lookup (`resolveScope` in
  `src/server/scope.ts`), before any tool runs, and answers HTTP 500 with JSON-RPC `-32603`. A mint
  answers 500 `{"error":"server_error"}`. Both write a `[worker]` line, and the hourly run fails with a
  `[retention]` line. The demo kitchen at `/mcp` still answers `log_reading`, which it refuses before
  any storage call, but its `due_now` reads storage and answers with that tool's fixed server-fault
  sentence and a `[due_now]` line. Only a store fault that reaches a tool itself answers with a fixed
  server-fault sentence and a `[log_reading]` or `[due_now]` line.
