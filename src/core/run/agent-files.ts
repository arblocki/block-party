import { join } from 'node:path';
import { buildAgents, buildSettings, shellRules } from '../agents/claude-config.js';
import { writeArtifact } from './artifacts.js';
import type { Ctx } from './context.js';

/**
 * Writes `agents.json` and `settings.json` (permission mode, hooks, sandbox) from the run's
 * saved configuration. They are regenerated before every implementer turn, so a file an agent
 * managed to change, or a configuration edited since, changes nothing: Claude Code reads them
 * when a process starts, and every turn that starts or resumes one goes through here first.
 */
export async function writeImplementerFiles(ctx: Ctx): Promise<void> {
  const { deps, st, runDir, input } = ctx;
  const models = input.config.subagents;
  await writeArtifact(
    runDir,
    'agents.json',
    buildAgents(
      (Object.keys(models) as (keyof typeof models)[]).map((name) => ({
        name,
        model: models[name],
        ...(name === 'explorer' ? { readOnly: true } : {}),
      })),
      shellRules(ctx.start.allowedTools),
    ),
  );
  await writeArtifact(
    runDir,
    'settings.json',
    buildSettings({
      hookArgv: deps.hookArgv,
      eventsPath: ctx.start.eventsPath,
      permissionMode: ctx.start.permissionMode,
      ...(input.config.policy.sandbox === 'on'
        ? {
            sandbox: {
              gitDir: join(st.repoPath, '.git'),
              extraAllowedDomains: input.config.policy.sandboxAllowedDomains,
              extraAllowWrite: [
                ...input.config.policy.sandboxAllowWrite,
                ...(deps.sandboxWritableDirs?.() ?? []),
              ],
            },
          }
        : {}),
    }),
  );
}

/** The planner's equivalents (read-only explorer only; no Bash, so no sandbox). */
export async function writePlannerFiles(ctx: Ctx): Promise<void> {
  const { deps, runDir, input } = ctx;
  await writeArtifact(
    runDir,
    'planner-settings.json',
    buildSettings({
      hookArgv: deps.hookArgv,
      eventsPath: ctx.start.eventsPath,
      permissionMode: 'default',
    }),
  );
  await writeArtifact(
    runDir,
    'planner-agents.json',
    buildAgents([{ name: 'explorer', model: input.config.subagents.explorer, readOnly: true }]),
  );
}
