import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ADR_PATH = 'docs/adr/0002-storage.md';
const ROWS_SECTION = '## Rows written per write';

const HEADINGS = [
  '## D1 over Durable Objects',
  '## Write model',
  '## Events table',
  '## Due slot rule',
  '## Key shape',
  ROWS_SECTION,
  '## Append-only guard',
  '## ui:// naming',
  '## Location and jurisdiction',
  '## Test harness',
  '## Consequences',
];

const adr = readFileSync(ADR_PATH, 'utf8');
const adrLines = adr.split(/\r?\n/);

function section(heading: string): string {
  const start = adrLines.indexOf(heading);
  if (start === -1) return '';
  const next = adrLines.findIndex((line, index) => index > start && line.startsWith('## '));
  return adrLines.slice(start + 1, next === -1 ? undefined : next).join('\n');
}

function measuredRows(): [string, number][] {
  const data = JSON.parse(readFileSync('data/store/rows-per-write.json', 'utf8')) as Record<string, unknown>;
  return Object.entries(data).filter((entry): entry is [string, number] => typeof entry[1] === 'number');
}

describe('the storage decision record', () => {
  it('holds each of the eleven sections the storage decision must record', () => {
    const missing = HEADINGS.filter((heading) => !adrLines.includes(heading));

    expect(missing).toEqual([]);
  });

  it('quotes every measured rows-per-write number from data/store/rows-per-write.json in its rows section', () => {
    const rows = measuredRows();
    const quoted = section(ROWS_SECTION);
    const mismatched = rows.filter(
      ([kind, count]) => !new RegExp(`\\|\\s*\`${kind}\`\\s*\\|\\s*${count}\\s*\\|`).test(quoted),
    );

    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(mismatched).toEqual([]);
  });

  it('contains no en dash and no em dash', () => {
    expect(adr).not.toMatch(/[–—]/);
  });
});
