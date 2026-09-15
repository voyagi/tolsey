#!/usr/bin/env node
// check-icon-decision.mjs - a lucide icon dependency demands a RECORDED decision.
//
// The shadcn-to-lucide default icon set is a common source of look-alike interfaces: eleven
// products shipped lucide and zero recorded choosing it (a review on 2026-08-22). Lucide is
// not banned - it is a fine set - but an UNRECORDED lucide is
// the machine default wearing the product's clothes. This gate forces the one-line record: if
// any lucide package is a dependency, design/ART-DIRECTION.md must name it with a reason, or the
// build swaps to an icon set chosen for this audience (Iconify carries many).
//
// WHAT IT DELIBERATELY DOES NOT DO: judge the reason. A reason's quality is the eyeball's job;
// this gate only refuses the empty record. The line must carry at least four words so a stray
// "lucide" token in a dependency listing cannot stand in for a decision - a floor, not taste.
//
// Dependencies are read from EVERY package.json outside dependency/build trees, not only the
// root: monorepos often declare lucide in apps/*/package.json, and a root-only read
// passes them silently. pubspec.yaml is scanned too (the Flutter twin, lucide_icons).
//
// Exit codes: 0 ok or nothing to decide, 1 an unrecorded lucide, 2 could not run.
//
// Usage: node scripts/check-icon-decision.mjs [--selftest]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.stryker-tmp', 'coverage']);
const LUCIDE_DEP_RE = /(^|\/)lucide(-|_|$)|^@lucide\//;
const ART_DIRECTION = process.env.ART_DIRECTION_FILE || join('design', 'ART-DIRECTION.md');

function collectManifests(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const p = join(dir, entry);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (entry === 'package.json' || entry === 'pubspec.yaml') out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

function lucideDeps(root) {
  const hits = [];
  for (const file of collectManifests(root)) {
    const rel = relative(root, file).split('\\').join('/');
    if (file.endsWith('package.json')) {
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(file, 'utf8'));
      } catch (e) {
        return { error: `${rel} is unparseable (${(e && e.message) || 'parse error'}); a dependency read that failed has verified nothing` };
      }
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
        for (const name of Object.keys(pkg[section] || {})) {
          if (LUCIDE_DEP_RE.test(name)) hits.push(`${name} (${rel} ${section})`);
        }
      }
    } else {
      // pubspec's dependency names sit as "  lucide_icons:" lines; full YAML parsing is not
      // needed to see one, and a false hit here costs one recorded line, not a build.
      // A read that failed is UNKNOWN, same as an unparseable package.json: a skipped
      // manifest has verified nothing (the sibling path already says so).
      let text;
      try { text = readFileSync(file, 'utf8'); } catch (e) {
        return { error: `${rel} could not be read (${(e && e.message) || 'read error'}); a dependency read that failed has verified nothing` };
      }
      for (const m of text.matchAll(/^\s{2,}(lucide[\w-]*)\s*:/gim)) hits.push(`${m[1]} (${rel})`);
    }
  }
  return { hits };
}

function run(cwd) {
  const { hits, error } = lucideDeps(cwd);
  if (error) {
    console.error(`[icon-decision] UNKNOWN: ${error}.`);
    return 2;
  }
  if (hits.length === 0) {
    console.log('[icon-decision] ok: no lucide dependency anywhere, nothing to decide.');
    return 0;
  }
  const artPath = join(cwd, ART_DIRECTION);
  let art = '';
  try {
    art = readFileSync(artPath, 'utf8');
  } catch { /* judged below: a lucide dep with no art-direction file is exactly the finding */ }
  const decisionLines = art.split(/\r?\n/).filter((l) => /lucide/i.test(l) && l.trim().split(/\s+/).length >= 4);
  if (decisionLines.length > 0) {
    console.log(`[icon-decision] ok: ${hits.length} lucide dep(s), decision recorded in ${ART_DIRECTION}: "${decisionLines[0].trim()}"`);
    return 0;
  }
  console.error(`[icon-decision] UNRECORDED DEFAULT: ${hits.join(', ')} shipped with no icon decision.`);
  console.error(`[icon-decision] Lucide is the default icon set most generated interfaces ship with. Either:`);
  console.error(`[icon-decision]   1. record it: one line in ${ART_DIRECTION} naming lucide and WHY it fits this product, or`);
  console.error('[icon-decision]   2. swap to an icon set chosen for this audience (Iconify carries many).');
  console.error(existsSync(artPath)
    ? `[icon-decision] ${ART_DIRECTION} exists but no line names lucide with at least four words.`
    : `[icon-decision] ${ART_DIRECTION} does not exist at all.`);
  return 1;
}

// --- selftest ---------------------------------------------------------------
function selftest() {
  const self = fileURLToPath(import.meta.url);
  let failures = 0;
  const roots = [];
  const fixture = (files) => {
    const root = mkdtempSync(join(tmpdir(), 'check-icon-st-'));
    roots.push(root);
    for (const [rel, bodyText] of Object.entries(files)) {
      const p = join(root, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, bodyText);
    }
    return root;
  };
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
  const PKG_LUCIDE = '{"name":"fx","dependencies":{"lucide-react":"^0.4.0"}}';
  const ART_OK = '# Art direction\n\nIcons: lucide, kept deliberately: its stroke weight matches the instrument-panel anchor.\n';
  try {
    check('no lucide dependency passes', runCli(fixture({ 'package.json': '{"name":"fx","dependencies":{"react":"19"}}' })), 0, /nothing to decide/);
    check('no package.json at all passes', runCli(fixture({ 'README.md': '# x\n' })), 0, /nothing to decide/);
    check('lucide with no art-direction file fails', runCli(fixture({ 'package.json': PKG_LUCIDE })), 1, /does not exist at all/);
    check('lucide with a recorded decision passes', runCli(fixture({ 'package.json': PKG_LUCIDE, 'design/ART-DIRECTION.md': ART_OK })), 0, /decision recorded/);
    check('an art-direction file that never names lucide fails',
      runCli(fixture({ 'package.json': PKG_LUCIDE, 'design/ART-DIRECTION.md': '# Art direction\n\nIcons: the house set.\n' })), 1, /no line names lucide/);
    check('a bare "lucide" token is not a decision',
      runCli(fixture({ 'package.json': PKG_LUCIDE, 'design/ART-DIRECTION.md': '# Art direction\n\nlucide\n' })), 1, /no line names lucide with at least four words/);
    check('a monorepo lucide in apps/web is caught, not only the root',
      runCli(fixture({ 'package.json': '{"name":"root"}', 'apps/web/package.json': PKG_LUCIDE })), 1, /apps\/web\/package\.json dependencies/);
    check('a devDependency counts too',
      runCli(fixture({ 'package.json': '{"name":"fx","devDependencies":{"lucide-svelte":"1"}}' })), 1, /lucide-svelte/);
    check('the Flutter twin in pubspec.yaml is caught',
      runCli(fixture({ 'pubspec.yaml': 'name: fx\ndependencies:\n  lucide_icons: ^1.0.0\n' })), 1, /lucide_icons \(pubspec\.yaml\)/);
    check('an unparseable package.json is UNKNOWN, never clean',
      runCli(fixture({ 'package.json': '{not json' })), 2, /UNKNOWN/);
    check('a lucide dep inside node_modules is not a product dependency',
      runCli(fixture({ 'package.json': '{"name":"fx"}', 'node_modules/x/package.json': PKG_LUCIDE })), 0, /nothing to decide/);
  } finally {
    for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch {} }
  }
  if (failures) {
    console.error(`\n[icon-decision] SELFTEST FAILED (${failures}). Do not trust this gate.`);
    return 1;
  }
  console.log('\n[icon-decision] selftest passed: unrecorded lucide fails, recorded or absent lucide passes.');
  return 0;
}

if (process.argv.includes('--selftest')) process.exit(selftest());
process.exit(run(process.cwd()));
