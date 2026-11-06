/**
 * Parser for `claude -p --output-format stream-json --verbose` (observed on Claude Code 2.1.319).
 *
 * Every line on stdout is one JSON object. Schemas are loose (extra fields are kept) because the
 * stream carries many fields we do not need and the CLI adds new ones between versions. Anything
 * that does not match a known shape is surfaced as `{ kind: 'unknown' }` instead of throwing, so a
 * CLI upgrade degrades the UI rather than crashing a run.
 */
import { z } from 'zod';

const usage = z.looseObject({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
});

const textBlock = z.looseObject({ type: z.literal('text'), text: z.string() });
const thinkingBlock = z.looseObject({ type: z.literal('thinking'), thinking: z.string() });
const toolUseBlock = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});
const toolResultBlock = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  // string, or an array of {type:'text'} blocks
  content: z.union([z.string(), z.array(z.unknown())]).optional(),
  is_error: z.boolean().optional(),
});
const contentBlock = z.union([textBlock, thinkingBlock, toolUseBlock, toolResultBlock]);

/** Shared by every event. `parent_tool_use_id` is non-null for events emitted inside a subagent. */
const base = {
  session_id: z.string(),
  uuid: z.string().optional(),
};

export const initEvent = z.looseObject({
  ...base,
  type: z.literal('system'),
  subtype: z.literal('init'),
  cwd: z.string(),
  model: z.string(),
  permissionMode: z.string(),
  tools: z.array(z.string()),
  agents: z.array(z.string()).optional(),
  claude_code_version: z.string().optional(),
});

export const hookEvent = z.looseObject({
  ...base,
  type: z.literal('system'),
  subtype: z.enum(['hook_started', 'hook_response']),
  hook_event: z.string(),
  hook_name: z.string(),
  hook_id: z.string(),
  outcome: z.string().optional(),
  exit_code: z.number().optional(),
});

export const taskEvent = z.looseObject({
  ...base,
  type: z.literal('system'),
  subtype: z.enum(['task_started', 'task_progress', 'task_updated', 'task_notification']),
  task_id: z.string(),
  tool_use_id: z.string().optional(),
  subagent_type: z.string().optional(),
  description: z.string().optional(),
  status: z.string().optional(),
  summary: z.string().optional(),
  usage: z
    .looseObject({
      total_tokens: z.number().optional(),
      tool_uses: z.number().optional(),
      duration_ms: z.number().optional(),
    })
    .optional(),
});

export const permissionDeniedEvent = z.looseObject({
  ...base,
  type: z.literal('system'),
  subtype: z.literal('permission_denied'),
  tool_name: z.string(),
  tool_use_id: z.string(),
  message: z.string(),
});

export const assistantEvent = z.looseObject({
  ...base,
  type: z.literal('assistant'),
  parent_tool_use_id: z.string().nullable().optional(),
  message: z.looseObject({
    id: z.string(),
    model: z.string(),
    content: z.array(contentBlock),
    stop_reason: z.string().nullable().optional(),
    usage: usage.optional(),
  }),
});

export const userEvent = z.looseObject({
  ...base,
  type: z.literal('user'),
  parent_tool_use_id: z.string().nullable().optional(),
  agent_id: z.string().optional(),
  message: z.looseObject({ role: z.literal('user'), content: z.array(contentBlock) }),
});

export const resultEvent = z.looseObject({
  ...base,
  type: z.literal('result'),
  subtype: z.string(), // 'success' | 'error_max_turns' | 'error_during_execution' | ...
  is_error: z.boolean(),
  result: z.string().optional(),
  stop_reason: z.string().nullable().optional(),
  terminal_reason: z.string().optional(),
  num_turns: z.number(),
  duration_ms: z.number(),
  duration_api_ms: z.number(),
  total_cost_usd: z.number(),
  usage,
  permission_denials: z.array(
    z.looseObject({ tool_name: z.string(), tool_use_id: z.string(), tool_input: z.unknown() }),
  ),
  subagent_stats: z.looseObject({ spawned: z.number(), completed: z.number() }).optional(),
});

export const rateLimitEvent = z.looseObject({
  type: z.literal('rate_limit_event'),
  rate_limit_info: z.looseObject({ status: z.string(), rateLimitType: z.string().optional() }),
});

export type InitEvent = z.infer<typeof initEvent>;
export type HookEvent = z.infer<typeof hookEvent>;
export type TaskEvent = z.infer<typeof taskEvent>;
export type PermissionDeniedEvent = z.infer<typeof permissionDeniedEvent>;
export type AssistantEvent = z.infer<typeof assistantEvent>;
export type UserEvent = z.infer<typeof userEvent>;
export type ResultEvent = z.infer<typeof resultEvent>;
export type RateLimitEvent = z.infer<typeof rateLimitEvent>;

export type StreamEvent =
  | { kind: 'init'; event: InitEvent }
  | { kind: 'hook'; event: HookEvent }
  | { kind: 'task'; event: TaskEvent }
  | { kind: 'permission_denied'; event: PermissionDeniedEvent }
  | { kind: 'assistant'; event: AssistantEvent }
  | { kind: 'user'; event: UserEvent }
  | { kind: 'result'; event: ResultEvent }
  | { kind: 'rate_limit'; event: RateLimitEvent }
  /** Known-noise system events (thinking_tokens, ...) and anything we could not validate. */
  | { kind: 'unknown'; raw: unknown; reason: string };

/** Classify one decoded JSON object. Never throws. */
export function parseEvent(raw: unknown): StreamEvent {
  const probe = z.looseObject({ type: z.string(), subtype: z.string().optional() }).safeParse(raw);
  if (!probe.success) return { kind: 'unknown', raw, reason: 'no type field' };
  const { type, subtype } = probe.data;
  const attempt = <T>(schema: z.ZodType<T>, wrap: (e: T) => StreamEvent): StreamEvent => {
    const r = schema.safeParse(raw);
    return r.success ? wrap(r.data) : { kind: 'unknown', raw, reason: z.prettifyError(r.error) };
  };
  switch (type) {
    case 'system':
      if (subtype === 'init') return attempt(initEvent, (event) => ({ kind: 'init', event }));
      if (subtype === 'hook_started' || subtype === 'hook_response')
        return attempt(hookEvent, (event) => ({ kind: 'hook', event }));
      if (subtype === 'permission_denied')
        return attempt(permissionDeniedEvent, (event) => ({ kind: 'permission_denied', event }));
      if (subtype?.startsWith('task_'))
        return attempt(taskEvent, (event) => ({ kind: 'task', event }));
      return { kind: 'unknown', raw, reason: `system/${subtype ?? '?'}` };
    case 'assistant':
      return attempt(assistantEvent, (event) => ({ kind: 'assistant', event }));
    case 'user':
      return attempt(userEvent, (event) => ({ kind: 'user', event }));
    case 'result':
      return attempt(resultEvent, (event) => ({ kind: 'result', event }));
    case 'rate_limit_event':
      return attempt(rateLimitEvent, (event) => ({ kind: 'rate_limit', event }));
    default:
      return { kind: 'unknown', raw, reason: `type ${type}` };
  }
}

/**
 * Incremental line splitter + parser. Feed raw stdout chunks; get typed events. Call `flush()` on
 * process close to handle a final line without trailing newline (e.g. after SIGTERM).
 */
export class StreamParser {
  private buf = '';

  push(chunk: string | Buffer): StreamEvent[] {
    this.buf += chunk.toString();
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? '';
    return lines.flatMap((l) => this.line(l));
  }

  flush(): StreamEvent[] {
    const rest = this.buf;
    this.buf = '';
    return this.line(rest);
  }

  private line(l: string): StreamEvent[] {
    if (l.trim() === '') return [];
    try {
      return [parseEvent(JSON.parse(l) as unknown)];
    } catch {
      return [{ kind: 'unknown', raw: l, reason: 'invalid JSON' }];
    }
  }
}

/** Text of a tool_result block (string or array-of-text-blocks form). */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (typeof c === 'object' && c !== null && 'text' in c ? String(c.text) : ''))
    .join('');
}

/** One-line human summary, used by run.ts and handy for UI event logs. */
export function summarize(ev: StreamEvent): string | null {
  switch (ev.kind) {
    case 'init':
      return `init session=${ev.event.session_id} model=${ev.event.model} mode=${ev.event.permissionMode}`;
    case 'task':
      return `${ev.event.subtype} ${ev.event.subagent_type ?? ''} ${ev.event.description ?? ev.event.status ?? ''}`.trim();
    case 'assistant':
    case 'user': {
      const who = ev.event.parent_tool_use_id
        ? `  [sub ${ev.event.parent_tool_use_id.slice(-6)}]`
        : '';
      const parts = ev.event.message.content.map((b) => {
        if (b.type === 'tool_use') return `tool_use ${b.name}`;
        if (b.type === 'tool_result')
          return `tool_result${b.is_error ? ' (error)' : ''} ${toolResultText(b.content).slice(0, 60)}`;
        if (b.type === 'text') return `text "${b.text.slice(0, 60)}"`;
        return 'thinking';
      });
      return `${ev.kind}${who}: ${parts.join(', ')}`;
    }
    case 'permission_denied':
      return `permission_denied ${ev.event.message}`;
    case 'result':
      return `result ${ev.event.subtype} turns=${ev.event.num_turns} cost=$${ev.event.total_cost_usd.toFixed(4)} denials=${ev.event.permission_denials.length}`;
    default:
      return null;
  }
}
