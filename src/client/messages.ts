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

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function asMessages(parsed: unknown): JsonRpcMessage[] {
  if (Array.isArray(parsed)) return parsed as JsonRpcMessage[];
  return parsed && typeof parsed === 'object' ? [parsed as JsonRpcMessage] : [];
}

// Every data line of an event stream is read, so a response is matched by its id rather than by
// being the first message on the stream.
export function messagesIn(contentType: string | null, bodyText: string): JsonRpcMessage[] {
  if (contentType?.includes('text/event-stream')) {
    return bodyText
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .flatMap((line) => asMessages(parseJson(line.slice('data:'.length))));
  }
  return bodyText ? asMessages(parseJson(bodyText)) : [];
}
