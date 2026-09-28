import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The first full mutation run over src/domain and src/server, 2026-09-28: 1608 mutants at
// concurrency 4, "Done in 220 minutes and 47 seconds". Replace it when a later full run is measured.
const MEASURED_FULL_RUN_MS = (220 * 60 + 47) * 1000;

const source = readFileSync('verify-ship.mjs', 'utf8');

function valueOf(expression: string): number {
  return expression
    .split('*')
    .map((factor) => factor.trim())
    .reduce((product, factor) => {
      if (/^[\d_]+$/.test(factor)) return product * Number(factor.replaceAll('_', ''));
      const declared = new RegExp(`^const ${factor} = ([^;]+);`, 'm').exec(source);
      if (declared === null) throw new Error(`verify-ship.mjs declares no constant ${factor}`);
      return product * valueOf(declared[1]);
    }, 1);
}

function stepTimeouts(): Map<string, string> {
  const steps = /^const STEPS = \[\r?\n([\s\S]*?)^\];/m.exec(source);
  if (steps === null) throw new Error('verify-ship.mjs has no STEPS table');
  const timeouts = new Map<string, string>();
  for (const match of steps[1].matchAll(/name: '([^']+)'.*timeoutMs: ([^,}]+?)\s*[,}]/g)) {
    timeouts.set(match[1], match[2]);
  }
  return timeouts;
}

describe('the ship gate mutation timeout', () => {
  // Below twice the measured run, a machine busy with other sessions reads a slow run as FAIL; above
  // three times, a hung run holds the relay for most of a day before it dies.
  it('gives the mutation step between two and three times the measured full run', () => {
    const expression = stepTimeouts().get('mutation');
    expect(expression).toBeDefined();
    const timeout = valueOf(expression ?? '0');

    expect(timeout).toBeGreaterThanOrEqual(2 * MEASURED_FULL_RUN_MS);
    expect(timeout).toBeLessThanOrEqual(3 * MEASURED_FULL_RUN_MS);
  });

  it('names the measured full run it is sized from', () => {
    expect(valueOf('MUTATION_FULL_RUN_MS')).toBe(MEASURED_FULL_RUN_MS);
  });

  it('leaves every other step on the shared timeout', () => {
    expect([...stepTimeouts().keys()]).toEqual(['mutation']);
  });
});
