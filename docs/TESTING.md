# Testing

Tolsey's tests run on Vitest. One configuration file, `vitest.config.ts`, defines five projects that
share one set of test files across three targets: the Worker code in the Node process, the built
Worker in workerd, and a deployed Worker. Around the suite sit three checks that judge a run rather
than trust its exit code: a test-count gate, coverage floors and mutation testing.

## Test framework and setup

| Tool | Version (`package.json`) | Used for |
|------|--------------------------|----------|
| Vitest | `vitest` `^5.0.0` | Test runner for every project |
| `@vitest/coverage-v8` | `5.0.0` | Coverage and its floors |
| fast-check | `fast-check` `^4.10.0` | Property tests (rule judgment, logging a reading, kitchen profile and rule table validation, the hostname allowlist, the tool contract) |
| `@modelcontextprotocol/client` | `2.2.0` | The reference client the conformance tests connect with |
| Wrangler | `wrangler` `^4.120.0` | `getPlatformProxy` for a local D1 database in Node, `createTestHarness` for the built Worker in workerd |
| Stryker | `@stryker-mutator/core` `^10.0.0` | Mutation testing |

Prerequisites:

- `Node.js >= 24` (`package.json` `engines`). CI uses Node 24.
- Dependencies installed from the lockfile. CI installs with scripts off and rebuilds only the two
  packages that need their install step:

```bash
npm ci --ignore-scripts
npm rebuild esbuild workerd
```

No account, network access or `.env` file is needed for the local suite. D1 runs locally through
Wrangler with `persist: false`, and every test database gets the SQL files in `migrations/` applied
in order before a test touches it (`openTestD1()` in `src/test-support/d1.ts`). The `e2e` project
needs a build, which `npm run test:e2e` runs itself.

### The five Vitest projects

| Project | Collects | Runs against |
|---------|----------|--------------|
| `unit` | `src/domain/**/*.test.ts`, `src/contract/**/*.test.ts` | Pure functions, no storage |
| `store` | `src/store/**/*.test.ts` | Both store adapters, D1 from `getPlatformProxy` |
| `conformance` | `src/server/**/*.test.ts` except `*.e2e.test.ts` | The Worker in process (`target: 'in-process'`) |
| `e2e` | `src/server/**/*.e2e.test.ts` and `src/server/conformance.test.ts` | The built Worker in workerd (`target: 'workerd'`), 60 second test and hook timeouts |
| `deployed` | `src/server/conformance.test.ts` | A deployed Worker (`target: 'deployed'`) |

`src/server/conformance.test.ts` is the one file that runs in three projects. It reads its target with
Vitest's `inject('target')` and gets a `Target` from `resolveTarget()` in `src/test-support/target.ts`:

- `in-process` calls `createWorker()` directly with a settable clock and a local D1 database.
- `workerd` starts the built Worker from `dist/tolsey/wrangler.json` with `createTestHarness` and
  applies the D1 migrations with `applyD1Migrations`.
- `deployed` talks to the base URL in `TOLSEY_MCP_URL` and asserts only what an outside client can
  see.

Every target mints its kitchen through `POST /api/kitchens`, as an outside client would. The local
targets answer on `localhost,127.0.0.1` (`LOCAL_HOSTNAMES`), never the deployed hostname.

## Running tests

Full suite, as CI and `npm run verify:ship` run it:

```bash
npm test
```

This runs `node scripts/test-tz.mjs`, then `npm run test:e2e`.

`scripts/test-tz.mjs` runs the `unit`, `store` and `conformance` projects twice, once with
`TZ=UTC` and once with `TZ=Europe/Amsterdam`. Neither is the demo kitchen's zone
(`America/Chicago`), so code that reads the host clock's zone instead of the kitchen's fails here.
Before each run the script starts a child process and checks that the zone actually reached it; if
not, it fails rather than report a green run in the wrong zone. `TZ` is set in the child's
environment, so the script works the same from cmd, PowerShell and Bash. Each zone run is killed
after 20 minutes, and the script stops at the first zone that fails.

End-to-end tests against the built Worker in workerd:

```bash
npm run test:e2e
```

This runs `vite build`, then `vitest run --project e2e`. The e2e files cover routing of the built
Worker (`routing.e2e.test.ts`), the hourly retention sweep (`retention.e2e.test.ts`), the built
Worker's `/mcp` endpoint, shipped allowlist and D1 binding (`built-worker.e2e.test.ts`), and `Intl` parity between workerd and Node
(`intl-parity.e2e.test.ts`, which starts a test-only Worker from
`src/test-support/intl-probe.wrangler.jsonc`).

Conformance against a deployed Worker:

```bash
TOLSEY_MCP_URL=https://<deployed hostname> npm run test:deployed
```

In PowerShell, set the variable first:

```powershell
$env:TOLSEY_MCP_URL = 'https://<deployed hostname>'
npm run test:deployed
```

The project fails at once with a message naming `TOLSEY_MCP_URL` when it is unset. CI does not run
this project.

Coverage:

```bash
npm run test:coverage
```

This runs the `unit`, `store` and `conformance` projects with V8 coverage and writes the report to
`coverage/` (git-ignored).

A subset or a single file, by project and path:

```bash
npx vitest run --project unit
npx vitest run --project store src/store/store.contract.test.ts
```

A direct run like this uses the host's own time zone; only `npm test` covers both zones. A single
`e2e` file needs `npm run build` first, because the harness loads the built config. There is no
watch-mode script.

Mutation testing:

```bash
npm run mutate        # incremental, cleared whenever an input changed
npm run mutate:full   # stryker run, a complete run
```

## Writing new tests

### Where a test file goes

- Name test files `<module>.test.ts` and place them next to the module they test, under
  `src/domain`, `src/contract`, `src/store` or `src/server`. The folder decides the Vitest project.
- A test that needs the built Worker in workerd goes in `src/server` as `<name>.e2e.test.ts`.
- A test file in any other folder (for example `src/ui`) is collected by no project. The test-count
  gate lists every tracked `*.test.ts`, `*.test.tsx`, `*.spec.ts` and `*.spec.tsx` under `src` and
  fails when one is missing from the report, so add a project in `vitest.config.ts` before adding
  tests there.
- Snapshots live in `__snapshots__/` beside the test (`src/domain/__snapshots__/log-reading.test.ts.snap`).

### No skipped tests

No test is skipped on purpose. `it.skip`, `describe.skip` and `it.todo` all fail the test-count
gate, in every folder, the end-to-end tests included. The shared helpers follow the same rule: `openTestD1()` throws when
`wrangler.jsonc` has no `DB` binding instead of letting a store suite skip.

### Shared helpers (`src/test-support/`)

| File | Purpose |
|------|---------|
| `d1.ts` | `openTestD1()` opens a local D1 database with every migration applied; `dumpRecordTables()` serializes the four record tables so two states compare as strings; `migrationStatements()` splits a migration file with Wrangler's SQL splitter |
| `target.ts` | `resolveTarget()` for the three conformance targets, `openInProcessWorker()` (Worker, settable clock, D1 and `D1Store`), `builtWorkerHarness()` for workerd, `mintThroughRoute()` |
| `events.ts` | Fixtures: `scratchKitchen()`, `testEvent()`, `kitchenInput()`, `appendInput()`, bulk inserts (`insertEvents()`, `insertLines()`, `insertScratchKitchens()`), and `readLimits()` / `readRowsPerWrite()`, which return the Worker's own validated copies of `data/store/*.json` |
| `mcp-client.ts` | `callLogReading()` makes one call through the reference MCP client and closes it; `walkInArguments()` builds a valid reading |
| `raw-mcp.ts` | `postJsonRpc()`, `sendRaw()`, `byId()`, `errorById()` for hand-built JSON-RPC requests, reading every data line of an event stream |
| `counting-store.ts` | `countingStore()` records every store call by name, so a test can prove a path never reached storage |
| `counting-d1.ts` | `countingD1()` records every statement and sums rows read and written; a result with no row metadata fails instead of counting as zero |
| `gated-store.ts` | `gatedStore()` holds the first call of one store method until released, to force one ordering of two racing requests |
| `barrier-store.ts` | `barrierStore()` makes several racing calls read the same pending prompt before any of them goes on |
| `q4-instants.ts` | Fixed instants around midnight and both 2026 clock changes in `America/Chicago`, read the same in workerd and Node |
| `intl-probe.worker.ts`, `intl-probe.wrangler.jsonc` | The test-only Worker the `Intl` parity test starts; never part of the product build |

### Patterns used in the existing tests

- **Both store adapters, one contract.** `src/store/store.contract.test.ts` runs the same cases
  against `MemoryStore` and `D1Store`. A change to the store port gets its case there, not in one
  adapter's own file.
- **Time is injected.** The Worker takes a `Clock`; tests set the instant rather than reading the
  host clock. Business-day tests pick instants where the UTC date and the kitchen's date differ.
- **Count calls, not only results.** Where a stored reply could hide a second write, wrap the store
  with `countingStore()` or the database with `countingD1()` and assert the number of calls.
- **Data files are read through the Worker's parsers**, never re-declared in a test, so a test cannot
  run against a limit the Worker would refuse.

## Coverage requirements

Floors are set in `vitest.config.ts` under `test.coverage.thresholds` and enforced by
`npm run test:coverage`. Coverage counts `src/contract`, `src/domain`, `src/store` and `src/server`
(test files and `src/test-support` excluded), measured from the `unit`, `store` and `conformance`
projects only; the workerd run adds nothing to it.

| Type | Whole measured tree | `src/domain/**/*.ts`, per file |
|------|---------------------|--------------------------------|
| Lines | 85% | 95% |
| Branches | 80% | 90% |
| Functions | 85% | 95% |
| Statements | 85% | 95% |

### Test-count gate

```bash
npm run gate:test-count
```

The script builds the Worker, then `scripts/check-test-count.mjs --floor 1300` runs the `unit`,
`store`, `conformance` and `e2e` projects with Vitest's JSON reporter, writing the report to a new
temporary folder each time. The `e2e` project runs the built Worker, as `npm run test:e2e` does. The
floor is set in the `gate:test-count` script in `package.json`. The gate refuses the run when:

- Vitest exits non-zero, the report says `success` is not `true`, any test failed, or any file failed
  to collect (each named, before anything is counted);
- any test is skipped or todo;
- fewer tests passed than the floor;
- a tracked test file under `src` is absent from the report.

Exit codes: 0 clean, 1 findings, 2 unknown (no report, an unparsable or empty report, Vitest not
installed, or no `--floor`). `node scripts/check-test-count.mjs --selftest` proves each refusal
against a stub Vitest; `npm run gate` runs that selftest through `gate:selftest`.

### Mutation score

`stryker.config.json` mutates `src/domain/**/*.ts` and `src/server/**/*.ts` (test files excluded) and
kills mutants with `vitest run --project unit --project conformance --bail 1`. Thresholds are
`high: 80`, `low: 60`, `break: null`: the score is reported, and no score fails the run.

`npm run mutate` (`scripts/mutate-incremental.mjs`) uses Stryker's incremental mode, but hashes every
input first (`src`, `data`, `migrations`, `package.json`, `package-lock.json`, `stryker.config.json`,
`vitest.config.ts`, `tsconfig*.json`, `wrangler.jsonc`, untracked files included). The five guides in
`docs/` and `scripts/deploy-preflight.mjs` count as inputs too, because tests in the mutation command
read them while mutated code runs: an edit to one of these guides makes the next `npm run mutate` a
full run. When the hash differs from the one stored after the last successful run, it deletes
`reports/stryker-incremental.json`, so the run is a full one. Stryker's command runner sees the whole
test command as one test and cannot detect a changed test on its own. A recorded mutation score comes
from `npm run mutate:full`.

### Gate script selftests

The repository's check scripts carry their own selftests, and five have a mutant harness that
disables one rule at a time and expects the matching selftest control to fail:

```bash
node scripts/check-client-secrets.mutants.mjs
node scripts/check-env-example.mutants.mjs
node scripts/check-goals.mutants.mjs
node scripts/check-ship-artifacts.mutants.mjs
node scripts/check-tsconfig-coverage.mutants.mjs
```

## CI integration

Workflow `gates` in `.github/workflows/ci-gates.yml`, job `gate`, on `ubuntu-24.04` with Node 24.
It runs on every pull request and on pushes to `main` or `master`.

1. `npm ci --ignore-scripts`, then `npm rebuild esbuild workerd`
2. Fail on any installed package with an install script not covered by `allowScripts` in
   `package.json`
3. `npm run build --if-present`
4. `npm run gate` (includes `gate:selftest`, so the test-count and mutation wrapper selftests run here)
5. `npm test`
6. `npm run test:coverage`
7. `npm run gate:test-count`
8. `node scripts/check-client-secrets.mjs`
9. Trivy vulnerability scan with dev dependencies included, failing on HIGH or CRITICAL findings
   (skipped on Dependabot pull requests)
10. On pushes only: a Trivy license census, uploaded as the `license-census` artifact

Tests, coverage and the test count are separate steps, so a failure names which one broke. CI does
not run `npm run test:deployed` or mutation testing.

### Before a release

```bash
npm run verify:ship
```

`verify-ship.mjs` runs, stopping at the first failure: `gate:types`, `npm test`, `gate:test-count`,
`lint`, `gate`, `gate:repo`, the build, `test:coverage`, `a11y:live` (printed as SKIPPED while no
such script exists in `package.json`), and `npm run mutate`. Each step is killed after 30 minutes
(override with `VERIFY_SHIP_TIMEOUT_MS`); the mutation step gets twice the slowest measured full
run (`MUTATION_FULL_RUN_MS` in `verify-ship.mjs`). The summary block at the end is the record of
the run.
