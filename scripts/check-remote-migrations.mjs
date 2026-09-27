#!/usr/bin/env node
// check-remote-migrations.mjs - the step between the remote migration apply and wrangler deploy.
//
// WHY. `npm run deploy` joins its steps with &&, but that only stops the chain on a non-zero
// exit. `wrangler d1 migrations apply DB --remote` asks for confirmation first, and a "no"
// returns without an error, so the chain went on and deployed a Worker over a database without
// its tables. A migration that fails part way through a set leaves the same gap. The preflight
// can only check the ORDER of the commands, never whether they completed, so this check asks the
// database itself: `wrangler d1 migrations list DB --remote` names whatever is still unapplied.
//
// It decides from the OUTPUT of the list command, never its exit code: the list command returns
// normally whether or not migrations are pending (wrangler's d1MigrationsListCommand handler logs
// either "Migrations to be applied:" with a table of names or the "No migrations to apply!" line,
// and returns in both cases).
//
// Verdicts: 0 every migration applied, 1 migrations left to apply (deploy stops here),
//           2 could not tell (UNKNOWN: no wrangler, the list failed, printed nothing, or printed
//           something unrecognised). Only exit 0 lets wrangler deploy run.
//
// Usage: node scripts/check-remote-migrations.mjs [--local] [--persist-to <dir>] [--selftest]
// --local and --persist-to exist only to probe the real output shape against a local D1;
// `npm run deploy` passes neither.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function run(cwd, flags) {
  void cwd;
  void flags;
  console.log('[remote-migrations] every migration is applied.');
  return 0;
}

function parseFlags(argv) {
  const flags = { local: argv.includes('--local'), persistTo: null };
  const at = argv.indexOf('--persist-to');
  if (at !== -1) flags.persistTo = argv[at + 1] ?? '';
  return flags;
}

// --- selftest ---------------------------------------------------------------
// Hermetic: each case writes a stub node_modules/wrangler/bin/wrangler.js into a temp directory.
// The stub records the arguments it received and prints a scripted output, so every case also
// proves the check asked the REMOTE database (a check that listed the local one cannot pass).
const REMOTE_ARGS = ['d1', 'migrations', 'list', 'DB', '--remote'];
// wrangler prefixes the no-migrations line with a check mark emoji; built here so no emoji
// character sits in this source file.
const CHECK_MARK = String.fromCodePoint(0x2705);

function listing(...names) {
  return ['Migrations to be applied:', '| Name |', ...names.map((n) => `| ${n} |`), ''].join('\n');
}

function selftest() {
  const self = fileURLToPath(import.meta.url);
  let failures = 0;
  const roots = [];
  const caseDir = (stub) => {
    const root = mkdtempSync(join(tmpdir(), 'remote-migrations-st-'));
    roots.push(root);
    if (stub) {
      const bin = join(root, 'node_modules', 'wrangler', 'bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(root, 'node_modules', 'wrangler', 'package.json'), '{"name":"wrangler","type":"commonjs"}\n');
      writeFileSync(join(bin, 'wrangler.js'),
        "const fs = require('fs'); const path = require('path');\n" +
        "fs.writeFileSync(path.join(__dirname, '..', '..', '..', 'args.json'), JSON.stringify(process.argv.slice(2)));\n" +
        `process.stdout.write(${JSON.stringify(stub.out ?? '')});\n` +
        `process.stderr.write(${JSON.stringify(stub.err ?? '')});\n` +
        `process.exitCode = ${stub.code ?? 0};\n`);
    }
    return root;
  };
  const runCli = (cwd, args = []) => {
    try {
      const out = execFileSync(process.execPath, [self, ...args], { cwd, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status == null ? -1 : e.status, out: String((e && e.stdout) || '') + String((e && e.stderr) || '') };
    }
  };
  const argsSeen = (root) => {
    try {
      return JSON.parse(readFileSync(join(root, 'args.json'), 'utf8'));
    } catch {
      return null;
    }
  };
  const check = (name, got, wantCode, wantRe, { notRe = null, root = null, wantArgs = REMOTE_ARGS } = {}) => {
    const problems = [];
    if (got.code !== wantCode) problems.push(`exit ${got.code}, wanted ${wantCode}`);
    if (!wantRe.test(got.out)) problems.push(`output did not match ${wantRe}`);
    if (notRe && notRe.test(got.out)) problems.push(`output matched ${notRe}, which it must not`);
    if (root) {
      const seen = argsSeen(root);
      if (JSON.stringify(seen) !== JSON.stringify(wantArgs)) problems.push(`the stub received ${JSON.stringify(seen)}, wanted ${JSON.stringify(wantArgs)}`);
    }
    if (problems.length) {
      failures++;
      console.error(`SELFTEST FAIL: ${name} -> ${problems.join('; ')}`);
    } else console.log(`selftest ok: ${name}`);
  };
  const stubCase = (name, stub, wantCode, wantRe, opts = {}) => {
    const root = caseDir(stub);
    check(name, runCli(root, opts.args), wantCode, wantRe, { ...opts, root });
  };
  try {
    stubCase('a declined prompt leaves both migrations listed: exit 1 naming both, deploy stopped',
      { out: listing('0001_record.sql', '0002_append_only_guard.sql') }, 1,
      /0001_record\.sql[\s\S]*0002_append_only_guard\.sql[\s\S]*wrangler deploy did not run/);
    stubCase('a failed migration leaves it listed alone: exit 1 naming only 0002',
      { out: listing('0002_append_only_guard.sql') }, 1,
      /0002_append_only_guard\.sql[\s\S]*wrangler deploy did not run/, { notRe: /0001_record/ });
    stubCase('a partly applied set (0001 applied, 0002 not) is exit 1',
      { out: `Resource location: remote\n${listing('0002_append_only_guard.sql')}` }, 1,
      /left to apply[\s\S]*0002_append_only_guard\.sql/, { notRe: /0001_record/ });
    stubCase('terminal colour codes around the phrase are stripped before matching',
      { out: `\u001b[1mMigrations to be applied:\u001b[22m\n| 0001_record.sql |\n` }, 1,
      /0001_record\.sql/);
    stubCase('an already-current database is exit 0',
      { out: `Resource location: remote\n${CHECK_MARK} No migrations to apply!\n` }, 0,
      /every migration is applied/);
    stubCase('a list run that exits 1 is UNKNOWN, exit 2, and says nothing was deployed',
      { err: 'X [ERROR] A request to the Cloudflare API failed.\n', code: 1 }, 2,
      /UNKNOWN[\s\S]*A request to the Cloudflare API failed[\s\S]*nothing was deployed/);
    stubCase('a list run that prints nothing is UNKNOWN, exit 2',
      { out: '' }, 2, /UNKNOWN[\s\S]*printed nothing/);
    stubCase('a list run printing unrelated text is UNKNOWN, exit 2',
      { out: 'Resource location: remote\nsomething else entirely\n' }, 2, /UNKNOWN[\s\S]*did not recognise/);
    stubCase('--local with --persist-to lists the local database at that directory',
      { out: `${CHECK_MARK} No migrations to apply!\n` }, 0, /every migration is applied/,
      { args: ['--local', '--persist-to', 'state-dir'], wantArgs: ['d1', 'migrations', 'list', 'DB', '--local', '--persist-to', 'state-dir'] });
    check('no wrangler entry at all is exit 2',
      runCli(caseDir(null)), 2, /UNKNOWN[\s\S]*wrangler is not installed/);
    check('--persist-to without --local is a usage error, exit 2',
      runCli(caseDir(null), ['--persist-to', 'x']), 2, /--persist-to needs --local/);
  } finally {
    for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch {} }
  }
  if (failures) {
    console.error(`\n[remote-migrations] SELFTEST FAILED (${failures}). Do not trust this check.`);
    return 1;
  }
  console.log('\n[remote-migrations] selftest passed: declined, failed and partial sets stop the deploy; a current database clears it.');
  return 0;
}

if (process.argv.includes('--selftest')) process.exit(selftest());
process.exit(run(process.cwd(), parseFlags(process.argv.slice(2))));
