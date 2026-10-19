import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchLike } from '../client/mcp-client';
import { messagesIn, parseJson } from '../client/messages';
import { localParts } from '../domain/business-day';
import type { KitchenProfile } from '../domain/rule';
import { createWallSession } from '../ui/wall-session';
import type { WallState } from '../ui/wall-state';

// One module for the rule and the writer, so the PRIV-02 test in CI and the capture that writes
// examples/ can never disagree about what a published run may hold.
export const CANONICAL_HOST = 'tolsey.taranity.com';

export const KEPT_HEADERS: readonly string[] = ['content-type', 'mcp-protocol-version'];

const FORBIDDEN_HEADER_NAMES: ReadonlySet<string> = new Set([
  'host',
  'origin',
  'user-agent',
  'cookie',
  'set-cookie',
  'authorization',
  'referer',
  'cf-connecting-ip',
  'cf-ray',
  'x-forwarded-for',
  'x-real-ip',
  'accept',
  'accept-language',
  'sec-ch-ua',
]);

const FORBIDDEN_HEADER_PREFIXES = ['sec-', 'cf-'];

export const CAPTURE_FILE = 'deployed-run.json';
const MANIFEST_FILE = 'manifest.json';
const MARKDOWN_FILE = /\.md$/i;

interface PrivacyProblem {
  kind: string;
  file: string;
  where: string;
}

export type PrivacyCheck = { status: 'absent' } | { status: 'checked'; files: string[]; problems: PrivacyProblem[] };

// Characters an IP literal can be made of. Every run of them is tested with isIP, so a time such as
// 04:30:00, a UUID or a version such as 0.1.0 is never mistaken for an address by its shape alone.
// Each piece between colons is tested too, so an IPv4 address with a port (203.0.113.7:443) is found
// while a whole IPv6 run is still tested as one.
const NOT_IP_CHARACTERS = /[^0-9A-Fa-f.:]+/;
const URL_PATTERN = /https?:\/\/[^\s"'<>)\]]+/gi;
// Any run inside a value shaped like a host name, its last label alphabetic and two characters or
// more, so a dotted version, a decimal or an "e.g." never reads as one, and a host named in a
// sentence is found as surely as one standing alone.
const HOST_SHAPE = /(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]/gi;

function holdsIpLiteral(text: string): boolean {
  return text
    .split(NOT_IP_CHARACTERS)
    .filter((run) => run !== '')
    .flatMap((run) => [run, ...run.split(':')])
    .some((run) => [run, run.replace(/\.+$/, ''), run.replace(/^\.+/, '')].some((candidate) => isIP(candidate) !== 0));
}

function foreignHostsIn(text: string): string[] {
  const hosts: string[] = [];
  for (const [url] of text.matchAll(URL_PATTERN)) {
    try {
      hosts.push(new URL(url).hostname);
    } catch {
      hosts.push(url);
    }
  }
  for (const [host] of text.matchAll(HOST_SHAPE)) hosts.push(host.toLowerCase());
  return hosts.filter((host) => host !== CANONICAL_HOST);
}

function isForbiddenHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return FORBIDDEN_HEADER_NAMES.has(lower) || FORBIDDEN_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function problemsInFile(file: string, content: unknown, roster: ReadonlySet<string>): PrivacyProblem[] {
  const problems: PrivacyProblem[] = [];
  const add = (kind: string, where: string) => problems.push({ kind, file, where });

  function checkString(text: string, where: string): void {
    if (holdsIpLiteral(text)) add('ip_literal', where);
    if (foreignHostsIn(text).length > 0) add('foreign_host', where);
  }

  function checkInitials(value: unknown, where: string): void {
    const all = Array.isArray(value) ? value : [value];
    if (all.some((initials) => typeof initials !== 'string' || !roster.has(initials))) add('initials_off_roster', where);
  }

  // Inside a headers object every name but the two kept ones is a problem; anywhere else, a key that
  // names a request header is.
  function walk(value: unknown, where: string, inHeaders: boolean): void {
    if (typeof value === 'string') {
      checkString(value, where);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${where}[${index}]`, false));
      return;
    }
    if (!isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const at = where === '' ? key : `${where}.${key}`;
      if (inHeaders ? !KEPT_HEADERS.includes(key.toLowerCase()) : isForbiddenHeader(key)) add('header_name', at);
      if (key === 'initials') checkInitials(child, at);
      walk(child, at, key === 'headers' && isPlainObject(child));
    }
  }

  walk(content, '', false);
  return problems;
}

// A listed name is a file directly in the folder. A path such as ../outside.md would have the check
// read, and the capture copy, a file outside it, and a colon names an NTFS stream rather than a file.
const PLAIN_NAME = /^[^\\/:]+$/;

function isPlainName(file: string): boolean {
  return PLAIN_NAME.test(file) && file !== '.' && file !== '..';
}

function listedFiles(dir: string): { listed: string[]; problems: PrivacyProblem[] } {
  const manifest = parseJson(existsSync(join(dir, MANIFEST_FILE)) ? readFileSync(join(dir, MANIFEST_FILE), 'utf8') : '');
  const files = isPlainObject(manifest) ? manifest.files : undefined;
  if (!Array.isArray(files) || !files.every((file) => typeof file === 'string')) {
    return { listed: [], problems: [{ kind: 'unreadable', file: MANIFEST_FILE, where: 'files' }] };
  }
  const problems = files.flatMap((file, index) => (isPlainName(file) ? [] : [{ kind: 'not_a_plain_name', file: MANIFEST_FILE, where: `files[${index}]` }]));
  return { listed: files.filter(isPlainName), problems };
}

// Absent is its own answer, never "clean": a folder that is not there has been checked for nothing.
export function privacyProblems(dir: string, roster: readonly string[]): PrivacyCheck {
  if (!existsSync(dir)) return { status: 'absent' };
  const { listed, problems } = listedFiles(dir);
  const listedSet = new Set(listed);
  for (const entry of readdirSync(dir)) {
    if (entry !== MANIFEST_FILE && !listedSet.has(entry)) problems.push({ kind: 'unlisted_file', file: entry, where: '' });
  }
  if (listed.length === 0) problems.push({ kind: 'empty', file: MANIFEST_FILE, where: 'files' });
  const rosterSet = new Set(roster);
  const files: string[] = [];
  for (const file of listed) {
    const path = join(dir, file);
    if (!existsSync(path)) {
      problems.push({ kind: 'missing_file', file, where: '' });
      continue;
    }
    files.push(file);
    // A listed Markdown file (the demo video's transcript) is prose, not a recorded run: its whole
    // text is held to the address and host rules as one string, with no JSON to walk.
    const text = readFileSync(path, 'utf8');
    const content = MARKDOWN_FILE.test(file) ? text : parseJson(text);
    if (content === undefined) problems.push({ kind: 'unreadable', file, where: '' });
    else problems.push(...problemsInFile(file, content, rosterSet));
  }
  return { status: 'checked', files, problems };
}

export interface RecordedExchange {
  method: string;
  path: string;
  status: number;
  request: { headers: Record<string, string>; body: unknown };
  response: { headers: Record<string, string>; body: unknown };
}

function keptHeaders(headers: Headers): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of KEPT_HEADERS) {
    const value = headers.get(name);
    if (value !== null) kept[name] = value;
  }
  return kept;
}

function parsedBody(contentType: string | null, text: string): unknown {
  if (text === '') return null;
  if (contentType?.includes('text/event-stream')) return messagesIn(contentType, text);
  return parseJson(text) ?? text;
}

// Each answer is read once here and handed on as a fresh Response with the same text, so the
// caller reads exactly what the recorder kept.
export function recordingFetch(inner: FetchLike): { fetch: FetchLike; exchanges: RecordedExchange[] } {
  const exchanges: RecordedExchange[] = [];
  const fetch: FetchLike = async (url, init = {}) => {
    const response = await inner(url, init);
    const text = await response.text();
    const sent = typeof init.body === 'string' ? init.body : '';
    exchanges.push({
      method: init.method ?? 'GET',
      path: new URL(String(url)).pathname,
      status: response.status,
      request: { headers: keptHeaders(new Headers(init.headers)), body: parsedBody('application/json', sent) },
      response: { headers: keptHeaders(response.headers), body: parsedBody(response.headers.get('content-type'), text) },
    });
    return new Response(text === '' ? null : text, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  return { fetch, exchanges };
}

export interface CaptureOptions {
  baseUrl: URL;
  fetch: FetchLike;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  gapMs: number;
  outDir: string;
  profile: KitchenProfile;
}

const LOGGED_OUTCOMES = ['in_range', 'out_of_range', 'not_covered'];

// A logged reading, a numberless check refused, then the number that clears it.
const CAPTURE_STEPS = [
  { words: 'the walk-in reads 38', outcomes: LOGGED_OUTCOMES },
  { words: 'reach-in two is fine', outcomes: ['refused'] },
  { words: 'reach-in two reads 38', outcomes: LOGGED_OUTCOMES },
];

interface CapturedStep {
  said: string;
  outcome: string;
  reply: string;
  serverTime: string;
}

function minutesOf(clock: string): number {
  const [hours, minutes] = clock.split(':').map(Number);
  return hours * 60 + minutes;
}

// The demo kitchen's service hours are its schedule's first and last check times: a run outside
// them would print times no kitchen keeps. The message names whichever end fell outside.
function assertInService(from: number, to: number, profile: KitchenProfile): void {
  const times = profile.schedule.flatMap((entry) => entry.times).sort((a, b) => a.localeCompare(b));
  const [open, close] = [times[0], times.at(-1) ?? times[0]];
  const localMinutes = (instant: number) => {
    const local = localParts(instant, profile.timeZone);
    return local.hour * 60 + local.minute;
  };
  const startsOutside = localMinutes(from) < minutesOf(open) || localMinutes(from) > minutesOf(close);
  if (startsOutside || localMinutes(to) > minutesOf(close) || localMinutes(to) < localMinutes(from)) {
    const local = localParts(startsOutside ? from : to, profile.timeZone);
    const shown = `${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`;
    throw new Error(`the capture runs only from ${open} to ${close} in ${profile.timeZone}, and it is ${shown} there`);
  }
}

interface ToolAnswer {
  content?: { text?: string }[];
  structuredContent?: { outcome?: unknown; serverTime?: unknown };
}

function resultIn(body: unknown, id: unknown): ToolAnswer | undefined {
  const messages = Array.isArray(body) ? body : [body];
  const reply = messages.find((message) => isPlainObject(message) && message.id === id);
  return isPlainObject(reply) ? (reply.result as ToolAnswer | undefined) : undefined;
}

function lastLogReading(exchanges: readonly RecordedExchange[]): ToolAnswer | undefined {
  for (let index = exchanges.length - 1; index >= 0; index -= 1) {
    const body = exchanges[index].request.body;
    if (isPlainObject(body) && body.method === 'tools/call' && isPlainObject(body.params) && body.params.name === 'log_reading') {
      return resultIn(exchanges[index].response.body, body.id);
    }
  }
  return undefined;
}

function stepOf(position: number, words: string, outcomes: readonly string[], state: WallState, exchanges: readonly RecordedExchange[]): CapturedStep {
  const named = `step ${position} ("${words}")`;
  if (state.phase !== 'ready' || state.notLogged !== null || state.exchange?.said !== words) {
    throw new Error(`${named} did not land: ${state.notLogged?.reason ?? state.stopMessage ?? 'no answer'}`);
  }
  const result = lastLogReading(exchanges);
  const outcome = String(result?.structuredContent?.outcome);
  if (!outcomes.includes(outcome)) throw new Error(`${named} answered ${outcome}, expected ${outcomes.join(' or ')}`);
  return {
    said: words,
    outcome,
    reply: result?.content?.[0]?.text ?? '',
    serverTime: String(result?.structuredContent?.serverTime),
  };
}

// A tools/list answer is kept as the tool names only. Its schemas carry the JSON Schema meta-schema
// URL and a property named initials, neither of which is part of the run, and keeping them would
// mean writing exemptions into the PRIV-02 rule.
function namesOnly(message: unknown): unknown {
  if (!isPlainObject(message) || !isPlainObject(message.result) || !Array.isArray(message.result.tools)) return message;
  const tools = message.result.tools.map((tool) => ({ name: isPlainObject(tool) ? tool.name : undefined }));
  return { ...message, result: { ...message.result, tools } };
}

function compacted(exchange: RecordedExchange): RecordedExchange {
  const request = exchange.request.body;
  if (!isPlainObject(request) || request.method !== 'tools/list') return exchange;
  const body = exchange.response.body;
  return { ...exchange, response: { ...exchange.response, body: Array.isArray(body) ? body.map(namesOnly) : namesOnly(body) } };
}

// Files outDir's manifest already lists beside the capture (the demo video's transcript) stay
// listed, and are judged again with the new capture, so a fresh run never unlists one. A listed file
// that has gone missing stays listed but is not staged, so the check reports it and nothing is written.
// A manifest that cannot be read, or a file in outDir it does not list, is reported here instead:
// the rewritten manifest would hide either one from the check in the scratch folder.
function keptFiles(outDir: string): { names: string[]; present: [string, string][]; problems: PrivacyProblem[] } {
  if (!existsSync(outDir)) return { names: [], present: [], problems: [] };
  const { listed, problems }: ReturnType<typeof listedFiles> = existsSync(join(outDir, MANIFEST_FILE))
    ? listedFiles(outDir)
    : { listed: [], problems: [] };
  const known = new Set([MANIFEST_FILE, CAPTURE_FILE, ...listed]);
  for (const entry of readdirSync(outDir)) {
    if (!known.has(entry)) problems.push({ kind: 'unlisted_file', file: entry, where: '' });
  }
  // The run writes the capture and the manifest itself, so neither is kept: an old manifest copied into
  // the scratch folder would replace the new one there, and the check would judge the wrong listing.
  // Names are compared without case, because a disk that ignores case reads MANIFEST.JSON as the
  // manifest and two spellings of one name as one file.
  const taken = new Set([CAPTURE_FILE, MANIFEST_FILE].map((file) => file.toLowerCase()));
  const names = listed.filter((file) => {
    const key = file.toLowerCase();
    if (taken.has(key)) return false;
    taken.add(key);
    return true;
  });
  const present = names
    .filter((file) => existsSync(join(outDir, file)))
    .map((file): [string, string] => [file, readFileSync(join(outDir, file), 'utf8')]);
  return { names, present, problems };
}

function refusal(problems: readonly PrivacyProblem[]): Error {
  const listed = problems.map((problem) => `${problem.kind} at ${problem.file} ${problem.where}`.trim()).join('; ');
  return new Error(`the capture failed PRIV-02 and was not written: ${listed}`);
}

// The files are judged in a scratch folder first and reach outDir only once they pass, each written
// in a fresh folder inside outDir and renamed into place, so a failed or refused run leaves outDir as
// it was. A listed name is a plain file name, so no listed file can be inside that folder, and the
// rename stays on outDir's own volume.
function writeChecked(capture: unknown, outDir: string, roster: readonly string[]): void {
  const kept = keptFiles(outDir);
  if (kept.problems.length > 0) throw refusal(kept.problems);
  const files: [string, string][] = [
    [CAPTURE_FILE, `${JSON.stringify(capture, null, 2)}\n`],
    [MANIFEST_FILE, `${JSON.stringify({ files: [CAPTURE_FILE, ...kept.names] }, null, 2)}\n`],
  ];
  const staging = mkdtempSync(join(tmpdir(), 'tolsey-capture-'));
  try {
    for (const [name, text] of [...files, ...kept.present]) writeFileSync(join(staging, name), text);
    const check = privacyProblems(staging, roster);
    const problems = check.status === 'checked' ? check.problems : [{ kind: 'absent', file: '', where: '' }];
    if (problems.length > 0) throw refusal(problems);
    mkdirSync(outDir, { recursive: true });
    const partial = mkdtempSync(join(outDir, '.capture-partial-'));
    try {
      for (const [name, text] of files) {
        writeFileSync(join(partial, name), text);
        renameSync(join(partial, name), join(outDir, name));
      }
    } finally {
      rmSync(partial, { recursive: true, force: true });
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function runCapture(options: CaptureOptions): Promise<void> {
  const { baseUrl, now, sleep, gapMs, outDir, profile } = options;
  const startedAt = now();
  assertInService(startedAt, startedAt + gapMs * (CAPTURE_STEPS.length - 1), profile);
  const recorder = recordingFetch(options.fetch);
  const session = createWallSession({ baseUrl, profile, fetch: recorder.fetch, mintBody: { label: 'capture' } });
  await session.start();
  const opened = session.getState();
  if (opened.phase !== 'ready') throw new Error(`the capture could not start: ${opened.startError ?? opened.stopMessage ?? opened.phase}`);

  const steps: CapturedStep[] = [];
  for (const [index, step] of CAPTURE_STEPS.entries()) {
    if (index > 0) await sleep(gapMs);
    await session.say(step.words);
    steps.push(stepOf(index + 1, step.words, step.outcomes, session.getState(), recorder.exchanges));
  }
  // The check before the first request counts only the gaps; this one holds the run to the moment
  // its last answer arrived, network time included.
  assertInService(startedAt, now(), profile);
  const capture = {
    where: 'deployed',
    canonicalHost: baseUrl.hostname,
    startedAt: new Date(startedAt).toISOString(),
    steps,
    exchanges: recorder.exchanges.map(compacted),
  };
  writeChecked(capture, outDir, profile.roster);
}
