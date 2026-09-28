#!/usr/bin/env node
// mutate-incremental.mjs - `npm run mutate`: Stryker's incremental mode, cleared whenever an input
// it cannot see has changed.
//
// WHY. Stryker runs this repo's tests through its command runner, which reports the whole command
// as one aggregate test (command-test-runner.js in @stryker-mutator/core 10). Its incremental mode
// can then detect changed mutants only, never a changed test (Stryker's incremental docs,
// "Limitations"), so a Killed result would outlive the test, fixture, rule row or config that
// killed it. This wrapper hashes every such input and deletes the incremental file when the hash
// differs from the one stored after the last successful run, which makes that run a full one.
//
// The new hash is stored only when Stryker exits 0. An interrupted or failed run keeps the old
// hash, so the next run clears the file again: the safe direction. Every recorded mutation score
// comes from `npm run mutate:full`, never from this script.
//
// Exit codes: Stryker's own; 2 when Stryker is not installed or the inputs cannot be listed.
//
// Usage: node scripts/mutate-incremental.mjs [--selftest]
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const STRYKER_BIN = join('node_modules', '@stryker-mutator', 'core', 'bin', 'stryker.js');

function run(cwd) {
  const stryker = join(cwd, STRYKER_BIN);
  const result = spawnSync(process.execPath, [stryker, 'run', '--incremental'], { cwd, stdio: 'inherit' });
  return result.status ?? 1;
}

// --- selftest ---------------------------------------------------------------
// Hermetic: a temp git repository with a STUB Stryker that records the arguments it received and
// whether the incremental file existed when it started, then writes that file as Stryker would.
const STUB = [
  "const fs = require('node:fs');",
  "const existed = fs.existsSync('reports/stryker-incremental.json');",
  "fs.appendFileSync('stub-calls.jsonl', JSON.stringify({ args: process.argv.slice(2), existed }) + '\\n');",
  "fs.mkdirSync('reports', { recursive: true });",
  "fs.writeFileSync('reports/stryker-incremental.json', '{}');",
  'process.exit(Number(process.env.STUB_EXIT || 0));',
].join('\n');

function selftest() {
  const self = fileURLToPath(import.meta.url);
  let failures = 0;
  const roots = [];
  const makeRoot = ({ git = true } = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'mutate-inc-st-'));
    roots.push(root);
    const put = (rel, body) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body);
    };
    put('package.json', '{"name":"fx","private":true}\n');
    put('stryker.config.json', '{}\n');
    put('src/domain/judge.ts', 'export const limit = 1;\n');
    put('src/domain/judge.test.ts', 'one test\n');
    put('data/rules.json', '[]\n');
    put(STRYKER_BIN, STUB);
    put('reports/stryker-incremental.json', '{"stale":true}\n');
    if (git) {
      execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'pipe' });
      execFileSync('git', ['add', 'package.json', 'stryker.config.json', 'src', 'data'], { cwd: root, stdio: 'pipe' });
    }
    return { root, put };
  };
  const runCli = (root, stubExit = 0) => {
    const r = spawnSync(process.execPath, [self], {
      cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, STUB_EXIT: String(stubExit) },
    });
    const calls = existsSync(join(root, 'stub-calls.jsonl'))
      ? readFileSync(join(root, 'stub-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      : [];
    return { code: r.status, out: String(r.stdout || '') + String(r.stderr || ''), calls, last: calls.at(-1) };
  };
  const check = (name, ok, detail) => {
    if (ok) console.log(`selftest ok: ${name}`);
    else {
      failures++;
      console.error(`SELFTEST FAIL: ${name} -> ${detail}`);
    }
  };
  const cleared = (got) => got.last !== undefined && got.last.existed === false;
  const kept = (got) => got.last !== undefined && got.last.existed === true;
  const seen = (got) => (got.last === undefined ? 'the stub never ran' : `the stub saw the file ${got.last.existed ? 'present' : 'absent'}, exit ${got.code}`);
  try {
    const { root, put } = makeRoot();
    let got = runCli(root);
    check('the first run, with no stored hash, clears the incremental file and runs', cleared(got) && got.code === 0 && /inputs changed/.test(got.out), seen(got));
    got = runCli(root);
    check('a second run with nothing changed keeps the incremental file', kept(got) && got.code === 0, seen(got));
    put('src/domain/judge.test.ts', 'two tests\n');
    got = runCli(root);
    check('a changed test file clears the incremental file', cleared(got), seen(got));
    put('data/rules.json', '[{"id":"cold"}]\n');
    got = runCli(root);
    check('a changed file under data/ clears the incremental file', cleared(got), seen(got));
    put('stryker.config.json', '{"concurrency":2}\n');
    got = runCli(root);
    check('a changed stryker.config.json clears the incremental file', cleared(got), seen(got));
    put('src/domain/judge.ts', 'export const limit = 2;\n');
    got = runCli(root);
    check('a changed non-test file under src/domain keeps the incremental file (Stryker diffs mutated source itself)', kept(got), seen(got));
    put('src/server/new.test.ts', 'a new untracked test\n');
    got = runCli(root);
    check('a new untracked test file clears the incremental file', cleared(got), seen(got));
    put('data/rules.json', '[{"id":"hot"}]\n');
    got = runCli(root, 1);
    check('a Stryker run that exits 1 is passed through as exit 1', cleared(got) && got.code === 1, seen(got));
    got = runCli(root);
    check('after a failed run the stored hash is unchanged, so the next run clears the file again', cleared(got) && got.code === 0, seen(got));
    const badArgs = got.calls.filter((c) => JSON.stringify(c.args) !== '["run","--incremental"]');
    check('every run passed Stryker exactly run --incremental', got.calls.length === 9 && badArgs.length === 0,
      `${got.calls.length} stub calls, ${badArgs.length} with other arguments: ${JSON.stringify(badArgs.map((c) => c.args))}`);

    const outside = makeRoot({ git: false });
    got = runCli(outside.root);
    check('a directory that is not a git repository exits 2 and never runs Stryker', got.code === 2 && got.calls.length === 0,
      `exit ${got.code}, ${got.calls.length} stub call(s)`);
  } finally {
    for (const r of roots) {
      try { rmSync(r, { recursive: true, force: true }); } catch { /* a locked temp dir is left for the OS */ }
    }
  }
  if (failures) {
    console.error(`\n[mutate] SELFTEST FAILED (${failures}). Do not trust this wrapper.`);
    return 1;
  }
  console.log('\n[mutate] selftest passed: every input Stryker cannot see clears its incremental results.');
  return 0;
}

if (process.argv.includes('--selftest')) process.exit(selftest());
process.exit(run(process.cwd()));
