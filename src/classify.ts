import { readDecision, requestBody, taskState, TYPESAFE_URL, type Decision, type Tier } from './policy.js'

export type ClassifierName = 'jev' | 'heuristic'

export interface Classification {
  decision: Decision | null
  classifier: ClassifierName
  ms: number
  /** Why there is no decision, for the log. Never contains the key. */
  error?: string
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export interface Task {
  title: string
  description: string | null
}

/**
 * Asks Jev the three questions. Any failure (network, status, timeout, a
 * malformed body) comes back as no decision, which leaves the agent as it is.
 */
export async function classifyWithJev(
  task: Task,
  apiKey: string,
  fetchFn: Fetch,
  timeoutMs = 5000,
  now: () => number = performance.now.bind(performance),
): Promise<Classification> {
  const started = now()
  const done = (decision: Decision | null, error?: string): Classification => ({
    decision,
    classifier: 'jev',
    ms: now() - started,
    ...(error ? { error } : {}),
  })
  try {
    const response = await fetchFn(TYPESAFE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: requestBody(taskState(task.title, task.description)),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    if (!response.ok) return done(null, `TypeSafe answered ${response.status}`)
    const decision = readDecision(text)
    return decision ? done(decision) : done(null, 'unreadable TypeSafe answer')
  } catch (error) {
    return done(null, error instanceof Error ? error.name : 'request failed')
  }
}

const DEEP_WORDS = [
  'architecture', 'architect', 'design', 'security', 'vulnerab', 'migration', 'migrate', 'production',
  'incident', 'outage', 'root cause', 'investigate', 'debug', 'race condition', 'concurrency', 'deadlock',
  'strategy', 'refactor', 'performance', 'compliance', 'legal', 'contract',
]
const FAST_WORDS = [
  'typo', 'rename', 'summarise', 'summarize', 'summary', 'translate', 'reformat', 'format', 'list ',
  'check if', 'look up', 'lookup', 'remind', 'tag ', 'label', 'file this', 'move this',
]

function hits(text: string, words: readonly string[]): number {
  return words.filter((word) => text.includes(word)).length
}

/**
 * The fallback when no TypeSafe key is set: keyword and length rules. It
 * reports no confidence, so the policy lets it route up but never down. A
 * hunch may spend more; it may not save money at the task's expense.
 */
export function classifyHeuristically(task: Task): Classification {
  const text = `${task.title}\n${task.description ?? ''}`.toLowerCase()
  const deep = hits(text, DEEP_WORDS)
  const fast = hits(text, FAST_WORDS)
  const long = text.length > 1500

  let tier: Tier = 'balanced'
  if (deep >= 2 || (deep >= 1 && long)) tier = 'deep'
  else if (fast >= 1 && deep === 0 && text.length < 300) tier = 'fast'

  const effort = tier === 'deep' ? 2 : tier === 'fast' ? 0 : 1
  return {
    decision: { tier, confidence: null, risky: null, effort, effortConfidence: null },
    classifier: 'heuristic',
    ms: 0,
  }
}
