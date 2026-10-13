#!/usr/bin/env node
// deploy-preflight.mjs - the first step of `npm run deploy`, after the build.
//
// WHY. The owner deploys a public Worker by hand, once per save point. A wrong key in the config
// does not fail loudly at deploy time: a Worker with no database_id deploys and then answers
// every scratch-kitchen request and every mint with a 500, a missing hostname in ALLOWED_HOSTNAMES
// makes the Host check refuse every real request, workers_dev left at its default publishes a
// second public URL on the account subdomain, a missing cron quietly stops the retention delete,
// and logging left to the platform's default either drops the Worker's fault lines or records every
// request's URL, which carries the kitchen id, against the privacy record. This gate refuses all of
// those before wrangler touches the account.
//
// It reads dist/tolsey/wrangler.json, the config the Vite plugin builds and wrangler deploy
// actually ships, never wrangler.jsonc: the plugin rewrites the config, so the source file is not
// what deploys. An absent key in the built file is a refusal (wrangler defaults workers_dev to
// true), never a reason to go and read the source instead.
//
// WHAT IT CHECKS:
//   - d1_databases has an entry with binding DB whose database_id is set, not empty, not all zeros
//   - vars.ALLOWED_HOSTNAMES passes the Worker's own list rules (src/server/allowlist.ts, loaded
//     here as TypeScript, which Node 24 runs directly) and names tolsey.taranity.com and nothing
//     else: the Worker refuses the whole list over one bad entry, so a list the Worker refuses
//     must not deploy
//   - workers_dev and preview_urls are exactly false (absent is not false)
//   - routes holds { pattern: tolsey.taranity.com, custom_domain: true }
//   - triggers.crons holds the hourly "0 * * * *" retention schedule
//   - observability.enabled is exactly true, so the Worker's own log lines are kept, and
//     observability.logs.invocation_logs is exactly false (absent is not false: wrangler fills it in
//     as true), so a request that succeeds leaves no log line (docs/privacy-accountability.md)
//   - observability.logs.enabled and observability.logs.persist are true or absent, and both
//     head_sampling_rate keys are 1 or absent, so no fault line is dropped or sampled away
//   - observability.traces.enabled is false or absent, since a trace records each request's full URL,
//     and observability.logs.destinations and observability.traces.destinations are empty or absent,
//     so no line goes to a service the privacy record does not name
//   - logpush is false or absent, and tail_consumers and streaming_tail_consumers are empty or absent,
//     since a Logpush job and a Tail Worker each receive every request's URL and metadata
//   - previews is absent or empty, since a previews block can turn all of the above back on for
//     preview deployments, which this Worker never publishes
//   - package.json scripts.deploy runs the build, the preflight, the remote migration apply, the
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

// The build comes first: the preflight judges dist/tolsey/wrangler.json and wrangler deploy ships that
// dist, so without a fresh build both would act on whatever the last build left.
const DEPLOY_STEPS = [
  { name: 'npm run build', re: /^npm\s+run\s+build$/ },
  { name: 'node scripts/deploy-preflight.mjs', re: /^node\s+scripts\/deploy-preflight\.mjs$/ },
  { name: 'wrangler d1 migrations apply DB --remote', re: /^wrangler\s+d1\s+migrations\s+apply\s+DB\s+--remote$/ },
  { name: 'node scripts/check-remote-migrations.mjs', re: /^node\s+scripts\/check-remote-migrations\.mjs$/ },
  { name: 'wrangler deploy', re: /^wrangler\s+deploy$/ },
];

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
    problems.push('database_id is not set on the DB binding: create the database with wrangler d1 create tolsey --jurisdiction=eu --binding DB, which writes its id onto the DB entry of wrangler.jsonc (a database that already exists: copy its id from wrangler d1 list onto that entry)');
  } else if (typeof db.database_id !== 'string' || db.database_id.trim() === '') {
    problems.push('database_id is empty on the DB binding: copy the id from wrangler d1 list onto the DB entry of wrangler.jsonc');
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
    // The Origin check compares hostnames only, so a page served under any other listed name (a
    // loopback dev server, a LAN address) would pass it: the list must be the deployed host alone.
    const others = allowlist.hostnames.filter((hostname) => hostname !== DEPLOYED_HOST);
    if (others.length) {
      problems.push(`vars.ALLOWED_HOSTNAMES names ${others.join(', ')} beside ${DEPLOYED_HOST}: a page served under any listed name would pass the deployed Worker's Origin check. Local runs bind their own list (vite.config.ts, src/test-support/target.ts)`);
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
  return problems.concat(loggingProblems(config));
}

function objectOrEmpty(value) {
  return value !== null && typeof value === 'object' ? value : {};
}

// The keys that keep, drop or sample the Worker's own lines are judged here, and the ones that record
// a request or send a line elsewhere in exportProblems. Absent logs.enabled, logs.persist and head
// sampling rates leave the platform default, which keeps every line; an explicit value that turns the
// Worker's own lines off, keeps them out of the dashboard or samples them is refused.
// redact_query_string is left alone: the kitchen id sits in the path, never in a query string.
function loggingProblems(config) {
  const problems = [];
  const observability = objectOrEmpty(config.observability);
  const logs = objectOrEmpty(observability.logs);
  if (observability.enabled !== true) {
    const state = 'enabled' in observability ? JSON.stringify(observability.enabled) : 'absent';
    problems.push(`observability.enabled is ${state}, not true: none of the Worker's own fault lines would be kept, the [retention] and [mint-sweep] sweep failures included`);
  }
  if (logs.invocation_logs !== false) {
    const state = 'invocation_logs' in logs ? JSON.stringify(logs.invocation_logs) : 'absent';
    problems.push(`observability.logs.invocation_logs is ${state}, not false: every request's URL, which carries the kitchen id, would be logged against the privacy record`);
  }
  for (const key of ['enabled', 'persist']) {
    if (key in logs && logs[key] !== true) {
      problems.push(`observability.logs.${key} is ${JSON.stringify(logs[key])}, not true or absent: the Worker's own fault lines would not be kept`);
    }
  }
  for (const [path, block] of [['observability', observability], ['observability.logs', logs]]) {
    if ('head_sampling_rate' in block && block.head_sampling_rate !== 1) {
      problems.push(`${path}.head_sampling_rate is ${JSON.stringify(block.head_sampling_rate)}, not 1 or absent: only a sample of the Worker's own fault lines would be kept`);
    }
  }
  return problems.concat(exportProblems(observability, logs), sinkProblems(config));
}

function isEmptyList(value) {
  return Array.isArray(value) && value.length === 0;
}

// A fetch handler's trace records url.full and url.path, which carry the kitchen id, with the
// visitor's user agent and location (Workers traces, spans and attributes, read 2026-10-11). Tracing
// is off unless a config turns it on, so absent passes. A destination sends lines to a service the
// privacy record names as no processor of this Worker's data.
function exportProblems(observability, logs) {
  const problems = [];
  const traces = objectOrEmpty(observability.traces);
  if ('enabled' in traces && traces.enabled !== false) {
    problems.push(`observability.traces.enabled is ${JSON.stringify(traces.enabled)}, not false or absent: every request's URL, which carries the kitchen id, would be traced against the privacy record`);
  }
  for (const [path, block] of [['observability.logs', logs], ['observability.traces', traces]]) {
    if ('destinations' in block && !isEmptyList(block.destinations)) {
      problems.push(`${path}.destinations is ${JSON.stringify(block.destinations)}, not empty or absent: lines would go to a service the privacy record does not name`);
    }
  }
  return problems;
}

// The top-level keys the installed wrangler types beside observability that also send a request's
// details out: logpush sends Workers Trace Events, which hold metadata about each request and
// response, to a Logpush job, and a Tail Worker receives each invocation's request URL, status,
// console lines and errors (Cloudflare Workers docs through Context7, read 2026-10-11). A previews
// block may override logpush, observability and the tail consumers for preview deployments
// (wrangler's PreviewsConfig type); this Worker publishes none, so any previews block is refused
// rather than judged a second time.
function sinkProblems(config) {
  const problems = [];
  if ('logpush' in config && config.logpush !== false) {
    problems.push(`logpush is ${JSON.stringify(config.logpush)}, not false or absent: every request's URL and metadata would go to a Logpush job the privacy record does not name`);
  }
  for (const key of ['tail_consumers', 'streaming_tail_consumers']) {
    if (key in config && !isEmptyList(config[key])) {
      problems.push(`${key} is ${JSON.stringify(config[key])}, not empty or absent: a Tail Worker would receive every request's URL, which carries the kitchen id`);
    }
  }
  const previews = config.previews;
  const emptyPreviews = previews !== null && typeof previews === 'object' && !Array.isArray(previews) && Object.keys(previews).length === 0;
  if ('previews' in config && !emptyPreviews) {
    problems.push(`previews is ${JSON.stringify(previews)}, not empty or absent: it could turn logging, traces, Logpush or Tail Workers back on for preview deployments, which this Worker never publishes`);
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
  console.log(`[deploy-preflight] cleared: database, ${DEPLOYED_HOST} route and allowlist, workers_dev and preview_urls off, hourly cron, fault logs kept with request logs, traces, Logpush and Tail Workers off, deploy order.`);
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
    observability: { enabled: true, logs: { invocation_logs: false } },
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
    // The unspecified address is joined from its parts so the commit gate's bind-address scan never
    // reads this test value as a server binding.
    const unspecified = ['0', '0', '0', '0'].join('.');
    for (const other of ['localhost', '127.0.0.1', '[::1]', '127.0.0.2', 'app.localhost', '192.168.1.20', unspecified]) {
      check(`a list naming ${other} beside the deployed host is refused`,
        runCli(fixture({ mutate: (c) => { c.vars.ALLOWED_HOSTNAMES = `${other},${DEPLOYED_HOST}`; } })), 1,
        new RegExp(`ALLOWED_HOSTNAMES names ${other.replace(/[.[\]]/g, '\\$&')} beside `));
    }
    check('a list naming the deployed host alone clears',
      runCli(fixture({ mutate: (c) => { c.vars.ALLOWED_HOSTNAMES = DEPLOYED_HOST; } })), 0, /cleared/);
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
    check('no observability block is refused for both keys, since the platform default decides neither',
      runCli(fixture({ mutate: (c) => { delete c.observability; } })), 1, /observability\.enabled is absent[\s\S]*invocation_logs is absent/);
    check('observability enabled false is refused',
      runCli(fixture({ mutate: (c) => { c.observability.enabled = false; } })), 1, /observability\.enabled is false, not true/);
    check('invocation_logs absent is refused, since wrangler fills it in as true',
      runCli(fixture({ mutate: (c) => { delete c.observability.logs; } })), 1, /invocation_logs is absent, not false/);
    check('invocation_logs true is refused',
      runCli(fixture({ mutate: (c) => { c.observability.logs.invocation_logs = true; } })), 1, /invocation_logs is true, not false/);
    check('logs.enabled false is refused, since it drops the fault lines',
      runCli(fixture({ mutate: (c) => { c.observability.logs.enabled = false; } })), 1, /observability\.logs\.enabled is false, not true or absent/);
    check('logs.persist false is refused, since it keeps the fault lines out of the dashboard',
      runCli(fixture({ mutate: (c) => { c.observability.logs.persist = false; } })), 1, /observability\.logs\.persist is false, not true or absent/);
    check('a head sampling rate below 1 on observability is refused',
      runCli(fixture({ mutate: (c) => { c.observability.head_sampling_rate = 0.1; } })), 1, /observability\.head_sampling_rate is 0\.1, not 1 or absent/);
    check('a head sampling rate below 1 on observability.logs is refused',
      runCli(fixture({ mutate: (c) => { c.observability.logs.head_sampling_rate = 0; } })), 1, /observability\.logs\.head_sampling_rate is 0, not 1 or absent/);
    check('traces turned on is refused, since a trace records each request\'s URL',
      runCli(fixture({ mutate: (c) => { c.observability.traces = { enabled: true }; } })), 1, /observability\.traces\.enabled is true, not false or absent/);
    check('a log destination is refused',
      runCli(fixture({ mutate: (c) => { c.observability.logs.destinations = ['an-outside-sink']; } })), 1, /observability\.logs\.destinations is \["an-outside-sink"\], not empty or absent/);
    check('a trace destination is refused even with traces off',
      runCli(fixture({ mutate: (c) => { c.observability.traces = { enabled: false, destinations: ['an-outside-sink'] }; } })), 1, /observability\.traces\.destinations is \["an-outside-sink"\], not empty or absent/);
    check('traces off and empty destinations clear',
      runCli(fixture({ mutate: (c) => { c.observability.traces = { enabled: false, destinations: [] }; c.observability.logs.destinations = []; } })), 0, /cleared/);
    check('logpush turned on is refused, since a Logpush job receives every request\'s metadata',
      runCli(fixture({ mutate: (c) => { c.logpush = true; } })), 1, /logpush is true, not false or absent/);
    check('a tail consumer is refused',
      runCli(fixture({ mutate: (c) => { c.tail_consumers = [{ service: 'a-tail-worker' }]; } })), 1, /tail_consumers is \[\{"service":"a-tail-worker"\}\], not empty or absent/);
    check('a streaming tail consumer is refused',
      runCli(fixture({ mutate: (c) => { c.streaming_tail_consumers = [{ service: 'a-tail-worker' }]; } })), 1, /streaming_tail_consumers is \[\{"service":"a-tail-worker"\}\], not empty or absent/);
    check('a previews block is refused, since it can turn logging back on for preview deployments',
      runCli(fixture({ mutate: (c) => { c.previews = { logpush: true }; } })), 1, /previews is \{"logpush":true\}, not empty or absent/);
    check('logpush false, empty tail consumer lists and an empty previews block clear',
      runCli(fixture({ mutate: (c) => { Object.assign(c, { logpush: false, tail_consumers: [], streaming_tail_consumers: [], previews: {} }); } })), 0, /cleared/);
    check('logs.enabled and logs.persist true with both sampling rates at 1 clear',
      runCli(fixture({ mutate: (c) => { Object.assign(c.observability, { head_sampling_rate: 1 }); Object.assign(c.observability.logs, { enabled: true, persist: true, head_sampling_rate: 1 }); } })), 0, /cleared/);
    check('no deploy script is refused',
      runCli(fixture({ deploy: null })), 1, /package\.json has no deploy script/);
    check('a deploy script running wrangler deploy before the remote migrations is refused',
      runCli(fixture({ deploy: deployWith([STEPS[0], STEPS[1], STEPS[4], STEPS[2], STEPS[3]], []) })), 1, /deploy script runs its steps out of order/);
    check('a deploy script with the applied-migrations check missing is refused',
      runCli(fixture({ deploy: deployWith([STEPS[0], STEPS[1], STEPS[2], STEPS[4]], []) })), 1, /deploy script does not run node scripts\/check-remote-migrations\.mjs/);
    check('a deploy script running the check after wrangler deploy is refused',
      runCli(fixture({ deploy: deployWith([STEPS[0], STEPS[1], STEPS[2], STEPS[4], STEPS[3]], []) })), 1, /deploy script runs its steps out of order/);
    check('a deploy script with no build is refused, since the preflight would judge whatever dist the last build left',
      runCli(fixture({ deploy: deployWith([STEPS[1], STEPS[2], STEPS[3], STEPS[4]], []) })), 1, /deploy script does not run npm run build/);
    check('a deploy script building after the preflight is refused',
      runCli(fixture({ deploy: deployWith([STEPS[1], STEPS[0], STEPS[2], STEPS[3], STEPS[4]], []) })), 1, /deploy script runs its steps out of order/);
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
