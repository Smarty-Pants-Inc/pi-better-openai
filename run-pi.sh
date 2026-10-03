#!/usr/bin/env bash
# Wrapper recorded inside asciinema: shows the exact command, runs the real Pi 1.0 CLI, shows its exit.
cd "$(dirname "$0")"
export PI_CODING_AGENT_DIR=/tmp/pbo28-demo-VySR/agent
CLI=pbo/node_modules/@earendil-works/pi-coding-agent/dist/cli.js
echo "# pi-better-openai PR #28 head $(git -C pbo rev-parse --short=8 HEAD) | node $(node --version) | pi $(node $CLI --version)"
echo "# chat: cliproxyapi/gpt-6-astra (fleet CLIProxyAPI gateway) | classifier route: openrouter (existing fleet key)"
ARGS=(--offline --no-extensions -e pbo/index.ts --no-skills --no-prompt-templates --no-context-files --no-approve
  --model cliproxyapi/gpt-6-astra --thinking low --tools openai_decide "$@")
echo "\$ node $CLI ${ARGS[*]}"
sleep 2
node "$CLI" "${ARGS[@]}"
code=$?
echo "[pi exit $code]"
sleep 2
exit $code
