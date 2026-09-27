import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { judgeReading, passes } from './judge';
import type { Comparator } from './rule';

const comparator = fc.constantFrom<Comparator>('at_most', 'at_least');
const limitTenths = fc.integer({ min: -500, max: 2500 });
const nearOffset = fc.integer({ min: -30, max: 30 });

describe('the judge', () => {
  it('equals the inclusive comparison for any limit and a reading near it', () => {
    fc.assert(
      fc.property(comparator, limitTenths, nearOffset, (c, limit, offset) => {
        const expected = c === 'at_most' ? offset <= 0 : offset >= 0;
        expect(passes(limit + offset, limit, c)).toBe(expected);
        expect(judgeReading(limit + offset, { comparator: c, limitFTenths: limit })).toBe(
          expected ? 'in_range' : 'out_of_range',
        );
      }),
    );
  });

  it('keeps its verdict when the reading and the limit shift by the same amount', () => {
    fc.assert(
      fc.property(comparator, limitTenths, nearOffset, fc.integer({ min: -1000, max: 1000 }), (c, limit, offset, shift) => {
        expect(passes(limit + offset + shift, limit + shift, c)).toBe(passes(limit + offset, limit, c));
      }),
    );
  });
});
