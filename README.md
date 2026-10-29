# paperclip-plugin-model-router

**Per-task model routing for [Paperclip](https://github.com/paperclipai/paperclip) agents.** Most agent runs don't need your biggest model. This plugin reads each task before the agent picks it up, decides how hard it is, and runs the agent with the cheapest model and reasoning effort that can do it well. Each agent can be given its own **min** and **max** model.

> Status: early work in progress. The design is below; the code is being written in the open.

## How it works

1. A task (Paperclip issue) is created or assigned to an agent.
2. The plugin asks a small decision model, by default **Jev** from [TypeSafe](https://typesafe.ai), three typed questions about the task:
   - **tier**: mechanical and local / ordinary engineering / hard or high-stakes;
   - **effort**: how much step-by-step reasoning it needs;
   - **risky**: does it touch production, money, credentials or something that cannot be undone?
3. It maps the answer onto a model ladder and **clamps it to the agent's min and max**.
4. The agent's run for that task uses that model and effort. Nothing else about the agent changes: not its instructions, permissions or environment.

Mistakes aren't equally costly, so it's cautious in the cheap direction:
- spending **more** needs only a low confidence (default 0.3);
- spending **less** needs a high one (default 0.6);
- a risky task always gets the agent's max model.

If the decision model can't be reached or is too slow, the run goes ahead unchanged. The router never blocks work.

## Configuration (planned)

| Setting | Scope | Example |
|---|---|---|
| Model ladder | company | `fast: claude-haiku-5-5`, `balanced: claude-sonnet-5-5`, `deep: claude-opus-5-5` |
| Min model / max model | per agent | Note Manager: min `haiku`, max `sonnet` |
| Effort range | per agent | `low` to `high` |
| Confidence bars | company | up 0.3, down 0.6, risky 0.7 |
| Backend | company | TypeSafe API key (secret reference), or a local fallback classifier |
| Excluded agents | company | agents whose tasks must never leave the machine |

## Privacy

With a TypeSafe key, the plugin sends the task's title and description to TypeSafe for classification, and nothing else. Agents can be excluded, and without a key nothing leaves your Paperclip instance.

## Credits

The routing policy is adapted from the MIT-licensed [jev-model-router](https://github.com/davila7/claude-code-templates) mod for Claude Code: asymmetric confidence bars and "risky means max".

## License

MIT, see [LICENSE](LICENSE). Built by [Piotr Bomba](https://piotrbomba.com).
