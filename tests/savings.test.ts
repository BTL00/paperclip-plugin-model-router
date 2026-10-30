import { describe, expect, test } from 'vitest'
import { estimateSavings, modelRates, rateFor, weightedTokens, type RoutedUsage, type Usage } from '../src/savings.js'

const usage = (model: string, costCents: number, input = 1000, cached = 0, output = 0): Usage => ({
  model,
  inputTokens: input,
  cachedInputTokens: cached,
  outputTokens: output,
  costCents,
})

const routed = (issueId: string, baselineModel: string, u: Usage): RoutedUsage => ({ ...u, issueId, baselineModel })

describe('savings', () => {
  test('cached input counts a tenth and output five times', () => {
    expect(weightedTokens(usage('m', 0, 1000, 1000, 1000))).toBe(1000 + 100 + 5000)
  })

  test('each model is priced from its own history, ignoring unpriced events', () => {
    const rates = modelRates([usage('haiku', 10, 1000), usage('haiku', 10, 1000), usage('opus', 50, 1000), usage('free', 0, 1000)])
    expect(rates.get('haiku')).toBeCloseTo(0.01)
    expect(rates.get('opus')).toBeCloseTo(0.05)
    expect(rates.has('free')).toBe(false)
  })

  test('an alias finds the full model id, but only when exactly one matches', () => {
    const rates = new Map([
      ['claude-sonnet-5-5', 0.03],
      ['claude-opus-5', 0.05],
      ['claude-opus-5-5', 0.06],
    ])
    expect(rateFor('sonnet', rates)).toBe(0.03)
    expect(rateFor('claude-opus-5', rates)).toBe(0.05)
    expect(rateFor('opus', rates)).toBeNull()
    expect(rateFor('', rates)).toBeNull()
  })

  test('a downgraded issue saves the difference to its baseline model', () => {
    const rates = new Map([
      ['claude-haiku-5-5', 0.01],
      ['claude-sonnet-5-5', 0.03],
    ])
    const result = estimateSavings([routed('i1', 'sonnet', usage('claude-haiku-5-5', 10, 1000))], rates)
    expect(result).toEqual({ actualCents: 10, baselineCents: 30, savedCents: 20, pricedIssues: 1, unpricedIssues: 0 })
  })

  test('an upgraded issue shows as a negative saving', () => {
    const rates = new Map([
      ['claude-sonnet-5-5', 0.03],
      ['claude-opus-5-5', 0.06],
    ])
    const result = estimateSavings([routed('i1', 'claude-sonnet-5-5', usage('claude-opus-5-5', 60, 1000))], rates)
    expect(result.savedCents).toBeCloseTo(-30)
  })

  test('issues without a baseline price, or with a run billed at nothing, are left out', () => {
    const rates = new Map([['claude-haiku-5-5', 0.01]])
    const result = estimateSavings(
      [
        routed('no-price', 'sonnet', usage('claude-haiku-5-5', 10)),
        routed('free-run', 'claude-haiku-5-5', usage('claude-haiku-5-5', 0)),
      ],
      rates,
    )
    expect(result).toEqual({ actualCents: 0, baselineCents: 0, savedCents: 0, pricedIssues: 0, unpricedIssues: 2 })
  })

  test('several models on one issue are summed against one baseline', () => {
    const rates = new Map([
      ['claude-haiku-5-5', 0.01],
      ['claude-sonnet-5-5', 0.03],
    ])
    const result = estimateSavings(
      [
        routed('i1', 'claude-sonnet-5-5', usage('claude-haiku-5-5', 10, 1000)),
        routed('i1', 'claude-sonnet-5-5', usage('claude-sonnet-5-5', 30, 1000)),
      ],
      rates,
    )
    expect(result).toMatchObject({ actualCents: 40, baselineCents: 60, savedCents: 20, pricedIssues: 1 })
  })
})
