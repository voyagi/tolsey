import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHarness } from 'wrangler';
import { businessDay, localParts } from '../domain/business-day';
import { PROBE_DAY_START, PROBE_ZONE, Q4_INSTANTS } from '../test-support/q4-instants';

const PROBE_CONFIG = './src/test-support/intl-probe.wrangler.jsonc';

interface ProbeAnswer {
  instant: number;
  parts: ReturnType<typeof localParts>;
  businessDay: string;
}

// D-11: the durable proof that workerd and Node read the same wall clock from the same module.
describe('Intl parity between workerd and Node', () => {
  let harness: ReturnType<typeof createTestHarness>;
  let url: URL;

  beforeAll(async () => {
    harness = createTestHarness({ workers: [{ configPath: PROBE_CONFIG }] });
    ({ url } = await harness.listen());
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('gives the same local parts and business day in workerd and Node for the eight Q4 instants', async () => {
    const instants = Q4_INSTANTS.map((instant) => Date.parse(instant.iso));
    const query = new URLSearchParams(instants.map((instant): [string, string] => ['at', String(instant)]));
    const response = await fetch(new URL(`/?${query}`, url));
    expect(response.status).toBe(200);
    const fromWorkerd = (await response.json()) as ProbeAnswer[];

    const fromNode = instants.map((instant) => ({
      instant,
      parts: localParts(instant, PROBE_ZONE),
      businessDay: businessDay(instant, PROBE_ZONE, PROBE_DAY_START),
    }));
    expect(fromWorkerd).toHaveLength(Q4_INSTANTS.length);
    expect(fromWorkerd).toEqual(fromNode);
    expect(fromWorkerd.map(({ parts }) => `${parts.hour}:${parts.minute} ${parts.zoneName}`)).toEqual(
      Q4_INSTANTS.map((instant) => `${instant.hour}:${instant.minute} ${instant.zoneName}`),
    );
  });
});
