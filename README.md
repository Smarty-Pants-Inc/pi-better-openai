# pi-better-openai

A pi extension for OpenAI subscription workflows: fast mode, usage visibility, realtime voice, footer polish, custom Codex pets, and image generation through `openai-codex` auth.

## Install

Requires Node.js 22.19.0 or newer.

Install from GitHub:

```bash
pi install git:github.com/monotykamary/pi-better-openai
```

Or install from npm:

```bash
pi install npm:@monotykamary/pi-better-openai
```

## Authentication

Usage display, image generation, and live voice require pi's `openai-codex` OAuth credentials.

1. In pi, run `/login openai-codex`.
2. Verify subscription usage with `/openai-usage`, or open `/openai-settings` and check **Diagnostics**.
3. The extension reads auth from pi's agent auth store, normally `~/.pi/agent/auth.json`. Do not copy, paste, or commit values from this file.
4. If `PI_CODING_AGENT_DIR` is set, the auth store, global extension config, and global generated-image directory use that agent directory instead of `~/.pi/agent`. A leading `~/` is expanded to your home directory.
5. When [pi-multiprovider](https://github.com/monotykamary/pi-multiprovider) 0.8.0+ pools several `openai-codex` accounts, the session's active account (chosen with `/switch-account`) is resolved first for usage display, image generation, web search, and live voice; the usage widget refreshes on every switch and whenever a resumed session restores the account, so it never keeps billing the account the session used before. Without that extension, credential resolution is unchanged.

## Features

- GPT-6 Astra and Daybreak Blue/Red model fallbacks for the built-in `openai-codex` provider.
- Fast mode for supported OpenAI models, toggled with `/fast` or in `/openai-settings`.
- OpenAI subscription usage display via `/openai-usage` and the footer.
- Interactive settings picker via `/openai-settings`.
- Footer customization for model, thinking, fast mode, usage, and token/cost context.
- OpenAI image generation/editing through the `openai_image` tool and `/openai-image` command.
- Live web search through the `openai_websearch` tool and `/openai-websearch` command, backed by the ChatGPT Codex search backend.
- Codex-backed realtime voice through `/live`, with an animated microphone waveform and coding-task delegation into the active pi session.
- Animated Codex custom pets rendered in the Better OpenAI footer.
- Commands:
  - `/fast` toggles fast mode.
  - `/openai-image <prompt>` generates an image directly.
  - `/openai-websearch <query>` searches the web and inserts the cited answer into the session.
  - `/live` starts or stops realtime voice mode. `Ctrl+Shift+L` is the keyboard toggle.
  - `/pets [help|list|wake [slug]|tuck|select <slug>]` renders or manages custom pets from `${CODEX_HOME:-~/.codex}/pets`.
  - `/openai-usage` shows current OpenAI subscription usage.
  - `/openai-resets` inspects and manually redeems a banked Codex reset.
  - `/openai-settings` opens settings, diagnostics, and config details.

## Banked resets

Unused banked Codex resets **auto-redeem by default, 1 minute before expiry**, while an interactive pi session is running and Codex credentials are available. Starting pi within that final one-minute window also triggers the check; expired credits are skipped. This runs independently of the usage display and current model. The reset picker and confirmation show each credit's actual local auto-redemption date and time (expiry minus one minute) beside its expiry. Disable **Auto-redeem banked resets** in `/openai-settings` or set `usage.autoRedeemBankedResets` to `false` to opt out.

For safety, each attempt targets one explicit, freshly checked credit ID, with no fallback to another credit and no automatic retry after a consume request (including errors or `nothing_to_reset`). A persistent per-account guard permits at most one redemption attempt in one minute across pi sessions sharing the same agent directory; manual redemption uses the same guard. Automatic reservations recheck the one-minute eligibility window while holding an exclusive filesystem lock, and attempted credit IDs remain blocked even after later redemptions or restarts. Simultaneously expiring credits are not drained, and later credits wait for their own final one-minute window. Reservations live under `$PI_CODING_AGENT_DIR/pi-better-openai/reset-redemptions` (default `~/.pi/agent/pi-better-openai/reset-redemptions`); unreadable state or an orphaned lock blocks redemption rather than risking a duplicate. Update/restart all pi instances to use the current guard. Separate machines/agent directories cannot coordinate this local guard; instances using the same account should share an agent directory.

Pi must remain running and awake; this is not an OS-level scheduled task. No eligible usage window or unavailable credentials can prevent redemption.

## Configuration

The extension reads JSON config from two locations:

- Project config: `.pi/extensions/pi-better-openai.json`
- Global config: `$PI_CODING_AGENT_DIR/extensions/pi-better-openai.json`, defaulting to `~/.pi/agent/extensions/pi-better-openai.json`

Project overrides global. Global values fill fields omitted by the project file. Invalid enum values are ignored, and numeric settings are clamped to safe ranges.

Default supported models:

```json
[
  "openai/gpt-5.4",
  "openai/gpt-5.5",
  "openai-codex/gpt-6-astra",
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-5.6-luna",
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.5"
]
```

Example config:

```json
{
  "persistState": true,
  "notifyOnModelSwitch": true,
  "desiredActive": false,
  "supportedModels": ["openai/gpt-5.5", "openai-codex/gpt-5.5"],
  "usage": {
    "enabled": true,
    "refreshIntervalMs": 60000,
    "showOnlyOnSubscriptionModels": true,
    "showResetTimes": true,
    "autoRedeemBankedResets": true
  },
  "footer": {
    "mode": "status"
  },
  "image": {
    "enabled": true,
    "defaultModel": "gpt-image-2.5",
    "defaultSave": "project",
    "outputFormat": "png",
    "timeoutMs": 180000
  },
  "live": {
    "enabled": true,
    "voice": "sol"
  },
  "pets": {
    "enabled": false,
    "slug": "",
    "placement": "inline-right",
    "state": "idle",
    "thinkingState": "review",
    "toolState": "running",
    "failedToolState": "failed",
    "idleEmotes": true,
    "idleEmoteIntervalMs": 30000,
    "sizeCells": 10
  }
}
```

## Codex model fallbacks

The extension adds `gpt-6-astra`, `gpt-daybreak-blue-latest`, and `gpt-daybreak-red-latest` to the built-in `openai-codex` provider without requiring local `models.json` entries. Existing built-in models remain available, and metadata from pi's live catalog takes precedence when pi publishes an official entry with the same ID.

Daybreak models require separate OpenAI approval and provisioning. pi currently exposes reasoning levels through `max`; Codex's `ultra` automatic-delegation mode is not a pi thinking level.

## Live voice

Run `/live` or press `Ctrl+Shift+L` to open the realtime voice panel. `Ctrl+L` remains pi's model selector, so the extension deliberately uses the shifted chord. The panel sits above pi's editor, and you can keep typing during a call:

- `Space` toggles microphone mute, and `Escape` ends the call, only while the editor is empty. With text in the editor, both keys edit as usual. While pi is streaming, the first `Escape` ends the call and a second `Escape` aborts pi's turn as usual.
- `Ctrl+Shift+L` or `/live` ends the call at any time.
- `Enter` sends typed text to pi as a normal message. Live voice also receives it as silent `[USER] ` context (the Codex realtime framing), so it knows what you asked; pi's answer is then spoken as a short update.
- The waveform reacts to microphone RMS level and the panel footer shows connecting, listening, working, speaking, muted, or error state.
- Streaming speech transcripts stay in the live panel. Coding and repository requests are delegated into the current pi agent session; normal tool and assistant output continues in the transcript, and the final result is spoken back through the live session.

Choose the spoken voice under **Live voice** in `/openai-settings`. Supported values are `arbor`, `breeze`, `cove`, `ember`, `juniper`, `maple`, `sol`, `spruce`, and `vale`.

Live mode requires interactive TUI mode, microphone/speaker access, `openai-codex` OAuth, and one of these native targets: macOS arm64/x64, Linux arm64/x64, or Windows x64. Standard `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` settings are honored for signaling and sideband traffic. Audio/WebRTC uses the MIT-licensed native platform packages from [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi). The adapted implementation is attributed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). On macOS, launchd-managed LocalTerm users should rerun `localterm install` after upgrading LocalTerm and allow its microphone prompt.

The feature uses Codex Desktop's experimental `gpt-live-1-codex`/Quicksilver protocol rather than the public OpenAI Realtime API. Upstream protocol or entitlement changes may temporarily break it.

### Gateway and remote audio

Two optional `live` settings support a pi session on a remote host, such as over SSH:

```json
{
  "live": { "provider": "cliproxyapi", "audio": "browser", "browserPort": 8795 }
}
```

- `provider` names a pi provider for a [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) gateway. Live signaling (`POST /v1/live`) and the sideband (`/v1/live/{call}`) then use that provider's base URL and API key. The gateway owns ChatGPT OAuth and account selection; pi needs no `openai-codex` login.
- `audio: "browser"` makes a browser tab the WebRTC media peer. It owns the microphone, speaker, and echo cancellation, so the pi host needs no audio devices or native audio packages. pi keeps signaling, the sideband, and delegation. `/live` serves a page on `127.0.0.1:<browserPort>` and prints its URL with a private token (stored in `~/.pi/agent/pi-better-openai/live-browser-token`). The page only accepts loopback hosts, same-origin WebSockets, and that token.

For pi on a remote host, forward the port from the machine with the microphone, for example with `LocalForward 8795 127.0.0.1:8795` in `~/.ssh/config` or `ssh -L 8795:127.0.0.1:8795 host`. Open the printed `http://localhost:8795/#…` URL (browsers allow the microphone on `localhost`), click **Enable audio** once, and keep the tab open. The tab follows `/live` sessions and stops retrying when live mode ends. Only one pi process per host can serve the page at a time.

## Image generation

Use the command for quick generation:

```text
/openai-image draw an otter reading a terminal
```

Agents can call the `openai_image` tool directly. Supported parameters:

- `prompt` (required): pass the user's image wording verbatim.
- `action`: `auto`, `generate`, or `edit`. `auto` uses the edit endpoint when `images` are supplied; explicit `edit` requires images, while explicit `generate` does not accept them.
- `images`: up to five distinct project-local reference/edit image paths. Paths must stay inside the current workspace and point to readable PNG, JPEG, WebP, or GIF files; each file is limited to 20 MB and the combined input to 50 MB.
- `model`: GPT Image model override for the standalone Codex Images API, for example `gpt-image-2.5` or `gpt-image-2`. Values outside the `gpt-image-` family, including legacy Responses chat models, are replaced with the configured default image model.
- `outputFormat`: `png`, `jpeg`, or `webp`. Codex returns PNG and the extension converts other formats locally.
- `save`: `project`, `global`, `custom`, or `none`.
- `saveDir`: required for `save: "custom"` unless `PI_IMAGE_SAVE_DIR` is set.

Save modes:

- `project` writes to `.pi/generated-images/` in the current project.
- `global` writes to the agent `generated-images` directory, normally `~/.pi/agent/generated-images/` or `$PI_CODING_AGENT_DIR/generated-images/`.
- `custom` writes to `saveDir` or `PI_IMAGE_SAVE_DIR`; relative paths are resolved from the current project.
- `none` returns the image without saving it.

The repository ignores `.pi/`, so generated images and local config should not be committed.

## Web search

Use the command for a quick search:

```text
/openai-websearch latest tanstack query release
```

Agents can call the `openai_websearch` tool directly. Supported parameters:

- `query` (required): the web search query.
- `responseLength`: `short`, `medium`, or `long`. Defaults to the configured value.

The tool returns a synthesized answer plus cited source URLs. It calls the
undocumented `chatgpt.com/backend-api/codex/alpha/search` endpoint with your ChatGPT
OAuth credentials (`openai-codex` login), so it can change or break without notice;
OAuth/API-key-only setups without ChatGPT login are not supported.

Settings under `websearch` in the config file or the `/openai-settings` picker:

- `enabled` (default `true`), `model` (default `gpt-6-luna`),
  `reasoningEffort` (default `max`), `responseLength` (default `short`),
  `maxOutputTokens` (default `4096`, clamped to 256-100000), and
  `timeoutMs` (default `25000`, clamped to 5000-120000).

## Codex pets

Codex pets are an OpenAI Codex app feature, so the floating overlay and pet picker are still controlled by Codex (`Settings → Appearance → Pets` or `/pet`). This extension can also render compatible custom pet spritesheets directly in pi's Better OpenAI footer.

```bash
/pets wake          # render the selected pet, or pick one if none is selected
/pets wake <slug>   # render a specific ready pet
/pets select <slug> # select a ready pet without changing visibility
/pets tuck          # hide it
/pets list          # list local custom pets and readiness diagnostics
```

You can also enable **Footer pet** in `/openai-settings`, cycle installed pets with the **Pet** row, preview the selected pet in the footer, and tune placement (`inline-right` by default), idle, thinking/streaming, tool-execution, and any failed-tool animation states, plus random idle emotes and size.

To create a custom pet for the Codex app:

```bash
$skill-installer hatch-pet
```

Then reload Codex skills (`Cmd/Ctrl+K → Force Reload Skills`) and ask:

```text
$hatch-pet create a new pet inspired by pi-better-openai
```

Custom pets should end up in `${CODEX_HOME:-~/.codex}/pets/<pet-name>/` with `pet.json` and `spritesheet.webp`. The spritesheet must be a 1536×1872 atlas arranged as 8 columns by 9 animation rows. Animated footer rendering also requires a terminal image protocol supported by pi. Refresh custom pets in Codex settings and toggle the overlay with `/pet`.

## Attribution

[`pi-better-openai`](https://github.com/mattleong/pi-better-openai) was originally created by [Matt Leong](https://github.com/mattleong). This fork is maintained and published under the `@monotykamary` namespace while retaining Matt's authorship and the original Git history. Realtime voice adaptations have separate attribution in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Screenshots

<!-- Add screenshots here. -->

<img width="983" height="851" alt="Screenshot 2026-04-29 at 11 53 23 PM" src="https://github.com/user-attachments/assets/07a2fb87-ef48-4396-8b12-124825c8d360" />
<img width="1327" height="102" alt="Screenshot 2026-04-29 at 11 34 49 PM" src="https://github.com/user-attachments/assets/22042782-c94e-491d-b5af-095f7f0810f9" />
