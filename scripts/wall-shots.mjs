#!/usr/bin/env node
// wall-shots.mjs - capture the wall at the judged sizes and prove its layout holds.
//
// WHY THIS EXISTS
// A judge decides in seconds at a laptop's size. This drives the built wall in a real browser, logs a reading through
// the real Worker, and checks what a screenshot alone cannot: at 1280 by 800 and 1366 by 657, in Light and Dark, the
// pass, the reply and the text field sit inside the viewport with the page unscrolled, and stay there with a row on
// the open-checks board, which then ends inside the viewport too; a reading with a tenth (38.5)
// fits its box; at 390 wide the page is no wider than the screen; at 320, 375, 501 and 720 wide, at the browser's
// Medium, Large and Very large text, each group of controls (who is logging, the theme switch on the wall and on the
// privacy page) stays whole on one line, its label beside it or on a line of its own, since a group split part-way
// across lines reads as broken on a phone, and past the phone rule the roster's label sits beside its tiles as before;
// and every request the page makes stays on its own origin, since the privacy notice names Cloudflare as the only
// processor.
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
// The browser's own text size (Chrome's Medium, Large and Very large), set the way its settings page sets it. A root
// font-size style would not move an em media query, so it cannot stand in for the setting.
const ROW_WIDTHS = [320, 375, 501, 720];
const TEXT_SIZES = [16, 20, 24];
// wall.css stacks the roster's label above its tiles up to this width. Past it the group fits inline at each size above,
// so there its label must sit beside it, the layout wider screens had before the phone rule.
const ROSTER_STACKS_TO = 500;
const TIMEOUT_SECONDS = 300;

// The script dev-browser runs, in its QuickJS sandbox. The base URL is written in as a literal.
function captureScript(base) {
  return `
const BASE = ${JSON.stringify(base)};
const SIZES = ${JSON.stringify(JUDGED_SIZES)};
const THEMES = ${JSON.stringify(THEMES)};
const PHONE = ${PHONE_WIDTH};
const ROW_WIDTHS = ${JSON.stringify(ROW_WIDTHS)};
const TEXT_SIZES = ${JSON.stringify(TEXT_SIZES)};
const result = { shots: [], fit: [], tenth: null, phone: [], rows: [], requests: [], errors: [] };
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

// Where each control group sits, read from the page. mediaPx is the text size an em media query sees, the control
// that the setting took: each width and size pair puts the viewport at its own em width.
function groupsOf(selectors) {
  return page.evaluate((groups) => {
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), text: element.textContent.trim() };
    };
    const ems = (px) => window.innerWidth / px;
    const mediaPx = [16, 20, 24].find((px) => matchMedia('(min-width: ' + (ems(px) - 0.05) + 'em) and (max-width: ' + (ems(px) + 0.05) + 'em)').matches);
    return {
      mediaPx: mediaPx === undefined ? null : mediaPx,
      groups: groups.map((group) => {
        const label = group.label === null ? null : document.querySelector(group.label);
        return { name: group.name, label: label === null ? null : box(label), items: [...document.querySelectorAll(group.items)].map(box) };
      }),
    };
  }, selectors);
}

const cdp = await page.context().newCDPSession(page);
for (const width of ROW_WIDTHS) {
  for (const px of TEXT_SIZES) {
    const name = width + ' wide at ' + px + 'px text';
    try {
      await cdp.send('Page.setFontSizes', { fontSizes: { standard: px, fixed: Math.round((px * 13) / 16) } });
      await page.setViewportSize({ width: width, height: 800 });
      await openWall('light');
      await page.evaluate(() => document.fonts.ready);
      result.rows.push(Object.assign({ name: name, width: width, px: px, page: 'wall' }, await groupsOf([
        { name: 'who is logging', label: '.roster legend', items: '.roster label' },
        { name: 'the theme switch', label: null, items: '.theme-switch button' },
      ])));
      await page.goto(BASE + '/privacy?theme=light');
      await page.waitForSelector('.theme-switch button', { timeout: 30000 });
      await page.evaluate(() => document.fonts.ready);
      result.rows.push(Object.assign({ name: name, width: width, px: px, page: 'privacy' }, await groupsOf([
        { name: 'the theme switch', label: null, items: '.theme-switch button' },
      ])));
    } catch (error) {
      result.errors.push(name + ': ' + String(error && error.message ? error.message : error));
    }
  }
}
await cdp.send('Page.setFontSizes', { fontSizes: { standard: 16, fixed: 13 } });

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

// Items one line apart sit at least a tile's height apart; a pixel or two is rounding inside one line.
const SAME_LINE_PX = 2;

function linesOf(items) {
  const lines = [];
  for (const item of items) {
    const line = lines.find((candidate) => Math.abs(candidate.top - item.top) <= SAME_LINE_PX);
    if (line === undefined) lines.push({ top: item.top, texts: [item.text] });
    else line.texts.push(item.text);
  }
  return lines;
}

function groupFailures(where, group, labelBesideOnly) {
  if (group.items.length === 0) return [`${where}: no ${group.name} on the page`];
  const lines = linesOf(group.items);
  if (lines.length > 1) return [`${where}: ${group.name} splits across ${lines.length} lines (${lines.map((line) => line.texts.join(' ')).join(' / ')})`];
  if (group.label === null) return [];
  const top = Math.min(...group.items.map((item) => item.top));
  const bottom = Math.max(...group.items.map((item) => item.bottom));
  const beside = group.label.top >= top - SAME_LINE_PX && group.label.bottom <= bottom + SAME_LINE_PX;
  const above = group.label.bottom <= top + SAME_LINE_PX;
  if (labelBesideOnly && !beside) return [`${where}: the "${group.label.text}" label is not beside ${group.name}, past the phone rule`];
  return beside || above ? [] : [`${where}: the "${group.label.text}" label sits neither beside ${group.name} nor on its own line above it`];
}

function rowFailures(rows) {
  const expected = ROW_WIDTHS.length * TEXT_SIZES.length * 2;
  if (rows.length !== expected) return [`control rows: ${rows.length} of ${expected} pages measured`];
  return rows.flatMap((row) => row.groups.flatMap((group) => groupFailures(`${row.name}, ${row.page}`, group, row.width > ROSTER_STACKS_TO)));
}

// A text size that did not take would measure the default size six times over and pass, so it stops the run.
function textSizeProblems(rows) {
  return rows.filter((row) => row.mediaPx !== row.px).map((row) => `${row.name}, ${row.page}: an em media query saw ${row.mediaPx}px text`);
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
    const textSizes = textSizeProblems(result.rows);
    if (textSizes.length > 0) throw new CannotRun(`the browser's text size did not take: ${textSizes.join('; ')}`);
    const offOrigin = [...new Set(result.requests.filter((url) => new URL(url).origin !== baseUrl.origin))];
    const failures = [
      ...fitFailures(result.fit),
      ...tenthFailures(result.tenth),
      ...phoneFailures(result.phone),
      ...rowFailures(result.rows),
      ...offOrigin.map((url) => `a request left the page's origin: ${url}`),
    ];
    const screenshots = copyShots(result);
    console.log(
      JSON.stringify({
        screenshots,
        fit: result.fit,
        tenth: result.tenth,
        phone: result.phone,
        rows: result.rows,
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
