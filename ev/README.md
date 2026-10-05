# PR #35 live Pi CLI proof — Smarty-Pants-Inc/pi-better-openai @ e7b97933

Task: pbo35-proof (Ryzen 1 / Dev1). Review: Astra round 1, P2. Recorded 2026-10-05 09:22–09:25 UTC.

## Versions

| What | Value |
|---|---|
| Checkout `git rev-parse HEAD` | `e7b97933ea9cef084bcdedb82924a664adb3bb45` (detached; `git status --short` empty after the run) |
| Extension `package.json` version | `@monotykamary/pi-better-openai` 0.2.11 |
| Pi CLI (`wt/node_modules/.bin/pi --version`) | `1.0.0` (`@earendil-works/pi-coding-agent@1.0.0` from the checkout's `bun.lock`) |
| pi-fabric | release `3d1f68540e4de55ae6bdebffa6b013a40d1da061` (`pi-fabric` 0.97.0), `dist/index.js`. This is the release the fleet's Pi settings load and that `PI_FABRIC_PINNED_EXTENSION` pins. (A newer release, `74edbdd0…`, is installed but not active; see item 3 for why that does not change the result.) |
| node / bun | `v24.18.0` / `1.4.0` |
| Install | `npm_config_update_notifier=false bun install --frozen-lockfile`: exit 0, 183 packages |
| Model for the two probe turns | `openrouter/anthropic/claude-haiku-4.5`. `~/.pi/agent/auth.json` holds only an `openrouter` `api_key` entry, with no `openai` or `openai-codex` login. |

## Launch (exact; agent dir redacted)

```
cd /tmp/factory-repair-mvVR/pbo35.NfZE/cwd          # scratch cwd, so no project .pi config lands in the checkout
# inherited PI_* variables unset first (scripts/launch.sh), then:
PI_CODING_AGENT_DIR=<REDACTED: private mktemp -d under the task dir, chmod 700; auth.json copied with cp, chmod 600> \
    PI_SKIP_VERSION_CHECK=1 npm_config_update_notifier=false \
  ../wt/node_modules/.bin/pi -ne -e ../wt/index.ts \
    -e /home/paul/.local/share/smarty-dev/fabric/releases/3d1f68540e4de55ae6bdebffa6b013a40d1da061/dist/index.js \
    --session-dir <agent dir>/sessions -nc -ns -np --no-themes --tui-mode regular \
    --model openrouter/anthropic/claude-haiku-4.5
```
The script is in `scripts/launch.sh`. At startup the TUI lists `[Extensions] dist, wt`, which are pi-fabric and this checkout. Nothing else loads (`00-startup.txt`).

**Deviation from `--no-session`:** Pi's `/export` refuses in-memory sessions ("Cannot export in-memory session to HTML"). So the session file was written to `<agent dir>/sessions`, inside the private dir, and that dir was deleted after the run. The export is how the run captures the exact top-level tool list and system prompt that Pi sends.

**Recording:** `smarty-video-proof tty pbo35-session.webm -- tmux -S <sock> new-session -s pbo35 -x 100 -y 28 launch.sh`. `scripts/drive.sh` drove the session from the side with `tmux send-keys` and saved each step with `capture-pane -e` (`NN-*.ansi`) and `capture-pane` (`NN-*.txt`). `shots/NN-*.png` are those exact captures rendered by xterm.js (`scripts/render.mjs`). Other outputs:
- `pbo35-session.webm`: the video.
- `pbo35-session.gif`: an animation of the video.
- `pbo35-session-sheet.png`: an 8-frame contact sheet.
- `pbo35-session.txt`: the full terminal text.

`pbo35-session-final.png` only shows tmux's `[exited]`, so use the `shots/` images instead. The timeline is in `steps.log`. The PIDs started for the run were driver 178337, tmux server 178407 and pi 178413; all have exited (checked with `ps -p`).

**Method for tool availability and guidance:** both of these, run once before and once after disabling:
- (a) One short model turn that runs `fabric_exec` with `return (await tools.list()).filter(t => String(t.ref).includes('openai_')).map(t => t.ref)`. This is pi-fabric's own captured-tool catalog.
- (b) `/export` to HTML. `scripts/extract.mjs` decodes the export and writes the top-level tool list and the full system prompt (`03-*-tools.txt`, `03-*-system-prompt.txt`, `03-*-summary.txt`).

The recorded run made two cheap turns in total, about $0.016. An earlier exploratory run, not recorded, made two more turns (about $0.017). One of those was accidental: `/openai-status` is not a command (the usage command is `/openai-usage`), so Pi sent it to the model as a prompt.

## Steps, output, evidence

| # | Command / keys | Observed (excerpt) | Evidence |
|---|---|---|---|
| 0 | launch | `[Extensions] dist, wt`; model `anthropic/claude-haiku-4.5` | `00-startup.*`, `shots/00-startup.png` |
| 1a | `/openai-settings` | `Image tool enabled · gpt-image-2.5`, `Web search tool enabled · gpt-6-luna`, `Typed decisions disabled` | `01a-settings-main.*` |
| 1b | ↓×5 Enter (Typed decisions) → Enter | `Enable decisions false` → `Enable decisions true` | `01b-decisions-before.*`, `01c-decisions-enabled.*` |
| 1c | Esc (main menu) | `Typed decisions model required` (enabled, no classifier selected) | `01d-settings-main-after-enable.*` |
| 1d | `/openai-decisions` | `Decisions: enabled; model: not selected; timeout: 10000ms.` | `01e-decisions-status-enabled.*` |
| 3a | probe turn, BEFORE (all three enabled) | `["extensions.openai_decide", "extensions.openai_image", "extensions.openai_websearch"]` | `03a-turn-before.*` |
| 3b | `/export ev/03-before.html` | top-level tools: `fabric_exec` only; prompt roster line `- @monotykamary/pi-better-openai: openai_decide, openai_image, openai_websearch` | `03-before.html`, `03-before-summary.txt`, `03-before-system-prompt.txt`, `03-before-tools.txt` |
| 1e | `/openai-settings` → Image tool → Enter | `Image tool true` → `Image tool false` | `01f-image-before.*`, `01g-image-disabled.*` |
| 1f | → Web search tool → Enter | `Web search tool true` → `false` | `01h-websearch-before.*`, `01i-websearch-disabled.*` |
| 1g | Esc (main menu) | `Image tool disabled`, `Web search tool disabled` | `01j-settings-main-after-disable.*` |
| 2a | `/openai-decisions off` | `Decision requests disabled.` | `02a-decisions-off.*` |
| 2b | `/openai-decisions` | `Decisions: disabled; model: not selected; timeout: 10000ms.` | `02b-decisions-status-after-off.*` |
| 3c | probe turn, AFTER (all three disabled) | **still** `["extensions.openai_decide", "extensions.openai_image", "extensions.openai_websearch"]` | `03c-turn-after.*`, `shots/03c-turn-after.png` |
| 3d | `/export ev/03-after.html` | top-level tools: `fabric_exec`; prompt roster line **unchanged**: `- @monotykamary/pi-better-openai: openai_decide, openai_image, openai_websearch`. The only diff from before is fabric's Jev paragraph. | `03-after.html`, `03-after-summary.txt`, `03-after-system-prompt.txt` |
| 4a | `/openai-settings` → Usage → ↓×5 | `Auto-redeem banked resets  true`, with description `Redeem one unused banked reset 10 minutes before expiry while pi is running.` | `04a-usage-autoredeem.*` |
| 4b | ↑↑ | `Usage reset times true`, `Include compact reset countdowns and local reset times.` | `04b-usage-reset-times.*` |
| 4c | `/openai-usage` | `Warning: Usage hidden: current model is not an OpenAI subscription model.` | `04c-openai-usage.*` |
| 4d | `/openai-resets` | `Error: Banked reset lookup failed: OpenAI Codex credentials unavailable.` No picker or confirmation opened, so no credit could be spent. | `04d-openai-resets.*` |
| 5 | config after the run | `image.enabled false`, `websearch.enabled false`, `decisions.enabled false`, `usage.autoRedeemBankedResets true` | `05-final-pi-better-openai.json` |
| 6 | exploratory run (not recorded): fresh config, decisions disabled from startup, one turn + `/export` | the roster already listed `openai_decide` while it was disabled | `06-explore-startup-decisions-disabled-summary.txt` |

## Verdict per review item

1. **`/openai-settings` enable/disable transitions: PASS.** In the real TUI, Typed decisions went false→true and Image tool and Web search tool went true→false. The main menu and `/openai-decisions` status updated right away, and the change was saved to the config (`05-…json`).
2. **`/openai-decisions off`: PASS.** It printed `Decision requests disabled.`, status then showed `Decisions: disabled`, and the config has `decisions.enabled: false`.
3. **Tool availability and guidance with Pi + pi-fabric loaded, before and after disabling: GAP.** The README.md:135-136 claim ("hides that tool and removes its system-prompt guidance, including from pi-fabric capture") does **not** hold with the active pi-fabric 0.97.0 (`3d1f6854`):
   - After disabling all three tools, pi-fabric's `tools.list()` still returns `extensions.openai_decide`, `extensions.openai_image` and `extensions.openai_websearch` (3c).
   - The system prompt sent to the model still carries the roster line naming all three (3d is identical to 3b).
   - `openai_decide` is listed even when decisions were disabled from startup (6).
   - Top-level, Pi exposes only `fabric_exec` in both states. In fabric mode the extension's `promptSnippet` and `promptGuidelines` texts appear 0 times both before and after. So the visible "guidance" in fabric mode is the roster line plus the `tools.list` descriptions, and neither is removed.
   - Likely cause, from reading the source: Pi's `ExtensionRunner.getAllRegisteredTools()` returns every registered tool, including ones with `exposure: "hidden"`. pi-fabric's `CapturedToolCatalog.replace()` (`dist/chunks/chunk-G5EXRSKX.js`) captures all of them without checking `exposure`. The string `exposure` does not appear in the dist of either 3d1f6854 or the newer installed 74edbdd0. This PR's `src/optional-tool.ts` assumes "Hidden exposure withdraws both native calls and Fabric capture", and that assumption is false for these pi-fabric releases.
   - Not tested: Pi without pi-fabric (direct mode), and actually calling `extensions.openai_image` while it is disabled.
4. **Ten-minute auto-redeem setting and reset-time display: GAP (setting PASS; display needs the account owner).**
   - The setting is shown live: `Auto-redeem banked resets true` with "Redeem one unused banked reset 10 minutes before expiry while pi is running." It matches `BANKED_RESET_AUTO_REDEEM_LEAD_MS = 10 * 60_000` in `src/resets.ts`.
   - The reset-time display (the usage footer, and the `· auto-redeems <time>` note in the reset picker and confirmation) did not render. The fleet has no ChatGPT/Codex login: `/openai-usage` → "Usage hidden: current model is not an OpenAI subscription model." and `/openai-resets` → "Banked reset lookup failed: OpenAI Codex credentials unavailable."
   - **The account owner needs to:** in an isolated agent dir, run `/login openai` (Sign in with ChatGPT; follow the precedent `pboev.FXHn/pr27-r2-live/06-fresh-login-prepared.md`), pick an `openai-codex`/`openai` subscription model, then run `/openai-usage` and `/openai-resets`. At the picker or "Redeem banked Codex reset?" confirmation, press **Esc**, and check that it says "Banked reset redemption cancelled." Never confirm.

## Hygiene

- No token, key or auth content is in the evidence. `secret-scan.txt` contains:
  - a pattern scan of every text file plus the decoded export payloads: 0 hits;
  - a check for the literal credential values (only the result is printed, never the values): 0 matches.
- The private agent dirs, which held the auth.json copies and session files, were deleted after the run. Nothing outside the task dir was touched or deleted, and the checkout's tracked files are unchanged.
- No push, no GitHub post, no reset credit spent.
