#!/usr/bin/env node
// check-test-count.mjs - the test-count gate: a green run that skipped, lost or failed tests is refused.
//
// WHY. A passing exit code says nothing about what ran. Four shapes pass a bare `vitest run`, or a
// count taken on its own:
//   1. A storage or conformance test is skipped (it.skip, or a missing binding turned into a skip)
//      and the suite stays green. Those suites throw without a binding, so anything but passed there
//      is refused.
//   2. A test file in a folder no Vitest project names is never collected, and nothing notices.
//      Every tracked test-shaped file under src must be in the report. The list is deliberately
//      wider than the projects' own globs: a list built from those globs could never see the orphan.
//   3. Enough passing tests can hide a failed one, and a file that fails to collect holds no test
//      for a per-test check to see. So before anything is counted, a non-zero vitest exit, success
//      false, a failed test in any folder, and a file whose entry is failed (Vitest's JSON reporter
//      puts the collection error in that entry's message) are each refused by name.
//   4. A report left from an earlier run reads as this run's. It is deleted before the spawn, so a
//      vitest that dies before writing leaves nothing behind, which is UNKNOWN, never clean.
//
// What is counted is tests whose status is passed, never the exit code: a filter that matches
// nothing exits 0.
//
// Verdicts: CLEAN (exit 0), FINDINGS (exit 1, each one named), UNKNOWN (exit 2: vitest missing, no
// report, an unparsable or empty report, no --floor, or the tracked files could not be listed).
//
// Usage: node scripts/check-test-count.mjs --floor N [--selftest]
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const VITEST_BIN = join('node_modules', 'vitest', 'vitest.mjs');
const REPORT = 'reports/vitest-count.json';

function run(cwd) {
  const r = spawnSync(process.execPath, [join(cwd, VITEST_BIN), 'run', '--reporter=json', `--outputFile=${REPORT}`], {
    cwd, encoding: 'utf8', windowsHide: true,
  });
  return r.status ?? 1;
}

// --- selftest ---------------------------------------------------------------
// Hermetic: a temp git repository with tracked test files and a STUB vitest that copies a fixture
// report to the --outputFile path it was given (or writes nothing) and exits STUB_EXIT.
const STUB = [
  "import { copyFileSync, existsSync, mkdirSync } from 'node:fs';",
  "import { dirname, resolve } from 'node:path';",
  "const arg = process.argv.find((a) => a.startsWith('--outputFile='));",
  "if (arg && existsSync('fixture-report.json')) {",
  "  const out = resolve(arg.slice('--outputFile='.length));",
  '  mkdirSync(dirname(out), { recursive: true });',
  "  copyFileSync('fixture-report.json', out);",
  '}',
  'process.exit(Number(process.env.STUB_EXIT || 0));',
].join('\n');

const TRACKED = ['src/domain/a.test.ts', 'src/store/b.test.ts', 'src/server/c.test.ts', 'src/server/d.e2e.test.ts'];

function selftest() {
  const self = fileURLToPath(import.meta.url);
  let failures = 0;
  const roots = [];
  const makeRoot = (extraTracked = []) => {
    const root = mkdtempSync(join(tmpdir(), 'test-count-st-'));
    roots.push(root);
    for (const rel of [...TRACKED, ...extraTracked]) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), 'a test file\n');
    }
    mkdirSync(join(root, dirname(VITEST_BIN)), { recursive: true });
    writeFileSync(join(root, VITEST_BIN), STUB);
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['add', 'src'], { cwd: root, stdio: 'pipe' });
    return root;
  };
  const test = (fullName, status = 'passed') => ({ fullName, title: fullName, status, ancestorTitles: [], failureMessages: [] });
  const file = (root, rel, tests, extra = {}) => ({
    name: join(root, rel).replaceAll('\\', '/'),
    status: tests.some((t) => t.status === 'failed') ? 'failed' : 'passed',
    message: '',
    assertionResults: tests,
    ...extra,
  });
  const report = (files, extra = {}) => {
    const tests = files.flatMap((f) => f.assertionResults);
    const numFailedTests = tests.filter((t) => t.status === 'failed').length;
    return {
      numTotalTests: tests.length,
      numPassedTests: tests.filter((t) => t.status === 'passed').length,
      numFailedTests,
      success: numFailedTests === 0 && files.every((f) => f.status !== 'failed'),
      testResults: files,
      ...extra,
    };
  };
  // The three tracked non-e2e files, each with one passing test unless a case overrides a file.
  const passing = (root, overrides = {}) => [
    overrides.domain ?? file(root, 'src/domain/a.test.ts', [test('judges a reading')]),
    overrides.store ?? file(root, 'src/store/b.test.ts', [test('stores a line')]),
    overrides.server ?? file(root, 'src/server/c.test.ts', [test('answers a call')]),
  ];
  const runCli = (root, { fixture, args = ['--floor', '3'], stubExit = 0 } = {}) => {
    if (fixture !== undefined) writeFileSync(join(root, 'fixture-report.json'), typeof fixture === 'string' ? fixture : JSON.stringify(fixture));
    const r = spawnSync(process.execPath, [self, ...args], {
      cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, STUB_EXIT: String(stubExit) },
    });
    return { code: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
  };
  const check = (name, got, wantCode, wantRe) => {
    if (got.code !== wantCode || !wantRe.test(got.out)) {
      failures++;
      console.error(`SELFTEST FAIL: ${name} -> exit ${got.code} wanted ${wantCode}; ${wantRe.test(got.out) ? 'output matched' : 'output missed ' + wantRe}`);
    } else console.log(`selftest ok: ${name}`);
  };
  try {
    let root = makeRoot();
    check('every test passed at or above the floor is CLEAN, and a tracked e2e file is not required in the report',
      runCli(root, { fixture: report(passing(root)) }), 0, /CLEAN: 3 tests passed/);

    root = makeRoot();
    check('a skipped test in a src/store file exits 1 naming it', runCli(root, {
      fixture: report(passing(root, { store: file(root, 'src/store/b.test.ts', [test('stores a line'), test('keeps a skipped line', 'skipped')]) })),
    }), 1, /src\/store\/b\.test\.ts: skipped: keeps a skipped line/);

    root = makeRoot();
    check('a passed count below the floor exits 1', runCli(root, { fixture: report(passing(root)), args: ['--floor', '10'] }),
      1, /only 3 tests passed, below the floor of 10/);

    root = makeRoot(['src/ui/x.test.tsx']);
    check('a tracked src/ui/x.test.tsx absent from the report exits 1 naming it', runCli(root, { fixture: report(passing(root)) }),
      1, /src\/ui\/x\.test\.tsx: tracked but not in the report/);

    root = makeRoot();
    check('an empty report is UNKNOWN, exit 2', runCli(root, { fixture: report([]) }), 2, /UNKNOWN: the report lists no test files/);

    root = makeRoot();
    check('an unparsable report is UNKNOWN, exit 2', runCli(root, { fixture: 'not json at all' }), 2, /UNKNOWN: .* did not parse/);

    root = makeRoot();
    mkdirSync(join(root, 'reports'), { recursive: true });
    writeFileSync(join(root, REPORT), JSON.stringify(report(passing(root))));
    check('a passing report left from an earlier run, with a vitest that exits 1 and writes nothing, is UNKNOWN, never clean',
      runCli(root, { stubExit: 1 }), 2, /UNKNOWN: vitest exited 1 and wrote no report/);

    root = makeRoot();
    check('one failed test in a src/domain file, every other test passed above the floor, exits 1 naming that test', runCli(root, {
      fixture: report(passing(root, { domain: file(root, 'src/domain/a.test.ts', [test('judges a reading'), test('judges 41.4 as out of range', 'failed')]) })),
      args: ['--floor', '1'], stubExit: 1,
    }), 1, /src\/domain\/a\.test\.ts: failed test: judges 41\.4 as out of range/);

    root = makeRoot();
    check('a file that failed to collect, with a message and no tests, exits 1 naming the file and its message', runCli(root, {
      fixture: report(passing(root, { server: file(root, 'src/server/c.test.ts', [], { status: 'failed', message: 'Cannot find module ./gone' }) })),
      args: ['--floor', '1'], stubExit: 1,
    }), 1, /src\/server\/c\.test\.ts: failed: Cannot find module \.\/gone/);

    root = makeRoot();
    check('a report whose success is false with no other sign exits 1', runCli(root, {
      fixture: report(passing(root), { success: false }),
    }), 1, /the report says success false/);

    root = makeRoot();
    check('a fully passing report from a vitest that exits 1 exits 1 naming the exit code', runCli(root, {
      fixture: report(passing(root)), stubExit: 1,
    }), 1, /vitest exited 1/);

    root = makeRoot();
    check('no --floor is UNKNOWN, exit 2, naming the usage', runCli(root, { fixture: report(passing(root)), args: [] }), 2, /--floor N/);
  } finally {
    for (const r of roots) {
      try { rmSync(r, { recursive: true, force: true }); } catch { /* a locked temp dir is left for the OS */ }
    }
  }
  if (failures) {
    console.error(`\n[test-count] SELFTEST FAILED (${failures}). Do not trust this gate.`);
    return 1;
  }
  console.log('\n[test-count] selftest passed: skipped, missing, failed and stale runs are all refused.');
  return 0;
}

if (process.argv.includes('--selftest')) process.exit(selftest());
process.exit(run(process.cwd()));
