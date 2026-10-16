import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// The two deploy gates are scripts, not modules: each one's --selftest is its whole suite, and
// before this file nothing ran it, so a refusal could stop being reachable with every check green.
const DEPLOY_GATES = ['scripts/deploy-preflight.mjs', 'scripts/check-remote-migrations.mjs'];
const SELFTEST_TIMEOUT_MS = 120_000;

describe.each(DEPLOY_GATES)('the %s selftest', (script) => {
  it(
    'passes every case and says so',
    () => {
      const run = spawnSync(process.execPath, [script, '--selftest'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: SELFTEST_TIMEOUT_MS,
      });
      const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;

      expect(output).not.toMatch(/SELFTEST FAIL/);
      expect(output.match(/^selftest ok: /gm)?.length ?? 0).toBeGreaterThan(5);
      expect(output).toMatch(/selftest passed/);
      expect(run.status).toBe(0);
    },
    SELFTEST_TIMEOUT_MS,
  );
});
