import { setTimeout as wait } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { CANONICAL_HOST, CAPTURE_FILE, privacyProblems, runCapture } from '../test-support/examples';
import { WALL_PROFILE } from '../ui/profile';

// Run by hand with npm run test:capture, once the deployed Worker is current, between 07:00 and 22:00
// in Chicago: it mints a scratch kitchen on the live Worker at tolsey.taranity.com, takes three steps
// a minute apart in real time, and writes examples/ only if the whole run lands and passes PRIV-02.
const STEP_GAP_MS = 60_000;
const OUT_DIR = 'examples';

it(`captures one real run of https://${CANONICAL_HOST} into examples/`, async () => {
  await runCapture({
    baseUrl: new URL(`https://${CANONICAL_HOST}`),
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    sleep: (ms) => wait(ms),
    gapMs: STEP_GAP_MS,
    outDir: OUT_DIR,
    profile: WALL_PROFILE,
  });
  // The capture, plus the file examples/manifest.json already listed: the demo video's transcript.
  expect(privacyProblems(OUT_DIR, WALL_PROFILE.roster)).toEqual({ status: 'checked', files: [CAPTURE_FILE, 'demo-transcript.md'], problems: [] });
});
