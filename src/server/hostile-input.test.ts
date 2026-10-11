import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import demoJson from '../../data/kitchens/demo.json';
import rulesJson from '../../data/rules/food-code-2022.json';
import { describeSource } from '../domain/citation';
import { KitchenProfileSchema, RuleTableSchema, type RuleRow, type RuleTable } from '../domain/rule';
import { D1Store } from '../store/d1-store';
import { countingStore, type CountingStore } from '../test-support/counting-store';
import { openTestD1, type TestD1 } from '../test-support/d1';
import { callLogReading, walkInArguments, type ToolResult } from '../test-support/mcp-client';
import { byId, sendRaw, type RawResponse } from '../test-support/raw-mcp';
import { LOCAL_HOSTNAMES, mintThroughRoute, type FetchLike } from '../test-support/target';
import { parseAllowlist } from './allowlist';
import { createWorker, type WorkerEnv } from './worker';

const BASE = new URL('http://localhost/');
const NOW = Date.UTC(2026, 9, 20, 15, 0);
const DEPLOYED = 'tolsey.taranity.com';
const NOT_FOUND = { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Not found' } };
const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'hostile-probe', version: '1.0.0' } },
});

type WithMeta = ToolResult & { _meta?: unknown };

describe('hostile input at the Worker', () => {
  let d1: TestD1;
  let counting: CountingStore;
  let instant = NOW;
  const worker = createWorker({ clock: { now: () => instant }, storeFor: () => counting.store });

  beforeAll(async () => {
    d1 = await openTestD1();
    counting = countingStore(new D1Store(d1.db));
  });

  afterAll(async () => {
    await d1?.dispose();
  });

  function envWith(allowed: string): WorkerEnv {
    return { ASSETS: { fetch: async () => new Response('asset', { status: 200 }) }, ALLOWED_HOSTNAMES: allowed, DB: d1.db };
  }

  // A Node Request carries no Host header, so each request gets the one its URL names, unless the
  // test sets its own.
  function fetchVia(allowed: string, headers: Record<string, string> = {}): FetchLike {
    return async (url, init) => {
      const request = new Request(url, init);
      const merged = new Headers(request.headers);
      merged.set('host', new URL(String(url)).host);
      for (const [name, value] of Object.entries(headers)) merged.set(name, value);
      return worker.fetch(new Request(request, { headers: merged }), envWith(allowed));
    };
  }

  const local: FetchLike = (url, init) => fetchVia(LOCAL_HOSTNAMES)(url, init);

  function initializeAt(path: string, fetchFn: FetchLike): Promise<RawResponse> {
    return sendRaw(
      { url: new URL(path, BASE), fetch: fetchFn },
      {
        method: 'POST',
        headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
        body: INITIALIZE,
      },
    );
  }

  // The routing tests elsewhere probe these shapes with an id no kitchen has, which answers Not found
  // whatever the pattern accepts. Only a real kitchen's id shows whether the shape reaches it.
  describe('a minted kitchen answers only at its exact path', () => {
    let kitchenId: string;

    beforeAll(async () => {
      kitchenId = (await mintThroughRoute(local, BASE)).id;
    });

    it('answers initialize at /mcp/k/<id> as Tolsey 0.1.0, the control every alias below is measured against', async () => {
      const response = await initializeAt(`/mcp/k/${kitchenId}`, local);
      expect(response.status).toBe(200);
      expect(byId(response, 1)).toMatchObject({ serverInfo: { name: 'tolsey', version: '0.1.0' } });
    });

    it.each([
      ['a trailing slash', (id: string) => `/mcp/k/${id}/`],
      ['an extra segment', (id: string) => `/mcp/k/${id}/extra`],
      ['a hex digit glued to the id', (id: string) => `/mcp/k/${id}0`],
      ['the id in uppercase', (id: string) => `/mcp/k/${id.toUpperCase()}`],
      ['the whole path nested under another /mcp segment', (id: string) => `/mcp/x/mcp/k/${id}`],
      ['a doubled slash before k', (id: string) => `/mcp//k/${id}`],
    ])('answers the real id with %s as Not found', async (_label, pathOf) => {
      const response = await initializeAt(pathOf(kitchenId), local);
      expect(response.status).toBe(404);
      expect(JSON.parse(response.bodyText)).toEqual(NOT_FOUND);
    });
  });

  describe('the demo kitchen', () => {
    it('refuses a write at /mcp with the code demo_read_only before any storage call', async () => {
      counting.calls.length = 0;
      const refused = (await callLogReading(local, new URL('/mcp', BASE))) as WithMeta;
      expect(refused.isError).toBe(true);
      expect(refused._meta).toEqual({ error: 'demo_read_only' });
      expect(counting.calls).toEqual([]);
    });

    it('does reach storage for the same call at a minted kitchen, the control for the count above', async () => {
      const minted = await mintThroughRoute(local, BASE);
      counting.calls.length = 0;
      const logged = await callLogReading(local, new URL(minted.mcpPath, BASE));
      expect(logged.isError).toBeFalsy();
      expect(counting.calls).toEqual(expect.arrayContaining(['findByRequest', 'append']));
    });
  });

  describe('a request_id belongs to the kitchen that used it', () => {
    it('logs a fresh line in a second kitchen under a request_id the first kitchen used with another value', async () => {
      const first = await mintThroughRoute(local, BASE);
      const second = await mintThroughRoute(local, BASE);
      const requestId = crypto.randomUUID();
      const inFirst = await callLogReading(local, new URL(first.mcpPath, BASE), walkInArguments({ request_id: requestId }));
      const inSecond = await callLogReading(
        local,
        new URL(second.mcpPath, BASE),
        walkInArguments({ request_id: requestId, value: 39, words: 'the walk-in reads 39' }),
      );

      expect(inFirst.isError).toBeFalsy();
      expect(inSecond.isError).toBeFalsy();
      expect(inSecond.structuredContent).toMatchObject({ outcome: 'in_range' });
      expect(inSecond.structuredContent?.lineId).not.toBe(inFirst.structuredContent?.lineId);
      const day = String(inSecond.structuredContent?.businessDay);
      const store = new D1Store(d1.db);
      expect((await store.linesForDay(first.id, day)).map((line) => [line.id, line.valueTenths])).toEqual([
        [inFirst.structuredContent?.lineId, 380],
      ]);
      expect((await store.linesForDay(second.id, day)).map((line) => [line.id, line.valueTenths])).toEqual([
        [inSecond.structuredContent?.lineId, 390],
      ]);
    });

    it('logs one line in each of two kitchens sent the same request_id at the same moment', async () => {
      const kitchens = [await mintThroughRoute(local, BASE), await mintThroughRoute(local, BASE)];
      const args = walkInArguments();
      const results = await Promise.all(kitchens.map((kitchen) => callLogReading(local, new URL(kitchen.mcpPath, BASE), args)));

      expect(results.map((result) => result.isError ?? false)).toEqual([false, false]);
      const day = String(results[0]?.structuredContent?.businessDay);
      const store = new D1Store(d1.db);
      for (const [index, kitchen] of kitchens.entries()) {
        expect((await store.linesForDay(kitchen.id, day)).map((line) => line.id)).toEqual([results[index]?.structuredContent?.lineId]);
      }
    });
  });

  describe('the verdict a host reads aloud', () => {
    it('says refused for a hedged reading, in range for a plain one, and held when that line is said wrong', async () => {
      const minted = await mintThroughRoute(local, BASE);
      const url = new URL(minted.mcpPath, BASE);
      const hedged = await callLogReading(local, url, walkInArguments({ words: 'the walk-in reads about 38', screen_id: 'hedge-wall' }));
      const logged = await callLogReading(local, url, walkInArguments({ screen_id: 'verdict-wall' }));
      const wrong = await callLogReading(local, url, {
        words: 'wrong number',
        initials: 'AB',
        screen_id: 'verdict-wall',
        request_id: crypto.randomUUID(),
      });

      expect(hedged.structuredContent).toMatchObject({ outcome: 'refused', verdict: 'refused' });
      expect(logged.structuredContent).toMatchObject({ outcome: 'in_range', verdict: 'in range' });
      expect(wrong.structuredContent).toMatchObject({ outcome: 'held', verdict: 'held' });
    });

    // The question "wrong number" opens closes at its expiry instant, which is still inside the reach
    // a later "wrong number" reads back, so only the expiry decides whether it is asked again.
    it('answers a second "wrong number" at the instant the first one\'s question expires with nothing to fix', async () => {
      const minted = await mintThroughRoute(local, BASE);
      const url = new URL(minted.mcpPath, BASE);
      const wrongNumber = () => ({ words: 'wrong number', initials: 'AB', screen_id: 'expiry-wall', request_id: crypto.randomUUID() });
      try {
        instant = NOW;
        await callLogReading(local, url, walkInArguments({ screen_id: 'expiry-wall' }));
        instant = NOW + 10_000;
        const asked = await callLogReading(local, url, wrongNumber());
        instant = NOW + 10_000 + 60_000;
        const stillOpen = await callLogReading(local, url, wrongNumber());
        instant = NOW + 10_000 + 120_000;
        const closed = await callLogReading(local, url, wrongNumber());

        expect(asked.structuredContent).toMatchObject({ outcome: 'held' });
        expect(stillOpen.structuredContent).toMatchObject({ outcome: 'held' });
        expect(closed.structuredContent).toMatchObject({ outcome: 'nothing_to_fix' });
      } finally {
        instant = NOW;
      }
    });
  });

  describe('Origin shapes that name the deployed host without being it', () => {
    it('accepts the deployed Host and Origin, the control for the refusals below', async () => {
      const response = await initializeAt('/mcp', fetchVia(DEPLOYED, { host: DEPLOYED, origin: `https://${DEPLOYED}` }));
      expect(response.status).toBe(200);
    });

    it.each([
      ['the deployed name as userinfo', `https://${DEPLOYED}@attacker.example`],
      ['the deployed name as a fragment', `https://attacker.example#${DEPLOYED}`],
      ['the deployed name as a subdomain of another site', `https://${DEPLOYED}.attacker.example`],
      ['the deployed name as a path', `https://attacker.example/${DEPLOYED}`],
    ])('refuses an Origin with %s with 403', async (_label, origin) => {
      const response = await initializeAt('/mcp', fetchVia(DEPLOYED, { host: DEPLOYED, origin }));
      expect(response.status).toBe(403);
    });
  });

  // Harder variants of the cases above: a boundary value with one decimal too many, look-alike
  // initials, invisible and direction-changing characters, prototype keys, and a burst of copies.
  describe('escalation', () => {
    async function storedRows(kitchenId: string): Promise<{ kind: string; words: string; initials: string | null }[]> {
      const rows = await d1.db
        .prepare('SELECT kind, words, initials FROM events WHERE kitchen_id = ? ORDER BY seq')
        .bind(kitchenId)
        .all<{ kind: string; words: string; initials: string | null }>();
      return rows.results;
    }

    it('refuses 41.04 at a 41 degree limit as too precise rather than rounding it into range, and stores nothing', async () => {
      const minted = await mintThroughRoute(local, BASE);
      const url = new URL(minted.mcpPath, BASE);
      const precise = await callLogReading(local, url, walkInArguments({ value: 41.04, words: 'the walk-in reads 41.04' }));
      const over = await callLogReading(local, url, walkInArguments({ value: 41.1, words: 'the walk-in reads 41.1' }));

      expect(precise.isError).toBe(true);
      expect(over.structuredContent).toMatchObject({ outcome: 'out_of_range' });
      expect((await storedRows(minted.id)).length).toBe(1);
    });

    it('refuses initials written in look-alike Cyrillic letters and stores nothing', async () => {
      const minted = await mintThroughRoute(local, BASE);
      const lookAlike = String.fromCharCode(0x410, 0x412);
      const refused = (await callLogReading(local, new URL(minted.mcpPath, BASE), walkInArguments({ initials: lookAlike }))) as WithMeta;

      expect(lookAlike).not.toBe('AB');
      expect(refused.isError).toBe(true);
      expect(refused._meta).toEqual({ error: 'initials_not_on_roster' });
      expect(await storedRows(minted.id)).toEqual([]);
    });

    it('stores no invisible or direction-changing character a cook\'s words carried', async () => {
      const minted = await mintThroughRoute(local, BASE);
      const hidden = [0x202e, 0x200b, 0x2066, 0x0007, 0xfeff].map((code) => String.fromCharCode(code));
      const words = `the walk-in${hidden[1]} reads ${hidden[0]}38${hidden[2]}${hidden[3]}${hidden[4]}`;
      await callLogReading(local, new URL(minted.mcpPath, BASE), walkInArguments({ words }));

      const rows = await storedRows(minted.id);
      expect(rows.length).toBe(1);
      // The words were kept, so the check below is about what they kept, not about nothing stored.
      expect(rows[0]?.words).toMatch(/walk-in/);
      for (const row of rows) {
        for (const char of hidden) expect(row.words.includes(char)).toBe(false);
      }
    });

    it('answers arguments carrying __proto__ and constructor keys without a fault and without touching the prototype', async () => {
      const minted = await mintThroughRoute(local, BASE);
      const prototypeKeys = JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}') as Record<string, unknown>;
      const hostile = { ...walkInArguments(), ...prototypeKeys };
      expect(JSON.stringify(hostile)).toContain('"__proto__"');

      const answer = (await callLogReading(local, new URL(minted.mcpPath, BASE), hostile)) as WithMeta;

      expect(answer._meta).not.toEqual({ error: 'server_fault' });
      expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('stores one line for eight copies of one call sent at the same moment, and answers every copy with it', async () => {
      const minted = await mintThroughRoute(local, BASE);
      const args = walkInArguments();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => callLogReading(local, new URL(minted.mcpPath, BASE), args)),
      );

      expect(results.filter((result) => result.isError)).toEqual([]);
      expect(new Set(results.map((result) => result.structuredContent?.lineId)).size).toBe(1);
      expect((await storedRows(minted.id)).map((row) => row.kind)).toEqual(['reading']);
    });
  });
});

describe('parseAllowlist names each malformed list exactly', () => {
  const NOT_SET = 'ALLOWED_HOSTNAMES is not set: list the hostnames this Worker answers, comma separated';
  const NOT_ASCII =
    'is not an ASCII hostname: use letters, digits, inner hyphens and dots, and give a non-ASCII name in its punycode form';

  it.each([
    ['unset', undefined, NOT_SET],
    ['whitespace only', '   ', NOT_SET],
    ['a stray comma', 'localhost,', 'ALLOWED_HOSTNAMES entry "" is empty: remove the stray comma'],
    ['a URL', `https://${DEPLOYED}`, `ALLOWED_HOSTNAMES entry "https://${DEPLOYED}" is a URL: give the bare hostname`],
    ['a path', `${DEPLOYED}/mcp`, `ALLOWED_HOSTNAMES entry "${DEPLOYED}/mcp" holds a path: give the bare hostname`],
    [
      'a wildcard',
      '*.taranity.com',
      'ALLOWED_HOSTNAMES entry "*.taranity.com" holds a wildcard: list every hostname, because the check matches exactly',
    ],
    ['an underscore in a label', 'bad_host.example', `ALLOWED_HOSTNAMES entry "bad_host.example" ${NOT_ASCII}`],
    ['a label ending in a hyphen', 'tolsey-.example', `ALLOWED_HOSTNAMES entry "tolsey-.example" ${NOT_ASCII}`],
    ['a 64-character label', `${'a'.repeat(64)}.example`, `ALLOWED_HOSTNAMES entry "${'a'.repeat(64)}.example" ${NOT_ASCII}`],
    ['text after a bracketed address', '[::1]x', 'ALLOWED_HOSTNAMES entry "[::1]x" is not a bracketed IPv6 literal'],
    ['a bracketed address no URL parser accepts', '[::::]', 'ALLOWED_HOSTNAMES entry "[::::]" is not an address a Host header can carry'],
  ])('refuses %s with its own reason', (_label, raw, reason) => {
    expect(parseAllowlist(raw)).toEqual({ ok: false, reason });
  });

  it('accepts a 63-character label, the longest a hostname may carry', () => {
    const entry = `${'a'.repeat(63)}.example`;
    expect(parseAllowlist(entry)).toEqual({ ok: true, hostnames: [entry] });
  });
});

describe('the data files refuse a malformed edit at load', () => {
  function issuesOfProfile(edit: (profile: typeof demoJson) => void): unknown[] {
    const profile = structuredClone(demoJson);
    edit(profile);
    const result = KitchenProfileSchema.safeParse(profile);
    expect(result.success).toBe(false);
    return result.error?.issues ?? [];
  }

  it('loads the shipped demo profile and rule table, the control for every refusal below', () => {
    expect(KitchenProfileSchema.safeParse(demoJson).success).toBe(true);
    expect(RuleTableSchema.safeParse(rulesJson).success).toBe(true);
  });

  it.each([
    ['four letters', 'ABCD'],
    ['a lowercase letter before two capitals', 'aAB'],
    ['one letter', 'A'],
  ])('refuses roster initials of %s', (_label, initials) => {
    const issues = issuesOfProfile((profile) => {
      profile.roster[0] = initials;
    });
    expect(issues).toEqual([expect.objectContaining({ path: ['roster', 0] })]);
  });

  it.each([
    ['a leading digit', '1walk_in'],
    ['a hyphen after valid characters', 'walk_in-2'],
    ['a capital letter', 'Walk_in'],
  ])('refuses a check point id with %s', (_label, id) => {
    const issues = issuesOfProfile((profile) => {
      profile.checkPoints[0]!.id = id;
    });
    expect(issues).toEqual([expect.objectContaining({ path: ['checkPoints', 0, 'id'] })]);
  });

  it.each([
    ['three hour digits', '107:00'],
    ['three minute digits', '07:000'],
    ['one hour digit', '7:00'],
  ])('refuses a scheduled time with %s', (_label, time) => {
    const issues = issuesOfProfile((profile) => {
      profile.schedule[0]!.times[0] = time;
    });
    expect(issues).toEqual([expect.objectContaining({ path: ['schedule', 0, 'times', 0] })]);
  });

  it('names the time zone it refuses', () => {
    const issues = issuesOfProfile((profile) => {
      profile.timeZone = 'Mars/Olympus_Mons';
    });
    expect(issues).toEqual([
      expect.objectContaining({ path: ['timeZone'], message: 'time zone must be a zone name Intl knows, such as America/Chicago' }),
    ]);
  });

  it('names the day start it refuses', () => {
    const issues = issuesOfProfile((profile) => {
      profile.dayStart = '02:30';
    });
    expect(issues).toEqual([
      expect.objectContaining({ path: ['dayStart'], message: 'day start must be HH:MM outside 01:00 to 03:00' }),
    ]);
  });

  it('refuses a house rule that tightens a row the table lacks, naming the row by its index', () => {
    const table: { rows: unknown[] } & Omit<typeof rulesJson, 'rows'> = structuredClone(rulesJson);
    const index = table.rows.length;
    table.rows.push({
      id: 'house_extra',
      kind: 'temperature',
      comparator: 'at_most',
      limitFTenths: 400,
      limitC: 4.4,
      source: { kind: 'house_rule', reason: 'a stricter kitchen figure', tightens: 'no_such_rule' },
    });
    const result = RuleTableSchema.safeParse(table);
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        code: 'custom',
        path: ['rows', index],
        message: 'house_extra tightens no_such_rule, which the table lacks',
      }),
    ]);
  });

  it('refuses two rows that share an id', () => {
    const table: { rows: unknown[] } & Omit<typeof rulesJson, 'rows'> = structuredClone(rulesJson);
    table.rows.push(structuredClone(rulesJson.rows[0]));
    const result = RuleTableSchema.safeParse(table);
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([expect.objectContaining({ code: 'custom', path: ['rows'], message: 'two rows share an id' })]);
  });
});

describe('a house rule never borrows a Code citation it does not have', () => {
  const codeRow: RuleRow = {
    id: 'code_cold',
    kind: 'temperature',
    comparator: 'at_most',
    limitFTenths: 410,
    limitC: 5,
    source: { kind: 'food_code', section: '3-501.16', page: '1', edition: '2022', quote: 'at 5C or less', unchanged2026: true },
  };
  const kitchenFigure: RuleRow = {
    id: 'kitchen_figure',
    kind: 'temperature',
    comparator: 'at_most',
    limitFTenths: 400,
    limitC: 4.4,
    source: { kind: 'house_rule', reason: 'the kitchen keeps its own figure', tightens: 'code_cold' },
  };
  const stricterStill: RuleRow = {
    id: 'stricter_still',
    kind: 'temperature',
    comparator: 'at_most',
    limitFTenths: 390,
    limitC: 3.9,
    source: { kind: 'house_rule', reason: 'stricter still', tightens: 'kitchen_figure' },
  };
  const table: RuleTable = { rulesVersion: 'test', edition: 'test', rows: [codeRow, kitchenFigure, stricterStill], notCovered: [] };

  it('cites the Code section and figure a house rule tightens, the control for the case below', () => {
    expect(describeSource(kitchenFigure, table)).toBe(
      'house rule: the kitchen keeps its own figure, stricter than Food Code 2022 3-501.16, 41°F or less',
    );
  });

  it('says the Code sets no limit for a house rule that tightens another house rule', () => {
    expect(describeSource(stricterStill, table)).toBe('house rule: stricter still; the Food Code sets no limit here');
  });
});
