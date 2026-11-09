export type CommandHandler = (argv: string[]) => Promise<void>;

export interface Handlers {
  review: CommandHandler;
  checks: CommandHandler;
  run: CommandHandler;
  hook: CommandHandler;
}

/** Handlers load lazily so `checks` does not pull in the review server's dependencies. */
export const defaultHandlers: Handlers = {
  review: async (argv) => (await import('./commands/review.js')).reviewMain(argv),
  checks: async (argv) => (await import('./commands/checks.js')).checksMain(argv),
  run: async (argv) => (await import('./commands/run.js')).runMain(argv),
  hook: async (argv) => (await import('./commands/hook.js')).hookMain(argv),
};

/** Dispatches `checks`, `run` and `hook` subcommands; anything else is the review flow. */
export async function main(argv: string[], handlers: Handlers = defaultHandlers): Promise<void> {
  const [first, ...rest] = argv;
  if (first === 'checks') return handlers.checks(rest);
  if (first === 'run') return handlers.run(rest);
  if (first === 'hook') return handlers.hook(rest);
  return handlers.review(argv);
}
