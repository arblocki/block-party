#!/usr/bin/env node
// Per-run Claude Code hook: append { ts, hook payload, selected env } as one JSON line to the
// events file given as argv[2]. Never fails the hook (always exit 0).
import fs from 'node:fs';

const file = process.argv[2];
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { unparsed: raw };
  }
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    payload,
    env: { HERDR_PANE_ID: process.env.HERDR_PANE_ID ?? null },
  });
  try {
    if (file) fs.appendFileSync(file, line + '\n');
  } catch {
    // swallow: a hook must never break the session
  }
  process.exit(0);
});
