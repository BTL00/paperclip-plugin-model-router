# paperclip-plugin-model-router — working notes

Public, MIT, open source: it doubles as a portfolio/marketing piece. Write code, commits and docs as if strangers will read them. Never commit secrets, local IDs, hostnames or anything from a private setup; those go in `CLAUDE.local.md` (gitignored).

## Goal
A Paperclip plugin that picks the model (and reasoning effort) for each agent run from the task itself, clamped to a per-agent **min** and **max** model. Default classifier: TypeSafe's Jev (System One decision model), with a fallback when no key is set.

## Findings so far (Paperclip source at commit 3be5453, 2026-10-27)
Read the Paperclip source (`paperclipai/paperclip`, see `CLAUDE.local.md` for the local checkout) before trusting these; they decide the architecture.

1. **Plugin events are async notifications**, not pre-run hooks: `issue.created`, `issue.updated`, `issue.assignment_wakeup_requested`, `agent.run.started`, ... (`packages/shared/src/constants.ts`, `PLUGIN_EVENT_TYPES`).
2. **Per-issue overrides exist and are applied at run time**: `issue.assigneeAdapterOverrides.adapterConfig` is merged into the adapter config when a heartbeat run is prepared (`server/src/services/heartbeat.ts`, around `parseIssueAssigneeAdapterOverrides`; parser in `server/src/services/execution-workspace-policy.ts`). Keys `model` and `effort` (claude_local), `model`/`variant` (opencode_local) and `modelReasoningEffort` (codex) are honoured unless the agent uses an AI-connection router binding.
3. **SDK gap**: `ctx.issues.create` accepts `assigneeAdapterOverrides`, `ctx.issues.update` does not (`packages/plugins/sdk/src/types.ts`, the `update(issueId, patch...)` signature). Options: (a) REST `PATCH /api/issues/:id` with `assigneeAdapterOverrides` through `http.outbound`; (b) an upstream PR adding it to the SDK update patch. (b) is the clean fix and a good OSS contribution; (a) unblocks us now.
4. **Race to measure**: assignment wakes the agent immediately, and the classification (~300 ms) may land after the run has read the issue. Measure first. Mitigations: classify on `issue.created` (before assignment, where possible); re-apply on retries and follow-up wakes; or the synchronous path below.
5. **Synchronous alternative**: the `ai.connections.route` capability + `onRouteAiConnection` (`server/src/services/ai-connection-router.ts`, types in `packages/shared/src/ai-connection-router.ts`). The host calls it before a run with `agentId`, `taskKey` and candidate pool members (each with a `runtimeConfig` incl. `model`). It's designed for spreading load across *accounts*, but a pool whose members are the same account at different models could make it a per-task model router with no race. Investigate: can a pool hold one account several times, and does `taskKey` map to the issue?
6. Reference policy to port: Claude Code mod `jev-model-router` (`hooks/policy.ts`, MIT, credit it): three questions in one request (tier `choice`, effort `score`, risky `noul`), asymmetric bars (up 0.3, down 0.6), risky > 0.7 → max, backends with no confidence may only route up, any failure leaves the request unchanged. TypeSafe endpoint `POST https://api.typesafe.ai/v1/systemone`, model `jev-latest`.

## Design (to confirm)
- Company settings: model ladder (fast/balanced/deep → model ids per adapter type), confidence bars, TypeSafe key as a **secret reference** (`secrets.read-ref`), excluded agents.
- Per-agent: min model, max model, effort range. Clamp the decision into it.
- Every decision recorded: an issue comment or plugin state + an issue detail tab ("routed to Sonnet / medium, confidence 0.71, 280 ms"), and a dashboard widget with estimated savings from `cost_event.created`.
- Fallback classifier without a key: a simple heuristic or a local OpenAI-compatible endpoint; it may only route *up*.
- Privacy: only title + description are sent; excluded agents are never sent.

## Build and test
- Scaffold from the SDK (`@paperclipai/plugin-sdk` on npm, reference examples in the Paperclip repo under `packages/plugins/examples/`), TypeScript, `node >= 24.11`.
- Unit-test the policy (pure functions, no I/O) like the mod does; use `@paperclipai/plugin-sdk/testing` (`createTestHarness`) for the worker.
- Install into the local Paperclip instance for end-to-end tests (details in `CLAUDE.local.md`).
