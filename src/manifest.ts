import type { PaperclipPluginManifestV1 } from '@paperclipai/plugin-sdk'

const tierEnum = { type: 'string', enum: ['fast', 'balanced', 'deep'] }
const effortEnum = { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'] }
const ladder = {
  type: 'object',
  properties: {
    fast: { type: 'string', title: 'Fast model id' },
    balanced: { type: 'string', title: 'Balanced model id' },
    deep: { type: 'string', title: 'Deep model id' },
  },
}

const manifest: PaperclipPluginManifestV1 = {
  id: 'btl00.model-router',
  apiVersion: 1,
  version: '0.1.0',
  displayName: 'Model Router',
  description:
    'Picks the model and reasoning effort for each agent run from the task itself, clamped to a per-agent minimum and maximum.',
  author: 'Piotr Bomba',
  categories: ['automation'],
  capabilities: [
    'events.subscribe',
    'issues.read',
    'issues.update',
    'issue.comments.create',
    'agents.read',
    'plugin.state.read',
    'plugin.state.write',
    'secrets.read-ref',
    'http.outbound',
  ],
  entrypoints: {
    worker: './dist/worker.js',
  },
  instanceConfigSchema: {
    type: 'object',
    properties: {
      typesafeApiKey: {
        type: 'string',
        format: 'secret-ref',
        title: 'TypeSafe API key',
        description:
          'A Paperclip secret holding a TypeSafe key. Without it a keyword heuristic is used, which may only route up.',
      },
      ladders: {
        type: 'object',
        title: 'Model ladders',
        description:
          'Model id per tier for each adapter type. claude_local defaults to haiku / sonnet / opus; other adapters are skipped until configured.',
        properties: {
          claude_local: ladder,
          codex_local: ladder,
          opencode_local: ladder,
        },
      },
      agents: {
        type: 'array',
        title: 'Routed agents',
        description: 'Only these agents are routed. Each gets a tier and effort range the decision is clamped to.',
        items: {
          type: 'object',
          required: ['agentId'],
          properties: {
            agentId: { type: 'string' },
            minTier: { ...tierEnum, default: 'fast' },
            maxTier: { ...tierEnum, default: 'deep' },
            minEffort: { ...effortEnum, default: 'low' },
            maxEffort: { ...effortEnum, default: 'xhigh' },
          },
        },
      },
      excludedAgentIds: {
        type: 'array',
        title: 'Excluded agents',
        description: 'Never routed and never classified. Use it for agents whose tasks hold private data.',
        items: { type: 'string' },
      },
      minUpgradeConfidence: { type: 'number', minimum: 0, maximum: 1, default: 0.3 },
      minDowngradeConfidence: { type: 'number', minimum: 0, maximum: 1, default: 0.6 },
      riskyThreshold: { type: 'number', minimum: 0, maximum: 1, default: 0.7 },
      assumeTierWhenUnset: { ...tierEnum, default: 'balanced' },
      comment: {
        type: 'boolean',
        title: 'Comment on routed issues',
        default: true,
      },
    },
  },
}

export default manifest
