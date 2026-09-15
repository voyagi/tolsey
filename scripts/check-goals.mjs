#!/usr/bin/env node
// check-goals.mjs - validates GOALS.md, the evolve loop's fitness file, as FLOORS ONLY.
//
// The failure this prevents is Goodhart by vibes: a goals file whose entries read "make it
// beautiful" or "score 95 on Lighthouse" trains the loop to game a judgment or a metered
// number. A goal here is a floor with a binary verdict: a command that exists, run to exit 0.
//
// THE CONTRACT (one block per goal):
//
//   ## <name>                        heading UNDER 37 characters, no taste words
//   **measure**: `<command>`         backticked; the command's binary must RESOLVE
//   **check**: exit code 0           this literal line - the only pass condition allowed
//   **weight**: 1..3
//
// At most SIX goals. Lighthouse is advisory, never a goal (its number is a measurement and its
// runs against a live origin can spend quota), so `lighthouse`/`lhci` measures are refused.
// An ABSENT file prints SKIPPED and exits 0: a product that has not adopted the evolve loop is
// not failing anything. A present file that does not parse into goals is a failure, not a skip.
//
// Exit codes: 0 valid (or absent, SKIPPED), 1 violations (each listed), 2 could not run.
//
// Usage: node scripts/check-goals.mjs [path-to-GOALS.md] [--selftest]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_GOALS = 6;
const MAX_NAME_CHARS = 37; // "under 37": 36 is the longest legal name
const WEIGHT_MIN = 1;
const WEIGHT_MAX = 3;
// Judgment words that mark a goal as taste, which no exit code can measure. Deliberately the
// unambiguous set: every one of these in a goal NAME means the goal is a vibe, not a floor.
const TASTE_WORDS = /\b(beautiful|elegant|polished|delightful|intuitive|sleek|stunning|gorgeous|lovely|premium|tasteful|classy|pretty|nice|awesome|amazing|world-class|aesthetic|feels|looks)\b/i;
// Advisory or metered measures, never a goal.
const REFUSED_BINARIES = new Set(['lighthouse', 'lhci']);

function resolveOnPath(token) {
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat', '.ps1'] : [''];
  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if (statSync(join(dir, token + ext)).isFile()) return true;
      } catch { /* keep looking */ }
    }
  }
  return false;
}

// A measure resolves when the thing it names can actually start on this machine:
//   npm run X  -> package.json has script X
//   node F     -> F exists relative to cwd (or absolutely)
//   npx ...    -> refused: npx eats exit codes on Windows, so it can never carry a floor
//   anything   -> its first token resolves on PATH
function measureProblem(cmd, cwd) {
  const tokens = cmd.trim().split(/\s+/);
  if (tokens.length === 0 || !tokens[0]) return 'is empty';
  const bin = tokens[0].toLowerCase();
  if (REFUSED_BINARIES.has(bin)) return `runs ${tokens[0]}, which is advisory and never a goal`;
  if (bin === 'npx' || bin === 'bunx') return 'runs through npx/bunx, which eats exit codes on Windows; use npm run or a direct node call';
  if (bin === 'npm') {
    if (tokens[1] !== 'run') return null; // npm test / npm ci etc: npm itself resolves
    const script = tokens[2];
    if (!script) return 'names npm run with no script';
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
      if (!pkg.scripts || !Object.prototype.hasOwnProperty.call(pkg.scripts, script)) {
        return `names npm script "${script}", which package.json does not define`;
      }
      return null;
    } catch {
      return 'names an npm script but package.json is unreadable here';
    }
  }
  if (bin === 'node') {
    const file = tokens[1];
    if (!file) return 'runs node with no script file';
    if (file.startsWith('-')) return null; // node -e / flags: node itself resolves
    const p = /^([a-z]:)?[\\/]/i.test(file) ? file : join(cwd, file);
    return existsSync(p) ? null : `runs node on ${file}, which does not exist`;
  }
  return resolveOnPath(tokens[0]) ? null : `runs ${tokens[0]}, which does not resolve on PATH`;
}

function validate(goalsPath, cwd) {
  let body;
  try {
    body = readFileSync(goalsPath, 'utf8');
  } catch (e) {
    console.error(`[goals] UNKNOWN: ${goalsPath} exists but could not be read (${(e && e.code) || 'read error'}).`);
    return 2;
  }
  const problems = [];
  const blocks = body.split(/^## /m).slice(1);
  if (blocks.length === 0) {
    problems.push('the file holds no "## <name>" goal blocks; the contract at the top of check-goals.mjs shows the shape');
  }
  if (blocks.length > MAX_GOALS) {
    problems.push(`${blocks.length} goals; at most ${MAX_GOALS} - more floors than that stops being a direction`);
  }
  for (const block of blocks) {
    const name = (block.split(/\r?\n/, 1)[0] || '').trim();
    const label = name || '(unnamed goal)';
    if (name.length >= MAX_NAME_CHARS) {
      problems.push(`"${label}": name is ${name.length} chars; keep it under ${MAX_NAME_CHARS}`);
    }
    const taste = TASTE_WORDS.exec(name);
    if (taste) {
      problems.push(`"${label}": "${taste[1]}" is a taste word - taste routes to the reviewer, never to a goal`);
    }
    const measure = /^\*\*measure\*\*:\s*`([^`]+)`\s*$/m.exec(block);
    if (!measure) {
      problems.push(`"${label}": no backticked **measure**: line`);
    } else {
      const mp = measureProblem(measure[1], cwd);
      if (mp) problems.push(`"${label}": measure ${mp}`);
    }
    if (!/^\*\*check\*\*: exit code 0\s*$/m.test(block)) {
      problems.push(`"${label}": the check line must be literally "**check**: exit code 0" - any other pass condition is a judgment or a number to game`);
    }
    const weight = /^\*\*weight\*\*:\s*(\d+)\s*$/m.exec(block);
    if (!weight) {
      problems.push(`"${label}": no **weight**: line`);
    } else if (Number(weight[1]) < WEIGHT_MIN || Number(weight[1]) > WEIGHT_MAX) {
      problems.push(`"${label}": weight ${weight[1]} is outside ${WEIGHT_MIN}..${WEIGHT_MAX}`);
    }
  }
  if (problems.length) {
    console.error(`[goals] ${problems.length} violation(s) in ${goalsPath}:`);
    for (const p of problems) console.error(`  ${p}`);
    return 1;
  }
  console.log(`[goals] valid: ${blocks.length} goal(s), every one a resolvable floor checked by exit code.`);
  return 0;
}

function run(cwd, explicitPath) {
  const candidates = explicitPath ? [explicitPath]
    : [join(cwd, '.planning', 'GOALS.md'), join(cwd, 'GOALS.md')];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    console.log(`[goals] SKIPPED: no GOALS.md at ${candidates.join(' or ')}. A product without the evolve loop has nothing to validate here.`);
    return 0;
  }
  return validate(found, cwd);
}

// --- selftest ---------------------------------------------------------------
function selftest() {
  const self = fileURLToPath(import.meta.url);
  let failures = 0;
  const roots = [];
  const GOOD = '## verify ship green\n**measure**: `node scripts/ok.mjs`\n**check**: exit code 0\n**weight**: 2\n';
  const fixture = (goalsBody, { pkg = null } = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'check-goals-st-'));
    roots.push(root);
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'ok.mjs'), 'process.exit(0);\n');
    if (pkg) writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
    if (goalsBody !== null) writeFileSync(join(root, 'GOALS.md'), goalsBody);
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
  try {
    check('a valid floors file passes', runCli(fixture(GOOD)), 0, /\[goals\] valid: 1 goal/);
    check('an absent file is a loud SKIPPED, exit 0', runCli(fixture(null)), 0, /SKIPPED: no GOALS\.md/);
    check('a heading of 37+ chars fails', runCli(fixture(
      '## this goal name is far too long to be a floor label\n**measure**: `node scripts/ok.mjs`\n**check**: exit code 0\n**weight**: 2\n')), 1, /keep it under 37/);
    check('a taste word in the name fails', runCli(fixture(
      '## beautiful landing page\n**measure**: `node scripts/ok.mjs`\n**check**: exit code 0\n**weight**: 2\n')), 1, /taste word/);
    check('an unresolvable measure fails', runCli(fixture(
      '## dead tool floor\n**measure**: `no-such-binary-xyzq --gate`\n**check**: exit code 0\n**weight**: 2\n')), 1, /does not resolve on PATH/);
    check('a missing npm script fails', runCli(fixture(
      '## gate floor\n**measure**: `npm run gate`\n**check**: exit code 0\n**weight**: 1\n',
      { pkg: { name: 'fx', scripts: {} } })), 1, /package\.json does not define/);
    check('a present npm script resolves', runCli(fixture(
      '## gate floor\n**measure**: `npm run gate`\n**check**: exit code 0\n**weight**: 1\n',
      { pkg: { name: 'fx', scripts: { gate: 'node scripts/ok.mjs' } } })), 0, /valid/);
    check('a non-literal check line fails', runCli(fixture(
      '## gate floor\n**measure**: `node scripts/ok.mjs`\n**check**: score above 90\n**weight**: 1\n')), 1, /literally "\*\*check\*\*: exit code 0"/);
    check('a weight outside 1..3 fails', runCli(fixture(
      '## gate floor\n**measure**: `node scripts/ok.mjs`\n**check**: exit code 0\n**weight**: 5\n')), 1, /outside 1\.\.3/);
    check('a seventh goal fails', runCli(fixture(Array.from({ length: 7 }, (_, i) =>
      `## floor number ${i}\n**measure**: \`node scripts/ok.mjs\`\n**check**: exit code 0\n**weight**: 1\n`).join('\n'))), 1, /at most 6/);
    check('a lighthouse measure is refused', runCli(fixture(
      '## perf floor\n**measure**: `lighthouse https://x.invalid`\n**check**: exit code 0\n**weight**: 1\n')), 1, /advisory and never a goal/);
    check('an npx measure is refused', runCli(fixture(
      '## gate floor\n**measure**: `npx some-tool`\n**check**: exit code 0\n**weight**: 1\n')), 1, /eats exit codes/);
    check('a goalless file fails rather than skips', runCli(fixture('# notes\n\njust prose\n')), 1, /holds no "## <name>" goal blocks/);
  } finally {
    for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch {} }
  }
  if (failures) {
    console.error(`\n[goals] SELFTEST FAILED (${failures}). Do not trust this gate.`);
    return 1;
  }
  console.log('\n[goals] selftest passed: every rule fires alone, valid floors and absence stay green.');
  return 0;
}

if (process.argv.includes('--selftest')) process.exit(selftest());
const pathArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
process.exit(run(process.cwd(), pathArg));
