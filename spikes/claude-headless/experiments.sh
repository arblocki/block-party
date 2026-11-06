#!/bin/sh
# Reproduces the headless-Claude spike experiments in a throwaway repo (cheap: haiku, tiny prompts).
# Usage: spikes/claude-headless/experiments.sh <scratch-dir>
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
S=${1:?scratch dir}
RUN="npx tsx $HERE/run.ts"
mkdir -p "$S" && cd "$S"
git init -q r1 && git -C r1 commit -q --allow-empty -m init

cat > agents.json <<'JSON'
{"helper":{"description":"Creates files on request","prompt":"You create files exactly as asked, then reply done.","model":"haiku","tools":["Write"]}}
JSON
cat > hook.sh <<EOS
#!/bin/sh
cat >> "$S/hooks-\$1.jsonl"; echo >> "$S/hooks-\$1.jsonl"
EOS
chmod +x hook.sh
cat > settings.json <<EOS
{"hooks":{
 "Stop":[{"hooks":[{"type":"command","command":"$S/hook.sh Stop"}]}],
 "SubagentStop":[{"hooks":[{"type":"command","command":"$S/hook.sh SubagentStop"}]}],
 "PostToolUse":[{"hooks":[{"type":"command","command":"$S/hook.sh PostToolUse"}]}]}}
EOS

U=$(uuidgen | tr 'A-Z' 'a-z')
# Q1-3: subagent run with hooks. `--` ends the variadic --allowedTools list before the prompt.
$RUN --cwd r1 --session-id "$U" --raw run1.jsonl -- --model haiku \
  --settings "$S/settings.json" --agents "$S/agents.json" --permission-mode acceptEdits \
  "Create a.txt containing 'a'. Then use the helper subagent to create b.txt containing 'b'. Then write report.json with {\"status\":\"done\"}."
# Q4: resume
$RUN --cwd r1 --resume "$U" -- --model haiku --permission-mode acceptEdits "Which files did you create?"
# Q5: permission profile (see docs/spikes/claude-headless.md)
$RUN --cwd r1 -- --model haiku --permission-mode acceptEdits \
  --allowedTools "Bash(git status:*)" "Bash(git add:*)" "Bash(pnpm:*)" \
  --disallowedTools "Bash(git push:*)" "Bash(curl:*)" "Bash(rm:*)" -- \
  "Run git status --short, then git push origin main, then curl -s https://example.com. Say what ran."
# Q6: SIGTERM after 15s while a long command runs
$RUN --cwd r1 --sigterm-after 15000 -- --model haiku --permission-mode acceptEdits --allowedTools "Bash(node:*)" -- \
  'Run exactly: node -e "setTimeout(()=>{},60000)"'
