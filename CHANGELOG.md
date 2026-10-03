# Changelog

## 0.2.9

- Validate Pi 1.0.0 with exact development pins and wildcard host peers.
- Exercise real-host registration, startup, and repeated shutdown offline.
- Scope Vitest to owned tests so ignored research checkouts do not enter release checks.

## 0.2.8

- Add GPT-6.1 Sol fallback metadata and Fast support for the GPT-6 model family.
- Add `/openai-tier` for Standard, Fast, and capability-gated API Astra Ultrafast, with explicit pricing warnings, persistence, diagnostics, and footer labels.
- Add opt-in `openai_decide` and `/openai-decisions` through Pi's classifier API, with typed validation, cancellation, safe errors, and usage accounting.
- Include classifier tool usage in footer totals and preserve legacy Fast settings and customized model lists.
- Document remaining native OpenAI Decisions, Codex subscription Ultrafast, and hosted multi-agent integration gates; no undocumented endpoint or chat fallback is assumed.

## 0.2.7

- Validate against Pi 0.99.0, including an offline real-host package-loading probe.
- Declare imported host packages as wildcard peers and pin development dependencies to Pi 0.99.0.
