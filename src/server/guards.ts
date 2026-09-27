import { isLegacyRequest } from '@modelcontextprotocol/server';

export const MAX_BODY_BYTES = 65536;

export type ParsedBody = { kind: 'empty' } | { kind: 'json'; value: unknown } | { kind: 'invalid' };
export type AllowlistParse = { ok: true; hostnames: string[] } | { ok: false; reason: string };

const IPV6_LITERAL = /^\[[0-9a-f:.]+\]$/;
const SUPPORTED_VERSIONS = 'Unsupported protocol version. Supported: 2025-11-25, 2025-06-18, 2025-03-26';

// The SDK compares a request's hostname against the list exactly, so an entry with a scheme, a path
// or a port can never match and would silently lock every visitor out; a bad list is refused loudly.
function entryProblem(entry: string): string | null {
  if (entry === '') return 'is empty: remove the stray comma';
  if (entry.includes('://')) return 'is a URL: give the bare hostname';
  if (entry.includes('/')) return 'holds a path: give the bare hostname';
  if (/\s/.test(entry)) return 'holds whitespace';
  if (entry.startsWith('[')) return IPV6_LITERAL.test(entry) ? null : 'is not a bracketed IPv6 literal';
  if (entry.includes(':')) return 'holds a port: give the hostname without it';
  return null;
}

export function parseAllowlist(raw: string | undefined): AllowlistParse {
  if (raw === undefined || raw.trim() === '') {
    return { ok: false, reason: 'ALLOWED_HOSTNAMES is not set: list the hostnames this Worker answers, comma separated' };
  }
  const hostnames = raw.split(',').map((entry) => entry.trim().toLowerCase());
  for (const entry of hostnames) {
    const problem = entryProblem(entry);
    if (problem) return { ok: false, reason: `ALLOWED_HOSTNAMES entry "${entry}" ${problem}` };
  }
  return { ok: true, hostnames };
}

// The SDK sets no body limit, and a Content-Length header can lie, so the stream itself is counted
// and cancelled the moment it passes the cap.
export async function readCappedBody(request: Request, maxBytes = MAX_BODY_BYTES): Promise<Uint8Array | 'too_large'> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return 'too_large';
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// TextDecoder drops a leading UTF-8 byte order mark, which JSON.parse would otherwise refuse.
export function parseJsonBody(bytes: Uint8Array): ParsedBody {
  if (bytes.byteLength === 0) return { kind: 'empty' };
  try {
    return { kind: 'json', value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { kind: 'invalid' };
  }
}

export function jsonError(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
}

export function jsonRpcError(status: number, code: number, message: string): Response {
  return jsonError(status, { jsonrpc: '2.0', id: null, error: { code, message } });
}

// The modern era also serves long-lived subscription streams, surface a public unauthenticated
// Worker gains nothing from. A clean JSON-RPC error is what lets an auto-negotiating client fall back
// to 2025-11-25. The request must be one whose body is still unread: with no parsed body the SDK
// classifies from a clone, and cloning a used body throws.
export async function refuseModernEra(request: Request, parsedBody: unknown): Promise<Response | undefined> {
  if (await isLegacyRequest(request, parsedBody)) return undefined;
  return jsonRpcError(400, -32000, SUPPORTED_VERSIONS);
}

// Never the message: an error raised while serving a call can carry the cook's words and initials.
export function logFault(prefix: string, error: unknown): void {
  const name = error instanceof Error ? error.name : typeof error;
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
  console.error(prefix, { name, code });
}
