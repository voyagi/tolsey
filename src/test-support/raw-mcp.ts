type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface Endpoint {
  url: URL;
  fetch?: FetchLike;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  result?: unknown;
  error?: JsonRpcError;
}

export interface RawResponse {
  status: number;
  contentType: string | null;
  bodyText: string;
  messages: JsonRpcMessage[];
}

const JSON_AND_STREAM = 'application/json, text/event-stream';
const BODY_PREVIEW_CHARS = 200;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asMessages(parsed: unknown): JsonRpcMessage[] {
  if (Array.isArray(parsed)) return parsed as JsonRpcMessage[];
  return parsed && typeof parsed === 'object' ? [parsed as JsonRpcMessage] : [];
}

// Every data line of an event stream is read, so a response is matched by its id rather than by
// being the first message on the stream.
function messagesIn(contentType: string | null, bodyText: string): JsonRpcMessage[] {
  if (contentType?.includes('text/event-stream')) {
    return bodyText
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .flatMap((line) => asMessages(parseJson(line.slice('data:'.length))));
  }
  return bodyText ? asMessages(parseJson(bodyText)) : [];
}

export async function sendRaw(endpoint: Endpoint, init: RequestInit): Promise<RawResponse> {
  const response = await (endpoint.fetch ?? fetch)(endpoint.url, init);
  const bodyText = await response.text();
  const contentType = response.headers.get('content-type');
  return { status: response.status, contentType, bodyText, messages: messagesIn(contentType, bodyText) };
}

export async function postJsonRpc(
  endpoint: Endpoint,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return sendRaw(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: JSON_AND_STREAM, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function describeResponse(response: RawResponse): string {
  return `status ${response.status}, body ${JSON.stringify(response.bodyText.slice(0, BODY_PREVIEW_CHARS))}`;
}

function matchId(response: RawResponse, id: string | number | null): JsonRpcMessage {
  const message = response.messages.find((candidate) => candidate.id === id);
  if (!message) throw new Error(`no JSON-RPC message with id ${JSON.stringify(id)}: ${describeResponse(response)}`);
  return message;
}

export function byId(response: RawResponse, id: string | number): unknown {
  const message = matchId(response, id);
  if (message.error) {
    throw new Error(`JSON-RPC error for id ${id}: ${message.error.code} ${message.error.message}`);
  }
  return message.result;
}

// A parse error answers with id null, because the request's own id could not be read.
export function errorById(response: RawResponse, id: string | number | null): JsonRpcError {
  const message = matchId(response, id);
  if (!message.error) {
    throw new Error(`JSON-RPC message ${JSON.stringify(id)} carries no error: ${describeResponse(response)}`);
  }
  return message.error;
}
