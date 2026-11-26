/** One dispatched `text/event-stream` message. */
export interface SseMessage {
  event: string;
  data: string;
  /** Last event id seen so far on the stream (persists across messages). */
  id: string | undefined;
}

/** Parser state carried between chunks. Mutated by `parseSse`. */
export interface SseState {
  /** Unterminated tail of the text received so far. */
  buffer: string;
  /** A chunk ended with CR; swallow an LF that starts the next chunk. */
  skipLf: boolean;
  event: string;
  data: string[];
  lastId: string | undefined;
}

export function createSseState(lastId?: string): SseState {
  return { buffer: '', skipLf: false, event: '', data: [], lastId };
}

const LINE_END = /\r\n|\r|\n/;

function processLine(line: string, state: SseState, out: SseMessage[]): void {
  if (line === '') {
    if (state.data.length > 0) {
      out.push({
        event: state.event || 'message',
        data: state.data.join('\n'),
        id: state.lastId,
      });
    }
    state.event = '';
    state.data = [];
    return;
  }
  if (line.startsWith(':')) return;
  const colon = line.indexOf(':');
  const field = colon === -1 ? line : line.slice(0, colon);
  let value = colon === -1 ? '' : line.slice(colon + 1);
  if (value.startsWith(' ')) value = value.slice(1);
  if (field === 'data') state.data.push(value);
  else if (field === 'event') state.event = value;
  else if (field === 'id' && !value.includes('\0')) state.lastId = value;
}

/** Feeds a chunk of event-stream text; returns the messages it completed. */
export function parseSse(chunkText: string, state: SseState): SseMessage[] {
  let text = chunkText;
  if (state.skipLf && text.length > 0) {
    if (text.startsWith('\n')) text = text.slice(1);
    state.skipLf = false;
  }
  state.buffer += text;
  const out: SseMessage[] = [];
  for (;;) {
    const m = LINE_END.exec(state.buffer);
    if (!m) break;
    const line = state.buffer.slice(0, m.index);
    const end = m.index + m[0].length;
    state.buffer = state.buffer.slice(end);
    // A trailing lone CR may be the first half of a CRLF split across chunks.
    if (m[0] === '\r' && state.buffer === '') state.skipLf = true;
    processLine(line, state, out);
  }
  return out;
}
