import { describe, expect, it } from 'vitest';
import { openStream } from '../api';
import { createSseState, parseSse, type SseMessage } from './sse';

function parseAll(chunks: string[]): SseMessage[] {
  const state = createSseState();
  return chunks.flatMap((c) => parseSse(c, state));
}

describe('parseSse', () => {
  it('parses a simple message', () => {
    expect(parseAll(['data: hello\n\n'])).toEqual([
      { event: 'message', data: 'hello', id: undefined },
    ]);
  });

  it('handles frames split mid-line, mid-field-name and mid-frame', () => {
    const whole = 'event: tick\ndata: {"a":1}\n\ndata: two\n\n';
    for (let i = 1; i < whole.length; i++) {
      expect(parseAll([whole.slice(0, i), whole.slice(i)])).toEqual([
        { event: 'tick', data: '{"a":1}', id: undefined },
        { event: 'message', data: 'two', id: undefined },
      ]);
    }
    expect(parseAll(['da', 'ta: x\n', '\n'])).toEqual([
      { event: 'message', data: 'x', id: undefined },
    ]);
  });

  it('does not emit a message until the blank line arrives', () => {
    const state = createSseState();
    expect(parseSse('data: a\n', state)).toEqual([]);
    expect(parseSse('\n', state)).toHaveLength(1);
  });

  it('joins multi-line data with newlines', () => {
    expect(parseAll(['data: a\ndata: b\ndata:\ndata: c\n\n'])[0]?.data).toBe('a\nb\n\nc');
  });

  it('ignores comments', () => {
    expect(parseAll([': hb\n\n', ': hb\ndata: x\n\n'])).toEqual([
      { event: 'message', data: 'x', id: undefined },
    ]);
  });

  it('strips only one leading space and handles missing colon', () => {
    expect(parseAll(['data:  two\n\n'])[0]?.data).toBe(' two');
    expect(parseAll(['data:nospace\n\n'])[0]?.data).toBe('nospace');
    expect(parseAll(['data\n\n'])).toEqual([{ event: 'message', data: '', id: undefined }]);
  });

  it('tracks ids and persists them across messages', () => {
    const msgs = parseAll(['id: 1\ndata: a\n\n', 'data: b\n\n', 'id: 3\ndata: c\n\n']);
    expect(msgs.map((m) => m.id)).toEqual(['1', '1', '3']);
  });

  it('ignores ids containing NUL and unknown fields', () => {
    const msgs = parseAll(['id: 1\ndata: a\n\n', 'id: b\0d\nretry: 5\nfoo: bar\ndata: b\n\n']);
    expect(msgs.map((m) => m.id)).toEqual(['1', '1']);
  });

  it('resets the event type after each frame, even without data', () => {
    expect(parseAll(['event: x\n\n', 'data: a\n\n'])).toEqual([
      { event: 'message', data: 'a', id: undefined },
    ]);
    expect(parseAll(['event: x\ndata: a\n\ndata: b\n\n']).map((m) => m.event)).toEqual([
      'x',
      'message',
    ]);
  });

  it('handles CRLF, CR and LF line endings', () => {
    const expected = [{ event: 'message', data: 'a\nb', id: undefined }];
    expect(parseAll(['data: a\r\ndata: b\r\n\r\n'])).toEqual(expected);
    expect(parseAll(['data: a\rdata: b\r\r'])).toEqual(expected);
  });

  it('handles CRLF split between chunks', () => {
    expect(parseAll(['data: a\r', '\ndata: b\r\n\r', '\n'])).toEqual([
      { event: 'message', data: 'a\nb', id: undefined },
    ]);
    // CR then a non-LF chunk: the CR was a complete line ending on its own.
    expect(parseAll(['data: a\r', '\rdata: b\n\n'])).toEqual([
      { event: 'message', data: 'a', id: undefined },
      { event: 'message', data: 'b', id: undefined },
    ]);
  });
});

describe('openStream', () => {
  const enc = new TextEncoder();

  function streamOf(chunks: string[], keepOpen?: AbortSignal): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        if (keepOpen) keepOpen.addEventListener('abort', () => controller.error(new Error('x')));
        else controller.close();
      },
    });
    return new Response(body, { status: 200 });
  }

  it('reconnects with Last-Event-ID and exponential backoff, then stops on abort', async () => {
    const ctrl = new AbortController();
    const seen: Array<string | null> = [];
    const sleeps: number[] = [];
    const responses = [
      () => streamOf(['id: 5\ndata: a\n\n']),
      () => new Response('nope', { status: 503 }),
      () => Promise.reject(new Error('offline')),
      () => streamOf(['data: b\n\n']),
    ];
    const fakeFetch = (async (_p: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('Last-Event-ID'));
      const next = responses.shift();
      if (!next) {
        ctrl.abort();
        throw new Error('aborted');
      }
      return next();
    }) as unknown as typeof fetch;
    const msgs: SseMessage[] = [];
    await openStream('/s', (m) => msgs.push(m), ctrl.signal, {
      fetch: fakeFetch,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(msgs.map((m) => m.data)).toEqual(['a', 'b']);
    expect(msgs[1]?.id).toBe('5');
    expect(seen).toEqual([null, '5', '5', '5', '5']);
    // 1s after the first drop (reset by success), then 2s, 4s, then reset to 1s.
    expect(sleeps).toEqual([1000, 2000, 4000, 1000]);
  });

  it('caps backoff at 10s', async () => {
    const ctrl = new AbortController();
    const sleeps: number[] = [];
    let calls = 0;
    const fakeFetch = (async () => {
      if (++calls > 6) ctrl.abort();
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await openStream('/s', () => {}, ctrl.signal, {
      fetch: fakeFetch,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 10000, 10000]);
  });

  it('resolves when aborted mid-stream and while waiting to reconnect', async () => {
    const ctrl = new AbortController();
    const fakeFetch = (async () =>
      streamOf(['data: a\n\n'], ctrl.signal)) as unknown as typeof fetch;
    const msgs: SseMessage[] = [];
    const p = openStream('/s', (m) => (msgs.push(m), ctrl.abort()), ctrl.signal, {
      fetch: fakeFetch,
    });
    await p;
    expect(msgs).toHaveLength(1);

    // Real (default) sleep: abort during the backoff wait resolves promptly.
    const ctrl2 = new AbortController();
    const failing = (async () => {
      setTimeout(() => ctrl2.abort(), 5);
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await openStream('/s', () => {}, ctrl2.signal, { fetch: failing });
  });
});
