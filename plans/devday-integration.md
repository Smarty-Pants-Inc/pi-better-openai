# DevDay integration status

Research checkpoint: September 29, 2026 (UTC). Announcements and account entitlements can change independently of source releases.

## Implemented

- GPT-6.1 Sol fallback metadata, with native Pi transport/auth and live catalog precedence preserved.
- Fast-mode defaults for GPT-6 Astra, 6.1 Sol, Sol, and Luna on OpenAI/Codex.
- Explicit Standard/Fast/Ultrafast selection, legacy state migration, model/endpoint capability gates, persistence, diagnostics, cost disclosure, and footer labels.
- `openai_decide`: an opt-in bridge to Pi's classifier API. Explicit model selection, bounded typed input/output, cancellation/deadlines, usage reporting, and no chat/provider fallback.
- No autonomous actions, model routing, approval bypasses, or inference-driven polling. Classification is an advisory primitive; application code owns policy and execution.

## Native OpenAI Decisions: blocked on a verifiable contract

The announcement is reported in [DevDay coverage](https://www.axios.com/2026/09/29/openai-dev-day-2026-dots-space-sol). At the research checkpoint, the public docs index and OpenAI Node SDK did not expose a verifiable Decisions contract; Codex search hits concerned existing approval decisions. This is not proof that private or later access is unavailable.

The tool works with explicitly selected registered classifiers, including Jev. It does not pretend this is OpenAI's new service. Once OpenAI publishes its contract:

1. Verify model IDs, schema, error/refusal behavior, modalities, endpoint, auth audience, rate limits, pricing, and data residency.
2. Prefer a native Pi classifier adapter rather than duplicating credentials and transport here. Register classifier models, not chat models; the current tool can then select them.
3. Preserve provider semantics. Do not equate arbitrary numeric scores or self-reported confidence with calibrated probabilities, or silently translate incompatible question types.
4. Keep API-key and Codex subscription access separate until subscription authorization is documented. Do not infer OAuth compatibility from a product announcement.
5. Add fixture tests and an opt-in live probe before claiming support. No default model ID is guessed today.

### Evaluation checklist

Before automated routing or background triage is enabled, compare pinned Jev/OpenAI classifier versions on the same consented, non-sensitive labeled cases:

- failure classification, candidate-tool ranking, task routing, and notification relevance;
- p50/p95 end-to-end latency, cost per useful decision, invalid-result/refusal/timeout rates;
- accuracy and abstention coverage; Brier score/calibration only for outputs documented as probabilities;
- low-confidence escalation and immutable policy/permission boundaries.

Do not automatically run paid benchmark requests. A typed result is not proof of truth or authorization. TypeSafe's [September 15 Jev announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev) establishes timing and the decision-oriented interface, not OpenAI implementation provenance.

## Codex subscription Ultrafast: capability gate remains closed

The [public Ultrafast guide](https://developers.openai.com/api/docs/guides/ultrafast-mode) documents API Astra support. Codex has catalog-driven tier controls and WebSocket tier-switch tests, but its inspected bundled Astra/Sol catalog advertises Fast, not a subscription Ultrafast entitlement.

Enable subscription Ultrafast only after an authenticated model/account capability contract is established, with tests for account switching, capability withdrawal, and unsupported requests. Arbitrary `supportedModels` configuration must not bypass this gate. Global/US API Astra is the verified path today. Host cost reporting currently may omit its 6x premium; never describe local estimates as actual billing.

## Hosted Responses multi-agent: deliberately deferred

[Responses multi-agent](https://developers.openai.com/api/docs/guides/responses-multi-agent) is a separate beta protocol, not a tier or ordinary thinking level. Adding only `multi_agent.enabled` is insufficient and could conflict with Fabric's orchestration.

A future opt-in integration must handle agent identities, hosted collaboration items versus client tool calls, interleaved streams, continuation routing, cancellation, concurrency and total-spend limits, and permission enforcement for every child. Do not assume `max_concurrent_subagents` limits total agents, tree depth, or total spend. Keep the existing local orchestration owner until these invariants are verified.

Dots, Space, and other consumer surfaces are not added without a documented integration contract.
