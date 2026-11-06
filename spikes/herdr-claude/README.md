# herdr + interactive Claude spike

Rerun: `npx tsx spikes/herdr-claude/0N-<name>.ts` (N = 1..5). Each script starts its own isolated
herdr session `bp-spike` (never the default one), and uses `HERDR_SPIKE_SCRATCH` (default: the
agent scratchpad) for throwaway repos and logs. Clean up with `herdr --session bp-spike server stop`
then `herdr session delete bp-spike`. Findings: `docs/spikes/herdr-claude.md`.
