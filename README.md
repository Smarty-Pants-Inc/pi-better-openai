# pi-better-openai

A pi extension for OpenAI subscription workflows: fast mode, usage visibility, footer polish, custom Codex pets, and image generation through ChatGPT OAuth.

## Install

Requires pi 1.x and Node.js 22.19.0 or newer.

Install from GitHub:

```bash
pi install git:github.com/monotykamary/pi-better-openai
```

Or install from npm:

```bash
pi install npm:@monotykamary/pi-better-openai
```

## Authentication

Usage display, image generation, and web search require pi's ChatGPT OAuth credentials. The extension preserves credential-source priority: the pinned pooled account, refreshed model-registry auth, then unexpired auth-file entries. Within each source it tries `openai` first, falling back to legacy `openai-codex` credentials; API keys are not subscription credentials.

1. In pi, run `/login openai` and choose **Sign in with ChatGPT**. Pi 1.0's ChatGPT login (`openai`) is a direct `api.openai.com` token with no ChatGPT account id, and the usage, image and web search endpoints need one: with only that login, these commands say so. Run `/login openai-codex` (**OpenAI Codex (legacy)**) as well to use them; web search can also use `websearch.provider`.
2. Verify subscription usage with `/openai-usage`, or open `/openai-settings` and check **Diagnostics**.
3. The extension reads auth from pi's agent auth store, normally `~/.pi/agent/auth.json`. Do not copy, paste, or commit values from this file.
4. If `PI_CODING_AGENT_DIR` is set, the auth store, global extension config, and global generated-image directory use that agent directory instead of `~/.pi/agent`. A leading `~/` is expanded to your home directory.
5. When [pi-multiprovider](https://github.com/monotykamary/pi-multiprovider) 0.8.0+ pools ChatGPT accounts under `openai` or legacy `openai-codex`, the session's active account (chosen with `/switch-account`) is resolved first for usage display, image generation, and web search; the usage widget refreshes on every switch and whenever a resumed session restores the account, so it never keeps billing the account the session used before. Without that extension, credential resolution is unchanged.

## Features

- GPT-6.1 Sol, GPT-6 Astra, and Daybreak Blue/Red model fallbacks for the built-in `openai-codex` provider.
- Standard, Fast, and capability-gated Ultrafast service tiers via `/openai-tier` or `/openai-settings`; `/fast` remains a quick Fast toggle.
- Opt-in typed decisions through `openai_decide`, using an explicitly selected Pi classifier provider (including Jev). Native OpenAI Decisions remains gated on a published adapter.
- OpenAI subscription usage display via `/openai-usage` and the footer.
- Interactive settings picker via `/openai-settings`.
- Footer customization for model, thinking, fast mode, usage, and token/cost context.
- OpenAI image generation/editing through the `openai_image` tool and `/openai-image` command.
- Live web search through the `openai_websearch` tool and `/openai-websearch` command, backed by the ChatGPT Codex search backend.
- Animated Codex custom pets rendered in the Better OpenAI footer.
- Commands:
  - `/fast` toggles Fast and Standard; it never enables Ultrafast.
  - `/openai-tier [standard|fast|ultrafast]` shows or selects the requested service tier.
  - `/openai-decisions [models|use provider/model|off]` inspects or configures typed decisions.
  - `/openai-image <prompt>` generates an image directly.
  - `/openai-websearch <query>` searches the web and inserts the cited answer into the session.
  - `/pets [help|list|wake [slug]|tuck|select <slug>]` renders or manages custom pets from `${CODEX_HOME:-~/.codex}/pets`.
  - `/openai-usage` shows current OpenAI subscription usage.
  - `/openai-resets` inspects and manually redeems a banked Codex reset.
  - `/openai-settings` opens settings, diagnostics, and config details.

## Pi 1.0 compatibility

Pi 1.0 uses fullscreen TUI by default. The pet footer continues to use `ctx.ui.setFooter()` and the injected `tui.requestRender()`; image messages use pi's `Image` component, so the host owns fullscreen positioning and image redraws. Regular TUI and text-only image fallbacks remain supported. Upstream fullscreen mode disables iTerm2 inline images, so those terminals receive the host's text fallback; Kitty images retain redraw and resize support.

Pi 1.0 also exposes upstream `generateImages()` through the model registry. This overlaps with `openai_image` and `/openai-image`, but these remain available: they provide the standalone Codex Images API route, local edit/reference inputs, workspace-contained saving, and the extension's image message renderer. No tool or command is removed.

The built-in MCP, codemode, and tool-search extensions now load by default. This extension does not change that loadout. `--no-extensions` also disables those built-ins; explicitly requested extension paths remain loadable.

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
  "openai/gpt-6-astra",
  "openai/gpt-6.1-sol",
  "openai/gpt-6-sol",
  "openai/gpt-6-luna",
  "openai-codex/gpt-6-astra",
  "openai-codex/gpt-6.1-sol",
  "openai-codex/gpt-6-sol",
  "openai-codex/gpt-6-luna",
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
  "serviceTier": "standard",
  "decisions": {
    "enabled": false,
    "model": "",
    "timeoutMs": 10000
  },
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

## Service tiers

`/openai-tier fast` requests `service_tier: "priority"`. `/openai-tier standard` explicitly requests `"default"`, clearing an inherited Fast/Ultrafast request tier on OpenAI providers. Legacy disabled configurations without an explicit tier leave payloads untouched. `/fast` and the `--fast` flag never select Ultrafast.

`/openai-tier ultrafast` explicitly opts into **6x Standard token prices** for `openai/gpt-6-astra` over the Responses API. Only the documented global (`https://api.openai.com/v1`) and US (`https://us.api.openai.com/v1`) endpoints are enabled. EU/regional endpoints, custom proxies, other models, and Codex subscription Ultrafast are not enabled without verified support. This does not promise account entitlement or available rate limits. Unsupported selections remain requested but inactive; the extension does not inject a lower-tier fallback or retry a rejected request.

The footer shows `fast` or `ultrafast` only when supported by the current model. Diagnostics distinguish the requested tier and last injected payload from server-confirmed service or billing. **Pi's host cost estimates may omit the Ultrafast premium**; use OpenAI billing for actual charges. The host's native transport is preserved; WebSockets are recommended by OpenAI but HTTP is also supported. See [Ultrafast documentation](https://developers.openai.com/api/docs/guides/ultrafast-mode) and [pricing](https://developers.openai.com/api/docs/pricing?latest-pricing=ultrafast).

`serviceTier` takes precedence over legacy `desiredActive`/`active` within each config layer; project state still overrides global state. `persistState: false` keeps tier changes session-only. `supportedModels` overrides the Fast allowlist, not Ultrafast capabilities. Unknown config fields and customized model lists are preserved.

## Typed decisions

The `openai_decide` tool returns typed judgments through Pi's classifier API, **not chat completions**. It is disabled by default and never chooses a provider automatically. To use an existing Jev classifier explicitly:

```text
/openai-decisions models
/openai-decisions use typesafe/jev-latest
```

Configure that provider's credentials through Pi (for example, `TYPESAFE_API_KEY` for TypeSafe). The model list shows registered classifiers, not guaranteed credentials or entitlement. `/openai-decisions use` saves the selected model and enables decisions in the active project/global config; `/openai-decisions off` disables requests. These settings are independent of service-tier persistence. Provider-qualified IDs containing further slashes, such as `openrouter/typesafe/jev-1.13`, are supported when registered by the host. Prefer pinned versions for stable evaluations.

**Native OpenAI Decisions is not yet implemented:** as of the September 29, 2026 research checkpoint, no verifiable public endpoint/schema or SDK adapter was found. The bridge accepts OpenAI only once a classifier adapter is registered in Pi; it does not invent an endpoint, forward Codex OAuth to another service, or silently substitute a chat model. See the [integration status and remaining gates](plans/devday-integration.md).

Example tool input:

```json
{
  "state": { "testFailure": "connection to local test database timed out" },
  "questions": {
    "route": {
      "type": "choice",
      "instructions": "Classify the failure for human review.",
      "criteria": { "environment": "Environment problem", "code": "Code defect" }
    }
  }
}
```

- `state`: JSON object; send only the necessary context, never credentials or the entire session.
- `questions`: 1–32 named questions. `choice` uses 2–64 labeled criteria; `bool` uses `true`/`false` criteria; `score` uses 2–64 ordered criteria. Pi maps boolean questions to Jev's `noul` representation.
- Total input is capped at 64 KiB. `decisions.timeoutMs` defaults to 10000 and is clamped to 1000–60000. Cancellation/deadlines abort the provider request; there are no automatic retries. A timed-out upstream request may still incur charges.
- Results have `status: "ok"`, provider/model provenance, and typed `answers`; errors have `status: "error"` and mark the tool failed. Structured output is available to programmatic callers. Provider error text is withheld to prevent credential/state leakage.
- Probabilities and confidence remain uncertain judgments; scores retain their provider-specific scale. No claim of cross-provider calibration is made. Decisions never authorize tools, execute commands, change the active model, or start background polling.
- Reported classifier token usage/cost is included in tool results and the Better OpenAI footer. Missing usage or catalog pricing is not evidence that a request was free.

## Codex model fallbacks

The extension adds `gpt-6.1-sol`, `gpt-6-astra`, `gpt-daybreak-blue-latest`, and `gpt-daybreak-red-latest` to the built-in `openai-codex` provider without requiring local `models.json` entries. Existing built-in models remain available, and metadata from pi's live catalog takes precedence when pi publishes an official entry with the same ID.

The GPT-6.1 Sol fallback uses Codex's conservative 272K context default, 128K output limit, and published short/long-context pricing. It maps Pi's `minimal` level to `low` and disables `off`; the model does not accept `none` or `minimal` reasoning efforts. See [model documentation](https://developers.openai.com/api/docs/models/gpt-6.1-sol) and the [upstream Codex catalog change](https://github.com/openai/codex/commit/b1e72963c3b71a9265a551e54beff078384efed9).

Daybreak models require separate OpenAI approval and provisioning. pi currently exposes reasoning levels through `max`; Codex's `ultra` automatic-delegation mode is not a pi thinking level.

## Voice

Realtime voice (`/live`) moved to [Smarty Voice](https://github.com/Smarty-Pants-Inc/smarty-voice) (`/voice`). Its first run copies this file's `live` settings into `smarty-voice.json`; settings writes here keep the `live` section.

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

[`pi-better-openai`](https://github.com/mattleong/pi-better-openai) was originally created by [Matt Leong](https://github.com/mattleong). This fork is maintained and published under the `@monotykamary` namespace while retaining Matt's authorship and the original Git history.

## Screenshots

<!-- Add screenshots here. -->

<img width="983" height="851" alt="Screenshot 2026-04-29 at 11 53 23 PM" src="https://github.com/user-attachments/assets/07a2fb87-ef48-4396-8b12-124825c8d360" />
<img width="1327" height="102" alt="Screenshot 2026-04-29 at 11 34 49 PM" src="https://github.com/user-attachments/assets/22042782-c94e-491d-b5af-095f7f0810f9" />
