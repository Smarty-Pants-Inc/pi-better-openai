# DevDay integration status

Research checkpoint: September 29, 2026 (UTC). Announcements and account entitlements can change independently of source releases.

## Implemented

- GPT-6.1 Sol fallback metadata, with native Pi transport/auth and live catalog precedence preserved.
- Fast-mode defaults for GPT-6 Astra, 6.1 Sol, Sol, and Luna on OpenAI/Codex.
- Explicit Standard/Fast/Ultrafast selection, legacy state migration, model/endpoint capability gates, persistence, diagnostics, cost disclosure, and footer labels.
- `openai_decide`: an opt-in bridge to Pi's classifier API. Explicit model selection, bounded typed input/output, cancellation/deadlines, usage reporting, and no chat/provider fallback.
- No autonomous actions, model routing, approval bypasses, or inference-driven polling. Classification is an advisory primitive; application code owns policy and execution.

## Native OpenAI Decisions: compatibility adapter available

The [public Decisions guide](https://developers.openai.com/api/docs/guides/decisions) now documents `POST /v1/decisions`, `gpt-6-luna`, predicates/choices/scores, inline image inputs, refusals, and input-only pricing. This supersedes the original research checkpoint above.

Pi 1.1.0, now pinned for development, ships `packages/ai/src/api/openai-decisions.ts` and the `openai` classifier registration. `src/openai-decisions.ts` provides compatibility through the same native classifier contract; it skips registration entirely when the host provides Decisions. Remove the shim once the minimum supported host ships the adapter.

- OpenAI chat transport, catalog, and native credential resolution are retained. Only the missing classifier operation is added. OAuth discovery excludes Decisions; API-key access is required, with no Codex credential substitution or chat fallback.
- Native codemode and Fabric call `modelRegistry.classify`; no separate decision tool protocol is required. Native requests support optional inline `images`. The bounded `openai_decide` wrapper remains JSON-state-only and opt-in.
- Typed result mapping preserves predicates, choice distributions, zero-based expected scores, error/aborted stop reasons, and billed usage, including refusals. Provider hooks, header overrides, cancellation, HTTP retry budgets, and long-context costs are covered by offline fixtures.
- `bun run test:pi` exercises real Pi loading, credential isolation, and codemode text/image requests with synthetic HTTP. Fabric's native-codemode tests cover the same context shape in QuickJS, Node, and Bun. No paid live request or account entitlement is implied by these tests.
- The provider's default HTTP retry policy is independent of the optional wrapper, which sends `maxRetries: 0` and enforces its own deadline. Neither interface authorizes actions.

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
