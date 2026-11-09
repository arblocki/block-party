import { describe, expect, it } from 'vitest';
import { StreamParser } from './stream.js';

describe('StreamParser', () => {
  it('decodes a multibyte UTF-8 character split across Buffer chunks', () => {
    const bytes = Buffer.from(`${JSON.stringify({ type: 'x', text: 'héllo 🎉' })}\n`, 'utf8');
    const emoji = bytes.indexOf(Buffer.from('🎉', 'utf8'));
    const p = new StreamParser();
    const events = [
      ...p.push(bytes.subarray(0, emoji + 2)),
      ...p.push(bytes.subarray(emoji + 2)),
      ...p.flush(),
    ];
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).toContain('héllo 🎉');
    expect(JSON.stringify(events[0])).not.toContain('�');
  });

  it('flushes a trailing partial character and line at end of stream', () => {
    const bytes = Buffer.from(JSON.stringify({ type: 'x', text: 'é' }), 'utf8');
    const p = new StreamParser();
    const events = [
      ...p.push(bytes.subarray(0, bytes.length - 3)),
      ...p.push(bytes.subarray(bytes.length - 3)),
      ...p.flush(),
    ];
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).toContain('é');
  });
});
