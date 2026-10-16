import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseAllowlist } from './allowlist';

// Written to break the list rules: an entry made of the characters a host, an address, a port or a
// pattern is written in, in any order.
const ENTRY_CHARACTERS = ['a', 'b', 'f', 'x', 'A', '0', '1', '9', '.', ':', '[', ']', '-', '*', '%', '/'];
const entry = fc.string({ unit: fc.constantFrom(...ENTRY_CHARACTERS), minLength: 1, maxLength: 12 });

describe('parseAllowlist, against entries built to break it', () => {
  // The SDK compares the hostname a URL parser makes of the Host header, so an accepted entry that
  // parser would write another way could never match a visitor.
  it('accepts an entry only in the exact form a Host header is compared in', () => {
    // The property means nothing unless some of the entries it is given are accepted.
    expect(fc.sample(entry, { numRuns: 2000, seed: 1 }).filter((raw) => parseAllowlist(raw).ok).length).toBeGreaterThan(50);
    fc.assert(
      fc.property(entry, (raw) => {
        const parsed = parseAllowlist(raw);
        if (!parsed.ok) return;
        const [hostname] = parsed.hostnames;
        expect(new URL(`http://${hostname}`).hostname).toBe(hostname);
        expect(new URL(`http://${hostname}:8787`).hostname).toBe(hostname);
      }),
      { numRuns: 2000 },
    );
  });

  it('names the entry it refuses, and never throws, whatever the text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 24 }), (raw) => {
        const parsed = parseAllowlist(raw);
        if (parsed.ok) return;
        const named = raw.split(',').some((part) => parsed.reason.includes(`"${part.trim().toLowerCase()}"`));
        expect(parsed.reason.startsWith('ALLOWED_HOSTNAMES is not set') || named).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
});
