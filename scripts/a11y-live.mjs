#!/usr/bin/env node
// a11y-live.mjs - the wall's accessibility gate, in a real browser over the built Worker.
//
// WHY THIS EXISTS
// A render test reads markup; it cannot press Tab, see a focus ring, hear a live region or watch what the page keeps
// in the browser. This drives the built wall through the dev-browser CLI in Light and Dark and, in each theme, takes
// it through its four states: initial, a logged reading, a refused numberless check, and NOT LOGGED (the MCP route
// blocked in the browser, so the call fails the way a dropped connection does), each audited only once the
// open-checks board shows the list the record gives in that state, then opens the privacy notice. axe-core audits
// each of the ten state and theme pairs against WCAG 2.0, 2.1 and 2.2 A and AA, injected with page.evaluate because the page's
// Content Security Policy refuses an injected script tag. In the Light run a fresh page is
// walked by keyboard alone: every chip, the field, Send, each cook on the roster, each theme button and the footer's
// link to the privacy notice must take focus with a visible ring, and Enter on two chips must log a reading and get a refusal. The one status region must
// be written exactly twice across a logged reading, a refusal, a held question and a theme change, and afterwards
// the browser may hold the tolsey-theme key and nothing else, since the privacy notice says so.
//
// WIRING: verify:ship only, after the build; local, never CI (dev-browser is a machine CLI). Run `npx vite build`
// first: it serves dist/, never the sources. The walk is written to reports/a11y-live/keyboard-walk.json (git-ignored).
// `--plant-missing-label` removes the text field's label before the first audit, so the gate can be seen red.
//
// Exit codes: 0 clean, 1 an accessibility, focus, status or storage failure, 2 the run could not audit (no dist,
// no CLI, no axe, zero checks, a non-200 navigation, a theme that did not take).

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { CannotRun, DEV_BROWSER_DIR, runDevBrowser, withBuiltWall } from './wall-browser.mjs';

const THEMES = ['light', 'dark'];
// The privacy notice is audited as one more state: it is public beside the wall, and its accessibility statement
// names this check.
const STATES = ['initial', 'logged', 'refused', 'not-logged', 'privacy'];
const REPORT_DIR = 'reports/a11y-live';
const TIMEOUT_SECONDS = 300;
const BROWSER_NAME = 'tolsey-a11y-live';
// The phrases are the wall's own chips (src/ui/wall-copy.ts); the NOT LOGGED words only need to be a call.
const PHRASES = {
  logged: 'the walk-in reads 38',
  refused: 'reach-in two is fine',
  held: 'walk-in 15',
  notLogged: 'the walk-in reads 37',
};
const NOT_LOGGED_TEXT = 'NOT LOGGED';
const ROSTER_SIZE = 4;
const THEME_BUTTONS = 3;
const MIN_RING_PX = 2;
const EXPECTED_STATUS_WRITES = 2;
const ALLOWED_STORAGE_KEYS = new Set(['tolsey-theme']);
const PLANT_FLAG = '--plant-missing-label';
const AXE_FILE = 'tolsey-axe.min.js';
const AXE_OPTIONS = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  // axe skips a rule it ships disabled even when its tag is selected: target-size (WCAG 2.5.8, wcag22aa) is still
  // "enabled": false in 4.14.0, and label-content-name-mismatch (2.5.3) is experimental. Named, they run.
  rules: { 'target-size': { enabled: true }, 'label-content-name-mismatch': { enabled: true } },
};
// An incomplete result is axe saying it could not decide, which is not clean. An entry here names the rule, the
// state and why axe cannot decide it on this wall; nothing has needed one.
const ALLOWED_INCOMPLETE = [];

// The script dev-browser runs, in its QuickJS sandbox. Everything it needs is written in as a literal.
function themeScript(base, theme, walk, plant) {
  return `
const BASE = ${JSON.stringify(base)};
const THEME = ${JSON.stringify(theme)};
const WALK = ${JSON.stringify(walk)};
const PLANT = ${JSON.stringify(plant)};
const PHRASES = ${JSON.stringify(PHRASES)};
const AXE_OPTIONS = ${JSON.stringify(AXE_OPTIONS)};
const AXE_SOURCE = await readFile(${JSON.stringify(AXE_FILE)});
const result = { theme: THEME, navigations: [], states: [], description: null, walk: null, planted: null, csp: [], errors: [] };

function message(error) {
  return String(error && error.message ? error.message : error);
}

async function freshPage() {
  const page = await browser.newPage();
  page.on('console', (entry) => {
    const text = entry.text();
    if (text.indexOf('Content Security Policy') !== -1) result.csp.push(text);
  });
  await page.emulateMedia({ colorScheme: THEME, reducedMotion: 'reduce' });
  return page;
}

async function waitReady(page) {
  await page.waitForSelector('button.chip:not([disabled])', { timeout: 30000 });
}

// A navigation that is not a 200 still renders something; recording the status lets the gate refuse it.
async function openWall(page) {
  const response = await page.goto(BASE + '/?theme=' + THEME);
  const status = response === null ? null : response.status();
  result.navigations.push(status);
  await waitReady(page);
  return status;
}

function appliedTheme(page) {
  return page.evaluate(() => document.documentElement.getAttribute('data-theme'));
}

// One call is in flight at a time, and the field is read-only while it is, so its words in the exchange with the
// field writable again means this utterance's answer has landed.
async function waitForAnswer(page, words) {
  await page.waitForFunction((said) => {
    const element = document.querySelector('.exchange .said');
    const field = document.querySelector('#cook-words');
    return element !== null && element.textContent === said && field !== null && !field.readOnly;
  }, words, { timeout: 30000 });
  return page.evaluate(() => {
    const answer = document.querySelector('.exchange .answer');
    const reading = document.querySelector('.pass .reading');
    return { answer: answer === null ? null : answer.textContent, reading: reading === null ? null : reading.textContent };
  });
}

function chip(page, words) {
  return page.getByRole('button', { name: words, exact: true });
}

// The open-checks board answers after the reply, so each audit first waits for the list the record gives in that
// state: axe then judges the board as a judge sees it, empty at load and after the logged reading, holding reach-in
// two after the refusal.
async function waitForBoard(page, expected) {
  await page.waitForFunction((text) => {
    const board = document.querySelector('.board');
    return board !== null && board.textContent.indexOf(text) !== -1;
  }, expected, { timeout: 30000 });
  return { board: await page.evaluate(() => document.querySelector('.board').textContent) };
}

// The theme is read first and recorded with the audit, so an audit of the wrong theme is refused, never counted.
async function checkpoint(page, state, extra) {
  const entry = Object.assign({ state: state, theme: await appliedTheme(page) }, extra || {});
  const loaded = await page.evaluate(() => typeof window.axe !== 'undefined');
  if (!loaded) await page.evaluate(AXE_SOURCE);
  entry.audit = await page.evaluate((options) => window.axe.run(document, options).then((run) => {
    const shape = (items) => items.map((item) => ({
      id: item.id,
      impact: item.impact,
      help: item.help,
      nodes: item.nodes.map((node) => {
        const check = node.any.concat(node.all, node.none)[0];
        return { target: node.target.join(' '), message: check === undefined ? '' : check.message };
      }),
    }));
    return {
      engine: run.testEngine.version,
      violations: shape(run.violations),
      incomplete: shape(run.incomplete),
      passes: run.passes.length,
      inapplicable: run.inapplicable.length,
    };
  }), AXE_OPTIONS);
  result.states.push(entry);
  return entry;
}

// The browser's own accessibility tree, not the markup: what a screen reader is given for the field.
async function fieldDescription(page) {
  const cdp = await page.context().newCDPSession(page);
  const focused = await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("#cook-words")' });
  const tree = await cdp.send('Accessibility.getPartialAXTree', { objectId: focused.result.objectId, fetchRelatives: false });
  const node = tree.nodes[0];
  return {
    role: node.role ? node.role.value : null,
    name: node.name ? node.name.value : null,
    description: node.description ? node.description.value : '',
  };
}

async function runStates() {
  const page = await freshPage();
  await openWall(page);
  if (PLANT) {
    result.planted = await page.evaluate(() => {
      const label = document.querySelector('label[for="cook-words"]');
      if (label === null) return false;
      label.remove();
      return true;
    });
  }
  await checkpoint(page, 'initial', await waitForBoard(page, 'No checks are open.'));

  await chip(page, PHRASES.logged).click();
  const logged = await waitForAnswer(page, PHRASES.logged);
  await checkpoint(page, 'logged', Object.assign(logged, await waitForBoard(page, 'No checks are open.')));

  await chip(page, PHRASES.refused).click();
  const refused = await waitForAnswer(page, PHRASES.refused);
  await checkpoint(page, 'refused', Object.assign(refused, await waitForBoard(page, 'Reach-in two')));

  const before = await fieldDescription(page);
  await page.route('**/mcp/**', (route) => route.abort());
  await page.fill('#cook-words', PHRASES.notLogged);
  await page.press('#cook-words', 'Enter');
  await page.waitForSelector('#not-logged', { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('#cook-words').readOnly, null, { timeout: 30000 });
  const after = await fieldDescription(page);
  const focusedId = await page.evaluate(() => document.activeElement === null ? null : document.activeElement.id);
  result.description = { before: before, after: after, focusedId: focusedId };
  await checkpoint(page, 'not-logged', {
    panel: await page.evaluate(() => document.querySelector('#not-logged').textContent),
    field: await page.evaluate(() => document.querySelector('#cook-words').value),
  });
  await page.unroute('**/mcp/**');

  const notice = await page.goto(BASE + '/privacy?theme=' + THEME);
  result.navigations.push(notice === null ? null : notice.status());
  await page.waitForSelector('main.sheet', { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('.theme-switch button[aria-pressed="true"]') !== null, null, { timeout: 30000 });
  await checkpoint(page, 'privacy', { title: await page.evaluate(() => document.querySelector('h1').textContent) });
}

// What a control is to the walk: a stable key, plus the ring the user sees. A roster radio is visually hidden, so
// its ring is drawn on the label around it, and that is the box measured.
async function focusInfo(page, cdp) {
  const info = await page.evaluate(() => {
    const element = document.activeElement;
    if (element === null || element === document.body) return { key: 'body' };
    const text = (element.textContent || '').trim();
    let key = 'other:' + element.tagName.toLowerCase() + ':' + (element.id || text);
    if (element.matches('button.chip')) key = 'chip:' + text;
    else if (element.id === 'cook-words') key = 'field';
    else if (element.matches('form.words button[type="submit"]')) key = 'send';
    else if (element.matches('input[name="cook"]')) key = 'roster:' + element.value;
    else if (element.closest('.theme-switch') !== null) key = 'theme:' + text;
    else if (element.matches('.page-foot a')) key = 'link:' + text;
    const ring = element.classList.contains('visually-hidden') ? element.closest('label') : element;
    const style = getComputedStyle(ring);
    return {
      key: key,
      ringOn: ring.tagName.toLowerCase(),
      outlineStyle: style.outlineStyle,
      outlineWidth: parseFloat(style.outlineWidth),
      outlineColor: style.outlineColor,
      focusVisible: element.matches(':focus-visible'),
    };
  });
  if (info.key === 'body') return info;
  const focused = await cdp.send('Runtime.evaluate', { expression: 'document.activeElement' });
  const tree = await cdp.send('Accessibility.getPartialAXTree', { objectId: focused.result.objectId, fetchRelatives: false });
  const node = tree.nodes[0];
  info.role = node.role ? node.role.value : null;
  info.name = node.name ? node.name.value : null;
  return info;
}

async function tabTo(page, cdp, key, log) {
  for (let presses = 1; presses <= 40; presses += 1) {
    await page.keyboard.press('Tab');
    const info = await focusInfo(page, cdp);
    if (info.key === key) {
      log.push({ to: key, tabs: presses });
      return;
    }
  }
  throw new Error(key + ' was never reached by Tab');
}

async function runWalk() {
  const walk = { required: [], steps: [], actions: [], statusAtLoad: null, statusWrites: null, storage: null, errors: [] };
  result.walk = walk;
  const page = await freshPage();
  const status = await openWall(page);
  if (status !== 200) return;
  // Anything a page at this origin left behind earlier would read as this page's own storage.
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.context().clearCookies();
  const reloaded = await page.reload();
  result.navigations.push(reloaded === null ? null : reloaded.status());
  await waitReady(page);
  walk.theme = await appliedTheme(page);
  walk.required = await page.evaluate(() => {
    const keys = [];
    for (const button of document.querySelectorAll('button.chip')) keys.push('chip:' + button.textContent.trim());
    if (document.querySelector('#cook-words') !== null) keys.push('field');
    if (document.querySelector('form.words button[type="submit"]') !== null) keys.push('send');
    for (const radio of document.querySelectorAll('input[name="cook"]')) keys.push('roster:' + radio.value);
    for (const button of document.querySelectorAll('.theme-switch button')) keys.push('theme:' + button.textContent.trim());
    for (const link of document.querySelectorAll('.page-foot a')) keys.push('link:' + link.textContent.trim());
    return keys;
  });

  // Every insertion into the region is one sentence handed to a screen reader.
  walk.statusAtLoad = await page.evaluate(() => {
    const regions = document.querySelectorAll('[role="status"]');
    const region = regions[0];
    window.__tolseyStatusWrites = [];
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'characterData' || record.addedNodes.length > 0) window.__tolseyStatusWrites.push(region.textContent);
      }
    }).observe(region, { childList: true, subtree: true, characterData: true });
    return { regions: regions.length, text: region.textContent };
  });

  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => {
    if (document.activeElement !== null && document.activeElement !== document.body) document.activeElement.blur();
  });
  try {
    for (let presses = 0; presses < 60; presses += 1) {
      await page.keyboard.press('Tab');
      const info = await focusInfo(page, cdp);
      if (info.key === 'body' || (walk.steps.length > 0 && info.key === walk.steps[0].key)) break;
      info.by = 'Tab';
      walk.steps.push(info);
      // A radio group is one Tab stop; the arrows move inside it, and the fourth one comes back to the first cook.
      if (info.key.indexOf('roster:') === 0) {
        for (let arrow = 1; arrow < ${ROSTER_SIZE}; arrow += 1) {
          await page.keyboard.press('ArrowRight');
          const moved = await focusInfo(page, cdp);
          moved.by = 'ArrowRight';
          walk.steps.push(moved);
        }
        await page.keyboard.press('ArrowRight');
        walk.cookAfterArrows = await page.evaluate(() => document.querySelector('input[name="cook"]:checked').value);
      }
    }

    await page.evaluate(() => {
      if (document.activeElement !== null && document.activeElement !== document.body) document.activeElement.blur();
    });
    await tabTo(page, cdp, 'chip:' + PHRASES.logged, walk.actions);
    await page.keyboard.press('Enter');
    walk.logged = await waitForAnswer(page, PHRASES.logged);
    walk.logged.focusAfter = (await focusInfo(page, cdp)).key;

    await tabTo(page, cdp, 'chip:' + PHRASES.refused, walk.actions);
    await page.keyboard.press('Enter');
    walk.refused = await waitForAnswer(page, PHRASES.refused);
    walk.refused.focusAfter = (await focusInfo(page, cdp)).key;

    await tabTo(page, cdp, 'chip:' + PHRASES.held, walk.actions);
    await page.keyboard.press('Enter');
    walk.held = await waitForAnswer(page, PHRASES.held);
    walk.held.focusAfter = (await focusInfo(page, cdp)).key;

    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark', null, { timeout: 10000 });
    walk.themeAfterSwitch = await appliedTheme(page);
    walk.statusWrites = await page.evaluate(() => window.__tolseyStatusWrites.slice());
  } catch (error) {
    walk.errors.push(message(error));
  }

  walk.storage = await page.evaluate(async () => {
    const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
    return {
      localStorage: Object.keys(localStorage),
      sessionStorage: Object.keys(sessionStorage),
      indexedDB: databases.map((database) => database.name),
      documentCookie: document.cookie,
    };
  });
  walk.storage.cookies = (await page.context().cookies()).map((cookie) => cookie.name);
}

try {
  await runStates();
} catch (error) {
  result.errors.push('states: ' + message(error));
}
if (WALK) {
  try {
    await runWalk();
  } catch (error) {
    result.errors.push('walk: ' + message(error));
  }
}
console.log(JSON.stringify(result));
`;
}

function couldNotRun(results) {
  const problems = [];
  for (const run of results) {
    for (const error of run.errors) problems.push(`${run.theme}: ${error}`);
    for (const status of run.navigations) {
      if (status !== 200) problems.push(`${run.theme}: the wall answered ${status}, not 200`);
    }
    if (run.navigations.length === 0) problems.push(`${run.theme}: the wall was never opened`);
    const reached = run.states.map((entry) => entry.state);
    if (reached.join() !== STATES.join()) problems.push(`${run.theme}: reached ${reached.join(', ') || 'no state'}, not ${STATES.join(', ')}`);
    for (const entry of run.states) {
      if (entry.theme !== run.theme) problems.push(`${run.theme}: the ${entry.state} state showed the ${entry.theme} theme`);
      if (entry.audit.passes === 0 && entry.audit.violations.length === 0) {
        problems.push(`${run.theme}: axe checked nothing in the ${entry.state} state`);
      }
    }
    if (run.planted === false) problems.push(`${run.theme}: there was no field label to remove`);
  }
  const walk = results.find((run) => run.walk !== null)?.walk;
  if (walk === undefined) problems.push('the keyboard walk did not run');
  else if (walk.theme !== 'light') problems.push(`the keyboard walk ran in the ${walk.theme} theme, not light`);
  else if (walk.required.length === 0) problems.push('the keyboard walk found no control to reach');
  return problems;
}

function isAllowedIncomplete(id, state) {
  return ALLOWED_INCOMPLETE.some((entry) => entry.rule === id && entry.state === state);
}

function nodeList(nodes) {
  return nodes.map((node) => (node.message ? `${node.target} (${node.message})` : node.target)).join('; ');
}

function auditFailures(results) {
  const failures = [];
  for (const run of results) {
    for (const entry of run.states) {
      const where = `${entry.state} (${run.theme})`;
      for (const item of entry.audit.violations) {
        failures.push(`axe [${item.impact}] ${item.id} in ${where}: ${item.help} at ${nodeList(item.nodes)}`);
      }
      for (const item of entry.audit.incomplete.filter((found) => !isAllowedIncomplete(found.id, entry.state))) {
        failures.push(`axe [undetermined] ${item.id} in ${where}: ${item.help} at ${nodeList(item.nodes)}`);
      }
    }
  }
  return failures;
}

function auditSummary(results) {
  const audits = results.flatMap((run) => run.states.map((entry) => entry.audit));
  const engines = [...new Set(audits.map((audit) => audit.engine))].join(', ');
  const passes = audits.reduce((sum, audit) => sum + audit.passes, 0);
  const violations = audits.reduce((sum, audit) => sum + audit.violations.length, 0);
  const undetermined = audits.reduce((sum, audit) => sum + audit.incomplete.length, 0);
  return `axe ${engines}: ${audits.length} audits (${STATES.length} states by ${THEMES.length} themes), ${passes} rule passes, ${violations} violations, ${undetermined} undetermined`;
}

function stateFailures(results) {
  const failures = [];
  for (const run of results) {
    for (const message of run.csp) failures.push(`${run.theme}: the page broke its Content Security Policy: ${message}`);
    const logged = run.states.find((entry) => entry.state === 'logged');
    if (logged !== undefined && logged.reading === null) failures.push(`${run.theme}: the logged state shows no reading on the pass`);
    const notLogged = run.states.find((entry) => entry.state === 'not-logged');
    if (notLogged !== undefined && !notLogged.panel.includes(NOT_LOGGED_TEXT)) failures.push(`${run.theme}: the NOT LOGGED panel reads "${notLogged.panel}"`);
    if (notLogged !== undefined && notLogged.field !== PHRASES.notLogged) failures.push(`${run.theme}: the field lost the words after NOT LOGGED ("${notLogged.field}")`);
    // NOT LOGGED is not a live region by design; a screen reader meets it as the field's description instead.
    const description = run.description?.after.description ?? '';
    if (!description.includes(NOT_LOGGED_TEXT)) failures.push(`${run.theme}: the field's accessible description is "${description}", without ${NOT_LOGGED_TEXT}`);
  }
  return failures;
}

function walkFailures(walk) {
  const failures = walk.errors.map((error) => `keyboard walk: ${error}`);
  const reached = new Set(walk.steps.map((step) => step.key));
  for (const key of walk.required) {
    if (!reached.has(key)) failures.push(`keyboard walk: ${key} was never reached`);
  }
  const roster = walk.required.filter((key) => key.startsWith('roster:')).length;
  if (roster !== ROSTER_SIZE) failures.push(`keyboard walk: the roster has ${roster} cooks, expected ${ROSTER_SIZE}`);
  const themes = walk.required.filter((key) => key.startsWith('theme:')).length;
  if (themes !== THEME_BUTTONS) failures.push(`keyboard walk: the theme switch has ${themes} buttons, expected ${THEME_BUTTONS}`);
  const footerLinks = walk.required.filter((key) => key.startsWith('link:')).length;
  if (footerLinks !== 1) failures.push(`keyboard walk: the footer has ${footerLinks} links, expected the one to the privacy notice`);
  for (const step of walk.steps) {
    if (step.outlineStyle === 'none' || !(step.outlineWidth >= MIN_RING_PX)) {
      failures.push(`keyboard walk: ${step.key} shows no focus ring (${step.outlineStyle} ${step.outlineWidth}px on the ${step.ringOn})`);
    }
    if (!step.name) failures.push(`keyboard walk: ${step.key} has no accessible name`);
  }
  // A control that drops focus once pressed leaves a keyboard user on the page itself, and a screen reader with
  // nothing to say about where they are.
  for (const action of ['logged', 'refused', 'held']) {
    const chip = `chip:${PHRASES[action]}`;
    const focusAfter = walk[action]?.focusAfter;
    if (focusAfter !== chip) failures.push(`keyboard walk: Enter on ${chip} left focus on ${focusAfter}, not the chip`);
  }
  if (walk.statusAtLoad?.regions !== 1) failures.push(`status: ${walk.statusAtLoad?.regions} status regions, expected 1`);
  if (walk.statusAtLoad?.text !== '') failures.push(`status: the region holds "${walk.statusAtLoad?.text}" at load`);
  const writes = walk.statusWrites ?? [];
  if (writes.length !== EXPECTED_STATUS_WRITES) {
    failures.push(`status: written ${writes.length} times across a logged reading, a refusal, a held question and a theme change, expected ${EXPECTED_STATUS_WRITES}: ${JSON.stringify(writes)}`);
  }
  const storage = walk.storage;
  const extraKeys = storage.localStorage.filter((key) => !ALLOWED_STORAGE_KEYS.has(key));
  if (extraKeys.length > 0) failures.push(`storage: localStorage holds ${extraKeys.join(', ')}`);
  if (storage.sessionStorage.length > 0) failures.push(`storage: sessionStorage holds ${storage.sessionStorage.join(', ')}`);
  if (storage.indexedDB.length > 0) failures.push(`storage: IndexedDB holds ${storage.indexedDB.join(', ')}`);
  if (storage.documentCookie !== '' || storage.cookies.length > 0) failures.push(`storage: cookies ${storage.cookies.join(', ') || storage.documentCookie}`);
  return failures;
}

function walkSummary(walk) {
  const byTab = walk.steps.filter((step) => step.by === 'Tab').length;
  const byArrow = walk.steps.length - byTab;
  const rings = [...new Set(walk.steps.map((step) => `${step.outlineWidth}px ${step.outlineStyle}`))].join(', ');
  const tabs = walk.actions.map((action) => `${action.to} after ${action.tabs} Tab`).join('; ');
  return `keyboard walk: ${byTab} Tab stops and ${byArrow} arrow moves reached ${walk.required.length} of ${walk.required.length} controls, rings ${rings}; Enter on ${tabs}; logged "${walk.logged?.answer}", refused "${walk.refused?.answer}"`;
}

function readArguments(argv) {
  const unknown = argv.filter((argument) => argument !== PLANT_FLAG);
  if (unknown.length > 0) throw new CannotRun(`unknown argument ${unknown.join(' ')}; the only flag is ${PLANT_FLAG}`);
  return { plant: argv.includes(PLANT_FLAG) };
}

// The sandbox reads files only from its own folder, so the engine is copied there from the installed package.
function stageAxe() {
  let source;
  try {
    source = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
  } catch {
    throw new CannotRun('axe-core is not installed: the audit did not run');
  }
  mkdirSync(DEV_BROWSER_DIR, { recursive: true });
  copyFileSync(source, join(DEV_BROWSER_DIR, AXE_FILE));
}

async function main() {
  const { plant } = readArguments(process.argv.slice(2));
  stageAxe();
  return withBuiltWall(async (baseUrl) => {
    const results = [];
    for (const theme of THEMES) {
      const run = await runDevBrowser(themeScript(baseUrl.origin, theme, theme === 'light', plant), {
        browserName: BROWSER_NAME,
        timeoutSeconds: TIMEOUT_SECONDS,
      });
      const result = run.lines.at(-1);
      if (result === undefined) throw new CannotRun(`dev-browser printed no result for ${theme} (exit ${run.code}): ${run.stderr.trim().slice(0, 500)}`);
      results.push(result);
    }
    const problems = couldNotRun(results);
    if (problems.length > 0) throw new CannotRun(problems.join('; '));

    const walk = results.find((run) => run.walk !== null).walk;
    mkdirSync(REPORT_DIR, { recursive: true });
    const walkFile = join(REPORT_DIR, 'keyboard-walk.json');
    writeFileSync(walkFile, `${JSON.stringify(walk, null, 2)}\n`);

    const failures = [...auditFailures(results), ...stateFailures(results), ...walkFailures(walk)];
    console.log(
      JSON.stringify({
        states: results.map((run) => ({
          theme: run.theme,
          planted: run.planted,
          states: run.states.map(({ audit, ...entry }) => ({ ...entry, passes: audit.passes, violations: audit.violations.length })),
          description: run.description,
        })),
        statusWrites: walk.statusWrites,
        storage: walk.storage,
        failures,
      }),
    );
    console.log(auditSummary(results));
    console.log(walkSummary(walk));
    console.log(walkFile);
    for (const failure of failures) console.error(`[a11y-live] FAIL: ${failure}`);
    return failures.length === 0 ? 0 : 1;
  });
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`[a11y-live] ${error instanceof CannotRun ? 'COULD NOT RUN' : 'FAILED'}: ${error.message}`);
  process.exitCode = 2;
}
