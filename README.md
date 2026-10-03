# PR #28 real-CLI evidence (head 67178c74)

Evidence for Astra R2 on [pi-better-openai#28](https://github.com/Smarty-Pants-Inc/pi-better-openai/pull/28).
Evidence only. Do not merge this branch.

- Head: `67178c74e8a7f8a64197e85e5c04aee97f492210`. Built as CI does: `bun install --frozen-lockfile` (exit 0), `bun run check` (exit 0, 252/252 tests).
- Runtime: Node v24.18.0, the repo-local Pi CLI `1.0.0` (`node_modules/@earendil-works/pi-coding-agent/dist/cli.js`), only this head's `index.ts` loaded (`--no-extensions -e pbo/index.ts`).
- Chat: `cliproxyapi/gpt-6-astra`, the fleet's existing CLIProxyAPI gateway (live). Classifier: `openrouter/~typesafe/jev-latest` (TypeSafe System One served by OpenRouter), the fleet's existing OpenRouter key (live). No new credential or account.
- No network fixtures, preloads or fake keys. Isolated `PI_CODING_AGENT_DIR` (/tmp) that holds only the cliproxyapi provider entry and the existing OpenRouter key; real HOME.
- Recorded with asciinema 3.2.0 (asciicast v2, 150x42 PTY), driven by `drive.py` (pexpect) through `run-pi.sh`. GIFs rendered with agg 1.9.0. `frames/` are single-screen stills cut from the same casts (`freeze.py`).
- One session across all four runs: `01a101a0-729f-76ad-8841-5ef4d378a262` (runs b to d use `--continue`). `session-summary.json` is an allowlisted extract of that session (no reasoning signatures, no headers).

| Run | Cast | GIF | Shows |
|---|---|---|---|
| a | `casts/a-live-decision.cast` | `gif/a-live-decision.gif` | classifier list, opt-in warning, `/openai-tier fast`, live `openai_decide` via OpenRouter Jev, typed answers, debug panel `Last injected ... priority`, `/session` |
| b | `casts/b-clean-failure-off.cast` | `gif/b-clean-failure-off.gif` | chat model and unknown id refused as classifier, missing-credential classifier gives `isError` result, `/openai-decisions off` then refused before network |
| c | `casts/c-picker-footer.cast` | `gif/c-picker-footer.gif` | resume, settings picker: tier fast to ultrafast (inactive on this route, warning) to standard, footer replace to status, live prompt at standard, footer back to replace |
| d | `casts/d-resume.cast` | `gif/d-resume.gif` | resume again: Standard persisted, same session id |

Play a cast: `asciinema play casts/a-live-decision.cast`.
