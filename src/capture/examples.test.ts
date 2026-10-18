import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { FetchLike } from '../client/mcp-client';
import {
  CANONICAL_HOST,
  KEPT_HEADERS,
  privacyProblems,
  recordingFetch,
  runCapture,
  type PrivacyCheck,
} from '../test-support/examples';
import { WALL_PROFILE } from '../ui/profile';

const ROSTER = WALL_PROFILE.roster;
const CAPTURE_FILE = 'deployed-run.json';
const TRANSCRIPT_FILE = 'demo-transcript.md';
const KITCHEN = '0123456789abcdef0123456789abcdef';
// 11:01 in Chicago (CDT, UTC minus 5): inside the demo kitchen's 07:00 to 22:00 schedule.
const IN_SERVICE = Date.parse('2026-10-19T16:01:00.000Z');
// 00:30 in Chicago: before the first scheduled check.
const BEFORE_SERVICE = Date.parse('2026-10-19T05:30:00.000Z');
const TEST_GAP_MS = 5;

const scratch = mkdtempSync(join(tmpdir(), 'tolsey-examples-'));
let fixtureCount = 0;

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function fixture(files: Record<string, unknown>, listed: string[] = Object.keys(files)): string {
  fixtureCount += 1;
  const dir = join(scratch, `fixture-${fixtureCount}`);
  mkdirSync(dir, { recursive: true });
  // A string is written as it stands (a Markdown file, or a JSON file that does not parse).
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ files: listed }));
  return dir;
}

// Shaped like a real capture: ISO times that read like IPv6 to a careless regex, UUIDs, record codes,
// a dotted version, the two kept header names and the canonical host.
function cleanCapture(): Record<string, unknown> {
  return {
    where: 'deployed',
    canonicalHost: CANONICAL_HOST,
    startedAt: '2026-10-19T16:01:00.000Z',
    steps: [{ said: 'the walk-in reads 38', outcome: 'in_range', serverTime: '2026-10-19T16:01:02.120Z' }],
    exchanges: [
      {
        method: 'POST',
        path: `/mcp/k/${KITCHEN}`,
        status: 200,
        request: {
          headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25' },
          body: {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: {
              name: 'log_reading',
              arguments: {
                check_point: 'walk_in',
                value: 38,
                words: 'the walk-in reads 38',
                initials: 'AB',
                screen_id: 'wall-3f2a9c1e-8b7d-4e6f-a1b2-c3d4e5f60718',
                request_id: '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a',
              },
            },
          },
        },
        response: {
          headers: { 'content-type': 'application/json' },
          body: {
            jsonrpc: '2.0',
            id: 3,
            result: {
              content: [{ type: 'text', text: 'Walk-in, 38, in range, AB' }],
              structuredContent: {
                contractVersion: 1,
                outcome: 'in_range',
                recordCode: '261019-001',
                initials: 'AB',
                serverTime: '2026-10-19T16:01:02.120Z',
                businessDay: '2026-10-19',
                note: 'opened at 04:30:00 local',
              },
            },
          },
        },
      },
      { method: 'POST', path: '/mcp/k/x', status: 200, request: { body: { params: { clientInfo: { name: 'tolsey-wall', version: '0.1.0' } } } } },
    ],
  };
}

function withPlanted(path: (capture: Record<string, unknown>) => void): Record<string, unknown> {
  const capture = cleanCapture();
  path(capture);
  return capture;
}

interface PlantedExchange {
  request: { headers: Record<string, string>; body: { params: { arguments: Record<string, unknown> } } };
}

function exchangeOf(capture: Record<string, unknown>): PlantedExchange {
  return (capture.exchanges as PlantedExchange[])[0];
}

function kindsOf(check: PrivacyCheck): string[] {
  return check.status === 'checked' ? check.problems.map((problem) => problem.kind) : [];
}

describe('PRIV-02: what a captured run may hold', () => {
  const planted: [string, string, () => string][] = [
    ['initials off the roster', 'initials_off_roster', () => fixture({ [CAPTURE_FILE]: withPlanted((c) => (exchangeOf(c).request.body.params.arguments.initials = 'AK')) })],
    ['an IPv4 literal', 'ip_literal', () => fixture({ [CAPTURE_FILE]: withPlanted((c) => (c.note = 'seen from 203.0.113.7')) })],
    ['an IPv6 literal', 'ip_literal', () => fixture({ [CAPTURE_FILE]: withPlanted((c) => (c.note = 'client 2001:db8::1 called')) })],
    ['an IPv4 literal with a port', 'ip_literal', () => fixture({ [CAPTURE_FILE]: withPlanted((c) => (c.note = 'client 203.0.113.7:443 called')) })],
    ['a bracketed IPv6 literal with a port', 'ip_literal', () => fixture({ [CAPTURE_FILE]: withPlanted((c) => (c.note = 'client [2001:db8::1]:443 called')) })],
    ['a request header name', 'header_name', () => fixture({ [CAPTURE_FILE]: withPlanted((c) => (exchangeOf(c).request.headers['user-agent'] = 'Mozilla/5.0')) })],
    ['a hostname other than the canonical one', 'foreign_host', () => fixture({ [CAPTURE_FILE]: withPlanted((c) => (c.source = 'https://example.com/run')) })],
    ['a bare hostname inside prose', 'foreign_host', () => fixture({ [CAPTURE_FILE]: withPlanted((c) => (c.note = 'served by example.com today')) })],
    ['a file the capture did not write', 'unlisted_file', () => fixture({ [CAPTURE_FILE]: cleanCapture(), 'notes.json': { said: 'hello' } }, [CAPTURE_FILE])],
    ['a listed JSON file that does not parse', 'unreadable', () => fixture({ [CAPTURE_FILE]: cleanCapture(), 'notes.json': '# not JSON\n' })],
    ['an IPv4 literal in a listed Markdown file', 'ip_literal', () => fixture({ [CAPTURE_FILE]: cleanCapture(), [TRANSCRIPT_FILE]: '# Transcript\n\nSeen from 203.0.113.7 today.\n' })],
    ['a hostname in a listed Markdown file', 'foreign_host', () => fixture({ [CAPTURE_FILE]: cleanCapture(), [TRANSCRIPT_FILE]: '# Transcript\n\nWatch it on example.com today.\n' })],
    ['a Markdown file the manifest does not list', 'unlisted_file', () => fixture({ [CAPTURE_FILE]: cleanCapture(), [TRANSCRIPT_FILE]: '# Transcript\n' }, [CAPTURE_FILE])],
  ];

  it.each(planted)('is red on %s, with exactly one problem of kind %s', (_name, kind, make) => {
    expect(kindsOf(privacyProblems(make(), ROSTER))).toEqual([kind]);
  });

  it('is green on a clean capture-shaped fixture', () => {
    const check = privacyProblems(fixture({ [CAPTURE_FILE]: cleanCapture() }), ROSTER);
    expect(check).toEqual({ status: 'checked', files: [CAPTURE_FILE], problems: [] });
  });

  it('stays green on the canonical host, a decimal, a version and "e.g." inside prose', () => {
    const capture = withPlanted((c) => (c.note = `served by ${CANONICAL_HOST}, e.g. at 38.5 on version 0.1.0.`));
    expect(privacyProblems(fixture({ [CAPTURE_FILE]: capture }), ROSTER)).toEqual({ status: 'checked', files: [CAPTURE_FILE], problems: [] });
  });

  it('reads a listed Markdown file as text, so prose that is not JSON passes when it holds no address or host', () => {
    const transcript = `# Transcript\n\nA paper log takes "fine." Served by ${CANONICAL_HOST}, e.g. at 38.5.\n`;
    const check = privacyProblems(fixture({ [CAPTURE_FILE]: cleanCapture(), [TRANSCRIPT_FILE]: transcript }), ROSTER);
    expect(check).toEqual({ status: 'checked', files: [CAPTURE_FILE, TRANSCRIPT_FILE], problems: [] });
  });

  it('is red when the manifest lists no capture file', () => {
    expect(kindsOf(privacyProblems(fixture({}, []), ROSTER))).toEqual(['empty']);
  });

  it('says absent, never clean, when there is no examples folder', () => {
    const check = privacyProblems(join(scratch, 'no-such-folder'), ROSTER);
    expect(check.status).toBe('absent');
    expect('problems' in check).toBe(false);
  });

  it('holds the real examples/ folder to the rule: absent until the capture runs, then checked and clean', () => {
    const check = privacyProblems('examples', ROSTER);
    if (check.status === 'absent') {
      expect(existsSync('examples')).toBe(false);
      return;
    }
    expect(check.files.length).toBeGreaterThan(0);
    expect(check.problems).toEqual([]);
  });
});

describe('recordingFetch keeps two headers and the parsed bodies', () => {
  it('records method, path, status, both bodies and only content-type and mcp-protocol-version, and still answers the caller', async () => {
    const inner: FetchLike = async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25', 'cf-ray': '8d1f', server: 'cloudflare', 'mcp-session-id': 's-1' },
      });
    const recorder = recordingFetch(inner);
    const answer = await recorder.fetch(new URL(`https://${CANONICAL_HOST}/mcp/k/${KITCHEN}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25', 'mcp-session-id': 's-1' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

    expect(await answer.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    expect(recorder.exchanges).toEqual([
      {
        method: 'POST',
        path: `/mcp/k/${KITCHEN}`,
        status: 200,
        request: {
          headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25' },
          body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        },
        response: {
          headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25' },
          body: { jsonrpc: '2.0', id: 1, result: { ok: true } },
        },
      },
    ]);
    expect(KEPT_HEADERS).toEqual(['content-type', 'mcp-protocol-version']);
  });
});

interface FakeWorker {
  fetch: FetchLike;
  paths: string[];
  mintBodies: unknown[];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cf-ray': '8d1f' } });
}

// A scripted Worker: it mints, initializes, lists both tools, answers due_now, and judges the three
// capture phrases. failOnLogCall makes that log_reading call never reach it.
function fakeWorker(failOnLogCall?: number): FakeWorker {
  const paths: string[] = [];
  const mintBodies: unknown[] = [];
  let logCalls = 0;
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (path === '/api/kitchens') {
      mintBodies.push(body);
      return json({ id: KITCHEN, mcpPath: `/mcp/k/${KITCHEN}`, expiresAt: '2026-10-20T15:46:00.000Z', closesAt: '2026-10-20T15:42:00.000Z' }, 201);
    }
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'initialize') {
      return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'tolsey', version: '0.1.0' } } });
    }
    if (body.method === 'tools/list') {
      // Shaped like the real answer: a JSON Schema meta-schema URL and a property named initials.
      const inputSchema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { initials: { type: 'string' } } };
      return json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'log_reading', inputSchema }, { name: 'due_now', inputSchema }] } });
    }
    if (body.params.name === 'due_now') {
      const structuredContent = { contractVersion: 1, businessDay: '2026-10-19', timeZone: 'America/Chicago', openChecks: [] };
      return json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'No checks are open.' }], structuredContent } });
    }
    logCalls += 1;
    if (logCalls === failOnLogCall) throw new TypeError('fetch failed');
    const refused = String(body.params.arguments.words).includes('is fine');
    const structuredContent = refused
      ? { contractVersion: 1, outcome: 'refused', verdict: 'refused', serverTime: `2026-10-19T16:0${logCalls}:00.000Z`, businessDay: '2026-10-19' }
      : {
          contractVersion: 1,
          outcome: 'in_range',
          verdict: 'in range',
          lineId: `line-${logCalls}`,
          recordCode: `261019-00${logCalls}`,
          checkPoint: { id: 'walk_in', name: 'Walk-in' },
          initials: 'AB',
          value: 38,
          unit: 'F',
          rule: { id: 'cold-holding', comparator: 'at_most', limit: 41, unit: 'F', sourceKind: 'food_code' },
          serverTime: `2026-10-19T16:0${logCalls}:00.000Z`,
          businessDay: '2026-10-19',
        };
    const text = refused ? 'I need the number on the thermometer. What does reach-in two read?' : 'Walk-in, 38, in range, AB';
    return json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text }], structuredContent } });
  };
  return { fetch, paths, mintBodies };
}

function captureRun(worker: FakeWorker, now: number, sleeps: number[] = [], outDir = join(scratch, `out-${(fixtureCount += 1)}`)) {
  const run = runCapture({
    baseUrl: new URL(`https://${CANONICAL_HOST}`),
    fetch: worker.fetch,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    gapMs: TEST_GAP_MS,
    outDir,
    profile: WALL_PROFILE,
  });
  return { run, outDir };
}

function filesIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

// An examples/ folder from an earlier run whose manifest also lists the transcript.
function folderWithTranscript(transcript: string): string {
  const outDir = join(scratch, `out-${(fixtureCount += 1)}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, TRANSCRIPT_FILE), transcript);
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ files: [CAPTURE_FILE, TRANSCRIPT_FILE] }));
  return outDir;
}

describe('runCapture writes a run only when the whole run lands and passes PRIV-02', () => {
  it('writes no file when a step fails partway', async () => {
    const { run, outDir } = captureRun(fakeWorker(2), IN_SERVICE);
    await expect(run).rejects.toThrow(/reach-in two is fine/);
    expect(filesIn(outDir)).toEqual([]);
  });

  it('writes the capture and its manifest after a full run, each file passing the check', async () => {
    const worker = fakeWorker();
    const sleeps: number[] = [];
    const { run, outDir } = captureRun(worker, IN_SERVICE, sleeps);
    await run;

    expect(filesIn(outDir)).toEqual([CAPTURE_FILE, 'manifest.json']);
    expect(privacyProblems(outDir, ROSTER)).toEqual({ status: 'checked', files: [CAPTURE_FILE], problems: [] });
    const capture = JSON.parse(readFileSync(join(outDir, CAPTURE_FILE), 'utf8'));
    expect(capture.where).toBe('deployed');
    expect(capture.canonicalHost).toBe(CANONICAL_HOST);
    expect(capture.steps.map((step: { outcome: string }) => step.outcome)).toEqual(['in_range', 'refused', 'in_range']);
    const listed = capture.exchanges.find((exchange: { request: { body: { method?: string } } }) => exchange.request.body?.method === 'tools/list');
    expect(listed.response.body.result.tools).toEqual([{ name: 'log_reading' }, { name: 'due_now' }]);
    expect(capture.steps.map((step: { serverTime: string }) => step.serverTime)).toEqual([
      '2026-10-19T16:01:00.000Z',
      '2026-10-19T16:02:00.000Z',
      '2026-10-19T16:03:00.000Z',
    ]);
  });

  it('keeps a file the manifest already lists, such as the transcript, listed and unchanged after a fresh run', async () => {
    const transcript = '# Transcript\n\nA paper log takes "fine." Tolsey asks for the number.\n';
    const { run, outDir } = captureRun(fakeWorker(), IN_SERVICE, [], folderWithTranscript(transcript));
    await run;

    expect(filesIn(outDir)).toEqual([TRANSCRIPT_FILE, CAPTURE_FILE, 'manifest.json']);
    expect(JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))).toEqual({ files: [CAPTURE_FILE, TRANSCRIPT_FILE] });
    expect(readFileSync(join(outDir, TRANSCRIPT_FILE), 'utf8')).toBe(transcript);
    expect(privacyProblems(outDir, ROSTER)).toEqual({ status: 'checked', files: [CAPTURE_FILE, TRANSCRIPT_FILE], problems: [] });
  });

  it('judges a kept file again, and writes nothing when it fails the rule', async () => {
    const { run, outDir } = captureRun(fakeWorker(), IN_SERVICE, [], folderWithTranscript('# Transcript\n\nSeen from 203.0.113.7 today.\n'));
    await expect(run).rejects.toThrow(/failed PRIV-02 and was not written: ip_literal at demo-transcript\.md/);
    expect(filesIn(outDir)).toEqual([TRANSCRIPT_FILE, 'manifest.json']);
  });

  it('writes nothing when a file the manifest lists has gone missing, rather than unlisting it', async () => {
    const outDir = join(scratch, `out-${(fixtureCount += 1)}`);
    mkdirSync(outDir, { recursive: true });
    const manifest = JSON.stringify({ files: [CAPTURE_FILE, TRANSCRIPT_FILE] });
    writeFileSync(join(outDir, 'manifest.json'), manifest);
    const { run } = captureRun(fakeWorker(), IN_SERVICE, [], outDir);
    await expect(run).rejects.toThrow(/failed PRIV-02 and was not written: missing_file at demo-transcript\.md/);
    expect(filesIn(outDir)).toEqual(['manifest.json']);
    expect(readFileSync(join(outDir, 'manifest.json'), 'utf8')).toBe(manifest);
  });

  it('writes nothing when the manifest already there cannot be read, rather than replacing it', async () => {
    const outDir = folderWithTranscript('# Transcript\n\nA paper log takes "fine."\n');
    writeFileSync(join(outDir, 'manifest.json'), '{ "files": [');
    const { run } = captureRun(fakeWorker(), IN_SERVICE, [], outDir);
    await expect(run).rejects.toThrow(/failed PRIV-02 and was not written: unreadable at manifest\.json files/);
    expect(filesIn(outDir)).toEqual([TRANSCRIPT_FILE, 'manifest.json']);
    expect(readFileSync(join(outDir, 'manifest.json'), 'utf8')).toBe('{ "files": [');
  });

  it('writes nothing when a file in the folder is not in its manifest, rather than writing past it', async () => {
    const outDir = folderWithTranscript('# Transcript\n\nA paper log takes "fine."\n');
    const manifest = JSON.stringify({ files: [CAPTURE_FILE] });
    writeFileSync(join(outDir, 'manifest.json'), manifest);
    const { run } = captureRun(fakeWorker(), IN_SERVICE, [], outDir);
    await expect(run).rejects.toThrow(/failed PRIV-02 and was not written: unlisted_file at demo-transcript\.md$/);
    expect(filesIn(outDir)).toEqual([TRANSCRIPT_FILE, 'manifest.json']);
    expect(readFileSync(join(outDir, 'manifest.json'), 'utf8')).toBe(manifest);
  });

  it('mints a fresh kitchen labelled capture and never calls the demo kitchen at /mcp', async () => {
    const worker = fakeWorker();
    await captureRun(worker, IN_SERVICE).run;
    expect(worker.mintBodies).toEqual([{ label: 'capture' }]);
    expect(worker.paths).not.toContain('/mcp');
    expect(worker.paths.filter((path) => path.startsWith('/mcp/k/')).length).toBeGreaterThan(0);
  });

  it('waits at least the gap between its three steps', async () => {
    const sleeps: number[] = [];
    await captureRun(fakeWorker(), IN_SERVICE, sleeps).run;
    expect(sleeps).toHaveLength(2);
    for (const ms of sleeps) expect(ms).toBeGreaterThanOrEqual(TEST_GAP_MS);
  });

  it('refuses to start outside 07:00 to 22:00 in Chicago, before any request', async () => {
    const worker = fakeWorker();
    const { run, outDir } = captureRun(worker, BEFORE_SERVICE);
    await expect(run).rejects.toThrow(/07:00 to 22:00/);
    expect(worker.paths).toEqual([]);
    expect(filesIn(outDir)).toEqual([]);
  });

  // The gaps alone predict the end; each request here also takes 20 seconds of clock time.
  function slowRun(startedAt: number) {
    let clock = startedAt;
    const worker = fakeWorker();
    const outDir = join(scratch, `out-${(fixtureCount += 1)}`);
    const run = runCapture({
      baseUrl: new URL(`https://${CANONICAL_HOST}`),
      fetch: async (url, init) => {
        clock += 20_000;
        return worker.fetch(url, init);
      },
      now: () => clock,
      sleep: async () => {},
      gapMs: TEST_GAP_MS,
      outDir,
      profile: WALL_PROFILE,
    });
    return { run, outDir, worker };
  }

  it('writes no file when the run starts in service but its last answer lands after 22:00 in Chicago', async () => {
    // 21:59:30 in Chicago: the gaps predict an end in the same minute, the requests carry it past 22:00.
    const { run, outDir, worker } = slowRun(Date.parse('2026-10-20T02:59:30.000Z'));
    await expect(run).rejects.toThrow(/07:00 to 22:00 in America\/Chicago, and it is 22:0\d there/);
    expect(worker.paths.length).toBeGreaterThan(0);
    expect(filesIn(outDir)).toEqual([]);
  });

  it('still writes a slow run whose last answer lands before 22:00 in Chicago', async () => {
    const { run, outDir } = slowRun(Date.parse('2026-10-20T02:00:00.000Z'));
    await run;
    expect(filesIn(outDir)).toEqual([CAPTURE_FILE, 'manifest.json']);
  });
});
