#!/usr/bin/env node
// check-tracked-gitignore.mjs - a TRACKED .gitignore must not name the build process.
//
// The leak this closes is subtle: the process files themselves (GOALS.md, RUNBOOK.md, the
// planning tree, review artifacts) are kept out of the repo by check-ship-artifacts.mjs, but an
// ignore RULE for them in a tracked .gitignore reprints the whole list to every cloner - the
// names alone say how the thing was built. That is why the install recipe writes those excludes
// into .git/info/exclude (never committed, invisible to a clone) and why this gate exists: it
// fails when any tracked .gitignore carries a process name, so the local convenience can never
// quietly migrate into the published file.
//
// Scans EVERY tracked .gitignore (root and nested). No tracked .gitignore at all is clean.
// Exit codes: 0 clean, 1 process names found, 2 the scan could not run.
//
// Usage: node scripts/check-tracked-gitignore.mjs [--selftest]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The process vocabulary a published ignore file must not carry. Matched case-insensitively
// against each line, comments included. 'claude' and 'planning' are substrings on purpose
// (.claude/, CLAUDE.md, .planning/ all leak the same way); the rest are the exact family
// names. REVIEW alone is boundary-anchored: bare, it sits inside 'preview', which is an
// ordinary product ignore rule (preview builds, .vercel/preview), and a gate that flags those
// gets deleted. \bREVIEW still catches REVIEW.md, REVIEW-*.md and reviews/.
const PROCESS_NAME_RE = /claude|planning|crash-buffer|BUILD-SPEC|RUNBOOK|GOALS|\bREVIEW|HUMAN-TODO|evolve/i;

function scan(cwd) {
  let root;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', windowsHide: true }).trim();
  } catch (e) {
    console.error(`[tracked-gitignore] UNKNOWN: not a git repository at ${cwd}: ${(e.message || '').split('\n')[0]}`);
    return 2;
  }
  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files', '-z', '--', '.gitignore', '**/.gitignore'], {
      cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    }).split('\0').filter(Boolean);
  } catch (e) {
    console.error(`[tracked-gitignore] UNKNOWN: git ls-files failed: ${(e.message || '').split('\n')[0]}`);
    return 2;
  }
  if (tracked.length === 0) {
    console.log('[tracked-gitignore] clean: no tracked .gitignore to inspect.');
    return 0;
  }
  const findings = [];
  for (const f of tracked) {
    let body;
    try {
      body = readFileSync(join(root, f), 'utf8');
    } catch (e) {
      console.error(`[tracked-gitignore] UNKNOWN: could not read tracked ${f} (${(e && e.code) || 'read error'}).`);
      return 2;
    }
    // Comment lines are judged too - a "# AI build artifacts" header leaks exactly as much as
    // the rule under it.
    body.split(/\r?\n/).forEach((line, i) => {
      const rule = line.trim();
      if (!rule) return;
      const m = PROCESS_NAME_RE.exec(rule);
      if (!m) return;
      const kind = rule.startsWith('#') ? 'comment ' : '';
      findings.push(`${f}:${i + 1}: ${kind}"${rule}" names the build process ("${m[0]}")`);
    });
  }
  if (findings.length) {
    console.error(`[tracked-gitignore] ${findings.length} process name(s) in tracked .gitignore file(s):`);
    for (const f of findings) console.error(`  ${f}`);
    console.error('');
    console.error('Move these rules to .git/info/exclude (same syntax, never committed, invisible to');
    console.error('a clone). The tracked .gitignore keeps only rules about the PRODUCT: build output,');
    console.error('dependencies, environment files.');
    return 1;
  }
  console.log(`[tracked-gitignore] clean (${tracked.length} tracked .gitignore file(s) inspected).`);
  return 0;
}

// --- selftest ---------------------------------------------------------------
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'tracked-gitignore-st-'));
  git(['init'], root);
  git(['config', 'user.email', 'selftest@example.invalid'], root);
  git(['config', 'user.name', 'selftest'], root);
  const noHooks = join(root, '.no-hooks');
  mkdirSync(noHooks);
  git(['config', 'core.hooksPath', noHooks], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  const noExcludes = join(root, '.git', 'empty-excludes');
  writeFileSync(noExcludes, '');
  git(['config', 'core.excludesFile', noExcludes.replace(/\\/g, '/')], root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  git(['add', '-A', '-f'], root);
  git(['commit', '-m', 'fixture'], root);
  return root;
}
function selftest() {
  const self = fileURLToPath(import.meta.url);
  let failures = 0;
  const roots = [];
  const runCli = (cwd) => {
    try {
      const out = execFileSync(process.execPath, [self], { cwd, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status == null ? -1 : e.status, out: String((e && e.stdout) || '') + String((e && e.stderr) || '') };
    }
  };
  const check = (name, got, wantCode, wantRe) => {
    if (got.code !== wantCode || !wantRe.test(got.out)) {
      failures++;
      console.error(`SELFTEST FAIL: ${name} -> exit ${got.code} wanted ${wantCode}; ${wantRe.test(got.out) ? 'output matched' : 'output missed ' + wantRe}`);
    } else console.log(`selftest ok: ${name}`);
  };
  try {
    let r = fixture({ 'README.md': '# x\n', '.gitignore': 'node_modules/\ndist/\n.env\n' });
    roots.push(r);
    check('a product-only .gitignore is clean', runCli(r), 0, /clean \(1 tracked/);
    r = fixture({ 'README.md': '# x\n', '.gitignore': 'preview-build/\n.vercel/preview/\n# previews are rebuilt\n' });
    roots.push(r);
    check('preview rules are NOT read as the REVIEW process name', runCli(r), 0, /clean \(1 tracked/);
    // One control per token in the pattern, each alone.
    for (const rule of ['.claude/', '.planning/', '.crash-buffers/', 'BUILD-SPEC*.md', 'RUNBOOK.md', 'GOALS.md', 'REVIEW-*.md', 'HUMAN-TODO.md', 'evolve-log.tsv']) {
      const fx = fixture({ 'README.md': '# x\n', '.gitignore': `node_modules/\n${rule}\n` });
      roots.push(fx);
      check(`the rule "${rule}" is caught`, runCli(fx), 1, /names the build process/);
    }
    r = fixture({ 'README.md': '# x\n', '.gitignore': 'node_modules/\n# AI planning artifacts live elsewhere\n' });
    roots.push(r);
    check('a comment naming the process is caught', runCli(r), 1, /comment ".*" names the build process/);
    r = fixture({ 'README.md': '# x\n', 'packages/web/.gitignore': 'dist/\n.planning/\n' });
    roots.push(r);
    check('a NESTED tracked .gitignore is inspected too', runCli(r), 1, /packages\/web\/\.gitignore/);
    r = fixture({ 'README.md': '# x\n' });
    roots.push(r);
    check('no tracked .gitignore at all is clean', runCli(r), 0, /no tracked \.gitignore/);
    const notRepo = mkdtempSync(join(tmpdir(), 'tracked-gitignore-st-nr-'));
    roots.push(notRepo);
    check('a non-repo is UNKNOWN, exit 2', runCli(notRepo), 2, /UNKNOWN: not a git repository/);
  } finally {
    for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch {} }
  }
  if (failures) {
    console.error(`\n[tracked-gitignore] SELFTEST FAILED (${failures}). Do not trust this gate.`);
    return 1;
  }
  console.log('\n[tracked-gitignore] selftest passed: every token fires alone, product rules stay green.');
  return 0;
}

if (process.argv.includes('--selftest')) {
  process.env.GIT_STRIP_CANARY = 'planted';
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase().startsWith('GIT_')) delete process.env[key];
  }
  if (process.env.GIT_STRIP_CANARY !== undefined) {
    console.error('[tracked-gitignore] the GIT_* environment strip did not run; refusing to build fixtures.');
    process.exit(2);
  }
  process.exit(selftest());
}
process.exit(scan(process.cwd()));
