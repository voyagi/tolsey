#!/usr/bin/env node
// wall-browser.mjs - the built wall served by workerd on loopback, and an async runner for the dev-browser CLI.
//
// WHY THIS EXISTS
// The wall's layout and its accessibility can only be judged in a real browser over the real built Worker, the same
// Worker that deploys, with its D1 migrations applied. wall-shots.mjs and the accessibility gate share this harness so
// both look at the same page the same way.
//
// TWO TRAPS IT EXISTS TO AVOID (both measured on dev-browser 0.2.9):
// - The harness's local server lives in this Node process. A synchronous spawn of dev-browser blocks the event loop,
//   so the page's requests never get an answer and every goto times out. The CLI is spawned asynchronously.
// - The CLI's sandbox dies on the page init-script hook, so a script here sets a theme with the page's own ?theme=
//   query instead.
//
// Only node: builtins and wrangler. The built config and the local hostnames are restated from
// src/test-support/target.ts, which a .mjs file cannot import.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness } from 'wrangler';

const BUILT_CONFIG = './dist/tolsey/wrangler.json';
const BUILT_PAGE = 'dist/client/index.html';
const LOCAL_HOSTNAMES = 'localhost,127.0.0.1';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
// The CLI's own --timeout ends a stuck script; this margin covers its start and its browser launch.
const KILL_MARGIN_MS = 30_000;

export const DEV_BROWSER_DIR = join(homedir(), '.dev-browser', 'tmp');

// A run that could not look at the page: exit 2, never 0, so a missing build or tool never reads as a clean layout.
export class CannotRun extends Error {}

export async function withBuiltWall(fn) {
  if (!existsSync(BUILT_PAGE)) throw new CannotRun(`${BUILT_PAGE} is missing: run npx vite build first`);
  const harness = createTestHarness({ workers: [{ configPath: BUILT_CONFIG, vars: { ALLOWED_HOSTNAMES: LOCAL_HOSTNAMES } }] });
  try {
    const { url } = await harness.listen();
    const baseUrl = new URL(url);
    if (!LOOPBACK_HOSTS.has(baseUrl.hostname)) {
      throw new CannotRun(`the harness listens on ${baseUrl.hostname}; only a loopback address is allowed`);
    }
    await harness.getWorker().applyD1Migrations('DB');
    return await fn(baseUrl);
  } finally {
    await harness.close();
  }
}

function endTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
}

function jsonLines(text) {
  const lines = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // A log line that only looks like JSON is not a result.
    }
  }
  return lines;
}

const MISSING_CLI = /is not recognized|command not found|ENOENT/i;

export async function runDevBrowser(scriptText, { browserName, timeoutSeconds }) {
  mkdirSync(DEV_BROWSER_DIR, { recursive: true });
  const file = join(DEV_BROWSER_DIR, `${browserName}-${process.pid}-${Date.now()}.js`);
  writeFileSync(file, scriptText);
  const args = ['--headless', '--browser', browserName, '--timeout', String(timeoutSeconds), 'run', file];
  try {
    // On Windows the global CLI is a .cmd shim, which only a shell can start; the shell takes one command line,
    // and none of these arguments holds a space or a shell character.
    const child =
      process.platform === 'win32'
        ? spawn(['dev-browser', ...args].join(' '), { shell: true, windowsHide: true })
        : spawn('dev-browser', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const killer = setTimeout(() => endTree(child), timeoutSeconds * 1000 + KILL_MARGIN_MS);
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    }).finally(() => clearTimeout(killer));
    if (MISSING_CLI.test(stderr) && !stdout.trim()) throw new CannotRun(`the dev-browser CLI did not start: ${stderr.trim().slice(0, 300)}`);
    return { code, lines: jsonLines(stdout), stdout, stderr };
  } catch (error) {
    if (error instanceof CannotRun) throw error;
    throw new CannotRun(`the dev-browser CLI could not run: ${error.message}`);
  } finally {
    rmSync(file, { force: true });
  }
}
