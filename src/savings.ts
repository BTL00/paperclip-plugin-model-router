/**
 * Estimated savings from routing. Pure: the worker queries the rows, this
 * prices them.
 *
 * Paperclip records tokens and cost per model but not a price list, so each
 * model's price is learned from this instance's own cost events. Anthropic
 * prices cached input at a tenth of input and output at five times input, so
 * one weighted token count per event leaves a single unknown per model: its
 * price per weighted token. The baseline is then the routed run's own tokens
 * priced at the agent's default model.
 *
 * It is an estimate: the same task on another model would not use exactly
 * the same tokens, and a change of effort alone saves nothing here.
 */

export const TOKEN_WEIGHTS = { input: 1, cachedInput: 0.1, output: 5 } as const

export interface Usage {
  model: string
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  costCents: number
}

export interface RoutedUsage extends Usage {
  issueId: string
  /** The model the agent would have run on without routing. */
  baselineModel: string
}

export interface Savings {
  actualCents: number
  baselineCents: number
  savedCents: number
  /** Issues whose cost could be priced against their baseline. */
  pricedIssues: number
  /** Issues left out: no observed price for the baseline, or a run billed at nothing. */
  unpricedIssues: number
}

export function weightedTokens(usage: Usage): number {
  return (
    usage.inputTokens * TOKEN_WEIGHTS.input +
    usage.cachedInputTokens * TOKEN_WEIGHTS.cachedInput +
    usage.outputTokens * TOKEN_WEIGHTS.output
  )
}

/** Cents per weighted token for each model with priced usage. */
export function modelRates(usages: readonly Usage[]): Map<string, number> {
  const totals = new Map<string, { cents: number; tokens: number }>()
  for (const usage of usages) {
    if (!(usage.costCents > 0)) continue
    const total = totals.get(usage.model) ?? { cents: 0, tokens: 0 }
    total.cents += usage.costCents
    total.tokens += weightedTokens(usage)
    totals.set(usage.model, total)
  }
  const rates = new Map<string, number>()
  for (const [model, total] of totals) if (total.tokens > 0) rates.set(model, total.cents / total.tokens)
  return rates
}

/**
 * The rate for a model id or alias. The agent's model and the cost events
 * may name the same model differently: `sonnet` on one side and
 * `claude-sonnet-5-5` on the other, either way round. So an alias contained
 * in exactly one priced id matches, and so does a priced alias (a name with
 * no version digits) contained in the model id.
 */
export function rateFor(model: string, rates: ReadonlyMap<string, number>): number | null {
  if (!model) return null
  const exact = rates.get(model)
  if (exact !== undefined) return exact
  const lowered = model.toLowerCase()
  const matches = [...rates.keys()].filter((id) => {
    const priced = id.toLowerCase()
    return priced.includes(lowered) || (!/\d/.test(priced) && lowered.includes(priced))
  })
  return matches.length === 1 ? (rates.get(matches[0] as string) ?? null) : null
}

export function estimateSavings(routed: readonly RoutedUsage[], rates: ReadonlyMap<string, number>): Savings {
  const byIssue = new Map<string, RoutedUsage[]>()
  for (const usage of routed) byIssue.set(usage.issueId, [...(byIssue.get(usage.issueId) ?? []), usage])

  const result: Savings = { actualCents: 0, baselineCents: 0, savedCents: 0, pricedIssues: 0, unpricedIssues: 0 }
  for (const all of byIssue.values()) {
    // A run that used no tokens (woken and finished at once) has nothing to price.
    const usages = all.filter((usage) => weightedTokens(usage) > 0)
    if (usages.length === 0) continue
    const baselineRate = rateFor(usages[0]?.baselineModel ?? '', rates)
    // A run billed at nothing (a subscription, or not priced yet) would
    // count its whole baseline as saved.
    if (baselineRate === null || usages.some((usage) => !(usage.costCents > 0))) {
      result.unpricedIssues += 1
      continue
    }
    const actual = usages.reduce((sum, usage) => sum + usage.costCents, 0)
    // Runs already on the baseline model cost what they cost; repricing them
    // at the averaged rate would invent a small saving or loss.
    const baseline = usages.reduce(
      (sum, usage) =>
        sum + (rateFor(usage.model, rates) === baselineRate ? usage.costCents : weightedTokens(usage) * baselineRate),
      0,
    )
    result.actualCents += actual
    result.baselineCents += baseline
    result.pricedIssues += 1
  }
  result.savedCents = result.baselineCents - result.actualCents
  return result
}
