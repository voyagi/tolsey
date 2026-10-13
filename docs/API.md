# API

Tolsey's Worker (`src/server/worker.ts`) answers two families of routes: an MCP endpoint over
Streamable HTTP, and a small JSON API that creates scratch kitchens. Every other path is served by
the static assets. This page documents what the code answers today. The storage model behind it is
in [ADR 0002: Storage](adr/0002-storage.md), and the settings it reads are in
[CONFIGURATION.md](CONFIGURATION.md).

Base URL: `https://<deployed hostname>`. The local dev server (`npm run dev`) answers on `localhost`
and `127.0.0.1`, a list `vite.config.ts` sets for `vite serve` only. Never add a local name to
`ALLOWED_HOSTNAMES` in `wrangler.jsonc`: the deployed list holds the deployed hostname alone, and the
deploy preflight refuses any other name beside it.

## Routes

`wrangler.jsonc` sends `/mcp`, `/mcp/*` and `/api/*` to the Worker first (`run_worker_first`), and
`familyOf` in `src/server/worker.ts` mirrors that list. Anything else goes to the `ASSETS` binding
with single-page-application fallback.

| Method | Path | Description | Auth required |
|--------|------|-------------|---------------|
| POST | `/mcp` (or `/mcp/`) | MCP endpoint for the seeded demo kitchen. Reads work; every `log_reading` call is refused with `demo_read_only` | No |
| POST | `/mcp/k/<id>` | MCP endpoint for one scratch kitchen, where `<id>` is exactly 32 lowercase hex characters | No (the id is the only key) |
| GET, DELETE | `/mcp`, `/mcp/k/<id>` | Refused with 405 and a JSON-RPC `-32000` error (stateless server, no standing stream) | No |
| POST | `/api/kitchens` | Mints a scratch kitchen and returns its MCP path | No |
| any | any other `/api/*` path | JSON 404 `{"error":"not_found"}` | No |
| GET | anything else | Static client pages from the asset build | No |

## Authentication

There is no authentication: no API keys, tokens or sessions. Access is shaped by three things
instead:

- **Host and Origin checks** on every `/mcp` and `/api/*` request (below).
- **The path chooses the kitchen.** `resolveScope` (`src/server/scope.ts`) maps `/mcp` to the
  read-only demo kitchen and `/mcp/k/<32 hex>` to a scratch kitchen found in storage. No tool argument
  can choose where a write lands. A kitchen id is 128 random bits from `crypto.getRandomValues`
  (`mintKitchen` in `src/server/kitchens.ts`), so the MCP path is effectively a bearer capability:
  share it only with the host that should write to that kitchen.
- **An unknown kitchen and a malformed path answer the same.** A path under `/mcp/` that does not
  match the pattern, or matches it but names no scratch kitchen, gets the same JSON-RPC 404
  (`{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Not found"}}`), so the shape of a path
  tells nothing about which ids exist.

### Host and Origin checks

`createMcpHandler` from `@modelcontextprotocol/server` does no Host or Origin validation of its own,
so the Worker runs both before any route logic (`hostOrOriginRejection` in `src/server/worker.ts`):

1. `parseAllowlist` (`src/server/allowlist.ts`) reads `ALLOWED_HOSTNAMES`, a comma-separated list of
   bare hostnames, lowercased. If the variable is missing, empty, or holds an entry no Host header can
   equal (a scheme, a path, a port, a wildcard, a trailing dot, whitespace, a non-ASCII name, an IPv6
   literal without brackets), every `/mcp` and `/api/*` request is answered:

   ```json
   { "error": "allowlist_unconfigured", "message": "ALLOWED_HOSTNAMES entry \"localhost:8787\" holds a port: give the hostname without it" }
   ```

   with status 503.
2. The SDK's `hostHeaderValidationResponse` refuses a request whose Host is missing or not on the
   list with 403 and a JSON-RPC error such as `"Invalid Host: attacker.example"`. Matching is exact,
   so a suffix such as `<deployed hostname>.attacker.example` is refused.
3. The SDK's `originValidationResponse` refuses an `Origin` header whose host is not on the list with
   403, and refuses any value that does not parse as a URL, `Origin: null` included. A request with no
   `Origin` header, or an empty one, passes this step: only browsers send the header, and a server-side
   MCP host sends none.

`/api/kitchens` sits behind the same checks as `/mcp`.

## Request limits common to both families

- **Body cap: 64 KiB.** `readCappedBody` (`src/server/guards.ts`) counts the stream itself and cancels
  it one byte past 65536. Over the cap, `/mcp` answers 413 with
  `{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Request body over 64 KiB"}}` and
  `/api/kitchens` answers 413 with `{"error":"body_too_large"}`.
- **JSON only.** A UTF-8 byte order mark and a `charset` parameter are accepted.
- **No caching.** Every answer the Worker builds itself is sent with `cache-control: no-store`: the
  503, 413, 404 and 500 errors, the 400 `-32600` for valid JSON that is no JSON-RPC message, the
  newer-era refusal, every `/api/kitchens` error and every minted kitchen. The answers the MCP SDK
  builds carry no `cache-control` header: the 403 Host and Origin refusals, the 400 `-32700` parse
  error, the 400 for an unknown `MCP-Protocol-Version`, and the 405, 406 and 415 transport errors.
- **Faults.** A fault outside the MCP handler (body read, scope lookup, mint) answers `/api/*` with
  500 `{"error":"server_error"}` and `/mcp` with 500 and JSON-RPC code `-32603` (`Internal error`).
  Only the error's name and code are logged (`logFault`), never its message.

## POST /api/kitchens

Mints a scratch kitchen: a private, writable copy of the demo kitchen's profile (time zone
`America/Chicago`, business day starting `04:00`, roster, check points and rules) that lives for a
limited time. Handled by `handleKitchensRoute` and `mintKitchen` in `src/server/kitchens.ts`.

### Request

The body is optional. When sent, it must be a JSON object whose only allowed key is `label`, taken
from the closed list `capture` or `conformance`:

```json
{ "label": "conformance" }
```

An empty body mints an unlabelled kitchen, whatever its content type. A non-empty body must be sent
as `Content-Type: application/json`.

```bash
curl -X POST "https://<deployed hostname>/api/kitchens" \
  -H "content-type: application/json" \
  -d '{}'
```

### Response

201 Created:

```json
{
  "id": "3f9c0a6e1b2d4c5e8f7a6b5c4d3e2f10",
  "mcpPath": "/mcp/k/3f9c0a6e1b2d4c5e8f7a6b5c4d3e2f10",
  "expiresAt": "2026-10-11T23:00:00.000Z",
  "closesAt": "2026-10-11T21:43:00.000Z"
}
```

| Field | Meaning |
|-------|---------|
| `id` | 32 lowercase hex characters |
| `mcpPath` | The MCP endpoint for this kitchen, `/mcp/k/<id>` |
| `closesAt` | End of the write window: creation plus `writeWindowHours` (22.75) less `retryWindowSeconds` (120). After it, `log_reading` is refused with `kitchen_closed` |
| `expiresAt` | Latest deletion time while the hourly sweep runs: creation plus `retentionAgeHours` (22.75) plus one hour plus a 15 minute late-start allowance |

The figures come from `data/store/limits.json` and the constants in `src/server/kitchens.ts`.

### Errors

Checks run in this order, so the first one that fails decides the answer:

| Status | Body | Cause |
|--------|------|-------|
| 503 | `{"error":"allowlist_unconfigured","message":"..."}` | `ALLOWED_HOSTNAMES` missing or malformed |
| 403 | The SDK's JSON-RPC error, code `-32000`, such as `"Invalid Host: attacker.example"` | Host or Origin not on the allowlist |
| 413 | `{"error":"body_too_large"}` | Body over 64 KiB |
| 404 | `{"error":"not_found"}` | Any `/api/*` path other than `/api/kitchens` |
| 415 | `{"error":"unsupported_media_type"}` | Non-empty body without a JSON content type |
| 405 | `{"error":"method_not_allowed"}` plus `allow: POST` | Any method other than POST |
| 400 | `{"error":"invalid_body"}` | Body is not JSON, not an object, or holds a key other than `label` |
| 400 | `{"error":"invalid_label"}` | `label` is not `capture` or `conformance` |
| 503 | `{"error":"demo_full","message":"The demo is full for today. Try the replay."}` | The day's row budget is spent |
| 500 | `{"error":"server_error"}` | A fault while reading the body or minting |

Only a POST has its body read, so the 413 and 415 checks apply to POST alone. Any other method skips
them and gets 404 on another `/api/*` path, or 405 on `/api/kitchens`, whatever body it carries.

## MCP endpoint

### Transport

- Streamable HTTP, served by `createMcpHandler` from `@modelcontextprotocol/server`, in the default
  stateless mode: a fresh `McpServer` is built for every request (`createServer` in
  `src/server/mcp.ts`), no session id is issued, and all state lives in D1.
- Protocol: initialize at `2025-11-25`. The conformance suite (`src/server/conformance.test.ts`) also
  negotiates `2025-06-18` and `2025-03-26`. A lone POST of `tools/list` with no prior `initialize` and
  no `MCP-Protocol-Version` header is answered too.
- Requests the SDK classifies as the newer protocol era are refused by `refuseModernEra`
  (`src/server/guards.ts`) with 400 and JSON-RPC code `-32000`, message
  `Unsupported protocol version. Supported: ...` (the SDK's own list), so an auto-negotiating client
  falls back to `2025-11-25`. An unknown `MCP-Protocol-Version` such as `1999-01-01` gets the same
  400 and `-32000`.
- POST with `Content-Type: application/json` and `Accept: application/json, text/event-stream`.

Server info reported on initialize: `{"name":"tolsey","version":"0.1.0"}`. Capabilities:
`tools.listChanged: false` and `resources.listChanged: false`. `resources/list` returns an empty list.

### Transport errors

| Status | JSON-RPC code | Cause |
|--------|---------------|-------|
| 202 (no body) | | A notification such as `notifications/initialized` |
| 400 | `-32700` | Empty body or invalid JSON |
| 400 | `-32600` | Valid JSON that is no JSON-RPC message (`{}`, `[]`, `null`, a number) |
| 400 | `-32000` | Unsupported protocol version or modern-era request |
| 403 | `-32000` | Host or Origin not on the allowlist (the message names the refused value) |
| 404 | `-32000` | Unknown kitchen or malformed kitchen path |
| 405 | `-32000` | GET or DELETE |
| 406 | `-32000` | `Accept` lacks `text/event-stream` |
| 413 | `-32000` | Body over 64 KiB |
| 415 | `-32000` | Non-JSON content type |
| 500 | `-32603` | Fault outside the MCP handler |
| 503 | | `ALLOWED_HOSTNAMES` missing or malformed (body is the `allowlist_unconfigured` object) |

### Tools

One tool is registered today: `log_reading`.

`src/contract/tools.ts` also fixes the names, descriptions and annotations of five planned tools that
are **not registered yet** and do not appear in `tools/list`: `record_corrective_action`,
`close_corrective_action`, `due_now`, `shift_handover` and `day_sheet`. The same file fixes four MCP
Apps card resource URIs (`ui://tolsey/reading.html`, `ui://tolsey/due-now.html`,
`ui://tolsey/open-action.html`, `ui://tolsey/handover.html`); no resource is registered yet.

## Tool: log_reading

Logs a temperature reading a cook just took, in degrees Fahrenheit. The same tool carries a
correction ("wrong number") and the cook's answer to a question Tolsey asked. Annotations:
`readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: false`.

### Input schema

Defined by `LogReadingInputSchema` in `src/contract/log-reading.ts`:

| Field | Type | Required | Rules |
|-------|------|----------|-------|
| `screen_id` | string | Yes | 1 to 64 characters of letters, digits, `.`, `_`, `:` and `-`. The same id on every call from one screen or device |
| `request_id` | string | Yes | Same character rules. A new random id (such as a UUID) for every utterance; reuse it only to retry the identical call |
| `check_point` | enum | No | One of the demo profile's check points: `walk_in`, `reach_in_1`, `reach_in_2`, `soup_well`, `carving_station`, `receiving`, `freezer`, `cooling`, `reheat` |
| `value` | number | No | From -459.6 to 1000, at most one decimal place. Leave it out when the cook said no number |
| `measured` | enum | No | `air` or a food id: `chicken_soup`, `prime_rib`, `raw_chicken`, `catered_chili`, `milk`. When left out, the check point's default (if it has one) is used |
| `words` | string | No | The cook's words, unchanged, up to 200 characters |
| `initials` | string | No | Up to 8 characters. Every character that is not a letter is dropped. When the rest is plain A to Z it is upper-cased, so `a.b.` reads as `AB`; any other letters are kept as sent, and no roster entry matches them. Must be on the kitchen's roster |
| `pending_prompt_id` | string | No | Up to 64 characters. The `prompt.id` of the question Tolsey just asked, sent with the cook's answer |

The check point and food lists come from `data/kitchens/demo.json`. A call that fails the schema is
answered with `isError: true` and a text naming the field, and stores nothing.

Example call:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "log_reading",
    "arguments": {
      "check_point": "walk_in",
      "value": 38,
      "measured": "air",
      "words": "the walk-in reads 38",
      "initials": "AB",
      "screen_id": "kitchen-wall-1",
      "request_id": "6f1c2a4e-9b7d-4c1a-8e2f-3d5b7a9c1e0f"
    }
  }
}
```

### Result

Every accepted call returns a short sentence in `content[0].text` for the voice reply and a
`structuredContent` object matching `LogReadingOutputSchema`. The listed `outputSchema` is an object
that refuses additional properties.

```json
{
  "content": [{ "type": "text", "text": "Walk-in, 38, in range, AB" }],
  "structuredContent": {
    "contractVersion": 1,
    "outcome": "in_range",
    "lineId": "0b8e5d0c-7f62-4b0e-9a1d-2c3f4e5a6b7c",
    "recordCode": "261020-001",
    "checkPoint": { "id": "walk_in", "name": "Walk-in" },
    "value": 38,
    "unit": "F",
    "verdict": "in range",
    "rule": { "id": "unit_air_cold", "comparator": "at_most", "limit": 41, "unit": "F", "sourceKind": "house_rule" },
    "serverTime": "2026-10-21T04:30:00.000Z",
    "businessDay": "2026-10-20",
    "timeZone": "America/Chicago",
    "initials": "AB"
  }
}
```

| Field | Meaning |
|-------|---------|
| `contractVersion` | Always `1` |
| `outcome` | `in_range`, `out_of_range`, `not_covered`, `refused`, `held` or `nothing_to_fix` |
| `verdict` | The outcome in words: `in range`, `out of range`, `not covered yet`, `refused`, `held`, `nothing to fix` |
| `lineId` | Id of the stored record line |
| `recordCode` | `YYMMDD-NNN`: the business day and the line's number within that day, given to reading and refusal lines |
| `checkPoint` | `{id, name}` of the check point |
| `value`, `unit` | The reading and `F` |
| `rule` | The rule judged against: `id`, optional `section` (absent for a house rule), `comparator` (`at_most` or `at_least`), `limit`, `unit`, `sourceKind` (`food_code`, `other_law`, `house_rule`) |
| `serverTime` | ISO 8601 UTC instant of the call |
| `businessDay`, `timeZone` | The kitchen's business day (`YYYY-MM-DD`) and zone |
| `initials` | Who logged it, in the roster's form |
| `supersedesLineId` | Set when this line corrects an earlier one |
| `prompt` | `{kind, id}` of a question Tolsey is asking; send `id` back as `pending_prompt_id` with the answer |
| `fix` | `{id, deadline}`, defined in the schema and not set by any outcome today |

Which fields each outcome carries is enforced by `checkOutcomeFields`:

| Outcome | Meaning | Must carry | Never carries |
|---------|---------|------------|---------------|
| `in_range` | Judged and within its rule | line fields, `rule` | `prompt` |
| `out_of_range` | Judged and outside its rule | line fields, `rule` | `prompt` |
| `not_covered` | Logged unjudged (no single-reading rule, as at `cooling` and `reheat`) | line fields | `rule`, `prompt` |
| `refused` | No usable number; the check stays open | | `value`, `unit`, `rule`, `supersedesLineId` |
| `held` | A question is open; nothing is logged yet | `prompt` | `lineId`, `recordCode`, `rule`, `supersedesLineId` |
| `nothing_to_fix` | "Wrong number" with nothing correctable | | `lineId`, `recordCode`, `value`, `unit`, `rule`, `prompt`, `supersedesLineId` |

Line fields are `lineId`, `recordCode`, `checkPoint`, `value`, `unit` and `initials`. `refused` and
`held` are ordinary results (`isError` is not set), because they are stored in the record.

### Questions and answers

A `held` or `refused` result may carry `prompt.kind` (`PromptKind` in `src/domain/decision.ts`):

| `prompt.kind` | Asked when | Spoken text |
|---------------|------------|-------------|
| `number` | A check point was named with no number | `I need the number on the thermometer. What does the walk-in read?` |
| `which_check` | A number with no check point | `Which check reads 38?` |
| `who_is_logging` | A number and check point with no initials | `Who is logging?` |
| `digit_repeat` | The number passes its rule but its commonly misheard twin (fifteen and fifty) would fail, or the number sits outside the check point's coarse band | `Say it one digit at a time. What does the walk-in read?` |
| `number_after_wrong` | The cook said "wrong number" about a line | `What does the walk-in read?` |

A call naming neither a check point nor a number is refused with `I need a check and the number on
the thermometer.` and asks nothing. Send the answer with the prompt's id as `pending_prompt_id`. A
prompt expires after `promptExpirySeconds` (120 in `data/kitchens/demo.json`); an answer after expiry,
from another `screen_id`, or naming a different check point is handled as a new call. A third miss on a
digit-repeat chain, or a third "wrong number" about one line, ends with `Log it by hand.` and the
check stays open.

### Corrections

Words that say a correction (`wrong number`, `that's wrong`, `wrong reading` in the profile's
vocabulary) are read before anything else, and act on the newest event from the same `screen_id`. A
reading line within `correctionWindowSeconds` (120) gets a `wrong_number` marker and a
`number_after_wrong` question; the number given in answer logs a new line with `supersedesLineId`
set. A question still open is asked again (or, for `which_check` and `who_is_logging`, its held
number is refused). Stored lines are never edited. With nothing correctable the result is
`nothing_to_fix`.

### Retries and idempotency

`request_id` is the idempotency key per kitchen. The arguments other than `request_id` are hashed with
SHA-256 (`argsHash` in `src/server/mcp.ts`), and a repeat is classified by `classifyRepeat`
(`src/store/port.ts`):

- Same id, same arguments, within `retryWindowSeconds` (120): the first result is returned unchanged
  and nothing new is stored.
- Same id, same arguments, after the window: refused as `request_id_expired`.
- Same id, other arguments: refused as `request_id_reused`.

A call refused with `isError: true` stored nothing, so repeating it is a new attempt.

### Tool errors

Refusals are tool results with `isError: true`, a sentence in `content[0].text` and a machine code in
`_meta.error`:

```json
{
  "content": [{ "type": "text", "text": "This kitchen is full. Start a new kitchen to keep logging." }],
  "isError": true,
  "_meta": { "error": "kitchen_full" }
}
```

| `_meta.error` | Text | Cause |
|---------------|------|-------|
| `demo_read_only` | `This is the demo kitchen, and its record is read only. Start your own kitchen to log readings.` | Any `log_reading` at `/mcp`; no storage call is made |
| `initials_not_on_roster` | `Those initials are not on this kitchen's roster. Who is logging? Call again with the whole reading and their initials.` | Initials not on the roster; nothing is stored, so send the whole reading again |
| `kitchen_closed` | `This kitchen has closed. Start a new kitchen to keep logging.` | Past the kitchen's write window (`closesAt`) |
| `kitchen_full` | `This kitchen is full. Start a new kitchen to keep logging.` | The kitchen holds `kitchenLineCap` (200) stored events |
| `demo_full` | `The demo is full for today. Try the replay.` | The day's row budget is spent; the same code `POST /api/kitchens` gives |
| `request_id_reused` | `Tolsey could not log that: this request_id was already used for a different call. Call again with a new request_id.` | See retries |
| `request_id_expired` | `Tolsey already logged this call earlier, record <code>. Use a new request_id only for a new reading.` | See retries |
| `server_fault` | `Tolsey could not log that. Try again.` | Any fault inside the tool; the message is never echoed, because it can carry the cook's words and initials |

## Rate limits

There is no per-client rate limiter. Writes are bounded by storage budgets from
`data/store/limits.json`, all UTC-day or per-kitchen:

| Limit | Value | Effect |
|-------|-------|--------|
| `dailyRowCap` | 40000 D1 rows written per UTC date | Once spent, minting answers 503 `demo_full` and `log_reading` answers `demo_full` |
| `kitchenLineCap` | 200 stored events per kitchen | Further `log_reading` calls answer `kitchen_full` |
| `writeWindowHours` | 22.75 hours (less the 120 second retry window) | Further `log_reading` calls answer `kitchen_closed` |

Each mint reserves `kitchen_create` (5) rows. Each event reserves `event_first_of_day` (10) rows,
plus 2 more when it corrects a line, 1 when it answers a question and 1 when it points at another
line (a `wrong_number` marker, a receipt, or a line on a digit-repeat chain), so between 10 and 14
(`expectedRowsFor` in `src/store/port.ts`, figures from `data/store/rows-per-write.json`).

Retention spends the same daily total. Each sweep round, hourly or run by a mint, adds the rows it
deleted plus `budget_add` (2) after the delete, and is never refused (`expireKitchens` in
`src/server/retention.ts`). A day's deletions can therefore push the total past `dailyRowCap` and
leave fewer rows for mints and lines than the cap alone suggests.

## Local exploration

The MCP endpoint can be driven with any Streamable HTTP client, for example the
`@modelcontextprotocol/client` package used by `src/server/conformance.test.ts`:

```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const base = 'https://<deployed hostname>';
const minted = await fetch(new URL('/api/kitchens', base), { method: 'POST' });
const { mcpPath } = (await minted.json()) as { mcpPath: string };

const client = new Client({ name: 'example', version: '1.0.0' }, { capabilities: {} });
await client.connect(new StreamableHTTPClientTransport(new URL(mcpPath, base)));
const result = await client.callTool({
  name: 'log_reading',
  arguments: {
    check_point: 'walk_in',
    value: 38,
    words: 'the walk-in reads 38',
    initials: 'AB',
    screen_id: 'kitchen-wall-1',
    request_id: crypto.randomUUID(),
  },
});
await client.close();
```
