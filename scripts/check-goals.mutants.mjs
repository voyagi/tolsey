#!/usr/bin/env node
// check-goals.mutants.mjs - proves check-goals.mjs --selftest can actually FAIL.
//
// Each mutant disables exactly ONE rule and asserts --selftest exits non-zero WITH at least one
// failed control. Both guards from the sibling harnesses are here from day one, because both
// were paid for there: a mutant is parsed with node --check first (a SyntaxError exits non-zero
// exactly like a caught mutation), and a non-zero exit with ZERO failed controls is NO VERDICT,
// never CAUGHT (anything that kills the suite early has the same signature as a catch).
//
// Usage: node scripts/check-goals.mutants.mjs
// Exit codes: 0 all mutations caught, 1 at least one escaped or returned no verdict.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), 'check-goals.mjs');
// Normalized so \n-embedding anchors survive a CRLF checkout (the sibling harnesses' measured
// 2026-08-29 failure shape); the mutant is written back LF-only, which node parses identically.
const src = readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

const MUTATIONS = [
  ['name length ceiling', 'const MAX_NAME_CHARS = 37;', 'const MAX_NAME_CHARS = 9999;'],
  ['goal count ceiling', 'const MAX_GOALS = 6;', 'const MAX_GOALS = 999;'],
  ['taste word list', 'const taste = TASTE_WORDS.exec(name);', 'const taste = null;'],
  ['measure resolution', 'const mp = measureProblem(measure[1], cwd);', 'const mp = null;'],
  ['the literal check line', "if (!/^\\*\\*check\\*\\*: exit code 0\\s*$/m.test(block)) {", 'if (false) {'],
  ['weight range', 'Number(weight[1]) < WEIGHT_MIN || Number(weight[1]) > WEIGHT_MAX', 'false'],
  ['advisory measures refused', "if (REFUSED_BINARIES.has(bin)) return `runs ${tokens[0]}, which is advisory and never a goal`;", ''],
  ['npx refusal', "if (bin === 'npx' || bin === 'bunx') return 'runs through npx/bunx, which eats exit codes on Windows; use npm run or a direct node call';", ''],
  ['npm script existence', "return `names npm script \"${script}\", which package.json does not define`;", 'return null;'],
  ['goalless file is a failure', "problems.push('the file holds no \"## <name>\" goal blocks; the contract at the top of check-goals.mjs shows the shape');", ''],
  // The anchor is the tail of the SKIPPED branch itself: the first version of this mutation
  // edited a line the absent-file path never reaches, which is a mutation that does not mutate
  // (it ESCAPED on arrival and proved nothing about the control).
  ['absent file exits 0, not 1', 'nothing to validate here.`);\n    return 0;', 'nothing to validate here.`);\n    return 1;'],
  ['violations exit 1', '    return 1;\n  }\n  console.log(`[goals] valid:', '    return 0;\n  }\n  console.log(`[goals] valid:'],
];

const dir = mkdtempSync(join(tmpdir(), 'check-goals-mutants-'));
let escaped = 0, skipped = 0, inconclusive = 0;
try {
  for (const [name, find, repl] of MUTATIONS) {
    const hits = src.split(find).length - 1;
    if (hits !== 1) {
      skipped++;
      console.log(`  ${hits === 0 ? 'SKIP' : 'AMBIGUOUS'} ${name} (anchor found ${hits} times - update this harness)`);
      continue;
    }
    const mutant = join(dir, `m${MUTATIONS.findIndex((m) => m[0] === name)}.mjs`);
    writeFileSync(mutant, src.replace(find, repl));
    try {
      execFileSync(process.execPath, ['--check', mutant], { windowsHide: true, stdio: 'pipe' });
    } catch {
      skipped++;
      console.log(`  UNPARSEABLE ${name} (the mutation is malformed, not the rule; rewrite it)`);
      continue;
    }
    let code = 0, out = '', err = '';
    try {
      out = execFileSync(process.execPath, [mutant, '--selftest'], { encoding: 'utf8', windowsHide: true, timeout: 120000, stdio: 'pipe' }) || '';
    } catch (e) {
      code = e.status == null ? -1 : e.status;
      out = String((e && e.stdout) || '');
      err = String((e && e.stderr) || '');
    }
    const failuresInRun = ((out + err).match(/SELFTEST FAIL: /g) || []).length;
    if (code === 0) {
      escaped++;
      console.log(`  ESCAPED ${name} (selftest stayed green with the rule disabled - its control is vacuous)`);
    } else if (failuresInRun === 0) {
      inconclusive++;
      console.log(`  NO VERDICT ${name} (exited ${code} without failing a single control)`);
    } else {
      console.log(`  CAUGHT  ${name} (${failuresInRun} control(s) failed)`);
    }
  }
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

const attempted = MUTATIONS.length - skipped;
console.log(`\n[goals-mutants] ${attempted - escaped - inconclusive}/${attempted} mutations caught` +
  (skipped ? `, ${skipped} skipped (fix the harness anchors)` : '') +
  (inconclusive ? `, ${inconclusive} no verdict` : ''));
process.exit(escaped || inconclusive || skipped ? 1 : 0);
