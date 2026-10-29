import { describe, expect, test } from 'vitest'
import {
  DEFAULT_POLICY,
  NO_BOUNDS,
  describeDecision,
  effortLevel,
  effortRank,
  readDecision,
  requestBody,
  route,
  taskState,
  toOverrides,
  type Bounds,
  type Decision,
  type Ladder,
} from '../src/policy.js'
import { classifyHeuristically, classifyWithJev } from '../src/classify.js'
import { parseConfig } from '../src/config.js'

const ladder: Ladder = { fast: 'haiku', balanced: 'sonnet', deep: 'opus' }

const decision = (overrides: Partial<Decision> = {}): Decision => ({
  tier: 'balanced',
  confidence: 0.9,
  risky: 0.01,
  effort: 1,
  effortConfidence: 0.9,
  ...overrides,
})

const on = (model: string, effort?: unknown) => ({ model, effort })
const run = (d: Decision | null, current = on('sonnet', 'medium'), bounds: Bounds = NO_BOUNDS) =>
  route(d, current, ladder, bounds, DEFAULT_POLICY)

const typesafeAnswer = (tier: string, confidence: number, risky = 0.02, effort = 1.2) =>
  JSON.stringify({
    answers: {
      tier: { choice: tier, confidence },
      effort: { score: effort, confidence: 0.8 },
      risky: { noul: risky, confidence: 0.9 },
    },
  })

describe('reading answers', () => {
  test('a TypeSafe answer is read from its own confidence and noul fields', () => {
    expect(readDecision(typesafeAnswer('deep', 0.81, 0.3, 2.4))).toEqual({
      tier: 'deep',
      confidence: 0.81,
      risky: 0.3,
      effort: 2.4,
      effortConfidence: 0.8,
    })
  })

  test('malformed or unexpected payloads read as no decision rather than throwing', () => {
    expect(readDecision('not json')).toBeNull()
    expect(readDecision('null')).toBeNull()
    expect(readDecision('{}')).toBeNull()
    expect(readDecision(JSON.stringify({ answers: { tier: { choice: 'huge' } } }))).toBeNull()
  })

  test('the request sends only the task title and description', () => {
    const body = JSON.parse(requestBody(taskState('Fix login', 'Users see a 500')))
    expect(body.model).toBe('jev-latest')
    expect(body.state).toEqual({ task: { title: 'Fix login', description: 'Users see a 500' } })
    expect(Object.keys(body.questions)).toEqual(['tier', 'effort', 'risky'])
    expect(body.questions.risky.type).toBe('noul')
  })
})

describe('routing', () => {
  test('spending less needs the high bar; the same confidence is enough to spend more', () => {
    expect(run(decision({ tier: 'fast', confidence: 0.5 })).model).toBeNull()
    expect(run(decision({ tier: 'deep', confidence: 0.5 })).model).toBe('opus')
    expect(run(decision({ tier: 'fast', confidence: 0.7 })).model).toBe('haiku')
  })

  test('effort moves in both directions on its own confidence', () => {
    expect(run(decision({ effort: 2.6, effortConfidence: 0.4 })).effort).toBe('xhigh')
    expect(run(decision({ effort: 0, effortConfidence: 0.4 })).effort).toBeNull()
    expect(run(decision({ effort: 0, effortConfidence: 0.7 })).effort).toBe('low')
  })

  test('a numeric effort is the caller\'s own scale and is left alone', () => {
    expect(run(decision({ effort: 3 }), on('sonnet', 5)).effort).toBeNull()
  })

  test('the rubric score maps onto the reasoning ladder', () => {
    expect([0, 0.6, 1.4, 2.5, 3, 9].map(effortLevel)).toEqual(['low', 'medium', 'medium', 'xhigh', 'xhigh', 'xhigh'])
    expect(effortRank('max')).toBe(4)
    expect(effortRank('weird')).toBeNull()
  })

  test('a risky task takes the deep tier and real reasoning, past both thresholds', () => {
    const routed = run(decision({ tier: 'fast', confidence: 0.99, risky: 0.9, effort: 0 }))
    expect(routed.model).toBe('opus')
    expect(routed.effort).toBe('high')
    expect(routed.reason).toContain('forced by risk')
  })

  test('risk raises the effort floor but never lowers one', () => {
    expect(run(decision({ risky: 0.9, effort: 0 }), on('opus', 'xhigh')).effort).toBeNull()
    expect(run(decision({ risky: 0.9, effort: 0 }), on('opus', 'max')).effort).toBeNull()
  })

  test('without a confidence a change may only go up, never down', () => {
    const blind = decision({ confidence: null, effortConfidence: null })
    expect(run({ ...blind, tier: 'deep' }).model).toBe('opus')
    expect(run({ ...blind, tier: 'fast', effort: 0 })).toMatchObject({ model: null, effort: null })
  })

  test('no decision, and a decision that changes nothing, both leave the agent as it is', () => {
    expect(run(null)).toEqual({ model: null, effort: null, reason: 'no decision' })
    const same = run(decision())
    expect(same).toMatchObject({ model: null, effort: null })
    expect(same.reason).toBe('kept sonnet/medium, wanted balanced (confidence 0.90)')
  })

  test('an agent with no model set is assumed to be on the configured tier', () => {
    expect(run(decision({ tier: 'fast', confidence: 0.5 }), on('')).model).toBeNull()
    expect(run(decision({ tier: 'fast', confidence: 0.7 }), on('')).model).toBe('haiku')
  })

  test('a full id is placed by the alias it contains, and its own tier is kept as written', () => {
    const full = on('claude-sonnet-5-5', 'medium')
    expect(run(decision({ tier: 'fast', confidence: 0.4 }), full).model).toBeNull()
    expect(run(decision({ risky: 0.9 }), full).model).toBe('opus')
    expect(run(decision({ tier: 'balanced', risky: 0.9 }), full, { ...NO_BOUNDS, maxTier: 'balanced' }).model).toBeNull()
  })

  test('a model that is not on the ladder is treated as an upgrade, not guessed at', () => {
    expect(run(decision({ tier: 'fast', confidence: 0.4 }), on('gpt-unknown')).model).toBe('haiku')
  })
})

describe('bounds', () => {
  const cheap: Bounds = { minTier: 'fast', maxTier: 'balanced', minEffort: 'low', maxEffort: 'medium' }
  const serious: Bounds = { minTier: 'balanced', maxTier: 'deep', minEffort: 'medium', maxEffort: 'xhigh' }

  test('a wanted tier above the maximum is clamped, and the reason says so', () => {
    const routed = run(decision({ tier: 'deep', effort: 3 }), on('haiku', 'low'), cheap)
    expect(routed.model).toBe('sonnet')
    expect(routed.effort).toBe('medium')
    expect(routed.reason).toContain('capped from deep')
  })

  test('risk never forces past the maximum', () => {
    const routed = run(decision({ risky: 0.95 }), on('haiku', 'low'), cheap)
    expect(routed.model).toBe('sonnet')
    expect(routed.effort).toBe('medium')
  })

  test('a wanted tier below the minimum is clamped up', () => {
    expect(run(decision({ tier: 'fast', effort: 0 }), on('sonnet', 'medium'), serious)).toMatchObject({
      model: null,
      effort: null,
    })
  })

  test('an agent whose own setting is outside the bounds is moved to the nearest bound', () => {
    // A confident "fast" can't go below balanced, and opus is above the max.
    const routed = run(decision({ tier: 'balanced', confidence: 0.1 }), on('opus', 'max'), cheap)
    expect(routed.model).toBe('sonnet')
    expect(routed.effort).toBe('medium')
  })
})

describe('overrides', () => {
  test('each adapter gets its own key names', () => {
    const routing = { model: 'm', effort: 'high' as const, reason: '' }
    expect(toOverrides('claude_local', routing)).toEqual({ model: 'm', effort: 'high' })
    expect(toOverrides('codex_local', routing)).toEqual({ model: 'm', modelReasoningEffort: 'high' })
    expect(toOverrides('opencode_local', routing)).toEqual({ model: 'm', variant: 'high' })
  })

  test('nothing to change writes nothing', () => {
    expect(toOverrides('claude_local', { model: null, effort: null, reason: '' })).toBeNull()
  })
})

describe('classifiers', () => {
  test('the heuristic reports no confidence, so it can only route up', () => {
    const fast = classifyHeuristically({ title: 'Fix typo in README', description: null })
    expect(fast.decision).toMatchObject({ tier: 'fast', confidence: null })
    expect(run(fast.decision)).toMatchObject({ model: null, effort: null })

    const deep = classifyHeuristically({
      title: 'Investigate production outage',
      description: 'Find the root cause of the deadlock in the payment worker.',
    })
    expect(deep.decision?.tier).toBe('deep')
    expect(run(deep.decision).model).toBe('opus')
  })

  test('Jev failures read as no decision and never leak the key', async () => {
    const task = { title: 't', description: null }
    const refused = await classifyWithJev(task, 'sk-secret', async () => new Response('nope', { status: 401 }))
    expect(refused).toMatchObject({ decision: null, classifier: 'jev', error: 'TypeSafe answered 401' })
    const thrown = await classifyWithJev(task, 'sk-secret', async () => {
      throw new TypeError('fetch failed sk-secret')
    })
    expect(thrown.decision).toBeNull()
    expect(JSON.stringify(thrown)).not.toContain('sk-secret')
  })

  test('Jev gets the key as a bearer token and its answer is read', async () => {
    let seen: RequestInit | undefined
    const result = await classifyWithJev({ title: 't', description: 'd' }, 'sk-1', async (_url, init) => {
      seen = init
      return new Response(typesafeAnswer('deep', 0.8))
    })
    expect((seen?.headers as Record<string, string>).authorization).toBe('Bearer sk-1')
    expect(result.decision?.tier).toBe('deep')
  })

  test('the decision line carries every answer and the latency', () => {
    expect(describeDecision(decision({ effort: 1.2, effortConfidence: 0.66, risky: 0.02, confidence: 0.71 }), 280.4)).toBe(
      'tier balanced (0.71) · effort 1.2 → medium (0.66) · risky 0.02 · 280 ms',
    )
    expect(describeDecision(null, null)).toBe('no answer')
  })
})

describe('config', () => {
  test('defaults: claude ladder only, opt-in agents, comments on', () => {
    const config = parseConfig({})
    expect(config.ladders).toEqual({ claude_local: ladder })
    expect(config.agents.size).toBe(0)
    expect(config.comment).toBe(true)
    expect(config.typesafeApiKey).toBeNull()
  })

  test('bad values fall back and upside-down ranges are swapped', () => {
    const config = parseConfig({
      minDowngradeConfidence: 7,
      typesafeApiKey: 'plain-string-is-not-a-ref',
      agents: [{ agentId: 'a', minTier: 'deep', maxTier: 'fast', maxEffort: 'turbo' }, { minTier: 'fast' }],
      ladders: { codex_local: { fast: 'gpt-mini', deep: 'gpt' }, unknown_adapter: { fast: 'x' } },
    })
    expect(config.policy.minDowngradeConfidence).toBe(0.6)
    expect(config.typesafeApiKey).toBeNull()
    expect(config.agents.get('a')).toEqual({ minTier: 'fast', maxTier: 'deep', minEffort: 'low', maxEffort: 'xhigh' })
    expect(config.agents.size).toBe(1)
    expect(config.ladders.codex_local).toEqual({ fast: 'gpt-mini', balanced: '', deep: 'gpt' })
    expect(Object.keys(config.ladders)).not.toContain('unknown_adapter')
  })
})
