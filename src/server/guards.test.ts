import { describe, expect, it } from 'vitest';
import { parseJsonBody, readCappedBody } from './guards';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('readCappedBody', () => {
  // A body larger than one network read arrives in pieces, which must land side by side in order.
  it('assembles a body sent in several chunks in the order they came', async () => {
    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      body: streamOf(['{"jsonrpc":', '"2.0",', '"id":1}']),
      duplex: 'half',
    });

    const bytes = await readCappedBody(request);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe('{"jsonrpc":"2.0","id":1}');
  });
});

describe('parseJsonBody', () => {
  it('names a body that is not JSON as invalid', () => {
    expect(parseJsonBody(new TextEncoder().encode('{"label":'))).toEqual({ kind: 'invalid' });
  });
});
