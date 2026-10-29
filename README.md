# paperclip-plugin-model-router

**Per-task model routing for [Paperclip](https://github.com/paperclipai/paperclip) agents.** Most agent runs don't need your biggest model. This plugin reads each task before the agent picks it up, decides how hard it is, and runs the agent with the cheapest model and reasoning effort that can do it well. Each agent can be given its own **min** and **max** model.

> Status: early work in progress. The policy and worker are written and unit-tested; end-to-end testing on a live Paperclip instance is next.

A typo fix doesn't need the deepest model, and a production incident shouldn't run on the cheapest one. The router reads an issue's title and description, asks a decision model three questions, and writes the result as a per-issue adapter override. Paperclip merges that override into the agent's config when it prepares the run.

## How it decides

One request to [TypeSafe](https://typesafe.ai)'s Jev decision model asks three questions:

| Question | Type | Used for |
|---|---|---|
| Cheapest tier that can do this well: fast / balanced / deep | choice | model |
| How much step-by-step reasoning it needs (0–3) | score | effort: low / medium / high / xhigh |
| Would carrying it out change production, move money, or destroy data? | probability | above 0.7, forces the deepest allowed tier and at least `high` effort |

Every answer comes with a calibrated confidence, and the bars are asymmetric:

- Spending more (a bigger model, more effort) needs confidence ≥ 0.3.
- Spending less needs ≥ 0.6, because under-powering a task is the costlier mistake.

The result is then clamped to the agent's range.

Without a TypeSafe key, a keyword heuristic stands in. It reports no confidence, so it may route **up** but never down. Any failure (timeout, bad answer, unreadable secret) leaves the agent as it is: routing is an optimisation and never blocks work.

## What it writes

| Adapter | Model key | Effort key |
|---|---|---|
| `claude_local` | `model` | `effort` |
| `codex_local` | `model` | `modelReasoningEffort` |
| `opencode_local` | `model` | `variant` |

The router follows four rules when it writes:

- It never overwrites a model or effort a person set on the issue.
- When the issue is reassigned, it removes the keys it wrote, so a model id never carries over to another agent.
- When it changes something, it comments on the issue, e.g.: `Model router: model opus, effort high. tier deep (0.82) · effort 2.1 → high (0.74) · risky 0.04 · 280 ms · jev · deep (confidence 0.82)`
- Agents are routed only when listed (opt-in). Excluded agents are never classified, so their task text is never sent anywhere.

## Configuration

```jsonc
{
  "typesafeApiKey": { "type": "secret_ref", "secretId": "<paperclip secret id>" },
  "agents": [
    { "agentId": "<uuid>", "minTier": "fast", "maxTier": "balanced", "maxEffort": "high" }
  ],
  "excludedAgentIds": ["<uuid of an agent handling private data>"],
  "ladders": {
    "claude_local": { "fast": "haiku", "balanced": "sonnet", "deep": "opus" },
    "codex_local": { "fast": "<id>", "balanced": "<id>", "deep": "<id>" }
  },
  "minUpgradeConfidence": 0.3,
  "minDowngradeConfidence": 0.6,
  "riskyThreshold": 0.7,
  "assumeTierWhenUnset": "balanced",
  "comment": true
}
```

- **`ladders`:** `claude_local` defaults to the `haiku` / `sonnet` / `opus` aliases. Other adapters are skipped until you configure their ladder.
- **`assumeTierWhenUnset`:** the tier assumed for an agent with no model set, so a move below it counts as a downgrade.

## Known limitation: the race

Paperclip has no synchronous pre-run hook for choosing a model. `issue.created` and the assignment wake-up are both fire-and-forget, so on a freshly created and assigned issue the first run can start before the override lands. Later runs on the issue (follow-ups, retries) always get it.

The plugin measures this. Each issue's state records whether the decision landed `before-run` or `after-run`, and the instance state key `race-stats` keeps the totals.

The AI-connection router hook was examined as an alternative. It can't pick a model: it chooses between pool members that are distinct accounts, and the choice is pinned per task.

## Development

```sh
npm install
npm test        # vitest: pure policy + worker via the SDK test harness
npm run typecheck
npm run build   # dist/manifest.js, dist/worker.js
```

Requires Node ≥ 24.11.

## Privacy

With a TypeSafe key, the plugin sends the task's title and description to TypeSafe for classification, and nothing else. Excluded agents are never classified, and without a key nothing leaves your Paperclip instance.

## Credits

The routing policy is adapted from the MIT-licensed [jev-model-router](https://github.com/davila7/claude-code-templates) mod for Claude Code: the question wording, asymmetric confidence bars and "risky means max".

## License

MIT, see [LICENSE](LICENSE). Built by [Piotr Bomba](https://piotrbomba.com).
