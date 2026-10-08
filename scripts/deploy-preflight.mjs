#!/usr/bin/env node
// deploy-preflight.mjs - the first step of `npm run deploy`, after the build.
//
// WHY. The owner deploys a public Worker by hand, once per save point. A wrong key in the config
// does not fail loudly at deploy time: a Worker with no database_id deploys and then answers
// every tool call with a binding error, a missing hostname in ALLOWED_HOSTNAMES makes the Host
// check refuse every real request, workers_dev left at its default publishes a second public URL
// on the account subdomain, and a missing cron quietly stops the retention delete. This gate
// refuses all of those before wrangler touches the account.
//
// It reads dist/tolsey/wrangler.json, the config the Vite plugin builds and wrangler deploy
// actually ships, never wrangler.jsonc: the plugin rewrites the config, so the source file is not
// what deploys. An absent key in the built file is a refusal (wrangler defaults workers_dev to
// true), never a reason to go and read the source instead.
//
// WHAT IT CHECKS:
//   - d1_databases has an entry with binding DB whose database_id is set, not empty, not all zeros
//   - vars.ALLOWED_HOSTNAMES passes the Worker's own list rules (src/server/allowlist.ts, loaded
//     here as TypeScript, which Node 24 runs directly) and names tolsey.taranity.com: the Worker
//     refuses the whole list over one bad entry, so a list the Worker refuses must not deploy;
//     it names no loopback host (localhost, *.localhost, 127.x.x.x, [::1])
//   - workers_dev and preview_urls are exactly false (absent is not false)
//   - routes holds { pattern: tolsey.taranity.com, custom_domain: true }
//   - triggers.crons holds the hourly "0 * * * *" retention schedule
//   - package.json scripts.deploy runs the preflight, the remote migration apply, the
//     applied-migrations check and wrangler deploy in that order, every step joined by &&
//     (a ; or || lets the Worker deploy after a failed step)
//
// It only reads files: no writes, no child processes, no network.
//
// Exit codes: 0 cleared, 1 refused, 2 could not run (no built config, unreadable files).
//
// Usage: node scripts/deploy-preflight.mjs [--selftest]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllowlist } from '../src/server/allowlist.ts';

const DEPLOYED_HOST = 'tolsey.taranity.com';
const RETENTION_CRON = '0 * * * *';

const DEPLOY_STEPS = [
  { name: 'node scripts/deploy-preflight.mjs', re: /^node\s+scripts\/deploy-preflight\.mjs$/ },
  { name: 'wrangler d1 migrations apply DB --remote', re: /^wrangler\s+d1\s+migrations\s+apply\s+DB\s+--remote$/ },
  { name: 'node scripts/check-remote-migrations.mjs', re: /^node\s+scripts\/check-remote-migrations\.mjs$/ },
  { name: 'wrangler deploy', re: /^wrangler\s+deploy$/ },
];

// The Origin check compares hostnames only, so any page a cook's browser loads from its own machine
// (a dev server, a local tool) would pass if a loopback name were listed.
function isLoopback(hostname) {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.startsWith('127.') || hostname === '[::1]';
}

function readJson(file) {
  try {
    return { value: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (e) {
    return { error: e && e.code === 'ENOENT' ? 'missing' : 'did not parse' };
  }
}

function configProblems(config) {
  const problems = [];
  const dbs = Array.isArray(config.d1_databases) ? config.d1_databases : [];
  const db = dbs.find((d) => d && d.binding === 'DB');
  if (!db) {
    problems.push('d1_databases has no entry with binding DB');
  } else if (!('database_id' in db) || db.database_id == null) {
    problems.push('database_id is not set on the DB binding: create the database with wrangler d1 create tolsey --jurisdiction=eu and put its id into wrangler.jsonc');
  } else if (typeof db.database_id !== 'string' || db.database_id.trim() === '') {
    problems.push('database_id is empty on the DB binding: put the id wrangler d1 create printed into wrangler.jsonc');
  } else if (/^[0-]+$/.test(db.database_id.trim())) {
    problems.push('database_id is the all-zero placeholder, not a real database');
  }
  const raw = config.vars && typeof config.vars.ALLOWED_HOSTNAMES === 'string' ? config.vars.ALLOWED_HOSTNAMES : undefined;
  const allowlist = parseAllowlist(raw);
  if (!allowlist.ok) {
    problems.push(`${allowlist.reason}, so the deployed Worker would answer every request with 503`);
  } else {
    if (!allowlist.hostnames.includes(DEPLOYED_HOST)) {
      problems.push(`vars.ALLOWED_HOSTNAMES does not name ${DEPLOYED_HOST}, so the Host check would refuse every request to the deployed Worker`);
    }
    const loopback = allowlist.hostnames.filter(isLoopback);
    if (loopback.length) {
      problems.push(`vars.ALLOWED_HOSTNAMES names the loopback host(s) ${loopback.join(', ')}: a page on any loopback origin would pass the deployed Worker's Origin check. Local runs bind their own list (vite.config.ts, src/test-support/target.ts)`);
    }
  }
  for (const key of ['workers_dev', 'preview_urls']) {
    if (config[key] !== false) {
      const state = key in config ? JSON.stringify(config[key]) : 'absent';
      problems.push(`${key} is ${state}, not false: it would publish a second public URL on the account's workers.dev subdomain`);
    }
  }
  const routes = Array.isArray(config.routes) ? config.routes : [];
  if (!routes.some((r) => r && r.pattern === DEPLOYED_HOST && r.custom_domain === true)) {
    problems.push(`routes has no custom-domain route for ${DEPLOYED_HOST} ({ "pattern": "${DEPLOYED_HOST}", "custom_domain": true })`);
  }
  const crons = config.triggers && Array.isArray(config.triggers.crons) ? config.triggers.crons : [];
  if (!crons.includes(RETENTION_CRON)) {
    problems.push(`triggers.crons does not contain "${RETENTION_CRON}", so the hourly retention delete would never run`);
  }
  return problems;
}

// Splits on shell control operators, longest first, so "&&" and "||" never read as "&" or "|".
function deployScriptProblems(deploy) {
  if (typeof deploy !== 'string' || deploy.trim() === '') return ['package.json has no deploy script'];
  const parts = deploy.split(/(&&|\|\||;|\||&|\r?\n)/);
  const segments = parts.filter((_, i) => i % 2 === 0).map((s) => s.trim().replace(/\s+/g, ' '));
  const joins = parts.filter((_, i) => i % 2 === 1).map((j) => (j.trim() === '' ? 'a newline' : j));
  const problems = [];
  for (const op of new Set(joins.filter((j) => j !== '&&'))) {
    problems.push(`deploy script joins its steps with "${op}": only && stops the chain when a step fails`);
  }
  const positions = DEPLOY_STEPS.map((step) => segments.findIndex((s) => step.re.test(s)));
  DEPLOY_STEPS.forEach((step, i) => {
    if (positions[i] === -1) problems.push(`deploy script does not run ${step.name}`);
  });
  const deployAt = segments.findIndex((s) => /\bwrangler\s+deploy\b/.test(s));
  const found = positions.filter((p) => p !== -1);
  const ordered = found.every((p, i) => i === 0 || p > found[i - 1]);
  if (!ordered || (deployAt !== -1 && deployAt < Math.max(...found))) {
    problems.push(`deploy script runs its steps out of order: it must run ${DEPLOY_STEPS.map((s) => s.name).join(', then ')}`);
  }
  return problems;
}

function run(cwd) {
  const builtPath = join(cwd, 'dist', 'tolsey', 'wrangler.json');
  const built = readJson(builtPath);
  if (built.error === 'missing') {
    console.error('[deploy-preflight] UNKNOWN: dist/tolsey/wrangler.json does not exist. Run npm run build first; the preflight judges the built config, never the source.');
    return 2;
  }
  if (built.error || built.value === null || typeof built.value !== 'object' || Array.isArray(built.value)) {
    console.error('[deploy-preflight] UNKNOWN: dist/tolsey/wrangler.json did not parse as a config object. Run npm run build again.');
    return 2;
  }
  const pkg = readJson(join(cwd, 'package.json'));
  if (pkg.error || pkg.value === null || typeof pkg.value !== 'object') {
    console.error(`[deploy-preflight] UNKNOWN: package.json ${pkg.error || 'is not an object'}, so the deploy order cannot be checked.`);
    return 2;
  }
  const problems = [
    ...configProblems(built.value),
    ...deployScriptProblems(pkg.value.scripts && pkg.value.scripts.deploy),
  ];
  if (problems.length) {
    console.error(`[deploy-preflight] REFUSED, ${problems.length} problem(s) in dist/tolsey/wrangler.json and package.json:`);
    for (const p of problems) console.error(`  ${p}`);
    console.error('[deploy-preflight] Nothing was deployed. Fix wrangler.jsonc or package.json, then npm run deploy again.');
    return 1;
  }
  console.log(`[deploy-preflight] cleared: database, ${DEPLOYED_HOST} route and allowlist, workers_dev and preview_urls off, hourly cron, deploy order.`);
  return 0;
}

// --- selftest ---------------------------------------------------------------
// Hermetic: every case writes its own dist/tolsey/wrangler.json and package.json into a temp
// directory and runs this file there as a child process, so the verdict comes from the same
// entry point the deploy script calls.
const CLEAN_DEPLOY =
  'npm run build && node scripts/deploy-preflight.mjs && wrangler d1 migrations apply DB --remote' +
  ' && node scripts/check-remote-migrations.mjs && wrangler deploy';

function cleanConfig() {
  return {
    name: 'tolsey',
    main: 'index.js',
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: DEPLOYED_HOST, custom_domain: true }],
    triggers: { crons: [RETENTION_CRON] },
    vars: { ALLOWED_HOSTNAMES: DEPLOYED_HOST },
    d1_databases: [
      { binding: 'DB', database_name: 'tolsey', database_id: '11111111-2222-4333-8444-555555555555', migrations_dir: '../../migrations' },
    ],
  };
}

function listTree(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listTree(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

function selftest() {
  const self = fileURLToPath(import.meta.url);
  let failures = 0;
  const roots = [];
  const fixture = ({ config = cleanConfig(), mutate = null, deploy = CLEAN_DEPLOY, rawConfig = null, built = true } = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'deploy-preflight-st-'));
    roots.push(root);
    if (mutate) mutate(config);
    if (built) {
      mkdirSync(join(root, 'dist', 'tolsey'), { recursive: true });
      writeFileSync(join(root, 'dist', 'tolsey', 'wrangler.json'), rawConfig ?? JSON.stringify(config));
    }
    const scripts = deploy === null ? { build: 'vite build' } : { build: 'vite build', deploy };
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', private: true, scripts }, null, 2));
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
      console.error(`SELFTEST FAIL: ${name} -> exit ${got.code}, wanted ${wantCode}; output ${wantRe.test(got.out) ? 'matched' : 'did not match ' + wantRe}`);
    } else console.log(`selftest ok: ${name}`);
  };
  const db = (c) => c.d1_databases[0];
  const deployWith = (steps, joins) => steps.map((s, i) => (i === 0 ? s : `${joins[i - 1] ?? '&&'} ${s}`)).join(' ');
  const STEPS = ['npm run build', 'node scripts/deploy-preflight.mjs', 'wrangler d1 migrations apply DB --remote', 'node scripts/check-remote-migrations.mjs', 'wrangler deploy'];
  try {
    check('a complete built config and deploy script clear, exit 0',
      runCli(fixture()), 0, /cleared/);
    check('no built config is exit 2 telling the owner to build first, never a pass',
      runCli(fixture({ built: false })), 2, /npm run build/);
    check('an unparsable built config is exit 2',
      runCli(fixture({ rawConfig: '{ not json' })), 2, /did not parse/);
    check('no DB entry in d1_databases is refused',
      runCli(fixture({ mutate: (c) => { c.d1_databases = [{ binding: 'OTHER', database_id: 'x' }]; } })), 1, /d1_databases has no entry with binding DB/);
    check('an absent database_id is refused',
      runCli(fixture({ mutate: (c) => { delete db(c).database_id; } })), 1, /database_id is not set/);
    check('an empty database_id is refused (E30)',
      runCli(fixture({ mutate: (c) => { db(c).database_id = ''; } })), 1, /database_id is empty/);
    check('an all-zero database_id placeholder is refused',
      runCli(fixture({ mutate: (c) => { db(c).database_id = '00000000-0000-0000-0000-000000000000'; } })), 1, /database_id is the all-zero placeholder/);
    check('ALLOWED_HOSTNAMES without the deployed host is refused',
      runCli(fixture({ mutate: (c) => { c.vars.ALLOWED_HOSTNAMES = 'localhost,127.0.0.1'; } })), 1, /ALLOWED_HOSTNAMES does not name tolsey\.taranity\.com/);
    check('a host that only contains the deployed name as a substring is refused',
      runCli(fixture({ mutate: (c) => { c.vars.ALLOWED_HOSTNAMES = 'localhost,evil-tolsey.taranity.com.example'; } })), 1, /ALLOWED_HOSTNAMES does not name/);
    check('a list naming the deployed host beside an entry with a port is refused, as the Worker would refuse it',
      runCli(fixture({ mutate: (c) => { c.vars.ALLOWED_HOSTNAMES = `localhost:8787,127.0.0.1,${DEPLOYED_HOST}`; } })), 1, /ALLOWED_HOSTNAMES entry "localhost:8787" holds a port/);
    for (const loopback of ['localhost', '127.0.0.1', '[::1]', '127.0.0.2', 'app.localhost']) {
      check(`a list naming the loopback host ${loopback} beside the deployed host is refused`,
        runCli(fixture({ mutate: (c) => { c.vars.ALLOWED_HOSTNAMES = `${loopback},${DEPLOYED_HOST}`; } })), 1,
        new RegExp(`ALLOWED_HOSTNAMES names the loopback host\\(s\\) ${loopback.replace(/[.[\]]/g, '\\$&')}:`));
    }
    check('a list naming the deployed host beside a wildcard entry is refused',
      runCli(fixture({ mutate: (c) => { c.vars.ALLOWED_HOSTNAMES = `localhost,*.taranity.com,${DEPLOYED_HOST}`; } })), 1, /ALLOWED_HOSTNAMES entry "\*\.taranity\.com"/);
    check('workers_dev absent is refused, since wrangler defaults it to true (E30)',
      runCli(fixture({ mutate: (c) => { delete c.workers_dev; } })), 1, /workers_dev is absent/);
    check('workers_dev true is refused',
      runCli(fixture({ mutate: (c) => { c.workers_dev = true; } })), 1, /workers_dev is true/);
    check('preview_urls absent is refused',
      runCli(fixture({ mutate: (c) => { delete c.preview_urls; } })), 1, /preview_urls is absent/);
    check('preview_urls true is refused',
      runCli(fixture({ mutate: (c) => { c.preview_urls = true; } })), 1, /preview_urls is true/);
    check('no custom-domain route for the deployed host is refused',
      runCli(fixture({ mutate: (c) => { c.routes = [{ pattern: 'tolsey.taranity.com/*', zone_name: 'taranity.com' }]; } })), 1, /no custom-domain route for tolsey\.taranity\.com/);
    check('a custom-domain route with custom_domain not true is refused',
      runCli(fixture({ mutate: (c) => { c.routes = [{ pattern: DEPLOYED_HOST, custom_domain: 'true' }]; } })), 1, /no custom-domain route/);
    check('no hourly cron is refused',
      runCli(fixture({ mutate: (c) => { c.triggers = {}; } })), 1, /triggers\.crons does not contain "0 \* \* \* \*"/);
    check('no deploy script is refused',
      runCli(fixture({ deploy: null })), 1, /package\.json has no deploy script/);
    check('a deploy script running wrangler deploy before the remote migrations is refused',
      runCli(fixture({ deploy: deployWith([STEPS[0], STEPS[1], STEPS[4], STEPS[2], STEPS[3]], []) })), 1, /deploy script runs its steps out of order/);
    check('a deploy script with the applied-migrations check missing is refused',
      runCli(fixture({ deploy: deployWith([STEPS[0], STEPS[1], STEPS[2], STEPS[4]], []) })), 1, /deploy script does not run node scripts\/check-remote-migrations\.mjs/);
    check('a deploy script running the check after wrangler deploy is refused',
      runCli(fixture({ deploy: deployWith([STEPS[0], STEPS[1], STEPS[2], STEPS[4], STEPS[3]], []) })), 1, /deploy script runs its steps out of order/);
    check('a deploy script missing the preflight is refused',
      runCli(fixture({ deploy: deployWith([STEPS[0], STEPS[2], STEPS[3], STEPS[4]], []) })), 1, /deploy script does not run node scripts\/deploy-preflight\.mjs/);
    check('a deploy script applying migrations to the local database only is refused',
      runCli(fixture({ deploy: CLEAN_DEPLOY.replace('--remote', '--local') })), 1, /deploy script does not run wrangler d1 migrations apply DB --remote/);
    check('a deploy script joining the apply and the check with ; is refused',
      runCli(fixture({ deploy: deployWith(STEPS, ['&&', '&&', ';', '&&']) })), 1, /deploy script joins its steps with ";"/);
    check('a deploy script joining the check and wrangler deploy with || is refused',
      runCli(fixture({ deploy: deployWith(STEPS, ['&&', '&&', '&&', '||']) })), 1, /deploy script joins its steps with "\|\|"/);
    check('a deploy script joining the build and the preflight with ; is refused',
      runCli(fixture({ deploy: deployWith(STEPS, [';', '&&', '&&', '&&']) })), 1, /deploy script joins its steps with ";"/);
    check('every problem is reported at once, not only the first',
      runCli(fixture({ mutate: (c) => { delete c.workers_dev; db(c).database_id = ''; c.triggers = {}; } })), 1, /3 problem\(s\)[\s\S]*database_id is empty[\s\S]*workers_dev is absent[\s\S]*triggers\.crons/);

    const root = fixture();
    const files = listTree(root);
    const before = files.map((f) => readFileSync(join(root, f)));
    const got = runCli(root);
    const after = listTree(root);
    const unchanged = after.length === files.length && after.every((f, i) => f === files[i]) &&
      files.every((f, i) => readFileSync(join(root, f)).equals(before[i]));
    check('a run leaves every fixture file byte-identical and adds no file',
      { code: unchanged ? got.code : -99, out: got.out }, 0, /cleared/);
  } finally {
    for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch {} }
  }
  if (failures) {
    console.error(`\n[deploy-preflight] SELFTEST FAILED (${failures}). Do not trust this gate.`);
    return 1;
  }
  console.log('\n[deploy-preflight] selftest passed: every refusal is reachable and a complete config clears.');
  return 0;
}

if (process.argv.includes('--selftest')) process.exit(selftest());
process.exit(run(process.cwd()));
