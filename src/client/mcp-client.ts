import { messagesIn, parseJson } from './messages';

export const PROTOCOL_VERSION = '2025-11-25';

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface MintedKitchen {
  id: string;
  mcpPath: string;
  expiresAt: string;
  closesAt: string;
}

export interface ToolCallResult {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface McpSession {
  readonly protocolVersion: string;
  listTools(): Promise<{ name: string }[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolCallResult>;
}

export type McpClientErrorKind = 'http' | 'protocol' | 'network' | 'timeout';

export const CALL_TIMEOUT_MS = 10_000;

export interface ClientOptions {
  timeoutMs?: number;
}

export class McpClientError extends Error {
  readonly kind: McpClientErrorKind;
  readonly status?: number;
  readonly code?: string | number;

  constructor(kind: McpClientErrorKind, message: string, details: { status?: number; code?: string | number } = {}) {
    super(message);
    this.name = 'McpClientError';
    this.kind = kind;
    this.status = details.status;
    this.code = details.code;
  }
}

const CLIENT_INFO = { name: 'tolsey-wall', version: '0.1.0' };
const JSON_AND_STREAM = 'application/json, text/event-stream';
const CREATED = 201;
const ACCEPTED = 202;
const BODY_PREVIEW_CHARS = 200;

// Called through an arrow so a browser never calls fetch with a detached receiver, which throws
// "Illegal invocation".
const globalFetch: FetchLike = (url, init) => fetch(url, init);

function preview(status: number, bodyText: string): string {
  return `status ${status}, body ${JSON.stringify(bodyText.slice(0, BODY_PREVIEW_CHARS))}`;
}

async function send(fetchFn: FetchLike, url: URL, init: RequestInit): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new McpClientError('network', `the request to ${url.pathname} never reached the server: ${reason}`);
  }
}

function isMinted(value: unknown): value is MintedKitchen {
  if (!value || typeof value !== 'object') return false;
  const { id, mcpPath } = value as Record<string, unknown>;
  // A path on the same origin only, so a reply can never point the wall at another host.
  return typeof id === 'string' && typeof mcpPath === 'string' && mcpPath.startsWith('/') && !mcpPath.startsWith('//');
}

export async function mintKitchen(
  baseUrl: URL,
  fetchFn: FetchLike = globalFetch,
  body: Record<string, string> = {},
  _options: ClientOptions = {},
): Promise<MintedKitchen> {
  // Never an empty body: the Worker answers an untyped empty POST with 415.
  const response = await send(fetchFn, new URL('/api/kitchens', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const bodyText = await response.text();
  const parsed = parseJson(bodyText);
  if (response.status !== CREATED) {
    const error = (parsed as { error?: unknown } | undefined)?.error;
    const code = typeof error === 'string' ? error : undefined;
    throw new McpClientError('http', `minting a kitchen failed: ${preview(response.status, bodyText)}`, {
      status: response.status,
      code,
    });
  }
  if (!isMinted(parsed)) {
    throw new McpClientError('protocol', `minting a kitchen answered no kitchen: ${preview(response.status, bodyText)}`, {
      status: response.status,
    });
  }
  return parsed;
}

interface Exchange {
  status: number;
  contentType: string | null;
  bodyText: string;
}

function connection(endpoint: URL, fetchFn: FetchLike) {
  let nextId = 1;
  let negotiated = false;
  let sessionId: string | null = null;

  function headers(): Record<string, string> {
    const sent: Record<string, string> = { 'content-type': 'application/json', accept: JSON_AND_STREAM };
    if (negotiated) sent['mcp-protocol-version'] = PROTOCOL_VERSION;
    if (sessionId !== null) sent['mcp-session-id'] = sessionId;
    return sent;
  }

  async function post(message: Record<string, unknown>, signal?: AbortSignal): Promise<Exchange> {
    const response = await send(fetchFn, endpoint, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ jsonrpc: '2.0', ...message }),
      signal,
    });
    sessionId = response.headers.get('mcp-session-id') ?? sessionId;
    return { status: response.status, contentType: response.headers.get('content-type'), bodyText: await response.text() };
  }

  async function request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const id = nextId;
    nextId += 1;
    const answer = await post({ id, method, params }, signal);
    const reply = messagesIn(answer.contentType, answer.bodyText).find((message) => message.id === id);
    if (!reply) {
      throw new McpClientError('protocol', `${method} got no answer with id ${id}: ${preview(answer.status, answer.bodyText)}`, {
        status: answer.status,
      });
    }
    if (reply.error) {
      throw new McpClientError('protocol', `${method} was refused: ${reply.error.code} ${reply.error.message}`, {
        status: answer.status,
        code: reply.error.code,
      });
    }
    return reply.result;
  }

  async function notify(method: string): Promise<void> {
    const answer = await post({ method });
    if (answer.status !== ACCEPTED) {
      throw new McpClientError('protocol', `${method} expected 202, got ${preview(answer.status, answer.bodyText)}`, {
        status: answer.status,
      });
    }
  }

  return {
    request,
    notify,
    markNegotiated: () => {
      negotiated = true;
    },
  };
}

function toolNamesIn(result: unknown): { name: string }[] {
  const tools = (result as { tools?: unknown } | undefined)?.tools;
  if (!Array.isArray(tools)) throw new McpClientError('protocol', 'tools/list answered without a tools list');
  return tools.filter((tool): tool is { name: string } => typeof tool?.name === 'string').map(({ name }) => ({ name }));
}

function toolResultIn(name: string, result: unknown): ToolCallResult {
  if (!Array.isArray((result as { content?: unknown } | undefined)?.content)) {
    throw new McpClientError('protocol', `tools/call ${name} answered without content`);
  }
  return result as ToolCallResult;
}

export async function openMcpSession(endpoint: URL, fetchFn: FetchLike = globalFetch, _options: ClientOptions = {}): Promise<McpSession> {
  const link = connection(endpoint, fetchFn);
  const initialized = await link.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  });
  const offered = (initialized as { protocolVersion?: unknown } | undefined)?.protocolVersion;
  if (offered !== PROTOCOL_VERSION) {
    throw new McpClientError('protocol', `the server offered protocol ${String(offered)}, and the wall speaks only ${PROTOCOL_VERSION}`);
  }
  link.markNegotiated();
  await link.notify('notifications/initialized');
  return {
    protocolVersion: PROTOCOL_VERSION,
    listTools: async () => toolNamesIn(await link.request('tools/list', {})),
    callTool: async (name, args, signal) => toolResultIn(name, await link.request('tools/call', { name, arguments: args }, signal)),
  };
}
