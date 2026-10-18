import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { FetchLike } from './target';

export interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

export function walkInArguments(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    check_point: 'walk_in',
    value: 38,
    measured: 'air',
    words: 'the walk-in reads 38',
    initials: 'AB',
    screen_id: 'test-wall',
    request_id: crypto.randomUUID(),
    ...overrides,
  };
}

// One reference client per call, closed afterwards, as a host would do per utterance.
async function callTool(fetchFn: FetchLike, url: URL, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(url, { fetch: fetchFn }));
  try {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  } finally {
    await client.close();
  }
}

export function callLogReading(
  fetchFn: FetchLike,
  url: URL,
  args: Record<string, unknown> = walkInArguments(),
): Promise<ToolResult> {
  return callTool(fetchFn, url, 'log_reading', args);
}

export function callDueNow(fetchFn: FetchLike, url: URL): Promise<ToolResult> {
  return callTool(fetchFn, url, 'due_now', {});
}
