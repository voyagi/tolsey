import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ToolCallResult } from '../client/mcp-client';
import { PHRASE_TABLE } from '../test-support/phrase-table';
import { intentFor } from './intent';
import { WALL_PROFILE } from './profile';
import {
  DEVICE_LABEL,
  LIMITS,
  LIMITS_HEADING,
  PRIVACY_LINK_TEXT,
  SPEAKER_LABEL,
  TAUGHT_PHRASES,
  WHATS_NEXT,
  WHATS_NEXT_HEADING,
} from './wall-copy';
import { initialWallState, wallReducer, type WallState } from './wall-state';
import { WallView } from './WallView';

const ACTIONS = { say: () => undefined, edit: () => undefined, retryStart: () => undefined, selectCook: () => undefined };
const EMPTY_PASS = 'No reading yet. Log one to see it here.';
const RULE_AT_MOST_41 = { id: 'unit_air_cold', comparator: 'at_most', limit: 41, unit: 'F', sourceKind: 'house_rule' } as const;

type Pass = NonNullable<WallState['pass']>;

const READY: WallState = wallReducer(initialWallState(WALL_PROFILE), { type: 'started' });

const IN_RANGE_PASS: Pass = {
  outcome: 'in_range',
  lineId: 'line-1',
  recordCode: '261016-001',
  checkPoint: { id: 'walk_in', name: 'Walk-in' },
  value: 38,
  unit: 'F',
  verdict: 'in range',
  rule: RULE_AT_MOST_41,
  initials: 'AB',
};

function render(state: WallState): string {
  return renderToStaticMarkup(createElement(WallView, { state, actions: ACTIONS }));
}

function withPass(pass: Partial<Pass>): string {
  return render({ ...READY, pass: { ...IN_RANGE_PASS, ...pass } });
}

// The text a reader sees, with the tags that only style it removed: the unit of a reading is set
// smaller than its figure, and is still read as one "38°F".
function textOf(markup: string): string {
  return markup.replace(/<[^>]*>/g, '');
}

function result(outcome: string, text: string, fields: Record<string, unknown>): ToolCallResult {
  return { content: [{ type: 'text', text }], structuredContent: { contractVersion: 1, outcome, ...fields } };
}

function afterResult(state: WallState, said: string, answer: ToolCallResult): WallState {
  return [
    { type: 'sent', said } as const,
    { type: 'resultReceived', said, result: answer, initials: 'AB' } as const,
  ].reduce(wallReducer, state);
}

// React writes a double quotation mark in text as an entity, so the markup is decoded before phrases
// are read out of it.
function decoded(markup: string): string {
  return markup
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function textsMatching(markup: string, pattern: RegExp): string[] {
  return [...markup.matchAll(pattern)].map((match) => decoded(match[1]));
}

// The wall's own controls. The theme switch is left out: it works while the wall starts or stops,
// because it changes nothing the server keeps.
function buttonsOf(markup: string): string[] {
  return (markup.match(/<button\b[^>]*>/g) ?? []).filter((button) => !button.includes('aria-pressed'));
}

describe('the pass shows a logged line with the fields the result carried', () => {
  it('an in_range line shows the check point, the value in °F, the verdict, the limit, the initials and the record code', () => {
    const markup = withPass({});
    for (const text of ['Walk-in', '38°F', 'in range', 'at most 41°F', 'AB', '261016-001']) expect(textOf(markup)).toContain(text);
    expect(markup).not.toContain('out-of-range');
  });

  it('an out_of_range line shows its verdict word and carries the out-of-range class beside it', () => {
    const markup = withPass({ outcome: 'out_of_range', value: 45, verdict: 'out of range' });
    expect(markup).toContain('out of range');
    expect(markup).toMatch(/class="[^"]*\bout-of-range\b/);
  });

  it('the out-of-range word and its class sit on the same verdict tile', () => {
    const markup = withPass({ outcome: 'out_of_range', value: 45, verdict: 'out of range' });
    expect(markup).toMatch(/<span class="[^"]*\bout-of-range\b[^"]*">out of range<\/span>/);
  });

  it('a value with a tenth steps the reading down to its tenth size', () => {
    expect(withPass({ value: 38.5 })).toMatch(/<p class="[^"]*\breading--tenth\b[^"]*">38\.5/);
    expect(withPass({ value: 38 })).not.toContain('reading--tenth');
  });

  it('a not_covered line shows not covered yet and no limit', () => {
    const markup = withPass({ outcome: 'not_covered', checkPoint: { id: 'cooling', name: 'Cooling' }, verdict: 'not covered yet', rule: undefined });
    expect(markup).toContain('not covered yet');
    expect(markup).not.toMatch(/at (most|least)/);
  });

  it('an at_least rule is written as at least its limit', () => {
    const rule = { id: 'hot_holding', comparator: 'at_least', limit: 135, unit: 'F', sourceKind: 'food_code' } as const;
    expect(textOf(withPass({ value: 140, rule }))).toContain('at least 135°F');
  });

  it('a value with a tenth shows as 38.5', () => {
    expect(textOf(withPass({ value: 38.5 }))).toContain('38.5°F');
  });

  it('a whole value shows as 38, never 38.0', () => {
    const markup = textOf(withPass({ value: 38 }));
    expect(markup).toContain('38°F');
    expect(markup).not.toContain('38.0');
  });

  it('before the first line the pass shows its empty-state sentence', () => {
    expect(render(READY)).toContain(EMPTY_PASS);
  });
});

describe('a refusal or a held question changes the exchange only', () => {
  it('a refused result shows its reply under the speaker label and the previous pass unchanged', () => {
    const reply = 'I need the number on the thermometer. What does reach-in two read?';
    const state = afterResult({ ...READY, pass: IN_RANGE_PASS }, 'reach-in two is fine', result('refused', reply, { verdict: 'refused' }));
    const markup = render(state);
    expect(markup).toContain('reach-in two is fine');
    expect(markup).toContain(reply);
    expect(markup).toContain(SPEAKER_LABEL);
    expect(markup).toContain('261016-001');
  });

  it('a held result shows its question and leaves the empty pass empty', () => {
    const reply = 'Say it one digit at a time. What does the walk-in read?';
    const state = afterResult(READY, 'walk-in 15', result('held', reply, { verdict: 'held', value: 15, prompt: { kind: 'digit_repeat', id: 'p-1' } }));
    const markup = render(state);
    expect(markup).toContain(reply);
    expect(markup).toContain(EMPTY_PASS);
  });
});

describe('the controls follow the start', () => {
  it('while starting every chip and the send button are disabled', () => {
    const buttons = buttonsOf(render(initialWallState(WALL_PROFILE)));
    expect(buttons.length).toBeGreaterThanOrEqual(5);
    for (const button of buttons) expect(button).toContain('disabled=""');
  });

  it('once ready no chip and no send button is disabled', () => {
    const buttons = buttonsOf(render(READY));
    expect(buttons.length).toBeGreaterThanOrEqual(5);
    for (const button of buttons) expect(button).not.toContain('disabled');
  });

  // A disabled button drops the keyboard's focus to the page, so the chip or Send a cook just pressed
  // stays focusable while its call is out and only says it is unavailable.
  it('while a call is out every chip and the send button are aria-disabled and stay focusable', () => {
    const buttons = buttonsOf(render(wallReducer(READY, { type: 'sent', said: 'the walk-in reads 38' })));
    expect(buttons.length).toBeGreaterThanOrEqual(5);
    for (const button of buttons) {
      expect(button).toContain('aria-disabled="true"');
      expect(button).not.toContain('disabled=""');
    }
  });

  it('a failed start shows its sentence, a Retry button and a disabled field', () => {
    const error = 'Could not open the MCP session (status 500).';
    const markup = render(wallReducer(initialWallState(WALL_PROFILE), { type: 'startFailed', error }));
    expect(markup).toContain(error);
    expect(markup).toMatch(/<button\b[^>]*>Retry<\/button>/);
    expect(markup).toMatch(/<input\b[^>]*disabled=""/);
  });
});

// The element opened at `start` runs to its matching close tag; nesting of the same tag is counted.
function elementSpan(markup: string, start: number, tag: string): [number, number] {
  const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g');
  tags.lastIndex = start;
  let depth = 0;
  for (let match = tags.exec(markup); match !== null; match = tags.exec(markup)) {
    depth += match[1] === '/' ? -1 : 1;
    if (depth === 0) return [start, tags.lastIndex];
  }
  return [start, markup.length];
}

function spanOf(markup: string, opener: RegExp, tag: string): [number, number] {
  const found = opener.exec(markup);
  if (found === null) throw new Error(`no ${String(opener)} in the markup`);
  return elementSpan(markup, found.index, tag);
}

function inside(position: number, [from, to]: [number, number]): boolean {
  return position >= from && position < to;
}

const STATUS_REGION = /<div role="status" aria-live="polite">/g;

function radiosOf(markup: string): string[] {
  return markup.match(/<input\b[^>]*type="radio"[^>]*>/g) ?? [];
}

describe('one polite status region', () => {
  it('is in the load markup exactly once, empty, outside the pass and outside every list', () => {
    const markup = render(READY);
    const regions = [...markup.matchAll(STATUS_REGION)];
    expect(regions).toHaveLength(1);
    expect(markup.match(/role="status"/g)).toHaveLength(1);
    const at = regions[0].index;
    expect(markup.slice(at)).toMatch(/^<div role="status" aria-live="polite"><\/div>/);
    expect(inside(at, spanOf(markup, /<section aria-label="Last reading">/, 'section'))).toBe(false);
    for (const list of markup.matchAll(/<ul\b/g)) expect(inside(at, elementSpan(markup, list.index, 'ul'))).toBe(false);
  });

  it('holds the reply of a logged reading and nothing else', () => {
    const reply = 'Walk-in, 38, in range, AB';
    const state = afterResult(READY, 'the walk-in reads 38', result('in_range', reply, { verdict: 'in range', value: 38 }));
    const markup = render(state);
    const [from, to] = spanOf(markup, /<div role="status" aria-live="polite">/, 'div');
    expect(markup.slice(from, to).replace(/<[^>]*>/g, '')).toBe(reply);
  });

  it('stays empty after a held question', () => {
    const reply = 'Say it one digit at a time. What does the walk-in read?';
    const state = afterResult(READY, 'walk-in 15', result('held', reply, { verdict: 'held', value: 15, prompt: { kind: 'digit_repeat', id: 'p-1' } }));
    expect(render(state)).toMatch(/<div role="status" aria-live="polite"><\/div>/);
  });
});

describe('who is logging, on the top bar', () => {
  it('lists AB, MR, JT and KL as one radio group under "Who is logging" with AB checked', () => {
    const markup = render(READY);
    expect(markup).toMatch(/<fieldset\b[^>]*><legend>Who is logging<\/legend>/);
    const radios = radiosOf(markup);
    expect(radios.map((radio) => /value="([^"]*)"/.exec(radio)?.[1])).toEqual(['AB', 'MR', 'JT', 'KL']);
    expect(new Set(radios.map((radio) => /name="([^"]*)"/.exec(radio)?.[1])).size).toBe(1);
    const checked = radios.filter((radio) => radio.includes('checked=""'));
    expect(checked).toHaveLength(1);
    expect(checked[0]).toContain('value="AB"');
  });

  it('checks exactly the cook selected', () => {
    const radios = radiosOf(render(wallReducer(READY, { type: 'cookSelected', initials: 'MR' })));
    const checked = radios.filter((radio) => radio.includes('checked=""'));
    expect(checked).toHaveLength(1);
    expect(checked[0]).toContain('value="MR"');
  });

  it('labels the words in the conversation with the cook who said them, not the cook selected since', () => {
    const answered = afterResult(READY, 'the walk-in reads 38', result('in_range', 'Walk-in, 38, in range, AB', { verdict: 'in range', value: 38 }));
    const markup = render(wallReducer(answered, { type: 'cookSelected', initials: 'MR' }));
    const [from, to] = spanOf(markup, /<section class="exchange"/, 'section');
    expect(markup.slice(from, to)).toContain('<span class="label">Cook AB</span>');
    expect(markup.slice(from, to)).not.toContain('Cook MR');
  });

  it('sits in the top bar, before the conversation', () => {
    const markup = render(READY);
    expect(markup.indexOf('<header')).toBeGreaterThanOrEqual(0);
    expect(inside(markup.indexOf('<fieldset'), spanOf(markup, /<header\b/, 'header'))).toBe(true);
  });
});

describe('a call that did not land', () => {
  it('shows NOT LOGGED with its reason, the words still in the field and the previous pass unchanged', () => {
    const reason = 'Tolsey did not answer in time. Send the same words again to retry.';
    const said = 'walk-in 45';
    const state = [
      { type: 'edited', text: said } as const,
      { type: 'sent', said } as const,
      { type: 'callFailed', said, reason, requestId: 'r-1', initials: 'AB' } as const,
    ].reduce(wallReducer, { ...READY, pass: IN_RANGE_PASS });
    const markup = render(state);
    expect(markup).toContain('NOT LOGGED');
    expect(markup).toContain(reason);
    expect(markup).toMatch(/<input\b[^>]*id="cook-words"[^>]*value="walk-in 45"/);
    expect(markup).toContain('261016-001');
    expect(markup).toMatch(/<div role="status" aria-live="polite"><\/div>/);
  });

  it('a stopped wall shows its message and disables every control', () => {
    const message = 'The demo is full for today. Try again tomorrow.';
    const markup = render(wallReducer(READY, { type: 'stopped', message }));
    expect(markup).toContain(message);
    for (const button of buttonsOf(markup)) expect(button).toContain('disabled=""');
    expect(markup).toMatch(/<input\b[^>]*id="cook-words"[^>]*disabled=""/);
  });
});

describe('the simulated device frame', () => {
  // The page draws its own frame; the Limits note beside it says simulated Alexa+ again, on purpose,
  // so the count is taken inside the frame.
  it('says simulated Alexa+ exactly once and holds the wall inside it', () => {
    const page = render(READY);
    const framed = page.slice(...spanOf(page, /<div class="device">/, 'div'));
    expect(DEVICE_LABEL).toBe('simulated Alexa+');
    expect(framed.split('simulated Alexa+')).toHaveLength(2);
    expect(framed).toContain('Who is logging');
    expect(framed).toContain('<main');
  });

  it('labels the answer with the speaker label on its own', () => {
    const reply = 'Walk-in, 38, in range, AB';
    const state = afterResult(READY, 'the walk-in reads 38', result('in_range', reply, { verdict: 'in range', value: 38 }));
    expect(render(state)).toMatch(new RegExp(`<span class="label">${SPEAKER_LABEL}</span>`));
  });
});

describe('markup the page CSP and the static look allow', () => {
  const failed = [
    { type: 'edited', text: 'walk-in 45' } as const,
    { type: 'sent', said: 'walk-in 45' } as const,
    { type: 'callFailed', said: 'walk-in 45', reason: 'Tolsey did not answer in time.', requestId: 'r-1', initials: 'AB' } as const,
  ].reduce(wallReducer, READY);
  const states: WallState[] = [
    initialWallState(WALL_PROFILE),
    READY,
    { ...READY, pass: IN_RANGE_PASS },
    { ...READY, pass: { ...IN_RANGE_PASS, outcome: 'out_of_range', value: 45, verdict: 'out of range' } },
    { ...READY, pass: { ...IN_RANGE_PASS, outcome: 'not_covered', verdict: 'not covered yet', rule: undefined } },
    failed,
    wallReducer(initialWallState(WALL_PROFILE), { type: 'startFailed', error: 'Could not open the MCP session (status 500).' }),
    wallReducer(READY, { type: 'stopped', message: 'The demo is full for today. Try again tomorrow.' }),
    { ...READY, openChecks: [{ id: 'reach_in_2', name: 'Reach-in two' }] },
    { ...READY, openChecks: [] },
  ];
  const markups = states.map(render);

  it('renders no style attribute in any state', () => {
    for (const markup of markups) expect(markup).not.toContain('style="');
  });

  it('renders no class naming a flap in any state', () => {
    for (const markup of markups) {
      for (const [, classes] of markup.matchAll(/class="([^"]*)"/g)) expect(classes).not.toContain('flap');
    }
  });
});

describe('the open-checks board shows what the record lists', () => {
  const BOARD = /<section\b[^>]*aria-labelledby="open-checks-head"[^>]*>/;
  const TWO_OPEN = [
    { id: 'walk_in', name: 'Walk-in' },
    { id: 'soup_well', name: 'Soup well' },
  ];

  function boardOf(markup: string): string {
    const [from, to] = spanOf(markup, new RegExp(BOARD.source), 'section');
    return markup.slice(from, to);
  }

  it('is not rendered until the record has answered', () => {
    expect(render(READY)).not.toMatch(BOARD);
    expect(textOf(render(READY))).not.toContain('Open checks');
  });

  it('lists the names in the order given, never the ids, under the heading Open checks', () => {
    const board = boardOf(render({ ...READY, openChecks: TWO_OPEN }));
    const text = textOf(board);

    expect(text).toContain('Open checks');
    expect(text.indexOf('Walk-in')).toBeGreaterThan(-1);
    expect(text.indexOf('Walk-in')).toBeLessThan(text.indexOf('Soup well'));
    expect(board).not.toContain('walk_in');
    expect(board).not.toContain('soup_well');
  });

  it('marks every row with the word Open on a status tile, never by colour alone', () => {
    const board = boardOf(render({ ...READY, openChecks: TWO_OPEN }));
    const tiles = board.match(/<span class="status[^"]*">Open<\/span>/g) ?? [];

    expect(tiles).toHaveLength(2);
    expect(textOf(board).match(/Needs a number/g)).toHaveLength(2);
  });

  it('adds nothing a keyboard can reach and no second live region', () => {
    const board = boardOf(render({ ...READY, openChecks: TWO_OPEN }));

    expect(board).not.toMatch(/<(button|a|input|select|textarea)\b|tabindex=|aria-live=|role="(status|alert|log)"/);
  });

  it('shows the designed empty sentence when nothing is open', () => {
    const board = boardOf(render({ ...READY, openChecks: [] }));

    expect(textOf(board)).toContain('No checks are open.');
    expect(board).not.toContain('<li');
  });

  it('keeps the one status region outside the board', () => {
    const markup = render({ ...READY, openChecks: TWO_OPEN });
    const status = markup.search(STATUS_REGION);

    expect(markup.match(/role="status"/g)).toHaveLength(1);
    expect(inside(status, spanOf(markup, new RegExp(BOARD.source), 'section'))).toBe(false);
  });
});

describe('words and replies are shown as text, never as markup', () => {
  it('shows <b>x</b> in what was said and in the reply literally, with no b element in the exchange', () => {
    const said = 'the walk-in reads 38 <b>x</b>';
    const reply = 'Walk-in, <b>x</b>';
    const markup = render({ ...READY, exchange: { said, reply, source: 'server', cook: 'AB' } });
    const exchange = markup.slice(...spanOf(markup, /<section class="exchange"/, 'section'));

    expect(exchange).toContain('the walk-in reads 38 &lt;b&gt;x&lt;/b&gt;');
    expect(exchange).toContain('Walk-in, &lt;b&gt;x&lt;/b&gt;');
    expect(exchange).not.toMatch(/<b\b/);
    expect(decoded(textOf(exchange))).toContain(said);
  });
});

describe("the Limits note, What's next and the footer", () => {
  const markup = render(READY);
  const text = decoded(textOf(markup));

  function sectionHeadedBy(heading: string): string {
    const opener = new RegExp(`<h2 id="([^"]+)"[^>]*>${heading.replaceAll("'", '&#x27;')}</h2>`).exec(markup);
    if (opener === null) throw new Error(`no h2 reading ${heading}`);
    return markup.slice(...spanOf(markup, new RegExp(`<section\\b[^>]*aria-labelledby="${opener[1]}"`), 'section'));
  }

  it('holds the six Limits lines and the seven names of what comes next, each as the copy module words it', () => {
    expect(LIMITS).toHaveLength(6);
    expect(WHATS_NEXT).toHaveLength(7);
    for (const line of [...LIMITS, ...WHATS_NEXT]) expect(text).toContain(line);
  });

  it('lists every Limits line under the Limits heading', () => {
    const limits = decoded(sectionHeadedBy(LIMITS_HEADING));
    for (const line of LIMITS) expect(limits).toContain(`<li>${line}</li>`);
  });

  it("lists every What's next name under a heading that says they are not built yet", () => {
    expect(WHATS_NEXT_HEADING).toMatch(/not built yet/);
    const next = decoded(sectionHeadedBy(WHATS_NEXT_HEADING));
    for (const name of WHATS_NEXT) expect(next).toContain(`<li>${name}</li>`);
    for (const line of LIMITS) expect(next).not.toContain(line);
  });

  it('sets the note outside the simulated device, so it never pushes the pass, the reply or the field down', () => {
    const [, deviceEnds] = spanOf(markup, /<div class="device">/, 'div');
    expect(markup.indexOf(LIMITS[1].replaceAll("'", '&#x27;'))).toBeGreaterThan(deviceEnds);
  });

  it('links the privacy notice from a footer that sits outside main', () => {
    const footer = markup.slice(...spanOf(markup, /<footer\b/, 'footer'));
    expect(footer).toContain(`<a href="/privacy">${PRIVACY_LINK_TEXT}</a>`);
    expect(inside(markup.indexOf('<footer'), spanOf(markup, /<main\b/, 'main'))).toBe(false);
  });
});

describe('every phrase the page teaches parses to its phrase-table entry', () => {
  const markup = render(READY);
  const chips = textsMatching(markup, /<button\b[^>]*class="chip"[^>]*>([^<]*)<\/button>/g);
  // Tags are dropped before double quotation marks are looked for, so attribute values never count.
  const textOnly = markup.replace(/<[^>]*>/g, ' ');
  const quoted = [...textsMatching(markup, /<q>([^<]*)<\/q>/g), ...textsMatching(decoded(textOnly), /"([^"]*)"/g)];
  const extracted = [...new Set([...chips, ...quoted])];

  it('finds the chips and the quoted example in the rendered wall', () => {
    expect(chips.length).toBeGreaterThan(0);
    expect(quoted.length).toBeGreaterThan(0);
  });

  it.each(extracted.length > 0 ? extracted : ['(nothing extracted)'])('%s has a row read with no question open and gives that row', (phrase) => {
    const row = PHRASE_TABLE.find((entry) => entry.phrase === phrase && entry.openPrompt === null);
    expect(row).toBeDefined();
    expect(intentFor(phrase, WALL_PROFILE, null)).toStrictEqual(row?.expected);
  });

  it('the phrases extracted are exactly the taught phrases', () => {
    expect([...extracted].sort()).toEqual([...TAUGHT_PHRASES].sort());
  });
});
