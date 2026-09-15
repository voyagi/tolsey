#!/usr/bin/env node
// check-ship-artifacts.mjs - fails the build when development-process artifacts are tracked
// in git. Checks known paths and file content, plus output-shaped directories, and refuses
// to report clean on a scan that could not run. Run --selftest to prove every rule fires.
// Exit codes: 0 clean, 1 findings, 2 the scan could not run.

import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN_PATHS = [
  '.claude/', '.planning/', '.crash-buffers/', '.codex/', '.agents/',
  '.cursor/', '.gemini/',   // other assistants' config trees (same class as .codex/)
  '.aider*',                // trailing * = PREFIX match at the root: .aider.chat.history.md,
  'CLAUDE.md', 'AGENTS.md',
  '.build-lane',
  'FINAL-REPORT.md', 'ATTACK-REPORT.md', 'REFINE-REPORT.md', 'FORENSICS-REPORT.md',
  'VERIFICATION.md',        // ROOT only; a nested one is judged by CONTENT below
  'HUMAN-TODO.md',          // carries absolute machine paths (home-path leak)
  'docs/BUILD-SPEC.md',     // useful while planning; it comes out before shipping
  'GOALS.md', 'RUNBOOK.md', 'evolve-log.tsv', 'GDPR-AUDIT.md',
  'graphify-out/',          // graphify's generated graph (graph.json, graph.html, cache/): a derived
];

const PASS_DIR_SEGMENT_RE = /^(?:[a-z0-9._-]+-)?pass-\d+$/i;
const SOURCE_ROOT_NAME_RE = /^(?:src|lib|libs|test|tests|spec|specs|vendor|node_modules|third_party|deps)$/i;

const STRONG_OUTPUT_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|pdf|mp4|webm|mov|har|trace|sarif|log|ndjson|jsonl|zip|gz|tgz)$/i;

const NEUTRAL_EXT_RE = /\.(md|markdown|txt|json|jsonc|ya?ml|toml|ini|cfg|conf|csv|tsv|svg|html?|xml|lock)$/i;

const PASS_DIR_MIN_OUTPUT = 3;

const RUN_DIR_SEGMENT_RE = /^[a-z0-9._]+(?:-[a-z0-9._]+)*-run$/i;
const RUN_TS_SEGMENT_RE = /^\d{4}-\d{2}-\d{2}[t_-]\d{2}[.:_-]?\d{2}(?:[.:_-]?\d{2})?(?:[.-]\d+)?z?$/i;
const BARE_DATE_SEGMENT_RE = /^\d{4}-\d{2}-\d{2}$/;
const RUN_PARENT_NAME_RE = /^runs?$/i;
const RUN_DIR_MIN_OUTPUT = 1;

function isRunSegment(seg, parent) {
  if (RUN_DIR_SEGMENT_RE.test(seg) || RUN_TS_SEGMENT_RE.test(seg)) return true;
  return BARE_DATE_SEGMENT_RE.test(seg) && parent !== null
    && (RUN_PARENT_NAME_RE.test(parent) || RUN_DIR_SEGMENT_RE.test(parent));
}

function artifactDirectoryFiles(files, isMarkedSegment, minOutput) {
  const byDir = new Map();
  for (const raw of files) {
    const norm = raw.replace(/\\/g, '/');
    const segs = norm.split('/');
    const base = segs.pop();
    const marked = segs.map((s, i) => isMarkedSegment(s, i > 0 ? segs[i - 1] : null));
    const idx = marked.indexOf(true);
    if (idx === -1) continue;
    if (segs.slice(0, idx).some((s) => SOURCE_ROOT_NAME_RE.test(s))) continue;
    const lastIdx = marked.lastIndexOf(true);
    const key = segs.slice(0, lastIdx + 1).join('/');
    let e = byDir.get(key);
    if (!e) { e = { files: [], strong: 0, unrecognised: 0 }; byDir.set(key, e); }
    e.files.push(norm);
    if (STRONG_OUTPUT_EXT_RE.test(base)) e.strong++;
    else if (!NEUTRAL_EXT_RE.test(base)) e.unrecognised++;
  }
  const flagged = new Map();
  for (const e of byDir.values()) {
    if (e.strong < minOutput) continue;
    const confident = e.unrecognised === 0;
    for (const f of e.files) {
      if (STRONG_OUTPUT_EXT_RE.test(f.slice(f.lastIndexOf('/') + 1))) {
        flagged.set(f, { confident });
      }
    }
  }
  return flagged;
}

function passDirectoryFiles(files) {
  return artifactDirectoryFiles(files, (s) => PASS_DIR_SEGMENT_RE.test(s), PASS_DIR_MIN_OUTPUT);
}

function runDirectoryFiles(files) {
  return artifactDirectoryFiles(files, isRunSegment, RUN_DIR_MIN_OUTPUT);
}

const PASS = 'pa' + 'ss';
const SIGNOFF = 'SIGN' + '-OFF';
const SLOPW = 'sl' + 'op';
const TELLW = 'AI-te' + 'll';
const DEAIW = 'de-' + 'AI';

const CONTENT_MARKERS = [
  { re: new RegExp(`\\b${PASS}\\s*\\(?\\s*\\d+\\s*(?:of|/)\\s*\\d+`, 'i'), what: 'pass numbering' },
  { re: new RegExp(`\\b${SIGNOFF.replace('-', '-?')}\\s+${PASS}\\b`, 'i'), what: `${SIGNOFF.toLowerCase()} ${PASS} label` },
  { re: new RegExp(`^\\s*Pass:\\s*(?:ATTACK|REFINE|PROVE|${SIGNOFF.replace('-', '-?')})`, 'im'), what: 'pipeline pass header' },
  { re: new RegExp(`\\bde-?${SLOPW}\\b|\\b(?:anti|AI)-${SLOPW}\\b|\\b${TELLW}s?\\b|\\b${DEAIW}\\b`, 'i'), what: 'meta-tell (build-strategy vocabulary)' },
];

const CONTENT_EXT_RE = /\.(md|markdown|mdx|txt|rst|adoc|org|tex|json|ndjson|sarif|ya?ml|toml|ini|cfg|conf|html?|xml|csv|tsv|log|diff|patch|jsonl|jsonc|svg|har|trace|lock)$/i;
const NO_EXT_RE = /(^|\/)\.?[^./]+$/;
const MAX_BYTES = 4 * 1024 * 1024;

function repoRoot(cwd) {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd, encoding: 'utf8', windowsHide: true,
  }).trim();
}

function scan(cwd) {
  let root;
  try {
    root = repoRoot(cwd);
  } catch (e) {
    return { unknown: true, reason: `not a git repository at ${cwd}: ${(e.message || '').split('\n')[0]}`, findings: [] };
  }

  let files;
  try {
    files = execFileSync('git', ['ls-files', '-z'], {
      cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    }).split('\0').filter(Boolean);
  } catch (e) {
    return { unknown: true, reason: `git ls-files failed: ${(e.message || '').split('\n')[0]}`, findings: [] };
  }
  if (files.length === 0) {
    return { unknown: true, reason: 'git ls-files returned no tracked files (empty index)', findings: [] };
  }

  const findings = [];
  const passFiles = passDirectoryFiles(files);
  const runFiles = runDirectoryFiles(files);
  for (const f of files) {
    const norm = f.replace(/\\/g, '/');
    const lower = norm.toLowerCase();
    for (const p of FORBIDDEN_PATHS) {
      const pl = p.toLowerCase();
      const hit = pl.endsWith('/') ? lower.startsWith(pl)
        : pl.endsWith('*') ? lower.startsWith(pl.slice(0, -1))
        : lower === pl;
      if (hit) {
        findings.push({ file: norm, why: `forbidden path (${p})` });
      }
    }
    const passHit = passFiles.get(norm);
    if (passHit) {
      findings.push({
        file: norm,
        why: passHit.confident
          ? 'pass-numbered directory (pipeline output)'
          : 'pass-numbered directory (ADVISORY: unrecognised files present, confirm before untracking)',
      });
    }
    const runHit = runFiles.get(norm);
    if (runHit) {
      findings.push({
        file: norm,
        why: runHit.confident
          ? 'run directory (pipeline output)'
          : 'run directory (ADVISORY: unrecognised files present, confirm before untracking)',
      });
    }
  }

  const gitlinks = new Set();
  try {
    for (const line of execFileSync('git', ['ls-files', '-s', '-z'], {
      cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    }).split('\0')) {
      if (line.startsWith('160000 ')) gitlinks.add(line.slice(line.indexOf('\t') + 1));
    }
  } catch { /* no gitlinks resolvable; every read failure then counts as unreadable */ }

  const unreadable = [];
  let read = 0;
  for (const f of files) {
    if (!CONTENT_EXT_RE.test(f) && !NO_EXT_RE.test(f)) continue;
    if (gitlinks.has(f)) continue; // a submodule has no content of its own here
    let buf;
    try {
      buf = readFileSync(join(root, f));
    } catch (e) {
      unreadable.push(`${f} (${(e && e.code) || 'read error'})`);
      continue;
    }
    if (buf.length > MAX_BYTES) {
      unreadable.push(`${f} (too large to scan fully: ${(buf.length / 1048576).toFixed(1)}MB)`);
      continue;
    }
    const body = buf.toString('utf8');
    read++;
    for (const m of CONTENT_MARKERS) {
      if (m.re.test(body)) { findings.push({ file: f.replace(/\\/g, '/'), why: `content: ${m.what}` }); break; }
    }
  }
  if (unreadable.length) {
    return {
      unknown: true,
      reason: `could not read ${unreadable.length} tracked file(s): ${unreadable.slice(0, 5).join(', ')}`,
      findings,
    };
  }

  const seen = new Set();
  const unique = findings.filter(x => {
    const k = x.file + '|' + x.why;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { unknown: false, ok: unique.length === 0, findings: unique, scanned: files.length, read, root };
}

function report(res) {
  if (res.unknown) {
    console.error(`[ship-artifacts] UNKNOWN: ${res.reason}`);
    console.error('[ship-artifacts] Refusing to report clean on a scan that did not run.');
    for (const f of res.findings || []) console.error(`  ${f.file}  <- ${f.why}`);
    return 2;
  }
  if (res.ok) {
    console.log(`[ship-artifacts] clean (${res.scanned} tracked, ${res.read} read)`);
    return 0;
  }
  console.error(`[ship-artifacts] ${res.findings.length} AI-process artifact(s) TRACKED in git:`);
  for (const f of res.findings) console.error(`  ${f.file}  <- ${f.why}`);
  if (res.findings.some((f) => /^forbidden path/.test(f.why) && !/^forbidden path \(\.build-lane\)/.test(f.why))) {
    console.error('');
    console.error('PATH hits are artifacts: untrack them (they stay on disk):');
    console.error('  git rm -r --cached <path>   then add to .gitignore');
  }
  if (res.findings.some((f) => /^forbidden path \(\.build-lane\)/.test(f.why))) {
    let excludePath = '.git/info/exclude';
    try { excludePath = git(['rev-parse', '--git-path', 'info/exclude'], res.root); } catch { /* keep the fallback */ }
    console.error('');
    console.error('THE .build-lane MARKER IS THE EXCEPTION: do NOT add it to .gitignore.');
    console.error('A tracked .gitignore naming it republishes the name. Ignore it locally instead:');
    for (const f of res.findings.filter((x) => /^forbidden path \(\.build-lane\)/.test(x.why))) {
      console.error(`  git rm --cached ${f.file}   then add /${f.file} to ${excludePath}`);
    }
    console.error('KEEP THE FILE ON DISK. The commit-msg hook, the build passes and the daily');
    console.error('health check all read it, so deleting it breaks them.');
  }
  if (res.findings.some((f) => /pass-numbered directory|run directory/.test(f.why))) {
    console.error('');
    console.error('PASS-NUMBERED AND RUN DIRECTORIES ARE A REPORT, NOT AN INSTRUCTION - both grades.');
    console.error('"pipeline output" means every file is a format this gate recognises, NOT that a');
    console.error('pipeline produced them: product images and screenshots are the same bytes to any');
    console.error('content test. "ADVISORY" means the directory also holds something unrecognised.');
    console.error('CONFIRM BEFORE UNTRACKING: open the directory, satisfy yourself it is pipeline');
    console.error('output rather than product files, and only then untrack it. Never on this alone.');
  }
  if (res.findings.some((f) => /^content:/.test(f.why))) {
    console.error('');
    console.error('CONTENT hits need a JUDGEMENT, not a reflex. If the file is a genuine product');
    console.error('document whose wording merely leaks pipeline vocabulary (a README, an ADR),');
    console.error('edit the wording - untracking it hides the leak rather than removing it. If it');
    console.error('is a pipeline REPORT that no path rule happened to name, untrack it like any');
    console.error('other artifact. Open the file and decide which it is.');
  }
  return 1;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'ship-artifacts-st-'));
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
  git(['add', '-A'], root);
  git(['commit', '-m', 'fixture'], root);
  const staged = git(['ls-files'], root).split('\n').filter(Boolean);
  const wanted = Object.keys(files).length;
  if (staged.length !== wanted) {
    throw new Error(`fixture staged ${staged.length} of ${wanted} file(s) - this case would ` +
      `assert nothing. Staged: ${staged.join(', ') || '(none)'}`);
  }
  return root;
}

function selftest() {
  const cases = [];
  const clean = { 'README.md': '# Thing\n\nInstall and run.\n', 'PRODUCT.md': '# Product\n\nWho it is for.\n' };

  cases.push({ name: 'clean product docs accepted', files: { ...clean, 'docs/VERIFICATION.md': '# Verification\n\nHow to check the build.\n' }, expect: 'clean' });

  cases.push({
    name: 'source and tests are NOT content-scanned (no false positive)',
    files: {
      ...clean,
      'src/render.ts': `// render ${PASS} 2 of 3 completes the frame\nexport const x = 1;\n`,
      'src/render.test.ts': `it('handles ${PASS} 2 of 3 correctly', () => {});\n`,
    },
    expect: 'clean',
  });

  cases.push({ name: 'path rule: root VERIFICATION.md', files: { ...clean, 'VERIFICATION.md': 'output\n' }, expect: 'fail' });
  cases.push({ name: 'path rule: case-variant .Codex/', files: { ...clean, '.Codex/reviews/n.json': '{"a":1}\n' }, expect: 'fail' });
  cases.push({ name: 'path rule: graphify-out/ generated graph', files: { ...clean, 'graphify-out/graph.json': '{"nodes":[],"edges":[]}\n' }, expect: 'fail' });
  cases.push({ name: 'path rule: root GOALS.md', files: { ...clean, 'GOALS.md': '## goals here\n' }, expect: 'fail' });
  cases.push({ name: 'path rule: root RUNBOOK.md', files: { ...clean, 'RUNBOOK.md': 'steps\n' }, expect: 'fail' });
  cases.push({ name: 'path rule: root evolve-log.tsv', files: { ...clean, 'evolve-log.tsv': 'a\tb\n' }, expect: 'fail' });
  cases.push({ name: 'path rule: root GDPR-AUDIT.md', files: { ...clean, 'GDPR-AUDIT.md': 'rows\n' }, expect: 'fail' });
  cases.push({
    name: 'path rule: root build-lane marker',
    files: { ...clean, '.build-lane': 'example-lane\n' },
    expect: 'fail', expectWhy: /forbidden path/,
  });
  cases.push({
    name: 'path rule: a NESTED build-lane fixture is not the root marker',
    files: { ...clean, 'scripts/fixtures/projects/demo/.build-lane': 'demo\n' },
    expect: 'clean',
  });
  cases.push({
    name: 'path rule: .planning/RUNBOOK.md is caught by the .planning/ prefix rule',
    files: { ...clean, '.planning/RUNBOOK.md': 'steps\n' },
    expect: 'fail', expectWhy: /forbidden path \(\.planning\/\)/,
  });
  cases.push({
    name: 'path rule: docs/RUNBOOK.md (an operator runbook) stays tracked and green',
    files: { ...clean, 'docs/RUNBOOK.md': '# Runbook\n\nRollback steps live here.\n' },
    expect: 'clean',
  });
  cases.push({ name: 'path rule: .cursor/', files: { ...clean, '.cursor/rules.json': '{"a":1}\n' }, expect: 'fail' });
  cases.push({ name: 'path rule: .gemini/', files: { ...clean, '.gemini/settings.json': '{"a":1}\n' }, expect: 'fail' });
  cases.push({ name: 'path rule: the .aider* prefix family', files: { ...clean, '.aider.chat.history.md': 'chat\n' }, expect: 'fail' });
  cases.push({
    name: 'path rule: a name merely containing aider is not in the .aider* family',
    files: { ...clean, 'src/aider-notes.md': 'about raiders\n' },
    expect: 'clean',
  });
  {
    const files = { ...clean };
    for (let i = 0; i < 3; i++) files[`artifacts/refine-pass-4/shot${i}.png`] = 'p\n';
    cases.push({ name: 'dir rule: pass-numbered directory', files, expect: 'fail' });
  }
  cases.push({ name: `content rule: ${PASS} numbering, parenthesised`, files: { ...clean, 'docs/notes/a.md': `# Report\n\nPROVE ${PASS} (2 of 5) complete\n` }, expect: 'fail' });
  cases.push({ name: `content rule: ${PASS} numbering, slash form`, files: { ...clean, 'docs/notes/b.md': `# Report\n\nrefine ${PASS} 4/5 done\n` }, expect: 'fail' });
  cases.push({ name: 'content rule: sign-off label', files: { ...clean, 'docs/notes/c.md': `# Handover\n\n${SIGNOFF} ${PASS} complete\n` }, expect: 'fail' });
  cases.push({ name: 'content rule: pipeline header', files: { ...clean, 'docs/notes/d.md': `# X\n\nPass: ATTACK\n` }, expect: 'fail' });
  cases.push({ name: 'content rule: meta-tell tool name', files: { ...clean, 'docs/notes/t1.md': `run the de${SLOPW} gate before shipping\n` }, expect: 'fail' });
  cases.push({ name: 'content rule: meta-tell hyphenated tool name', files: { ...clean, 'docs/notes/t2.md': `the de-${SLOPW} pass is green\n` }, expect: 'fail' });
  cases.push({ name: 'content rule: meta-tell anti compound', files: { ...clean, 'docs/notes/t3.md': `our anti-${SLOPW} bar\n` }, expect: 'fail' });
  cases.push({ name: 'content rule: meta-tell tells compound', files: { ...clean, 'docs/notes/t4.md': `zero ${TELLW}s remain\n` }, expect: 'fail' });
  cases.push({ name: `content rule: meta-tell ${DEAIW} compound`, files: { ...clean, 'docs/notes/t5.md': `after the ${DEAIW} step\n` }, expect: 'fail' });
  cases.push({
    name: 'ordinary prose with the bare inner word is NOT a meta-tell',
    files: { ...clean, 'docs/notes/t6.md': `Do not ${SLOPW} paint over the decade-AI... wait, over the deck.\n` },
    expect: 'clean',
  });
  cases.push({
    name: 'ordinary product prose is NOT flagged as tool attribution',
    files: {
      ...clean,
      'docs/api.md': '# API\n\nThe next page token is generated by cursor position, not by offset.\n',
      'docs/ai.md': '# AI\n\nImage captions are generated by Gemini, answers by Claude via the API.\n',
    },
    expect: 'clean',
  });
  cases.push({
    name: 'an ordinary directory containing "pass" is NOT a pass-numbered directory',
    files: { ...clean, 'src/multipass-3/shader.ts': 'export const x = 1;\n', 'src/bypass-2/i.ts': 'export const y = 2;\n' },
    expect: 'clean',
  });
  cases.push({ name: 'run rule: a stage-run directory with one log', files: { ...clean, 'docs/attack-run/feeds.log': 'lines\n' }, expect: 'fail' });
  cases.push({ name: 'run rule: case variant stage-run directory', files: { ...clean, 'docs/Attack-Run/feeds.log': 'lines\n' }, expect: 'fail' });
  {
    const files = { ...clean };
    files['docs/refine-run/2026-06-11T16-49-55Z/project/state/metrics.jsonl'] = '{"a":1}\n';
    files['docs/refine-run/2026-06-11T16-49-55Z/project/public/index.html'] = '<html></html>\n';
    cases.push({ name: 'run rule: dated run under a stage-run parent', files, expect: 'fail' });
  }
  cases.push({ name: 'run rule: a timestamp directory outside any -run parent', files: { ...clean, 'logs/2026-06-11T16-49-55Z/t1.jsonl': '{"a":1}\n' }, expect: 'fail' });
  cases.push({ name: 'run rule: a bare date directory under runs/', files: { ...clean, 'runs/2026-06-11/shot.png': 'p\n' }, expect: 'fail' });
  cases.push({ name: 'run rule: a dated blog directory is left alone', files: { ...clean, 'content/blog/2026-06-11/hero.png': 'p\n' }, expect: 'clean' });
  cases.push({ name: 'run rule: a millisecond timestamp directory is caught', files: { ...clean, 'logs/2026-06-11T16-49-55.123Z/t.jsonl': '{"a":1}\n' }, expect: 'fail' });
  cases.push({ name: 'run rule: a dated blog SLUG directory is left alone', files: { ...clean, 'content/blog/2026-06-11-launch-post/hero.png': 'p\n' }, expect: 'clean' });
  cases.push({ name: 'run rule: a bare run/ directory is left alone (prefix required)', files: { ...clean, 'tools/run/shot.png': 'p\n' }, expect: 'clean' });
  cases.push({ name: 'run rule: a source root above a run directory exempts it', files: { ...clean, 'src/perf-run/shot.png': 'p\n' }, expect: 'clean' });
  cases.push({ name: 'run rule: a furniture-only run directory is left alone', files: { ...clean, 'docs/notes-run/README.md': '# notes\n' }, expect: 'clean' });
  cases.push({ name: 'run rule: a FILE named like a run directory is not a hit', files: { ...clean, 'docs/demo-run.md': '# demo notes\n' }, expect: 'clean' });
  for (const ext of ['log', 'html', 'htm', 'csv', 'tsv', 'xml', 'toml', 'ini', 'cfg', 'conf',
    'org', 'tex', 'ndjson', 'sarif', 'diff', 'patch', 'rst', 'adoc', 'mdx', 'txt',
    'json', 'yaml', 'yml', 'markdown',
    'jsonl', 'jsonc', 'svg', 'har', 'trace', 'lock']) {
    cases.push({
      name: `content rule reaches .${ext}`,
      files: { ...clean, [`out/report.${ext}`]: `${SIGNOFF} ${PASS} complete\n` },
      expect: 'fail',
    });
  }
  cases.push({ name: 'content rule reaches hidden extensionless files', files: { ...clean, 'docs/.handover': `${SIGNOFF} ${PASS} complete\n` }, expect: 'fail' });
  cases.push({ name: 'content rule reaches plain extensionless files', files: { ...clean, 'docs/HANDOVER': `${SIGNOFF} ${PASS} complete\n` }, expect: 'fail' });

  for (const dir of ['design/refine-pass-4', 'design/signoff-pass-5', 'design/refine-pass-4/baseline',
    'artifacts/refine-pass-4', 'artifacts/signoff-pass-5', 'artifacts/refine-final-pass-4',
    'artifacts/verify-pass-6', 'artifacts/a11y-pass-3', 'artifacts/taste-pass-5', 'artifacts/design-pass-2',
    'artifacts/pass-2', 'artifacts/nested/deep-pass-9', 'docs/pass-3', 'reports/attack-pass-2',
    'pass-3', 'artifacts/REFINE-PASS-4', 'artifacts/SignOff-Pass-5',
    'apps/web/design/refine-pass-4', 'packages/site/design/signoff-pass-5',
    'apps/mobile/artifacts/verify-pass-6', 'examples/demo/artifacts/refine-pass-4']) {
    const files = { ...clean };
    for (let i = 0; i < 3; i++) files[`${dir}/shot${i}.png`] = 'p\n';
    cases.push({ name: `dir rule catches ${dir}/`, files, expect: 'fail' });
  }
  for (const [dir, file] of [
    ['web/src/render-pass-1', 'x.ts'],
    ['app/src/main/java/com/x/render-pass-1', 'A.java'],
    ['crates/core/src/render-pass-1', 'm.rs'],
    ['internal/gfx/blur-pass-2', 'b.go'],
    ['server/src/final-pass-2', 'y.ts'],
    ['components/blur-pass-2', 'index.tsx'],
    ['shaders/render-pass-1', 'frag.glsl'],
  ]) {
    cases.push({ name: `dir rule leaves ${dir}/ alone (not pipeline output)`, files: { ...clean, [`${dir}/${file}`]: 'x\n' }, expect: 'clean' });
  }
  for (const [dir, names] of [
    ['gfx/render-pass-1', ['a.hlsl', 'b.metal']],
    ['render/blur-pass-2', ['blur.wgsl']],
    ['proto/schema-pass-2', ['user.proto']],
    ['infra/deploy-pass-1', ['main.tf']],
    ['esm/build-pass-3', ['index.mts']],
    ['ui/blur-pass-2', ['styles.module.css']],
    ['hw/sim-pass-2', ['top.sv']],
  ]) {
    const files = { ...clean };
    for (const n of names) files[`${dir}/${n}`] = 'x\n';
    cases.push({ name: `dir rule leaves ${dir}/ alone (unlisted code extension)`, files, expect: 'clean' });
  }
  {
    const files = { ...clean, 'design/refine-pass-4/viewer.js': 'render();\n' };
    for (let i = 0; i < 12; i++) files[`design/refine-pass-4/baseline/shot${i}.png`] = 'p\n';
    cases.push({ name: 'a lone script does NOT silence a directory of screenshots', files, expect: 'fail' });
  }
  cases.push({
    name: 'a spec/ folder INSIDE a pass directory does not exonerate it',
    files: { ...clean, 'design/refine-pass-4/spec/a.png': 'p\n', 'design/refine-pass-4/spec/b.png': 'p\n', 'design/refine-pass-4/spec/c.png': 'p\n' },
    expect: 'fail',
  });
  {
    const files = { ...clean };
    for (let i = 0; i < 2; i++) files[`design/refine-pass-4/shot${i}.png`] = 'p\n';
    for (let i = 0; i < 2; i++) files[`design/refine-pass-4/tools-pass-2/shot${i}.png`] = 'p\n';
    cases.push({ name: 'nested pass dirs are judged separately, not merged over the floor', files, expect: 'clean' });
  }
  {
    const files = { ...clean };
    for (let i = 0; i < 3; i++) files[`design/refine-pass-4/shot${i}.png`] = 'p\n';
    files['design/refine-pass-4/tools-pass-2/gen.ts'] = 'export const x = 1;\n';
    cases.push({ name: 'a nested source pass dir does not exonerate the outer screenshots', files, expect: 'fail' });
  }
  for (const [label, extra] of [
    ['one README does not turn a shader directory into a delete instruction',
      { 'shaders/render-pass-1/frag.glsl': 'x\n', 'shaders/render-pass-1/README.md': '# shaders\n' }],
    ['one README does not turn a wgsl directory into a delete instruction',
      { 'render/blur-pass-2/blur.wgsl': 'x\n', 'render/blur-pass-2/README.md': '# blur\n' }],
    ['a package directory is not pipeline output',
      { 'packages/render-pass-1/package.json': '{}\n', 'packages/render-pass-1/tsconfig.json': '{}\n',
        'packages/render-pass-1/README.md': '# x\n', 'packages/render-pass-1/src/index.ts': 'export const x=1;\n' }],
    ['config furniture alone is not pipeline output',
      { 'infra/deploy-pass-1/main.tf': 'x\n', 'infra/deploy-pass-1/policy.json': '{}\n',
        'infra/deploy-pass-1/compose.yml': 'x\n', 'infra/deploy-pass-1/README.md': '# x\n' }],
    ['an svg icon beside a component is not pipeline output',
      { 'components/blur-pass-2/index.tsx': 'x\n', 'components/blur-pass-2/icon.svg': '<svg/>\n' }],
  ]) {
    cases.push({ name: `leave alone: ${label}`, files: { ...clean, ...extra }, expect: 'clean' });
  }
  for (const [label, names] of [
    ['jsonl traces', ['t1.jsonl', 't2.jsonl', 't3.jsonl']],
    ['sarif reports', ['semgrep.sarif', 'trivy.sarif', 'zap.sarif']],
    ['screenshots outnumbered by traces', ['a.png', 'b.png', 'c.png', 't1.jsonl', 't2.jsonl', 't3.jsonl', 't4.jsonl']],
    ['a har capture set', ['one.har', 'two.har', 'three.har']],
  ]) {
    const files = { ...clean };
    for (const n of names) files[`artifacts/refine-pass-4/${n}`] = 'x\n';
    cases.push({ name: `dir rule catches ${label}`, files, expect: 'fail' });
  }
  {
    const two = { ...clean };
    for (let i = 0; i < 2; i++) two[`assets/icon-pass-1/img${i}.png`] = 'p\n';
    cases.push({ name: 'two artifacts are below the floor and left alone', files: two, expect: 'clean' });
    const three = { ...clean };
    for (let i = 0; i < 3; i++) three[`assets/icon-pass-1/img${i}.png`] = 'p\n';
    cases.push({ name: 'three artifacts reach the floor and are caught', files: three, expect: 'fail' });
  }
  {
    const confident = { ...clean, 'design/refine-pass-4/manifest.json': '{}\n' };
    for (let i = 0; i < 3; i++) confident[`design/refine-pass-4/shot${i}.png`] = 'p\n';
    cases.push({
      name: 'a directory of pure output is named as output, not merely advised',
      files: confident, expect: 'fail', expectWhy: /pipeline output/, forbidWhy: /ADVISORY/,
      forbidFile: /manifest\.json$/,
    });
    const advisory = { ...clean, 'internal/gfx/blur-pass-2/blur.go': 'package gfx\n' };
    for (let i = 0; i < 3; i++) advisory[`internal/gfx/blur-pass-2/testdata/golden${i}.png`] = 'p\n';
    cases.push({
      name: 'a source directory holding golden images is ADVISORY, never a delete instruction',
      files: advisory, expect: 'fail', expectWhy: /ADVISORY/, forbidFile: /\.go$/,
    });
    const pkg = { ...clean, 'packages/icons-pass-1/package.json': '{}\n', 'packages/icons-pass-1/README.md': '# icons\n' };
    for (let i = 0; i < 3; i++) pkg[`packages/icons-pass-1/icon${i}.png`] = 'p\n';
    cases.push({
      name: 'a package directory is reported without naming its package.json or README',
      files: pkg, expect: 'fail', forbidFile: /package\.json$|packages\/icons-pass-1\/README\.md$/,
    });
  }
  for (const dir of ['src/render-pass-1', 'src/passes/blur-pass-2', 'src/multipass-3', 'src/bypass-2',
    'src/final-pass-2', 'src/build-pass-1', 'src/improve-pass-1', 'src/shipping-pass-1',
    'src/artifacts/render-pass-1', 'vendor/artifacts/x-pass-2', 'test/fixtures/artifacts/bypass-2',
    'packages/ui/src/render-pass-1', 'lib/compass-3']) {
    cases.push({ name: `dir rule leaves ${dir}/ alone`, files: { ...clean, [`${dir}/x.ts`]: 'export const x = 1;\n' }, expect: 'clean' });
  }

  for (const dir of ['design/compass-3', 'design/multipass-9', 'design/bypass-2',
    'design/pass-3-notes', 'design/refine-pass-4-draft']) {
    const files = { ...clean };
    for (let i = 0; i < 3; i++) files[`${dir}/shot${i}.png`] = 'binary-ish\n';
    cases.push({
      name: `dir rule leaves ${dir}/ alone on NAME SHAPE alone (no source present)`,
      files,
      expect: 'clean',
    });
  }
  for (const dir of ['vendor/pkg/refine-pass-4', 'node_modules/thing/artifacts/verify-pass-6']) {
    const files = { ...clean };
    for (let i = 0; i < 3; i++) files[`${dir}/shot${i}.png`] = 'p\n';
    cases.push({
      name: `dir rule leaves ${dir}/ alone on the SOURCE-ROOT NAME alone`,
      files,
      expect: 'clean',
    });
  }

  let failures = 0;
  let skipped = 0;
  const roots = [];
  try {
    for (const c of cases) {
      const root = fixture(c.files);
      roots.push(root);
      const res = scan(root);
      const got = res.unknown ? 'unknown' : (res.ok ? 'clean' : 'fail');
      const whys = (res.findings || []).map((f) => f.why);
      let problem = null;
      if (got !== c.expect) {
        problem = `expected ${c.expect}, got ${got}` + (whys.length ? ` (${whys.join('; ')})` : '');
      } else if (c.expectWhy && !whys.some((w) => c.expectWhy.test(w))) {
        problem = `no finding matched ${c.expectWhy} (${whys.join('; ') || 'no findings at all'})`;
      } else if (c.forbidWhy && whys.some((w) => c.forbidWhy.test(w))) {
        problem = `a finding matched ${c.forbidWhy}, which this case forbids (${whys.join('; ')})`;
      } else if (c.forbidFile && (res.findings || []).some((f) => c.forbidFile.test(f.file))) {
        problem = `a finding named a file matching ${c.forbidFile}, which this case forbids`;
      }
      if (problem) {
        failures++;
        console.error(`SELFTEST FAIL: ${c.name} -> ${problem}`);
      } else {
        console.log(`selftest ok: ${c.name}`);
      }
    }

    const notRepo = mkdtempSync(join(tmpdir(), 'ship-artifacts-st-norepo-'));
    roots.push(notRepo);
    if (!scan(notRepo).unknown) { failures++; console.error('SELFTEST FAIL: a non-repo must report UNKNOWN'); }
    else console.log('selftest ok: non-repo reports UNKNOWN, not clean');

    const emptyRepo = mkdtempSync(join(tmpdir(), 'ship-artifacts-st-empty-'));
    roots.push(emptyRepo);
    git(['init'], emptyRepo);
    if (!scan(emptyRepo).unknown) { failures++; console.error('SELFTEST FAIL: an empty index must report UNKNOWN'); }
    else console.log('selftest ok: empty index reports UNKNOWN, not clean');

    const sub = fixture({ ...clean, 'VERIFICATION.md': 'x\n', 'web/package.json': '{"name":"w"}\n' });
    roots.push(sub);
    const fromSub = scan(join(sub, 'web'));
    if (fromSub.unknown || fromSub.ok) {
      failures++;
      console.error('SELFTEST FAIL: a run from a subdirectory missed a root artifact (false clean)');
    } else console.log('selftest ok: a subdirectory run still scans the whole repo');

    const bigDir = fixture({ ...clean, 'docs/small.md': 'ok\n' });
    roots.push(bigDir);
    writeFileSync(join(bigDir, 'docs/big.md'), 'x'.repeat(MAX_BYTES + 1024) + `\n${SIGNOFF} ${PASS} complete\n`);
    git(['add', '-A'], bigDir); git(['commit', '-m', 'big'], bigDir);
    const bigRes = scan(bigDir);
    if (!bigRes.unknown) {
      failures++;
      console.error('SELFTEST FAIL: an oversized tracked file did not report UNKNOWN (silent partial scan)');
    } else console.log('selftest ok: an oversized file reports UNKNOWN rather than a partial clean');

    const wideBytes = fixture({ ...clean, 'docs/keep.md': 'ok\n' });
    roots.push(wideBytes);
    writeFileSync(join(wideBytes, 'notes.log'), Buffer.alloc(2 * 1024 * 1024, 0xff));
    git(['add', '-A'], wideBytes); git(['commit', '-m', 'wide'], wideBytes);
    const wideRes = scan(wideBytes);
    if (wideRes.unknown) {
      failures++;
      console.error('SELFTEST FAIL: a 2MB non-UTF-8 file reported UNKNOWN -> the size check is ' +
        'measuring the decoded string, not the file (' + wideRes.reason + ')');
    } else console.log('selftest ok: a non-UTF-8 file is measured by its real size, not its decode');

    const cjk = fixture({ ...clean, 'docs/keep2.md': 'ok\n' });
    roots.push(cjk);
    writeFileSync(join(cjk, 'big-cjk.log'), '漢'.repeat(1500000));
    git(['add', '-A'], cjk); git(['commit', '-m', 'cjk'], cjk);
    const cjkRes = scan(cjk);
    if (!cjkRes.unknown) {
      failures++;
      console.error('SELFTEST FAIL: a 4.5MB CJK file was scanned as if under the limit -> the ' +
        'size check is counting UTF-16 code units, not bytes');
    } else console.log('selftest ok: a multi-byte file is measured in bytes, not UTF-16 units');

    const dirPath = fixture({ ...clean, 'docs/notes.md': 'ok\n' });
    roots.push(dirPath);
    unlinkSync(join(dirPath, 'docs/notes.md'));
    mkdirSync(join(dirPath, 'docs/notes.md'));
    const dirRes = scan(dirPath);
    if (!dirRes.unknown) {
      failures++;
      console.error('SELFTEST FAIL: a tracked path replaced by a directory did not report UNKNOWN');
    } else console.log('selftest ok: a directory-shaped tracked path reports UNKNOWN');

    const mixed = fixture({ ...clean, 'VERIFICATION.md': 'x\n', 'docs/gone.md': 'ok\n' });
    roots.push(mixed);
    unlinkSync(join(mixed, 'docs/gone.md'));
    let mixedOut = '';
    try {
      execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { cwd: mixed, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
    } catch (e) { mixedOut = (e.stdout || '') + (e.stderr || ''); }
    if (!/VERIFICATION\.md/.test(mixedOut) || !/UNKNOWN/.test(mixedOut)) {
      failures++;
      console.error('SELFTEST FAIL: an UNKNOWN run did not name the artifact it had already found');
    } else console.log('selftest ok: findings are still named when the run ends UNKNOWN');

    const missing = fixture({ ...clean, 'docs/notes/z.md': 'nothing notable\n' });
    roots.push(missing);
    unlinkSync(join(missing, 'docs/notes/z.md'));
    const missingRes = scan(missing);
    if (!missingRes.unknown) {
      failures++;
      console.error('SELFTEST FAIL: a tracked-but-unreadable file did not report UNKNOWN');
    } else console.log('selftest ok: an unreadable tracked file reports UNKNOWN, not clean');

    const self = fileURLToPath(import.meta.url);
    const runCli = (cwd) => {
      try {
        execFileSync(process.execPath, [self], { cwd, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
        return 0;
      } catch (e) { return e.status == null ? -1 : e.status; }
    };
    const exitCases = [
      ['clean repo exits 0', fixture({ ...clean }), 0],
      ['a tracked artifact exits 1', fixture({ ...clean, 'VERIFICATION.md': 'x\n' }), 1],
      ['a scan that could not run exits 2', mkdtempSync(join(tmpdir(), 'ship-artifacts-st-nr-')), 2],
    ];
    for (const [name, repo, want] of exitCases) {
      roots.push(repo);
      const got = runCli(repo);
      if (got !== want) { failures++; console.error(`SELFTEST FAIL: ${name} -> got exit ${got}`); }
      else console.log(`selftest ok: ${name}`);
    }

    const cliOut = (cwd) => {
      try {
        return execFileSync(process.execPath, [self], { cwd, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
      } catch (e) { return String((e && e.stdout) || '') + String((e && e.stderr) || ''); }
    };
    {
      const REMEDIES = {
        PATH: /PATH hits are artifacts/,
        'build-lane': /THE \.build-lane MARKER IS THE EXCEPTION/,
        'pass-directory': /CONFIRM BEFORE UNTRACKING/,
        CONTENT: /CONTENT hits need a JUDGEMENT/,
      };
      const expectExactly = (label, files, want) => {
        const repo = fixture(files);
        roots.push(repo);
        const out = cliOut(repo);
        const wrong = [];
        for (const [key, re] of Object.entries(REMEDIES)) {
          const printed = re.test(out);
          if (printed !== want.includes(key)) {
            wrong.push(printed ? `${key} printed but must not be` : `${key} missing`);
          }
        }
        if (wrong.length) {
          failures++;
          console.error(`SELFTEST FAIL: ${label} did not print exactly its own remedy (${wrong.join('; ')})`);
        } else console.log(`selftest ok: ${label} prints exactly its own remedy`);
        return out;
      };

      const confidentRepo = { ...clean };
      for (let i = 0; i < 3; i++) confidentRepo[`artifacts/refine-pass-4/shot${i}.png`] = 'p\n';
      expectExactly('a confident pass-directory-only run', confidentRepo, ['pass-directory']);
      const advisoryRepo = { ...clean, 'internal/gfx/blur-pass-2/blur.go': 'package gfx\n' };
      for (let i = 0; i < 3; i++) advisoryRepo[`internal/gfx/blur-pass-2/testdata/g${i}.png`] = 'p\n';
      expectExactly('an advisory pass-directory-only run', advisoryRepo, ['pass-directory']);
      const runOnlyRepo = { ...clean, 'docs/attack-run/feeds.log': 'lines\n' };
      expectExactly('a run-directory-only run', runOnlyRepo, ['pass-directory']);
      expectExactly('a PATH-only run', { ...clean, 'VERIFICATION.md': 'x\n' }, ['PATH']);
      expectExactly('a CONTENT-only run',
        { ...clean, 'docs/notes/report.md': `${SIGNOFF} ${PASS} complete\n` }, ['CONTENT']);
      const markerOut = expectExactly('a build-lane marker-only run',
        { ...clean, '.build-lane': 'example-lane\n' }, ['build-lane']);
      expectExactly('a marker plus an ordinary path hit',
        { ...clean, '.build-lane': 'example-lane\n', 'VERIFICATION.md': 'x\n' }, ['PATH', 'build-lane']);

      if (!/add \/\.build-lane to /.test(markerOut)) {
        failures++;
        console.error('SELFTEST FAIL: the marker remedy must name the root-anchored /.build-lane, ' +
          'not a bare name that also hides nested fixture copies');
      } else console.log('selftest ok: the marker remedy names the root-anchored /.build-lane');

      {
        const variantRepo = fixture({ ...clean, '.BUILD-LANE': 'example-lane\n' });
        roots.push(variantRepo);
        const variantOut = cliOut(variantRepo);
        const wrong = [];
        if (!/git rm --cached \.BUILD-LANE\b/.test(variantOut)) wrong.push('the untrack command does not name .BUILD-LANE');
        if (!/add \/\.BUILD-LANE to /.test(variantOut)) wrong.push('the exclude pattern does not name /.BUILD-LANE');
        const caseName = "the marker remedy names the tracked path's own case";
        if (wrong.length) {
          failures++;
          console.error(`SELFTEST FAIL: ${caseName} -> ${wrong.join('; ')}`);
        } else console.log(`selftest ok: ${caseName}`);
      }

      const wtMain = fixture({ ...clean });
      roots.push(wtMain);
      const wtLinked = mkdtempSync(join(tmpdir(), 'ship-artifacts-st-wt-'));
      rmSync(wtLinked, { recursive: true, force: true }); // git insists on creating it itself
      roots.push(wtLinked);
      let worktreeMade = true;
      try {
        git(['worktree', 'add', '-b', 'selftest-worktree', wtLinked], wtMain);
      } catch { worktreeMade = false; }
      if (!worktreeMade) {
        failures++;
        console.error('SELFTEST FAIL: could not create a worktree fixture, so the marker remedy path is UNTESTED');
      } else {
        writeFileSync(join(wtLinked, '.build-lane'), 'example-lane\n');
        git(['add', '.build-lane'], wtLinked);
        git(['commit', '-m', 'track the marker'], wtLinked);
        const wtOut = cliOut(wtLinked);
        const named = (wtOut.match(/add \/\.build-lane to (.+)/) || [])[1];
        const resolved = git(['rev-parse', '--git-path', 'info/exclude'], wtLinked);
        if (!named) {
          failures++;
          console.error('SELFTEST FAIL: the marker remedy printed no exclude path in a linked worktree');
        } else if (named.trim() !== resolved) {
          failures++;
          console.error(`SELFTEST FAIL: the marker remedy named "${named.trim()}" but git resolves the exclude file to "${resolved}"`);
        } else {
          console.log('selftest ok: the marker remedy names git\'s own exclude path in a linked worktree');
        }
      }
    }

    const subRoot = fixture({ ...clean });
    roots.push(subRoot);
    const subDep = fixture({ 'lib.txt': 'dep\n' });
    roots.push(subDep);
    try {
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet',
        subDep.replace(/\\/g, '/'), 'vendor/dep'], { cwd: subRoot, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'add submodule'], { cwd: subRoot, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
      const subRes = scan(subRoot);
      if (subRes.unknown || !subRes.ok) {
        failures++;
        console.error('SELFTEST FAIL: a real submodule made the scan report ' +
          (subRes.unknown ? 'UNKNOWN' : 'findings') + ' -> ' + (subRes.reason || ''));
      } else console.log('selftest ok: a real submodule is skipped without becoming UNKNOWN');
    } catch (e) {
      skipped++;
      console.log('selftest SKIPPED: submodule control could not be built (' +
        String((e && e.message) || e).split('\n')[0] + ')');
    }

    const selfSrc = readFileSync(new URL(import.meta.url), 'utf8');
    const selfRepo = fixture({ ...clean, 'scripts/check-ship-artifacts.mjs': selfSrc });
    roots.push(selfRepo);
    const selfRes = scan(selfRepo);
    if (selfRes.unknown || !selfRes.ok) {
      failures++;
      console.error('SELFTEST FAIL: the gate flags ITS OWN SOURCE once installed -> ' +
        (selfRes.findings || []).map(f => `${f.file} (${f.why})`).join(', '));
    } else console.log('selftest ok: the gate does not flag its own installed source');

    for (const [label, file] of [
      ['gate', new URL(import.meta.url)],
      ['mutants harness', new URL('./check-ship-artifacts.mutants.mjs', import.meta.url)],
    ]) {
      let body = null;
      try { body = readFileSync(file, 'utf8'); } catch { /* harness may not sit beside the gate */ }
      if (body === null) { skipped++; console.log(`selftest SKIPPED: ${label} source not readable beside the gate`); continue; }
      const selfHits = CONTENT_MARKERS.filter(m => m.re.test(body)).map(m => m.what);
      if (selfHits.length) {
        failures++;
        console.error(`SELFTEST FAIL: ${label} source contains a literal marker example (${selfHits.join(', ')}) - ` +
          'assemble it from fragments, or widening the extension allowlist would make this file its own violation');
      } else console.log(`selftest ok: ${label} source carries no literal marker example`);
    }
  } finally {
    for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch {} }
  }

  if (failures) {
    console.error(`\n[ship-artifacts] SELFTEST FAILED (${failures}). Do not trust this gate.`);
    return 1;
  }
  if (skipped) {
    console.log(`\n[ship-artifacts] selftest passed with ${skipped} control(s) SKIPPED. Every rule ` +
      'that RAN fires alone and clean docs stay clean, but the skipped control(s) proved nothing ' +
      'on this machine. Exit 0 because a skip is an environment limit, not a gate defect.');
    return 0;
  }
  console.log('\n[ship-artifacts] selftest passed: every rule fires alone, and clean docs stay clean.');
  return 0;
}

if (process.argv.includes('--selftest')) {
  process.env.GIT_STRIP_CANARY = 'planted';
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase().startsWith('GIT_')) delete process.env[key];
  }
  if (process.env.GIT_STRIP_CANARY !== undefined) {
    console.error('[ship-artifacts] the GIT_* environment strip did not run: its planted canary '
      + 'survived. Refusing to build selftest fixtures with a possibly repo-pinned environment.');
    process.exit(2);
  }
  process.exit(selftest());
}
process.exit(report(scan(process.cwd())));

