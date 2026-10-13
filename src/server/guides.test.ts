import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../contract/tools';
import { readLimits, readRowsPerWrite } from '../test-support/events';
import { byId, postJsonRpc, type Endpoint } from '../test-support/raw-mcp';
import { openInProcessWorker, type InProcessWorker } from '../test-support/target';
import { DEMO_PROFILE } from './data';

// The guides describe what the server registers today and quote the data files. When a later phase
// registers another tool, attaches the card resources, or measures a figure again, the conformance and
// storage pins change with it; these tests make the guides change in the same commit, because they read
// the registered set from the running Worker and the figures from the Worker's own validated data.
const GUIDE_FILES = {
  API: 'docs/API.md',
  ARCHITECTURE: 'docs/ARCHITECTURE.md',
  CONFIGURATION: 'docs/CONFIGURATION.md',
  DEPLOYMENT: 'docs/DEPLOYMENT.md',
  TESTING: 'docs/TESTING.md',
};
const GUIDES = Object.fromEntries(
  Object.entries(GUIDE_FILES).map(([guide, path]) => [guide, readFileSync(path, 'utf8')]),
) as Record<keyof typeof GUIDE_FILES, string>;
const { API, ARCHITECTURE, CONFIGURATION, DEPLOYMENT, TESTING } = GUIDES;

function paragraphHolding(text: string, phrase: string): string {
  return text.split(/\r?\n\r?\n/).find((paragraph) => paragraph.includes(phrase)) ?? '';
}

// Every figure a guide gives right after a backticked key, as "`key` (40000)", "| `key` | `40000` |"
// or "| `key` | 40000 rows".
function quotedFigures(text: string, key: string): number[] {
  const pattern = new RegExp(`\`${key}\`\\s*(?:\\(|\\|)\\s*\`?(-?\\d+(?:\\.\\d+)?)`, 'g');
  return [...text.matchAll(pattern)].map((match) => Number(match[1]));
}

// A repository path as a guide cites it, by the rule scripts/check-privacy-accountability.mjs applies
// to the privacy register: backticked, relative, inside at least one folder, a file name with an
// extension, no parent step.
function citedPaths(text: string): string[] {
  const tokens = new Set([...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]));
  return [...tokens].filter(
    (token) => /^[\w.-]+(\/[\w.-]+)+$/.test(token) && /\.\w+$/.test(token) && !token.split('/').includes('..'),
  );
}

// Folders a build or a mutation run writes. A fresh clone has neither, and the mutation sandbox never
// gets reports/ (Stryker always leaves it out), so a path under them is not checked for existence.
const BUILD_OUTPUTS = new Set(['dist', 'reports']);

function wrongFigures(figures: Record<string, number>): string[] {
  return Object.entries(GUIDES).flatMap(([guide, text]) =>
    Object.entries(figures).flatMap(([key, value]) =>
      quotedFigures(text, key)
        .filter((quoted) => quoted !== value)
        .map((quoted) => `${guide}: \`${key}\` quoted as ${quoted}, the data says ${value}`),
    ),
  );
}

describe('the guides and what the server registers', () => {
  let worker: InProcessWorker;
  let tools: string[];
  let resources: string[];

  async function listed(endpoint: Endpoint, method: string, key: 'tools' | 'resources'): Promise<string[]> {
    const response = await postJsonRpc(endpoint, { jsonrpc: '2.0', id: 1, method, params: {} });
    const result = byId(response, 1) as Record<typeof key, { name?: string; uri?: string }[]>;
    return result[key].map((entry) => entry.name ?? entry.uri ?? '');
  }

  beforeAll(async () => {
    worker = await openInProcessWorker();
    const endpoint = { url: new URL('/mcp', worker.baseUrl), fetch: worker.fetch };
    tools = await listed(endpoint, 'tools/list', 'tools');
    resources = await listed(endpoint, 'resources/list', 'resources');
  });

  afterAll(async () => {
    await worker?.dispose();
  });

  it('gives every registered tool its own section in API.md', () => {
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.filter((name) => !API.includes(`## Tool: ${name}`))).toEqual([]);
  });

  it('lists as not registered yet exactly the planned tools the server does not register', () => {
    const paragraph = paragraphHolding(API, 'not registered yet');
    const namedThere = TOOL_NAMES.filter((name) => paragraph.includes(`\`${name}\``));
    const unregistered = TOOL_NAMES.filter((name) => !tools.includes(name));

    expect(namedThere).toEqual(unregistered);
  });

  it('says one tool is registered only while exactly one is', () => {
    const single = tools.length === 1;

    expect(API.includes('One tool is registered today')).toBe(single);
    expect(ARCHITECTURE.includes('is the only registered tool')).toBe(single);
  });

  it('says no resource is registered only while the server lists none', () => {
    const none = resources.length === 0;

    expect(API.includes('no resource is registered yet')).toBe(none);
    expect(API.includes('`resources/list` returns an empty list')).toBe(none);
  });
});

describe('the guides and the data they quote', () => {
  const limits = readLimits();
  const rows = readRowsPerWrite();
  const windows = {
    correctionWindowSeconds: DEMO_PROFILE.correctionWindowSeconds,
    promptExpirySeconds: DEMO_PROFILE.promptExpirySeconds,
  };

  it('finds the quoted figures it checks, so a reworded guide cannot pass by quoting none', () => {
    expect(quotedFigures(API, 'dailyRowCap')).toContain(limits.dailyRowCap);
    expect(quotedFigures(CONFIGURATION, 'dailyRowCap')).toContain(limits.dailyRowCap);
    expect(quotedFigures(API, 'event_first_of_day')).toContain(rows.event_first_of_day);
    expect(quotedFigures(API, 'correctionWindowSeconds')).toContain(windows.correctionWindowSeconds);
    expect(quotedFigures(API, 'promptExpirySeconds')).toContain(windows.promptExpirySeconds);
  });

  it('quotes every store limit, every measured row count and the profile windows as the data files hold them', () => {
    expect(wrongFigures({ ...limits, ...rows, ...windows })).toEqual([]);
  });

  it('copies data/store/limits.json into CONFIGURATION.md as the Worker loads it', () => {
    const section = CONFIGURATION.split('### `data/store/limits.json`')[1] ?? '';
    const block = /```json\r?\n([\s\S]*?)```/.exec(section);

    expect(block).not.toBeNull();
    expect(JSON.parse(block?.[1] ?? '{}')).toEqual(limits);
  });

  it('gives the event row reservation that expectedRowsFor computes from the measured rows', () => {
    const superseding = rows.event_superseding - rows.event;
    const answering = rows.event_answering - rows.event;
    const referencing = rows.event_referencing - rows.event;
    const most = rows.event_first_of_day + superseding + answering + referencing;

    expect(API).toContain(
      `plus ${superseding} more when it corrects a line, ${answering} when it answers a question and ${referencing} when it points`,
    );
    expect(API).toContain(`so between ${rows.event_first_of_day} and ${most}`);
  });

  // The floor is raised whenever tests are added (15 raises from 2026-09-28 to 2026-10-13).
  it('quotes the test-count floor that the gate:test-count script runs with', () => {
    const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;
    const floor = /--floor (\d+)/.exec(scripts['gate:test-count'] ?? '')?.[1];

    expect(floor).toBeDefined();
    expect([...TESTING.matchAll(/--floor (\d+)/g)].map((match) => match[1])).toEqual([floor]);
  });

  it('describes migration 0002 as triggers only while it still creates them', () => {
    const createsTriggers = /CREATE TRIGGER/i.test(readFileSync('migrations/0002_append_only_guard.sql', 'utf8'));

    expect(ARCHITECTURE.includes('| `0002_append_only_guard.sql` | Triggers that abort')).toBe(createsTriggers);
    expect(DEPLOYMENT.includes('| `migrations/0002_append_only_guard.sql` | Triggers that abort')).toBe(createsTriggers);
  });
});

// A guide's claim about a file rests on that file, so a move or a delete fails here, in the commit
// that makes it, instead of leaving the guide pointing nowhere.
describe('the guides and the files they cite', () => {
  it('reads the cited paths it checks, so a broken rule cannot pass by finding none', () => {
    expect(citedPaths(DEPLOYMENT)).toContain('scripts/deploy-preflight.mjs');
    expect(citedPaths(TESTING)).toContain('reports/stryker-incremental.json');
    for (const notAPath of ['text/event-stream', 'ui://tolsey/reading.html']) {
      expect(API).toContain(`\`${notAPath}\``);
      expect(citedPaths(API)).not.toContain(notAPath);
    }
  });

  it('cites only files that exist, outside the folders a build writes', () => {
    const missing = Object.entries(GUIDES).flatMap(([guide, text]) =>
      citedPaths(text)
        .filter((path) => !BUILD_OUTPUTS.has(path.split('/')[0]) && !existsSync(path))
        .map((path) => `${guide}: ${path}`),
    );

    expect(missing).toEqual([]);
  });

  // This file runs inside the mutation command, so its result on a mutant rests on the guides' text too.
  it('names every guide it reads as a mutation input, so a guide edit clears reused mutation results', () => {
    const wrapper = readFileSync('scripts/mutate-incremental.mjs', 'utf8');

    expect(Object.values(GUIDE_FILES).filter((path) => !wrapper.includes(`'${path}'`))).toEqual([]);
  });
});
