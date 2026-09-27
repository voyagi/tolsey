export type ParsedBody = { kind: 'empty' } | { kind: 'json'; value: unknown } | { kind: 'invalid' };

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
