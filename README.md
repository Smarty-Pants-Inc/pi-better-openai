# pi-better-openai

A pi extension for OpenAI subscription workflows: fast mode, usage visibility, footer polish, custom Codex pets, and image generation through `openai-codex` auth.

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

Pi 1.0.2 supports **Sign in with ChatGPT** under `/login openai`, using the native Responses API at `api.openai.com`. Use `openai/*` models for that subscription login or an OpenAI API key; the extension preserves pi's native authentication and transport. Standard/Fast tier overrides work with both login methods on supported models.

Pi labels `openai-codex` **legacy**, but this extension's usage polling, banked resets, image generation, and web search still call separate `chatgpt.com/backend-api` endpoints. They require the legacy Codex login, not the new direct-OpenAI OAuth grant. Credentials are never copied or substituted between providers.

1. For those backend features, also run `/login openai-codex`. You can keep an `openai/*` model selected.
2. Inspect the Codex account's usage with `/openai-usage`, or open `/openai-settings` and check **Diagnostics**. While using `openai/*`, the footer labels it **Codex Usage**: it is not verified against your active OpenAI login and could belong to a different account. For your OpenAI subscription, check [ChatGPT usage](https://chatgpt.com/settings/usage).
3. The extension reads auth from pi's agent auth store, normally `~/.pi/agent/auth.json`. Do not copy, paste, or commit values from this file.
4. If `PI_CODING_AGENT_DIR` is set, the auth store, global extension config, and global generated-image directory use that agent directory instead of `~/.pi/agent`. A leading `~/` is expanded to your home directory.
5. With [pi-multiprovider](https://github.com/monotykamary/pi-multiprovider), a session's selected account is never replaced by another account for usage, banked resets, image generation, or web search. Selected Codex auth is pinned by the stable pool slot `id` from `getActiveAccount()`: the selection must stay unchanged across auth resolution and a final re-read, with no account-change event in between. Implicit affinity can move without an event, so a selection read started in the same turn as auth resolution must also match the pin; the current bridge captures its slot synchronously at that call. The current bridge returns only `{accessToken, label, source}`, and that label must match the pin; an optional auth `id` from a future bridge must match the pin instead. Labels and JWT ChatGPT account IDs are not pool slot IDs. Unresolved, changed, ambiguous, or account-ID-less selections fail closed. A selected native `openai` account is refused for Codex backend operations, not forwarded to `chatgpt.com`. Both pools' switch/resume events refresh usage and resets. Reset caches, pickers, confirmations, and scheduled automatic redemptions retain the original pool slot identity; the exact credit and identity are revalidated before reservation and consumption, never rebound to a newly selected account. After a switch, automatic redemption re-arms for the newly selected account's own credits, and each reset request sends the verified slot's current token. With no pool selection, the default `openai-codex` credential remains independent of native OpenAI login. Without that extension, credential resolution is unchanged.

## Features

- GPT-6.1 Sol, GPT-6 Astra, and Daybreak Blue/Red model fallbacks for the built-in `openai-codex` provider.
- Standard, Fast, and capability-gated Ultrafast service tiers via `/openai-tier` or `/openai-settings`; `/fast` remains a quick Fast toggle.
- Opt-in typed decisions through `openai_decide`, using an explicitly selected Pi classifier provider (including Jev), with per-call confirmation of the outgoing payload.
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

## Banked resets

Unused banked Codex resets **auto-redeem by default, 10 minutes before expiry**, while an interactive pi session is running and Codex credentials are available. Starting pi within that final ten-minute window also triggers the check; expired credits are skipped. This runs independently of the usage display and current model. The reset picker and confirmation show each credit's actual local auto-redemption date and time (expiry minus ten minutes) beside its expiry. Disable **Auto-redeem banked resets** in `/openai-settings` or set `usage.autoRedeemBankedResets` to `false` to opt out.

For safety, each attempt targets one explicit, freshly checked credit ID, with no fallback to another credit and no automatic retry after a consume request (including errors or `nothing_to_reset`). A persistent per-account guard permits at most one redemption attempt in ten minutes across pi sessions sharing the same agent directory; manual redemption uses the same guard. Automatic reservations recheck the ten-minute eligibility window while holding an exclusive filesystem lock, and attempted credit IDs remain blocked even after later redemptions or restarts. Simultaneously expiring credits are not drained, and later credits wait for their own final ten-minute window. Reservations live under `$PI_CODING_AGENT_DIR/pi-better-openai/reset-redemptions` (default `~/.pi/agent/pi-better-openai/reset-redemptions`); unreadable state or an orphaned lock blocks redemption rather than risking a duplicate. Update/restart all pi instances to use the current guard. Separate machines/agent directories cannot coordinate this local guard; instances using the same account should share an agent directory.

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
    "timeoutMs": 10000,
    "allowWithoutConfirmation": false
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

Setting `image.enabled`, `websearch.enabled`, or `decisions.enabled` to `false` hides that tool and removes its system-prompt guidance, including from pi-fabric capture. Changes in `/openai-settings` or `/openai-decisions` apply immediately; use `/reload` after editing config files manually. Configuration commands remain available.

## Service tiers

`/openai-tier fast` requests `service_tier: "priority"`. `/openai-tier standard` explicitly requests `"default"`, clearing an inherited Fast/Ultrafast request tier on OpenAI providers. Legacy disabled configurations without an explicit tier leave payloads untouched. `/fast` and the `--fast` flag never select Ultrafast.

`/openai-tier ultrafast` explicitly opts into **6x Standard token prices** for **API-key-authenticated** `openai/gpt-6-astra` over the Responses API. Only the documented global (`https://api.openai.com/v1`) and US (`https://us.api.openai.com/v1`) endpoints are enabled. EU/regional endpoints, custom proxies, other models, and ChatGPT subscription Ultrafast (both `openai` OAuth and legacy `openai-codex`) are not enabled without verified support. This does not promise account entitlement or available rate limits. Unsupported selections remain requested but inactive; the extension does not inject a lower-tier fallback or retry a rejected request.

The footer shows `fast` or `ultrafast` only when supported by the current model. Diagnostics distinguish the requested tier and last injected payload from server-confirmed service or billing. **Pi's host cost estimates may omit the Ultrafast premium**; use OpenAI billing for actual charges. The host's native transport is preserved; WebSockets are recommended by OpenAI but HTTP is also supported. See [Ultrafast documentation](https://developers.openai.com/api/docs/guides/ultrafast-mode) and [pricing](https://developers.openai.com/api/docs/pricing?latest-pricing=ultrafast).

`serviceTier` takes precedence over legacy `desiredActive`/`active` within each config layer; project state still overrides global state. `persistState: false` keeps tier changes session-only. `supportedModels` overrides the Fast allowlist, not Ultrafast capabilities. Unknown config fields and customized model lists are preserved.

## Typed decisions

The `openai_decide` tool returns typed judgments through Pi's classifier API, **not chat completions**. It is disabled by default and never chooses a provider automatically. To use an existing Jev classifier explicitly:

```text
/openai-decisions models
/openai-decisions use typesafe/jev-latest
```

Configure that provider's credentials through Pi (for example, `TYPESAFE_API_KEY` for TypeSafe). `/openai-decisions models`, `/openai-decisions use`, the settings picker, and every `openai_decide` request use one shared availability check: only classifiers the Pi host reports as usable with the current credentials are listed, accepted, or called (for example, a classifier that requires an API key is not selectable with only ChatGPT OAuth). Availability does not guarantee account entitlement. `/openai-decisions use` saves the selected model and enables decisions in the active project/global config; `/openai-decisions off` disables requests. These settings are independent of service-tier persistence. Provider-qualified IDs containing further slashes, such as `openrouter/typesafe/jev-1.13`, are supported when registered by the host. Prefer pinned versions for stable evaluations.

**Native OpenAI Decisions:** the native OpenAI Decisions adapter from upstream 0.2.13 is not shipped in this fork; tracked in smarty-dev#3155. This extension registers no OpenAI classifier and sends no OpenAI API key anywhere. A classifier registered by the Pi host itself is only used if you select it explicitly, and every `openai_decide` request still requires the per-call confirmation below.

### Optional bounded tool

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
- **Per-call confirmation.** The model chooses `state`, so every `openai_decide` request is confirmed before anything leaves the machine. Interactive sessions show a dialog with the destination (provider/model and endpoint host), the total request size, the question names, and a preview of the exact JSON state (first 2,000 characters). Declining fails the tool with "declined by user" and sends nothing. Without a UI (print/JSON/RPC mode) requests are refused unless `decisions.allowWithoutConfirmation` is `true` (default `false`); only set it for unattended runs whose inputs you trust. This applies to every configured classifier.
- `questions`: 1–32 named questions. `choice` uses 2–64 labeled criteria; `bool` uses `true`/`false` criteria; `score` uses 2–64 ordered criteria. Pi maps boolean questions to the provider's representation (for example, Jev's `noul`).
- Total input is capped at 64 KiB. `decisions.timeoutMs` defaults to 10000 and is clamped to 1000–60000. Cancellation/deadlines abort the provider request; there are no automatic retries. A timed-out upstream request may still incur charges.
- Results have `status: "ok"`, provider/model provenance, and typed `answers`; errors have `status: "error"` and mark the tool failed. Structured output is available to programmatic callers. Provider error text is withheld to prevent credential/state leakage.
- Probabilities and confidence remain uncertain judgments; scores retain their provider-specific scale. No claim of cross-provider calibration is made. Decisions never authorize tools, execute commands, change the active model, or start background polling.
- Reported classifier token usage/cost is included in tool results and the Better OpenAI footer. Missing usage or catalog pricing is not evidence that a request was free.

## Codex model fallbacks

These fallbacks remain scoped to the legacy provider. The native `openai` provider and its catalog are not replaced or redirected to Codex.

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
