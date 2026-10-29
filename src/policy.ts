/**
 * Pure decision logic: no I/O, no Paperclip SDK. It builds the question set
 * for the decision model, reads its answer, and turns that answer into a
 * model and reasoning effort for one agent, clamped to that agent's limits.
 *
 * Ported from the `jev-model-router` Claude Code mod (MIT), which settled
 * the question wording, the asymmetric confidence bars and the risk rule
 * against real TypeSafe answers. What changed here: tiers are configured per
 * adapter type instead of guessed from family names, every result is clamped
 * to a per-agent range, and the output is a set of adapter config keys.
 */

export type Tier = 'fast' | 'balanced' | 'deep'

export const TIER_ORDER: readonly Tier[] = ['fast', 'balanced', 'deep']

/** The reasoning levels this router may ask for, cheapest first. */
export const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh'] as const

export type Effort = (typeof EFFORT_ORDER)[number]

/** Model id for each tier on one adapter type. An empty id disables the tier. */
export interface Ladder {
  fast: string
  balanced: string
  deep: string
}

/** The adapters whose per-issue overrides Paperclip honours for model and effort. */
export type AdapterType = 'claude_local' | 'codex_local' | 'opencode_local'

/**
 * Where each adapter reads model and effort from its config. Taken from the
 * adapters' own `execute.ts`: `effort` becomes `--effort` for Claude,
 * `modelReasoningEffort` becomes `-c model_reasoning_effort=` for Codex, and
 * `variant` becomes `--variant` for OpenCode.
 */
export const ADAPTER_KEYS: Record<AdapterType, { model: string; effort: string }> = {
  claude_local: { model: 'model', effort: 'effort' },
  codex_local: { model: 'model', effort: 'modelReasoningEffort' },
  opencode_local: { model: 'model', effort: 'variant' },
}

export function isAdapterType(value: unknown): value is AdapterType {
  return typeof value === 'string' && value in ADAPTER_KEYS
}

export interface Decision {
  tier: Tier
  /** Confidence in the tier, or null when the classifier reported none. */
  confidence: number | null
  /** P(true) that carrying the task out would itself be costly or final. */
  risky: number | null
  /** 0..3 along the effort rubric, or null when absent. */
  effort: number | null
  /** Confidence in the effort, or null when the classifier reported none. */
  effortConfidence: number | null
}

/**
 * How each tier is described to the decision model. About the shape of the
 * work, not model names: the decision model never sees an id.
 */
const TIER_CRITERIA: Record<Tier, string> = {
  fast: 'Mechanical and local: read or summarise a document, run one command, rename something, answer a question whose answer is already in the task.',
  balanced:
    'Ordinary work: implement a well-specified change, write tests, fix a clearly described bug, draft or edit a document from clear instructions, review a small change.',
  deep: 'Hard or high-stakes: architecture and design, debugging a failure whose cause is unknown, security, data migrations, concurrency, strategy, anything touching production or money.',
}

const EFFORT_RUBRIC = ['almost none', 'some', 'a lot', 'as much as possible'] as const

export const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone'
export const TYPESAFE_MODEL = 'jev-latest'

/** The three questions, asked in one request. */
export function questions(): Record<string, unknown> {
  return {
    tier: {
      type: 'choice',
      instructions: 'Which is the cheapest tier that can complete this task well?',
      criteria: TIER_CRITERIA,
    },
    effort: {
      type: 'score',
      instructions: 'How much step-by-step reasoning does this task need?',
      criteria: EFFORT_RUBRIC,
    },
    risky: {
      type: 'noul',
      // Asked about the act, not the subject. Asking whether the task
      // "touches production, money, credentials" scored 0.96 on ordinary code
      // that merely deals with payments, and escalated it for no reason.
      instructions:
        'Carrying out this task would itself change production, move real money, or alter data that cannot be restored. Writing or testing code that deals with such things, without running it against the real system, does not count.',
    },
  }
}

/** The state the decision model sees: the task's title and description, nothing else. */
export function taskState(title: string, description: string | null): Record<string, unknown> {
  return { task: { title, description: description ?? '' } }
}

export function requestBody(state: Record<string, unknown>, model = TYPESAFE_MODEL): string {
  return JSON.stringify({ model, state, questions: questions() })
}

function isTier(value: unknown): value is Tier {
  return value === 'fast' || value === 'balanced' || value === 'deep'
}

/** Reads a TypeSafe answer. Anything malformed reads as no decision. */
export function readDecision(responseText: string): Decision | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(responseText)
  } catch {
    return null
  }
  const answers = (parsed as { answers?: Record<string, Record<string, unknown>> } | null)?.answers
  if (!answers) return null

  const tierAnswer = answers.tier
  if (!tierAnswer || !isTier(tierAnswer.choice)) return null

  const effortAnswer = answers.effort
  const riskyAnswer = answers.risky
  return {
    tier: tierAnswer.choice,
    confidence: numberOrNull(tierAnswer.confidence),
    effort: numberOrNull(effortAnswer?.score),
    effortConfidence: numberOrNull(effortAnswer?.confidence),
    risky: numberOrNull(riskyAnswer?.noul),
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** The rubric score (0..3) as a reasoning level. */
export function effortLevel(score: number): Effort {
  const index = Math.min(EFFORT_ORDER.length - 1, Math.max(0, Math.round(score)))
  return EFFORT_ORDER[index] as Effort
}

/**
 * Where a reasoning level sits on the ladder, or null when unknown. `max`
 * ranks above every level the rubric can produce without joining
 * EFFORT_ORDER, which is also the set of values this router may write.
 */
export function effortRank(effort: unknown): number | null {
  if (typeof effort !== 'string') return null
  if (effort === 'max') return EFFORT_ORDER.length
  const index = EFFORT_ORDER.indexOf(effort as Effort)
  return index === -1 ? null : index
}

/**
 * Where a model id sits on the ladder, or null when it is not on it. An exact
 * match wins; otherwise a ladder entry contained in the id counts, so the
 * alias `sonnet` places `claude-sonnet-5-5`, which agents are often set to.
 */
export function rankOf(model: string, ladder: Ladder): number | null {
  if (!model) return null
  const exact = TIER_ORDER.findIndex((tier) => ladder[tier] === model)
  if (exact !== -1) return exact
  const lowered = model.toLowerCase()
  const partial = TIER_ORDER.findIndex((tier) => ladder[tier] && lowered.includes(ladder[tier].toLowerCase()))
  return partial === -1 ? null : partial
}

export interface Bounds {
  minTier: Tier
  maxTier: Tier
  minEffort: Effort
  maxEffort: Effort
}

export const NO_BOUNDS: Bounds = { minTier: 'fast', maxTier: 'deep', minEffort: 'low', maxEffort: 'xhigh' }

export interface PolicyConfig {
  /**
   * How sure the decision must be to spend more. Being wrong here costs
   * money, so the bar is low.
   */
  minUpgradeConfidence: number
  /**
   * How sure it must be to spend less. Being wrong here means a task handled
   * by too small a model or too little thought, so the bar is high.
   */
  minDowngradeConfidence: number
  /** Above this P(risky), take the deepest allowed tier and at least `high` effort. */
  riskyThreshold: number
  /**
   * The tier assumed when an agent has no model set (the adapter default),
   * so moving below it counts as a downgrade and needs the strict bar.
   */
  assumeTierWhenUnset: Tier
}

export const DEFAULT_POLICY: PolicyConfig = {
  minUpgradeConfidence: 0.3,
  minDowngradeConfidence: 0.6,
  riskyThreshold: 0.7,
  assumeTierWhenUnset: 'balanced',
}

/** What the agent would run with if nothing were routed. */
export interface Current {
  model: string
  effort?: unknown
}

export interface Routing {
  /** The model to run on, or null to leave it as it is. */
  model: string | null
  /** The reasoning level to ask for, or null to leave it as it is. */
  effort: Effort | null
  /** Why, for the comment and the log. */
  reason: string
}

const NOTHING: Routing = { model: null, effort: null, reason: 'no decision' }

function clampIndex(index: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, index))
}

/**
 * Whether a change of rank passes its threshold. Both directions are allowed
 * but do not clear the same bar, because the two mistakes do not cost the
 * same. A move whose direction cannot be told is treated as an upgrade.
 */
function allowed(wanted: number, current: number | null, confidence: number | null, config: PolicyConfig): boolean {
  if (current !== null && wanted === current) return false
  const isDowngrade = current !== null && wanted < current
  // A classifier that reports no confidence (the heuristic fallback) clears
  // the upgrade bar but never the downgrade one: spending less on an
  // unmeasured hunch is the bad trade.
  if (confidence === null) return !isDowngrade
  return confidence >= (isDowngrade ? config.minDowngradeConfidence : config.minUpgradeConfidence)
}

/**
 * Turns a decision into a model and a reasoning level for one agent. Either
 * may be null to leave the agent's own setting in place.
 *
 * The bounds are hard: a wanted tier outside them is clamped before any
 * threshold is checked, and an agent whose own setting lies outside them is
 * moved to the nearest bound whatever the decision's confidence. Risk forces
 * the deepest tier the bounds allow, never past them.
 */
export function route(
  decision: Decision | null,
  current: Current,
  ladder: Ladder,
  bounds: Bounds,
  config: PolicyConfig,
): Routing {
  if (!decision) return NOTHING

  const minTier = TIER_ORDER.indexOf(bounds.minTier)
  const maxTier = TIER_ORDER.indexOf(bounds.maxTier)
  const minEffort = EFFORT_ORDER.indexOf(bounds.minEffort)
  // The top of the ladder as a maximum means no cap: an agent set to `max`
  // stays there rather than being pulled down to `xhigh`.
  const maxEffort =
    bounds.maxEffort === EFFORT_ORDER[EFFORT_ORDER.length - 1]
      ? EFFORT_ORDER.length
      : EFFORT_ORDER.indexOf(bounds.maxEffort)

  let tierIndex = TIER_ORDER.indexOf(decision.tier)
  let effortScore = decision.effort
  const forced = decision.risky !== null && decision.risky > config.riskyThreshold
  if (forced) {
    tierIndex = TIER_ORDER.length - 1
    effortScore = Math.max(effortScore ?? 0, 2)
  }

  const wantedTierIndex = clampIndex(tierIndex, minTier, maxTier)
  const capped = wantedTierIndex !== tierIndex
  const wantedModel = ladder[TIER_ORDER[wantedTierIndex] as Tier]

  const currentTier = current.model
    ? rankOf(current.model, ladder)
    : TIER_ORDER.indexOf(config.assumeTierWhenUnset)

  let model: string | null = null
  const sameTier = wantedModel === current.model || wantedTierIndex === currentTier
  if (wantedModel && !sameTier && (forced || allowed(wantedTierIndex, currentTier, decision.confidence, config))) {
    model = wantedModel
  } else if (currentTier !== null && clampIndex(currentTier, minTier, maxTier) !== currentTier) {
    model = ladder[TIER_ORDER[clampIndex(currentTier, minTier, maxTier)] as Tier] || null
  }

  let effort: Effort | null = null
  // A numeric effort is the caller's own scale, not this ladder; leave it.
  const comparable = typeof current.effort !== 'number'
  const currentRank = effortRank(current.effort)
  if (comparable && effortScore !== null) {
    let wantedRank = EFFORT_ORDER.indexOf(effortLevel(effortScore))
    // Risk raises the floor; it must never lower one.
    if (forced && currentRank !== null) wantedRank = Math.max(wantedRank, currentRank)
    wantedRank = clampIndex(wantedRank, minEffort, maxEffort)
    if (wantedRank !== currentRank && (forced || allowed(wantedRank, currentRank, decision.effortConfidence, config))) {
      effort = EFFORT_ORDER[Math.min(wantedRank, EFFORT_ORDER.length - 1)] as Effort
    }
  }
  if (!effort && comparable && currentRank !== null && clampIndex(currentRank, minEffort, maxEffort) !== currentRank) {
    effort = EFFORT_ORDER[clampIndex(currentRank, minEffort, maxEffort)] as Effort
  }

  const tierName = TIER_ORDER[wantedTierIndex] as Tier
  const said = decision.confidence === null ? 'confidence n/d' : `confidence ${decision.confidence.toFixed(2)}`
  const why = forced ? `${tierName}, forced by risk` : `${tierName} (${said})`
  const cap = capped ? `, capped from ${TIER_ORDER[tierIndex]}` : ''

  if (!model && !effort) {
    const kept = `${current.model || 'default'}${current.effort === undefined ? '' : `/${String(current.effort)}`}`
    return { model: null, effort: null, reason: `kept ${kept}, wanted ${why}${cap}` }
  }
  const keptModel = model ? '' : `; model kept at ${current.model || 'default'}`
  return { model, effort, reason: `${why}${cap}${keptModel}` }
}

/** The adapter config keys a routing writes. Null when there is nothing to write. */
export function toOverrides(adapterType: AdapterType, routing: Routing): Record<string, string> | null {
  const keys = ADAPTER_KEYS[adapterType]
  const out: Record<string, string> = {}
  if (routing.model) out[keys.model] = routing.model
  if (routing.effort) out[keys.effort] = routing.effort
  return Object.keys(out).length > 0 ? out : null
}

function reported(value: number | null): string {
  return value === null ? 'n/d' : value.toFixed(2)
}

/** What the classifier answered, before any policy touches it. */
export function describeDecision(decision: Decision | null, ms: number | null): string {
  const took = ms === null ? '' : ` · ${Math.round(ms)} ms`
  if (!decision) return `no answer${took}`
  const parts = [`tier ${decision.tier} (${reported(decision.confidence)})`]
  if (decision.effort !== null) {
    parts.push(`effort ${decision.effort.toFixed(1)} → ${effortLevel(decision.effort)} (${reported(decision.effortConfidence)})`)
  }
  if (decision.risky !== null) parts.push(`risky ${reported(decision.risky)}`)
  return parts.join(' · ') + took
}
