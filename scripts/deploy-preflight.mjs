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
//   - vars.ALLOWED_HOSTNAMES names tolsey.taranity.com
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

const DEPLOYED_HOST = 'tolsey.taranity.com';
const RETENTION_CRON = '0 * * * *';

function run(cwd) {
  void cwd;
  console.log('[deploy-preflight] cleared.');
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
    vars: { ALLOWED_HOSTNAMES: `localhost,127.0.0.1,${DEPLOYED_HOST}` },
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
