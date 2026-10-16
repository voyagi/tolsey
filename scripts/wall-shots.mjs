#!/usr/bin/env node
// wall-shots.mjs - capture the wall at the judged sizes and prove its layout holds.
//
// WHY THIS EXISTS
// A judge decides in seconds at a laptop's size. This drives the built wall in a real browser, logs a reading through
// the real Worker, and checks what a screenshot alone cannot: at 1280 by 800 and 1366 by 657, in Light and Dark, the
// pass, the reply and the text field sit inside the viewport with the page unscrolled, and stay there with a row on
// the open-checks board, which then ends inside the viewport too; a reading with a tenth (38.5)
// fits its box; at 390 wide the page is no wider than the screen; and every request the page makes stays on its own
// origin, since the privacy notice names Cloudflare as the only processor.
//
// The screenshots land in reports/wall-shots/ (git-ignored) to be compared with design/mockups/shots/ by eye.
//
// WIRING: local, run by hand and by plan 02-06; not in CI (the dev-browser CLI and its browser live on this machine).
// Run `npx vite build` first: it serves dist/, never the sources.
//
// Exit codes: 0 clean, 1 layout or origin failure, 2 could not run (no build, no CLI, a theme that did not take,
// a page that never became ready).

import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CannotRun, DEV_BROWSER_DIR, runDevBrowser, withBuiltWall } from './wall-browser.mjs';

const OUT_DIR = 'reports/wall-shots';
const JUDGED_SIZES = [
  [1280, 800],
  [1366, 657],
];
const THEMES = ['light', 'dark'];
const PHONE_WIDTH = 390;
const TIMEOUT_SECONDS = 240;

// The script dev-browser runs, in its QuickJS sandbox. The base URL is written in as a literal.
function captureScript(base) {
  return `
const BASE = ${JSON.stringify(base)};
const SIZES = ${JSON.stringify(JUDGED_SIZES)};
const THEMES = ${JSON.stringify(THEMES)};
const PHONE = ${PHONE_WIDTH};
const result = { shots: [], fit: [], tenth: null, phone: [], requests: [], errors: [] };
const page = await browser.newPage();
page.on('request', (request) => result.requests.push(request.url()));
await page.emulateMedia({ reducedMotion: 'reduce' });

async function openWall(theme) {
  await page.goto(BASE + '/?theme=' + theme);
  const applied = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.waitForSelector('button.chip:not([disabled])', { timeout: 30000 });
  return applied;
}

async function logChip(text) {
  await page.locator('button.chip', { hasText: text }).first().click();
  await page.waitForSelector('.pass .reading', { timeout: 30000 });
  await page.waitForSelector('.exchange .answer', { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('#cook-words').readOnly, null, { timeout: 30000 });
  await page.waitForSelector('.board', { timeout: 30000 });
}

// A refused reach-in two puts a row on the open-checks board, the tallest state the wall's own chips reach.
async function refuseReachInTwo() {
  await page.locator('button.chip', { hasText: 'reach-in two is fine' }).first().click();
  await page.waitForFunction(() => {
    const board = document.querySelector('.board');
    return board !== null && board.textContent.indexOf('Reach-in two') !== -1;
  }, null, { timeout: 30000 });
}

async function fitOf(withBoard) {
  return page.evaluate((board) => {
    const bottom = (selector) => {
      const element = document.querySelector(selector);
      return element === null ? null : element.getBoundingClientRect().bottom;
    };
    const fit = {
      pass: bottom('.pass'),
      reply: bottom('.exchange .answer'),
      field: bottom('#cook-words'),
      innerHeight: window.innerHeight,
      scrollY: window.scrollY,
    };
    if (board) fit.board = bottom('.board');
    return fit;
  }, withBoard);
}

for (const size of SIZES) {
  for (const theme of THEMES) {
    const name = size[0] + 'x' + size[1] + '-' + theme;
    try {
      await page.setViewportSize({ width: size[0], height: size[1] });
      const applied = await openWall(theme);
      await logChip('the walk-in reads 38');
      const file = await saveScreenshot(await page.screenshot(), 'tolsey-wall-' + name + '.png');
      const fit = await fitOf(false);
      result.shots.push({ name: name, file: file, theme: applied });
      result.fit.push(Object.assign({ name: name }, fit));
      if (size[0] === 1280 && theme === 'light') {
        await page.fill('#cook-words', 'the walk-in reads 38.5');
        await page.press('#cook-words', 'Enter');
        await page.waitForFunction(() => {
          const reading = document.querySelector('.pass .reading');
          return reading !== null && reading.textContent.indexOf('38.5') === 0;
        }, null, { timeout: 30000 });
        const tenthFile = await saveScreenshot(await page.screenshot(), 'tolsey-wall-1280x800-light-tenth.png');
        result.tenth = await page.evaluate(() => {
          const reading = document.querySelector('.pass .reading');
          const pass = document.querySelector('.pass');
          return {
            text: reading.textContent,
            scrollWidth: reading.scrollWidth,
            clientWidth: reading.clientWidth,
            right: reading.getBoundingClientRect().right,
            passRight: pass.getBoundingClientRect().right,
          };
        });
        result.tenth.file = tenthFile;
      }
      const openName = size[0] + 'x' + size[1] + '-open-' + theme;
      await refuseReachInTwo();
      const openFile = await saveScreenshot(await page.screenshot(), 'tolsey-wall-' + openName + '.png');
      result.shots.push({ name: openName, file: openFile, theme: applied });
      result.fit.push(Object.assign({ name: openName }, await fitOf(true)));
    } catch (error) {
      result.errors.push(name + ': ' + String(error && error.message ? error.message : error));
    }
  }
}

for (const theme of THEMES) {
  const name = PHONE + 'x800-' + theme;
  try {
    await page.setViewportSize({ width: PHONE, height: 800 });
    const applied = await openWall(theme);
    await logChip('the walk-in reads 38');
    const file = await saveScreenshot(await page.screenshot({ fullPage: true }), 'tolsey-wall-' + name + '.png');
    const widths = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    result.phone.push(Object.assign({ name: name, file: file, theme: applied }, widths));
    const openName = PHONE + 'x800-open-' + theme;
    await refuseReachInTwo();
    const openFile = await saveScreenshot(await page.screenshot({ fullPage: true }), 'tolsey-wall-' + openName + '.png');
    const openWidths = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    result.phone.push(Object.assign({ name: openName, file: openFile, theme: applied }, openWidths));
  } catch (error) {
    result.errors.push(name + ': ' + String(error && error.message ? error.message : error));
  }
}

console.log(JSON.stringify(result));
`;
}

function fitFailures(fit) {
  const failures = [];
  for (const row of fit) {
    if (row.scrollY !== 0) failures.push(`${row.name}: the page is scrolled (${row.scrollY})`);
    // A row measured with its open-checks board holds the board to the same rule as the pass, reply and field.
    const parts = 'board' in row ? ['pass', 'reply', 'field', 'board'] : ['pass', 'reply', 'field'];
    for (const part of parts) {
      if (row[part] === null) failures.push(`${row.name}: no ${part} on the page`);
      else if (row[part] > row.innerHeight) failures.push(`${row.name}: the ${part} ends at ${row[part]}, below the ${row.innerHeight} viewport`);
    }
  }
  const boardRows = fit.filter((row) => 'board' in row).length;
  const expected = JUDGED_SIZES.length * THEMES.length;
  if (boardRows !== expected) failures.push(`the open-checks board was measured in ${boardRows} of ${expected} captures`);
  return failures;
}

function tenthFailures(tenth) {
  if (tenth === null) return ['1280x800: the 38.5 reading was never measured'];
  if (!tenth.text.startsWith('38.5')) return [`1280x800: the reading shows ${tenth.text}, not 38.5`];
  const failures = [];
  if (tenth.scrollWidth > tenth.clientWidth) failures.push(`1280x800: 38.5 overflows its box (${tenth.scrollWidth} > ${tenth.clientWidth})`);
  if (tenth.right > tenth.passRight) failures.push(`1280x800: 38.5 runs past the pass (${tenth.right} > ${tenth.passRight})`);
  return failures;
}

function phoneFailures(phone) {
  // Each theme is measured twice: after a logged reading and with a row on the open-checks board.
  const expected = THEMES.length * 2;
  if (phone.length !== expected) return [`390 wide: ${phone.length} of ${expected} captures measured`];
  return phone
    .filter((row) => row.scrollWidth !== row.innerWidth)
    .map((row) => `${row.name}: the page is ${row.scrollWidth} wide in a ${row.innerWidth} viewport`);
}

function themeProblems(result) {
  const rows = [...result.shots, ...result.phone];
  return rows.filter((row) => !row.name.endsWith(`-${row.theme}`)).map((row) => `${row.name}: the theme applied was ${row.theme}`);
}

function copyShots(result) {
  mkdirSync(OUT_DIR, { recursive: true });
  const copied = [];
  for (const row of [...result.shots, ...result.phone]) {
    const target = join(OUT_DIR, `${row.name}.png`);
    copyFileSync(join(DEV_BROWSER_DIR, `tolsey-wall-${row.name}.png`), target);
    copied.push(target);
  }
  if (result.tenth !== null) {
    const target = join(OUT_DIR, '1280x800-light-tenth.png');
    copyFileSync(join(DEV_BROWSER_DIR, 'tolsey-wall-1280x800-light-tenth.png'), target);
    copied.push(target);
  }
  return copied;
}

async function main() {
  return withBuiltWall(async (baseUrl) => {
    const run = await runDevBrowser(captureScript(baseUrl.origin), { browserName: 'tolsey-wall-shots', timeoutSeconds: TIMEOUT_SECONDS });
    const result = run.lines.at(-1);
    if (result === undefined) throw new CannotRun(`dev-browser printed no result (exit ${run.code}): ${run.stderr.trim().slice(0, 500)}`);
    if (result.errors.length > 0) throw new CannotRun(`the page never became ready: ${result.errors.join('; ')}`);
    const themes = themeProblems(result);
    if (themes.length > 0) throw new CannotRun(themes.join('; '));
    const offOrigin = [...new Set(result.requests.filter((url) => new URL(url).origin !== baseUrl.origin))];
    const failures = [
      ...fitFailures(result.fit),
      ...tenthFailures(result.tenth),
      ...phoneFailures(result.phone),
      ...offOrigin.map((url) => `a request left the page's origin: ${url}`),
    ];
    const screenshots = copyShots(result);
    console.log(
      JSON.stringify({
        screenshots,
        fit: result.fit,
        tenth: result.tenth,
        phone: result.phone,
        requests: result.requests.length,
        offOrigin,
        failures,
      }),
    );
    for (const file of screenshots) console.log(file);
    return failures.length === 0 ? 0 : 1;
  });
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`[wall-shots] ${error instanceof CannotRun ? 'COULD NOT RUN' : 'FAILED'}: ${error.message}`);
  process.exitCode = 2;
}
