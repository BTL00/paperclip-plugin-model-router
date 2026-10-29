import {
  DEFAULT_POLICY,
  EFFORT_ORDER,
  NO_BOUNDS,
  TIER_ORDER,
  isAdapterType,
  type AdapterType,
  type Bounds,
  type Effort,
  type Ladder,
  type PolicyConfig,
  type Tier,
} from './policy.js'

export interface SecretRef {
  type: 'secret_ref'
  secretId: string
  version?: number | 'latest'
}

export interface RouterConfig {
  typesafeApiKey: SecretRef | null
  ladders: Partial<Record<AdapterType, Ladder>>
  policy: PolicyConfig
  /** Only these agents are routed; the router is opt-in per agent. */
  agents: Map<string, Bounds>
  /** Never routed and never classified, whatever `agents` says. */
  excludedAgentIds: Set<string>
  /** Post a comment on the issue when the router changes something. */
  comment: boolean
}

/**
 * Claude Code accepts family aliases for `--model`, so these stay valid as
 * new versions ship. Codex and OpenCode have no stable aliases, so their
 * ladders must be configured before those agents are routed.
 */
export const DEFAULT_LADDERS: Partial<Record<AdapterType, Ladder>> = {
  claude_local: { fast: 'haiku', balanced: 'sonnet', deep: 'opus' },
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function unit(value: unknown, fallback: number): number {
  return typeof value === 'number' && value >= 0 && value <= 1 ? value : fallback
}

function tier(value: unknown, fallback: Tier): Tier {
  return TIER_ORDER.includes(value as Tier) ? (value as Tier) : fallback
}

function effort(value: unknown, fallback: Effort): Effort {
  return EFFORT_ORDER.includes(value as Effort) ? (value as Effort) : fallback
}

export function isSecretRef(value: unknown): value is SecretRef {
  const ref = record(value)
  return ref.type === 'secret_ref' && typeof ref.secretId === 'string' && ref.secretId.length > 0
}

function ladder(value: unknown): Ladder | null {
  const raw = record(value)
  const parsed = { fast: string(raw.fast), balanced: string(raw.balanced), deep: string(raw.deep) }
  return parsed.fast || parsed.balanced || parsed.deep ? parsed : null
}

/**
 * Reads the operator's config. Lenient by design: a bad value falls back to
 * its default rather than failing the worker, and a range given upside down
 * is swapped rather than read as empty.
 */
export function parseConfig(raw: Record<string, unknown>): RouterConfig {
  const ladders: Partial<Record<AdapterType, Ladder>> = { ...DEFAULT_LADDERS }
  for (const [adapterType, value] of Object.entries(record(raw.ladders))) {
    const parsed = ladder(value)
    if (isAdapterType(adapterType) && parsed) ladders[adapterType] = parsed
  }

  const agents = new Map<string, Bounds>()
  for (const entry of Array.isArray(raw.agents) ? raw.agents : []) {
    const agent = record(entry)
    const agentId = string(agent.agentId)
    if (!agentId) continue
    let minTier = tier(agent.minTier, NO_BOUNDS.minTier)
    let maxTier = tier(agent.maxTier, NO_BOUNDS.maxTier)
    if (TIER_ORDER.indexOf(minTier) > TIER_ORDER.indexOf(maxTier)) [minTier, maxTier] = [maxTier, minTier]
    let minEffort = effort(agent.minEffort, NO_BOUNDS.minEffort)
    let maxEffort = effort(agent.maxEffort, NO_BOUNDS.maxEffort)
    if (EFFORT_ORDER.indexOf(minEffort) > EFFORT_ORDER.indexOf(maxEffort)) [minEffort, maxEffort] = [maxEffort, minEffort]
    agents.set(agentId, { minTier, maxTier, minEffort, maxEffort })
  }

  const excluded = Array.isArray(raw.excludedAgentIds) ? raw.excludedAgentIds : []

  return {
    typesafeApiKey: isSecretRef(raw.typesafeApiKey) ? raw.typesafeApiKey : null,
    ladders,
    policy: {
      minUpgradeConfidence: unit(raw.minUpgradeConfidence, DEFAULT_POLICY.minUpgradeConfidence),
      minDowngradeConfidence: unit(raw.minDowngradeConfidence, DEFAULT_POLICY.minDowngradeConfidence),
      riskyThreshold: unit(raw.riskyThreshold, DEFAULT_POLICY.riskyThreshold),
      assumeTierWhenUnset: tier(raw.assumeTierWhenUnset, DEFAULT_POLICY.assumeTierWhenUnset),
    },
    agents,
    excludedAgentIds: new Set(excluded.map(string).filter(Boolean)),
    comment: raw.comment !== false,
  }
}
