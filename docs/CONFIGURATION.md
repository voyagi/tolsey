# Configuration

Tolsey runs as one Cloudflare Worker with static assets and a D1 database. Its configuration comes
from four places:

1. `wrangler.jsonc`: the Worker's bindings, its one variable (`ALLOWED_HOSTNAMES`), routes, the
   hourly Cron Trigger and logging.
2. `vite.config.ts`: the override the local dev server applies on top of `wrangler.jsonc`.
3. JSON data files under `data/`: the rule table, the demo kitchen profile and the storage limits.
   They are bundled into the Worker and validated when it loads.
4. Process environment variables read by the repository's check scripts and the test runner. The
   Worker itself reads no process environment.

## Environment variables

### Worker variables and bindings

These come from `wrangler.jsonc` and are typed in `WorkerEnv` (`src/server/worker.ts`).

| Name | Kind | Required | Default | Description |
|------|------|----------|---------|-------------|
| `ALLOWED_HOSTNAMES` | var | **Required** | The deployed hostname, set in `wrangler.jsonc` `vars` | Comma-separated hostnames the Worker answers on. Every request to `/mcp`, `/mcp/*` and `/api/*` must carry a `Host` header (and, when present, an `Origin`) naming one of them. |
| `DB` | D1 binding | **Required** | `database_name: "tolsey"`, `migrations_dir: "migrations"` | The day record: kitchens, events, line counts and the daily row budget. Schema lives in `migrations/0001_record.sql` through `migrations/0004_bounded_reads.sql`. |
| `ASSETS` | assets binding | Required | Set by `assets.binding` | Serves the built web app. Any path outside `/mcp`, `/mcp/*` and `/api/*` goes straight to it. |

After changing a binding, run `npm run types:worker` (`wrangler types`) to regenerate the binding
types. `npm run gate:types` runs it too.

### Script and test variables

The check scripts and the test runner read these from the process environment. No file is loaded
automatically: set a variable in the shell that runs the command. `.env.example` lists the names
that `scripts/check-env-example.mjs` (`npm run gate:env`) finds read without a fallback. Reads that
have a fallback, and reads inside test files, are not listed there.

| Variable | Required | Default | Read by | Description |
|----------|----------|---------|---------|-------------|
| `LICENSE_HOLDER` | Optional | `package.json` `author` | `scripts/check-license.mjs` | The copyright holder `LICENSE` must name. With neither this nor an `author`, the holder check is skipped and says so. |
| `GIT_STRIP_CANARY` | Leave empty | none | The git-related check scripts | Not a setting. Each script plants this value itself in `--selftest` mode, then removes every inherited `GIT_*` variable and stops if the canary survived. It is in `.env.example` only because the parity gate sees it read. |
| `TOLSEY_MCP_URL` | Required for `npm run test:deployed` | none | `src/server/conformance.test.ts` | Base URL of a deployed Worker. The `deployed` Vitest project fails at once without it. |
| `GIT_IDENTITY_ALLOW` | Optional | empty | `scripts/check-git-identity.mjs` | Extra allowed commit emails, comma-separated. Each entry is a full address or an `@suffix`. `@users.noreply.github.com` and `noreply@github.com` are always allowed. |
| `ARTIFACT_METADATA_MARKERS` | Optional | empty | `scripts/check-artifact-metadata.mjs` | Extra literals (comma-separated, case-insensitive) that must not appear in the metadata of tracked PNG, JPEG, PDF or Office files. |
| `ART_DIRECTION_FILE` | Optional | `design/ART-DIRECTION.md` | `scripts/check-icon-decision.mjs` | Path of the design file the icon check reads. |
| `VERIFY_SHIP_TIMEOUT_MS` | Optional | `1800000` (30 minutes) | `verify-ship.mjs` | Time limit per step of `npm run verify:ship`. A value that is not a positive number falls back to the default. |
| `TSCONFIG_COVERAGE_TS` | Optional, test use only | the repository's own `typescript` | `scripts/check-tsconfig-coverage.mjs` | Directory of a `typescript` package to use in place of the installed one. |

`scripts/test-tz.mjs` (the first half of `npm test`) sets `TZ` itself. It runs the unit, store and
conformance projects once under `UTC` and once under `Europe/Amsterdam`, both outside the demo
kitchen's zone, and checks that the zone actually reached the child process before it trusts a
green run.

The browser bundle reads no environment values: nothing under `src/` uses `import.meta.env`.
`node scripts/check-client-secrets.mjs` checks the built bundle for secrets in CI.

## Config file format

### `wrangler.jsonc`

```jsonc
{
  "name": "tolsey",
  "main": "src/server/worker.ts",
  "compatibility_date": "2026-08-15",
  "assets": {
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/mcp", "/mcp/*", "/api/*"]
  },
  "d1_databases": [{ "binding": "DB", "database_name": "tolsey", "migrations_dir": "migrations" }],
  "vars": { "ALLOWED_HOSTNAMES": "<deployed hostname>" },
  "routes": [{ "pattern": "<deployed hostname>", "custom_domain": true }],
  "workers_dev": false,
  "preview_urls": false,
  "triggers": { "crons": ["0 * * * *"] },
  "observability": { "enabled": true, "logs": { "invocation_logs": false } }
}
```

| Key | Purpose |
|-----|---------|
| `assets.run_worker_first` | The only paths the Worker code handles. `familyOf()` in `src/server/worker.ts` mirrors this list, so the two change together. |
| `assets.not_found_handling` | Unknown paths fall back to the web app's `index.html`. |
| `d1_databases` | The `DB` binding. It carries no `database_id` in the repository. Local D1 and the test harnesses accept the entry without one, and the deploy preflight refuses to deploy until one is added. |
| `vars.ALLOWED_HOSTNAMES` | The deployed hostname alone (see Required vs optional settings). |
| `routes` | One custom-domain route for the deployed hostname. |
| `workers_dev`, `preview_urls` | Both `false`, so the Worker gets no second public URL on a `workers.dev` subdomain. |
| `triggers.crons` | `0 * * * *`: the hourly retention sweep (`scheduled()` in `src/server/worker.ts`, `runScheduledSweep()` in `src/server/retention.ts`). |
| `observability` | Workers Logs on, so the Worker's own `[worker]`, `[mcp]`, `[retention]` and `[mint-sweep]` fault lines are kept. Invocation logs off, so a successful request leaves no log line carrying its URL (and the kitchen id in it). See `docs/privacy-accountability.md`. |

The deployed hostname appears in three tracked places that must agree: `vars.ALLOWED_HOSTNAMES`,
`routes`, and the `DEPLOYED_HOST` constant in `scripts/deploy-preflight.mjs`.

### `data/store/limits.json`

Storage caps and retention timing, parsed by a strict Zod schema in `src/server/data.ts`. Every value
must be a positive number, and the integer keys must be integers. An unknown key is refused.

```json
{
  "dailyRowCap": 40000,
  "kitchenLineCap": 200,
  "writeWindowHours": 22.75,
  "retentionAgeHours": 22.75,
  "retryWindowSeconds": 120,
  "sweepBatchLimit": 25,
  "cronSweepBatchLimit": 2000,
  "maxSweepRounds": 10
}
```

### `data/store/rows-per-write.json`

The number of D1 rows each kind of write costs, charged against `dailyRowCap` before the write runs.
Keys: `kitchen_create`, `event_first_of_day`, `event`, `event_superseding`, `event_answering`,
`event_referencing`, `budget_add` (positive integers), plus `measuredOn`, a note of where the figures
were measured. These are measurements, not tuning knobs. A schema change that alters the rows a
write touches turns the store suite red until the file is measured again (`docs/adr/0002-storage.md`).

### `data/kitchens/demo.json`

The demo kitchen profile, parsed by `KitchenProfileSchema` in `src/domain/rule.ts` (strict).

| Key | Description |
|-----|-------------|
| `timeZone` | IANA zone name (`America/Chicago`). Must be a zone `Intl` knows. |
| `dayStart` | `HH:MM` when the business day turns over (`04:00`). Must fall outside 01:00 to 03:00. |
| `roster` | Staff initials, 2 or 3 capital letters each. The demo uses invented initials. |
| `foods` | Foods with `id`, `name`, `aliases`, and optional `roast: true`. |
| `checkPoints` | Units and stations with `id`, `name`, `askAs`, `kind` (`cold`, `hot`, `receiving`, `freezer`, `cooling`, `reheat`), `aliases`, and the rule ids they are judged by (`airRule`, `foodRule`, `roastRule`, `foodRules`, `defaultMeasured`). |
| `schedule` | Timed checks: check point, `check` (`cold_holding` or `hot_holding`), `times`, `intervalRule`, `graceMinutes`. |
| `checklist` | `opening` and `closing` items, each with `id` and `text`. |
| `noTimeAsPublicHealthControl` | The kitchen's statement that no food is held under time as a public health control. |
| `correctionWindowSeconds` | How long after a line a spoken correction can still change it (`120`). |
| `promptExpirySeconds` | How long a follow-up question stays answerable (`120`). |
| `coarseBands` | Plausible range in °F per check point kind (`lowF` below `highF`). |
| `vocabulary` | Words and phrases the spoken-reading parser recognizes or refuses as hedges. |

Every scratch kitchen minted through `POST /api/kitchens` copies `timeZone` and `dayStart` from this
profile.

### `data/rules/food-code-2022.json`

The rule table, parsed by `RuleTableSchema` in `src/domain/rule.ts` (strict). Top-level keys:

| Key | Description |
|-----|-------------|
| `rulesVersion` | Version string stored with each judged line. |
| `edition` | The code edition the table follows (`FDA Food Code 2022`). |
| `rows` | Rules of kind `temperature`, `timed_temperature`, `duration` or `observation`. Each carries a `source` of kind `food_code` (section, page, edition, quote), `other_law` or `house_rule`. |
| `notCovered` | Sections the table deliberately does not judge, each with `section` and `description`. |

## Required vs optional settings

Each check below runs either when the Worker module loads, on every request, or before deploy.

| Setting | When checked | What happens if it is wrong |
|---------|--------------|-----------------------------|
| `ALLOWED_HOSTNAMES` unset or blank | Each request to `/mcp`, `/mcp/*`, `/api/*` | HTTP 503, `{"error":"allowlist_unconfigured","message":"ALLOWED_HOSTNAMES is not set: list the hostnames this Worker answers, comma separated"}`. Static assets are still served. |
| `ALLOWED_HOSTNAMES` with a bad entry | Each request to those paths | HTTP 503 with a message naming the entry and the problem. `parseAllowlist()` in `src/server/allowlist.ts` refuses empty entries, URLs, paths, whitespace, ports, wildcards, trailing dots, non-ASCII names (give the punycode form) and IP addresses not written in the form a `Host` header is compared in. One bad entry refuses the whole list. |
| Request host not in the list | Each request to those paths | Refused by the MCP SDK's `Host` and `Origin` validation before any handler runs. |
| Any `data/` file failing its schema | Worker load | The Worker fails to start. Zod names the failing key. |
| A check point naming a rule id the table lacks, or a `defaultMeasured` that is not `air` or a food id | Worker load | The Worker fails to start with `check point <id> names rule <rule>, which the rule table lacks` or `check point <id> defaults to <measure>, which is not a known measure`. |
| `DB` binding | Deploy (`scripts/deploy-preflight.mjs`) | Deploy refused if there is no `DB` entry, or its `database_id` is absent, empty, or all zeros. |

### Deploy preflight

`npm run deploy` runs, joined by `&&`:

```bash
npm run build && node scripts/deploy-preflight.mjs && wrangler d1 migrations apply DB --remote && node scripts/check-remote-migrations.mjs && wrangler deploy
```

`scripts/deploy-preflight.mjs` reads the Wrangler config that `npm run build` produces, not
`wrangler.jsonc`, because the Vite plugin rewrites the config at build time. It refuses the deploy
(exit 1) unless:

- `DB` has a real `database_id`.
- `vars.ALLOWED_HOSTNAMES` passes `parseAllowlist()` and names the deployed hostname and nothing else.
  A loopback or LAN name beside it would let a page served there pass the deployed Worker's
  `Origin` check.
- `workers_dev` and `preview_urls` are exactly `false` (absent is refused, since Wrangler defaults
  `workers_dev` to true).
- `routes` holds the custom-domain route for the deployed hostname.
- `triggers.crons` contains `0 * * * *`.
- `observability.enabled` is `true` and `observability.logs.invocation_logs` is exactly `false`.
- `observability.logs.enabled` and `persist` are `true` or absent, and both `head_sampling_rate` keys
  are `1` or absent.
- Traces are off or absent, log and trace `destinations` are empty or absent, `logpush` is false or
  absent, `tail_consumers` and `streaming_tail_consumers` are empty or absent, and there is no
  non-empty `previews` block.
- The `deploy` script in `package.json` runs the five steps above in that order, joined only by `&&`.

It exits 2 when there is no built config to judge. `node scripts/deploy-preflight.mjs --selftest`
proves each refusal fires.

`scripts/check-remote-migrations.mjs` then lists remote migrations and stops the deploy unless none
are left to apply.

Before the first deploy, the database must be created and its id added to `wrangler.jsonc`.
`docs/adr/0002-storage.md` records the command, which creates the database under the EU
jurisdiction:

```bash
npx wrangler d1 create tolsey --jurisdiction=eu
```

## Defaults

### Storage limits (`data/store/limits.json`)

| Setting | Default | Used in | Effect |
|---------|---------|---------|--------|
| `dailyRowCap` | `40000` | `src/server/kitchens.ts`, `src/server/mcp.ts`, `src/store/d1-store.ts` | Rows the Worker may write per UTC day, summed from `rows-per-write.json`. Past it, minting a kitchen and writing a line are refused with "The demo is full for today. Try the replay." |
| `kitchenLineCap` | `200` | `src/store/d1-store.ts` | Lines one kitchen may hold before writes are refused as `kitchen_full`. |
| `writeWindowHours` | `22.75` | `writeWindowMs()` in `src/server/kitchens.ts` | A scratch kitchen accepts writes for this long, minus `retryWindowSeconds`, after it is minted. Reported as `closesAt`. |
| `retentionAgeHours` | `22.75` | `src/server/retention.ts` | Scratch kitchens this old are deleted with their lines. Deletion is promised by `retentionAgeHours` plus one hour plus 15 minutes, reported as `expiresAt`. |
| `retryWindowSeconds` | `120` | `src/server/mcp.ts`, `src/store/port.ts` | A repeated request id with the same arguments gets its stored result back within this window. After it, the repeat is refused as expired. |
| `sweepBatchLimit` | `25` | `mintKitchen()` in `src/server/kitchens.ts` | Kitchens deleted by the one sweep round each mint runs. |
| `cronSweepBatchLimit` | `2000` | `runScheduledSweep()` | Kitchens read and deleted per round of the hourly run. |
| `maxSweepRounds` | `10` | `runScheduledSweep()` | Rounds per hourly run. A run stops early once a round reads fewer than `cronSweepBatchLimit` kitchens. |

### Fixed values in source

These are constants, not configuration. Change them in code.

| Value | Where | Meaning |
|-------|-------|---------|
| 64 KiB (`65536` bytes) | `MAX_BODY_BYTES`, `src/server/guards.ts` | Largest request body. Larger bodies get HTTP 413. |
| 1 hour, 15 minutes | `SWEEP_INTERVAL_MS`, `SWEEP_LATE_START_MS`, `src/server/kitchens.ts` | Sweep interval and the late-start allowance used to compute `expiresAt`. |
| 16 bytes | `KITCHEN_ID_BYTES`, `src/server/kitchens.ts` | Random bytes in a scratch kitchen id (32 hex characters). |
| `capture`, `conformance` | `LABELS`, `src/server/kitchens.ts` | The only labels `POST /api/kitchens` accepts. Any other body key is refused. |

## Per-environment overrides

There are no per-environment `.env` files and no `NODE_ENV` branches. The difference between
environments is the hostname list and where the database lives.

| Environment | How it runs | `ALLOWED_HOSTNAMES` | `DB` |
|-------------|-------------|---------------------|------|
| Local dev | `npm run dev` (Vite with `@cloudflare/vite-plugin`) | `localhost,127.0.0.1`, set by `DEV_ONLY_VARS` in `vite.config.ts` for `vite serve` only | Local D1 |
| Local preview | `npm run build`, then `npm run preview` | The deployed hostname from `wrangler.jsonc`, so requests to `/mcp` and `/api/*` on a local address are refused | Local D1 |
| Tests, in process | `vitest` projects `unit`, `store`, `conformance` | `localhost,127.0.0.1` (`LOCAL_HOSTNAMES`, `src/test-support/target.ts`) | D1 from Wrangler's `getPlatformProxy`, migrations applied in setup |
| Tests, workerd | `npm run test:e2e` | `localhost,127.0.0.1`, passed to `createTestHarness` over the built config | Local D1, migrations applied with `applyD1Migrations` |
| Tests, deployed | `npm run test:deployed` | The deployed Worker's own list | Remote D1. Needs `TOLSEY_MCP_URL`. |
| Production | `npm run deploy` | The deployed hostname alone, enforced by the preflight | Remote D1 named by `database_id` |

The dev-only hostnames are applied by a Vite plugin option that is never used for a build, so they
cannot reach the config `wrangler deploy` ships. To apply migrations to the local database for dev:

```bash
npx wrangler d1 migrations apply DB --local
```
